import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  GoodsReceiptStatus,
  ItemStatus,
  ItemVariantKind,
  LocationStatus,
  PriceBookDirection,
  Prisma,
  PurchaseOrderStatus,
  SupplierStatus,
  TenantContext,
} from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import { PricingEngineService } from "../pricing/pricing-engine.service.js";
import type { AuthenticatedTenant } from "../tenancy/tenant.decorators.js";
import { DeliveriesService } from "./deliveries.service.js";
import { computePoLineCapacity, decomposeBaseToBulk } from "./delivery-units.utils.js";

export interface PurchaseOrderLineInput {
  itemId: string;
  packId?: string | null;
  orderedQty: number;
  unitCostCents?: number;
  supplierSku?: string | null;
  description?: string | null;
}

export interface CreatePurchaseOrderInput {
  poNumber?: string;
  supplierId: string;
  locationId: string;
  currency?: string;
  priceBookId?: string | null;
  promoCodes?: string[];
  taxCents?: number;
  expectedAt?: string | null;
  notes?: string | null;
  lines: PurchaseOrderLineInput[];
}

export interface UpdatePurchaseOrderInput {
  locationId?: string;
  currency?: string;
  priceBookId?: string | null;
  promoCodes?: string[];
  taxCents?: number;
  expectedAt?: string | null;
  notes?: string | null;
  lines?: PurchaseOrderLineInput[];
}

export interface ListPurchaseOrdersQuery {
  status?: PurchaseOrderStatus;
  supplierId?: string;
  locationId?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface ReceiveGoodsInput {
  receiptNumber?: string;
  locationId?: string;
  carrier?: string | null;
  trackingNumber?: string | null;
  packingSlipNumber?: string | null;
  notes?: string;
  lines: Array<{
    purchaseOrderLineId: string;
    receivedQty?: number;
    packId?: string | null;
    packQty?: number;
    looseBaseQty?: number;
    baseQty?: number;
    lotNumber?: string | null;
    batchCode?: string | null;
    manufacturedAt?: string | null;
    expiresAt?: string | null;
    serialNumbers?: string[] | null;
  }>;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

@Injectable()
export class PurchaseOrdersService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(PricingEngineService)
    private readonly pricingEngine: PricingEngineService,
    @Inject(DeliveriesService)
    private readonly deliveriesService: DeliveriesService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  async createPurchaseOrder(
    tenant: AuthenticatedTenant,
    input: CreatePurchaseOrderInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const poNumber =
      input.poNumber?.trim().toUpperCase() ||
      `PO-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    const [supplier, location, items, supplierItems] = await Promise.all([
      this.prismaService.raw.supplier.findFirst({
        where: { id: input.supplierId, organizationId },
      }),
      this.prismaService.raw.location.findFirst({
        where: { id: input.locationId, organizationId },
      }),
      this.prismaService.raw.item.findMany({
        where: {
          organizationId,
          id: { in: input.lines.map((l) => l.itemId) },
        },
      }),
      this.prismaService.raw.supplierItem.findMany({
        where: {
          organizationId,
          supplierId: input.supplierId,
          itemId: { in: input.lines.map((l) => l.itemId) },
        },
      }),
    ]);

    if (!supplier || supplier.status !== SupplierStatus.ACTIVE) {
      throw new BadRequestException(
        "Supplier must exist and be ACTIVE to create a purchase order.",
      );
    }
    if (!location || location.status !== LocationStatus.ACTIVE) {
      throw new BadRequestException(
        "Destination location must exist and be ACTIVE.",
      );
    }

    const currency = (input.currency ?? supplier.currency).toUpperCase();
    const quote = await this.pricingEngine.calculateQuote(tenant, {
      direction: PriceBookDirection.PURCHASE,
      currency,
      supplierId: supplier.id,
      priceBookId: input.priceBookId ?? null,
      promoCodes: input.promoCodes,
      lines: input.lines.map((l) => ({
        itemId: l.itemId,
        packId: l.packId ?? null,
        quantity: l.orderedQty,
        overrideUnitPriceCents: l.unitCostCents ?? null,
      })),
    });

    const itemMap = new Map(items.map((it) => [it.id, it]));
    const supplierItemMap = new Map(supplierItems.map((si) => [si.itemId, si]));

    const builtLines = input.lines.map((line, idx) => {
      const item = itemMap.get(line.itemId);
      if (!item) {
        throw new NotFoundException(`Catalog item "${line.itemId}" was not found.`);
      }
      if (item.status === ItemStatus.ARCHIVED) {
        throw new BadRequestException(
          `Archived item "${item.sku}" cannot be ordered.`,
        );
      }
      if (item.variantKind === ItemVariantKind.TEMPLATE) {
        throw new BadRequestException(
          `Item "${item.sku}" is a product template. Select a concrete variant SKU instead.`,
        );
      }

      const mapped = supplierItemMap.get(line.itemId);
      const quoted = quote.lines[idx]!;
      const unitsPerPack = quoted.unitsPerPack;
      const orderedBaseQty = line.orderedQty * unitsPerPack;
      const unitCostCents = line.unitCostCents ?? quoted.effectiveUnitPriceCents;
      const lineTotalCents =
        line.unitCostCents !== undefined
          ? line.orderedQty * line.unitCostCents
          : quoted.finalLineTotalCents;

      return {
        organizationId,
        itemId: item.id,
        packId: quoted.packId,
        unitsPerPack,
        orderedBaseQty,
        receivedBaseQty: 0,
        supplierSku: line.supplierSku ?? mapped?.supplierSku ?? null,
        description:
          line.description ??
          (quoted.packCode ? `${item.name} (${quoted.packCode})` : item.name),
        orderedQty: line.orderedQty,
        receivedQty: 0,
        unitCostCents,
        lineTotalCents,
        pricingSnapshot: {
          pricingModel: quoted.pricingModel,
          priceBookId: quoted.priceBookId,
          priceBookCode: quoted.priceBookCode,
          unitsPerPack,
          orderedBaseQty,
          lineDiscountCents: quoted.lineDiscountCents,
          appliedTiers: quoted.appliedTiers,
          appliedDiscounts: quoted.appliedDiscounts,
        } as unknown as Prisma.InputJsonValue,
      };
    });

    const subtotalCents = builtLines.reduce(
      (sum, l) => sum + l.lineTotalCents,
      0,
    );
    const taxCents = input.taxCents ?? 0;
    const totalCents = Math.max(
      0,
      subtotalCents - quote.orderDiscountTotalCents + taxCents,
    );

    try {
      const created = await this.prismaService.raw.$transaction(async (tx) => {
        const created = await tx.purchaseOrder.create({
          data: {
            organizationId,
            poNumber,
            supplierId: supplier.id,
            locationId: location.id,
            status: PurchaseOrderStatus.DRAFT,
            currency,
            subtotalCents,
            taxCents,
            totalCents,
            notes: input.notes ?? null,
            expectedAt: input.expectedAt ? new Date(input.expectedAt) : null,
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
            lines: { create: builtLines },
          },
          include: {
            supplier: { select: { id: true, code: true, name: true } },
            location: { select: { id: true, code: true, name: true, type: true } },
            lines: {
              include: {
                item: {
                  select: {
                    id: true,
                    sku: true,
                    name: true,
                    type: true,
                    unitOfMeasure: true,
                  },
                },
                pack: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    unitOfMeasure: true,
                    unitsPerPack: true,
                  },
                },
              },
            },
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "purchase_order.created",
            resourceType: "PurchaseOrder",
            resourceId: created.id,
            metadata: {
              poNumber: created.poNumber,
              supplierCode: supplier.code,
              locationCode: location.code,
              totalCents: created.totalCents,
              lineCount: created.lines.length,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return created;
      });

      this.analyticsService.captureDomainEvent({
        event: "purchase_order.created",
        distinctId: tenant.userId,
        organizationId,
        properties: {
          purchase_order_id: created.id,
          po_number: created.poNumber,
          currency: created.currency,
          total_cents: created.totalCents,
          line_count: created.lines.length,
        },
      });

      return created;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `Purchase order number "${poNumber}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async listPurchaseOrders(
    tenant: AuthenticatedTenant,
    query: ListPurchaseOrdersQuery,
  ) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const records = await this.prismaService.scoped.purchaseOrder.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(search
          ? { poNumber: { contains: search, mode: "insensitive" } }
          : {}),
      },
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        location: { select: { id: true, code: true, name: true, type: true } },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    const hasMore = records.length > take;
    const items = hasMore ? records.slice(0, take) : records;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return {
      organizationId: tenant.organizationId,
      items,
      nextCursor,
    };
  }

  async getPurchaseOrder(tenant: AuthenticatedTenant, poId: string) {
    this.resolveVerifiedOrganizationId(tenant);

    const po = await this.prismaService.scoped.purchaseOrder.findUnique({
      where: { id: poId },
      include: {
        supplier: { select: { id: true, code: true, name: true, email: true } },
        location: { select: { id: true, code: true, name: true, type: true } },
        lines: {
          include: {
            item: {
              select: {
                id: true,
                sku: true,
                name: true,
                type: true,
                unitOfMeasure: true,
                trackInventory: true,
              },
            },
            pack: {
              select: {
                id: true,
                code: true,
                name: true,
                unitOfMeasure: true,
                unitsPerPack: true,
              },
            },
          },
        },
        goodsReceipts: {
          orderBy: { receivedAt: "desc" },
          include: { lines: true },
        },
      },
    });

    if (!po) {
      throw new NotFoundException("Purchase order was not found.");
    }

    const activeStagedStatuses = new Set<GoodsReceiptStatus>([
      GoodsReceiptStatus.PENDING_QC,
      GoodsReceiptStatus.QC_IN_PROGRESS,
      GoodsReceiptStatus.QC_COMPLETED,
    ]);
    const pendingByPoLine = new Map<string, number>();
    for (const receipt of po.goodsReceipts) {
      if (!activeStagedStatuses.has(receipt.status)) {
        continue;
      }
      for (const rLine of receipt.lines) {
        pendingByPoLine.set(
          rLine.purchaseOrderLineId,
          (pendingByPoLine.get(rLine.purchaseOrderLineId) ?? 0) +
            rLine.receivedBaseQty,
        );
      }
    }

    return {
      ...po,
      lines: po.lines.map((line) => {
        const pendingQcBaseQty = pendingByPoLine.get(line.id) ?? 0;
        const cap = computePoLineCapacity(line, pendingQcBaseQty);
        const packLabel = line.pack?.unitOfMeasure ?? line.pack?.name ?? null;
        return {
          ...line,
          pendingQcBaseQty,
          openBaseQty: cap.openBaseQty,
          openBreakdown: decomposeBaseToBulk(
            cap.openBaseQty,
            line.unitsPerPack,
            packLabel,
            line.item.unitOfMeasure,
          ),
          billableRemainingBaseQty: Math.max(
            0,
            line.acceptedBaseQty - line.billedBaseQty,
          ),
        };
      }),
    };
  }

  async updateDraftPurchaseOrder(
    tenant: AuthenticatedTenant,
    poId: string,
    input: UpdatePurchaseOrderInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const existing = await this.prismaService.raw.purchaseOrder.findFirst({
      where: { id: poId, organizationId },
      include: { lines: true },
    });

    if (!existing) {
      throw new NotFoundException("Purchase order was not found.");
    }

    if (existing.status !== PurchaseOrderStatus.DRAFT) {
      throw new BadRequestException("Only DRAFT purchase orders can be edited.");
    }

    const nextCurrency = (input.currency ?? existing.currency).toUpperCase();
    const quote = input.lines
      ? await this.pricingEngine.calculateQuote(tenant, {
          direction: PriceBookDirection.PURCHASE,
          currency: nextCurrency,
          supplierId: existing.supplierId,
          priceBookId: input.priceBookId ?? null,
          promoCodes: input.promoCodes,
          lines: input.lines.map((l) => ({
            itemId: l.itemId,
            packId: l.packId ?? null,
            quantity: l.orderedQty,
            overrideUnitPriceCents: l.unitCostCents ?? null,
          })),
        })
      : null;

    return this.prismaService.raw.$transaction(async (tx) => {
      if (input.locationId) {
        const loc = await tx.location.findFirst({
          where: { id: input.locationId, organizationId },
        });
        if (!loc || loc.status !== LocationStatus.ACTIVE) {
          throw new BadRequestException(
            "Destination location must exist and be ACTIVE.",
          );
        }
      }

      let subtotalCents = existing.subtotalCents;
      const taxCents = input.taxCents ?? existing.taxCents;

      if (input.lines && quote) {
        const [items, supplierItems] = await Promise.all([
          tx.item.findMany({
            where: {
              organizationId,
              id: { in: input.lines.map((l) => l.itemId) },
            },
          }),
          tx.supplierItem.findMany({
            where: {
              organizationId,
              supplierId: existing.supplierId,
              itemId: { in: input.lines.map((l) => l.itemId) },
            },
          }),
        ]);

        const itemMap = new Map(items.map((it) => [it.id, it]));
        const supplierItemMap = new Map(
          supplierItems.map((si) => [si.itemId, si]),
        );

        const rebuiltLines = input.lines.map((line, idx) => {
          const item = itemMap.get(line.itemId);
          if (!item) {
            throw new NotFoundException(
              `Catalog item "${line.itemId}" was not found.`,
            );
          }
          if (item.status === ItemStatus.ARCHIVED) {
            throw new BadRequestException(
              `Archived item "${item.sku}" cannot be ordered.`,
            );
          }
          if (item.variantKind === ItemVariantKind.TEMPLATE) {
            throw new BadRequestException(
              `Item "${item.sku}" is a product template. Select a concrete variant SKU instead.`,
            );
          }
          const mapped = supplierItemMap.get(line.itemId);
          const quoted = quote.lines[idx]!;
          const unitsPerPack = quoted.unitsPerPack;
          const orderedBaseQty = line.orderedQty * unitsPerPack;
          const unitCostCents =
            line.unitCostCents ?? quoted.effectiveUnitPriceCents;
          const lineTotalCents =
            line.unitCostCents !== undefined
              ? line.orderedQty * line.unitCostCents
              : quoted.finalLineTotalCents;

          return {
            organizationId,
            purchaseOrderId: poId,
            itemId: item.id,
            packId: quoted.packId,
            unitsPerPack,
            orderedBaseQty,
            receivedBaseQty: 0,
            supplierSku: line.supplierSku ?? mapped?.supplierSku ?? null,
            description:
              line.description ??
              (quoted.packCode ? `${item.name} (${quoted.packCode})` : item.name),
            orderedQty: line.orderedQty,
            receivedQty: 0,
            unitCostCents,
            lineTotalCents,
            pricingSnapshot: {
              pricingModel: quoted.pricingModel,
              priceBookId: quoted.priceBookId,
              priceBookCode: quoted.priceBookCode,
              unitsPerPack,
              orderedBaseQty,
              lineDiscountCents: quoted.lineDiscountCents,
              appliedTiers: quoted.appliedTiers,
              appliedDiscounts: quoted.appliedDiscounts,
            } as unknown as Prisma.InputJsonValue,
          };
        });

        await tx.purchaseOrderLine.deleteMany({
          where: { organizationId, purchaseOrderId: poId },
        });
        await tx.purchaseOrderLine.createMany({ data: rebuiltLines });
        subtotalCents = rebuiltLines.reduce(
          (sum, l) => sum + l.lineTotalCents,
          0,
        );
      }

      const orderDiscount = quote ? quote.orderDiscountTotalCents : 0;
      const totalCents = Math.max(0, subtotalCents - orderDiscount + taxCents);

      const updated = await tx.purchaseOrder.update({
        where: { id: poId },
        data: {
          ...(input.locationId !== undefined
            ? { locationId: input.locationId }
            : {}),
          ...(input.currency !== undefined ? { currency: nextCurrency } : {}),
          ...(input.taxCents !== undefined ? { taxCents } : {}),
          ...(input.expectedAt !== undefined
            ? {
                expectedAt: input.expectedAt ? new Date(input.expectedAt) : null,
              }
            : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          subtotalCents,
          totalCents,
          updatedByUserId: tenant.userId,
        },
        include: {
          supplier: { select: { id: true, code: true, name: true } },
          location: { select: { id: true, code: true, name: true, type: true } },
          lines: {
            include: {
              item: {
                select: { id: true, sku: true, name: true, unitOfMeasure: true },
              },
              pack: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  unitOfMeasure: true,
                  unitsPerPack: true,
                },
              },
            },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "purchase_order.updated",
          resourceType: "PurchaseOrder",
          resourceId: updated.id,
          metadata: {
            poNumber: updated.poNumber,
            totalCents: updated.totalCents,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async submitPurchaseOrder(
    tenant: AuthenticatedTenant,
    poId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const submitted = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.purchaseOrder.findFirst({
        where: { id: poId, organizationId },
        include: { lines: true },
      });

      if (!existing) {
        throw new NotFoundException("Purchase order was not found.");
      }
      if (existing.status !== PurchaseOrderStatus.DRAFT) {
        throw new BadRequestException(
          `Only DRAFT purchase orders can be submitted (current status: ${existing.status}).`,
        );
      }
      if (existing.lines.length === 0) {
        throw new BadRequestException(
          "Purchase order must contain at least one line before submission.",
        );
      }

      const claimed = await tx.purchaseOrder.updateMany({
        where: {
          id: poId,
          organizationId,
          status: PurchaseOrderStatus.DRAFT,
        },
        data: {
          status: PurchaseOrderStatus.SUBMITTED,
          submittedAt: new Date(),
          submittedByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
        },
      });

      if (claimed.count !== 1) {
        throw new ConflictException(
          "Purchase order state changed concurrently. Refresh and retry.",
        );
      }

      const submitted = await tx.purchaseOrder.findFirstOrThrow({
        where: { id: poId, organizationId },
        include: {
          supplier: { select: { id: true, code: true, name: true } },
          location: { select: { id: true, code: true, name: true, type: true } },
          lines: true,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "purchase_order.submitted",
          resourceType: "PurchaseOrder",
          resourceId: submitted.id,
          metadata: {
            poNumber: submitted.poNumber,
            totalCents: submitted.totalCents,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return submitted;
    });

    this.analyticsService.captureDomainEvent({
      event: "purchase_order.submitted",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        purchase_order_id: submitted.id,
        po_number: submitted.poNumber,
        currency: submitted.currency,
        total_cents: submitted.totalCents,
      },
    });

    return submitted;
  }

  async cancelPurchaseOrder(
    tenant: AuthenticatedTenant,
    poId: string,
    reason?: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const cancelled = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.purchaseOrder.findFirst({
        where: { id: poId, organizationId },
        include: { lines: true },
      });

      if (!existing) {
        throw new NotFoundException("Purchase order was not found.");
      }

      if (
        existing.status !== PurchaseOrderStatus.DRAFT &&
        existing.status !== PurchaseOrderStatus.SUBMITTED
      ) {
        throw new BadRequestException(
          `Purchase orders in status "${existing.status}" cannot be cancelled.`,
        );
      }

      const hasReceivedItems = existing.lines.some((l) => l.receivedQty > 0);
      if (hasReceivedItems) {
        throw new BadRequestException(
          "Cannot cancel a purchase order that already has received goods.",
        );
      }

      const claimed = await tx.purchaseOrder.updateMany({
        where: { id: poId, organizationId, status: existing.status },
        data: {
          status: PurchaseOrderStatus.CANCELLED,
          cancelledAt: new Date(),
          updatedByUserId: tenant.userId,
        },
      });

      if (claimed.count !== 1) {
        throw new ConflictException(
          "Purchase order state changed concurrently. Refresh and retry.",
        );
      }

      const cancelled = await tx.purchaseOrder.findFirstOrThrow({
        where: { id: poId, organizationId },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "purchase_order.cancelled",
          resourceType: "PurchaseOrder",
          resourceId: cancelled.id,
          metadata: {
            poNumber: cancelled.poNumber,
            previousStatus: existing.status,
            ...(reason ? { reason } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return cancelled;
    });

    this.analyticsService.captureDomainEvent({
      event: "purchase_order.cancelled",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        purchase_order_id: cancelled.id,
        po_number: cancelled.poNumber,
      },
    });

    return cancelled;
  }

  async receiveGoods(
    tenant: AuthenticatedTenant,
    poId: string,
    input: ReceiveGoodsInput,
    ipAddress?: string,
  ) {
    const delivery = await this.deliveriesService.createDelivery(
      tenant,
      poId,
      {
        receiptNumber: input.receiptNumber,
        locationId: input.locationId,
        carrier: input.carrier,
        trackingNumber: input.trackingNumber,
        packingSlipNumber: input.packingSlipNumber,
        notes: input.notes,
        lines: input.lines.map((line) => ({
          purchaseOrderLineId: line.purchaseOrderLineId,
          packId: line.packId,
          packQty:
            line.packQty !== undefined
              ? line.packQty
              : line.baseQty === undefined && line.looseBaseQty === undefined
                ? line.receivedQty
                : undefined,
          looseBaseQty: line.looseBaseQty,
          baseQty: line.baseQty,
          lotNumber: line.lotNumber,
          batchCode: line.batchCode,
          manufacturedAt: line.manufacturedAt,
          expiresAt: line.expiresAt,
          serialNumbers: line.serialNumbers,
        })),
      },
      ipAddress,
    );

    const purchaseOrder = await this.prismaService.scoped.purchaseOrder.findUnique({
      where: { id: poId },
    });

    return {
      receipt: delivery,
      delivery,
      purchaseOrder,
    };
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedTenant): string {
    const contextOrgId = TenantContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active tenant context mismatch.");
    }
    return tenant.organizationId;
  }
}

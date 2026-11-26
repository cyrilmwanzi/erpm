import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AttachmentDocumentType,
  DeliveryLineQcStatus,
  GoodsReceiptStatus,
  LocationStatus,
  Prisma,
  PurchaseOrderStatus,
  QuarantineStatus,
  RejectionDisposition,
  StockMovementType,
  StorageEntityType,
  SupplierClaimStatus,
  SupplierClaimType,
  TenantContext,
} from "@scace/db";
import type { FastifyRequest } from "fastify";
import { PrismaService } from "../database/prisma.service.js";
import { computeExpiresAtFromShelfLife } from "../locations/lot-allocation.utils.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import {
  type AttachmentInput,
  AttachmentsService,
  STORED_OBJECT_SUMMARY_SELECT,
} from "../storage/attachments.service.js";
import type { AuthenticatedTenant } from "../tenancy/tenant.decorators.js";
import {
  type BulkQuantityInput,
  computeBaseUnitValueCents,
  computePoLineCapacity,
  decomposeBaseToBulk,
  normalizeBulkQuantity,
} from "./delivery-units.utils.js";

export interface CreateDeliveryLineInput extends BulkQuantityInput {
  purchaseOrderLineId: string;
  packId?: string | null;
  lotNumber?: string | null;
  batchCode?: string | null;
  supplierBatchNumber?: string | null;
  manufacturedAt?: string | null;
  expiresAt?: string | null;
  serialNumbers?: string[] | null;
  attachments?: AttachmentInput[];
}

export interface CreateDeliveryInput {
  receiptNumber?: string;
  locationId?: string;
  carrier?: string | null;
  trackingNumber?: string | null;
  packingSlipNumber?: string | null;
  deliveredAt?: string | null;
  notes?: string | null;
  attachments?: AttachmentInput[];
  lines: CreateDeliveryLineInput[];
}

export interface ListDeliveriesQuery {
  purchaseOrderId?: string;
  supplierId?: string;
  locationId?: string;
  status?: GoodsReceiptStatus;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface SubmitQcLineInput {
  deliveryLineId: string;
  accepted?: BulkQuantityInput;
  acceptedBaseQty?: number;
  rejected?: BulkQuantityInput;
  rejectedBaseQty?: number;
  quarantined?: BulkQuantityInput;
  quarantinedBaseQty?: number;
  rejectionDisposition?: RejectionDisposition;
  defectReasonCode?: string | null;
  qcNotes?: string | null;
  lotNumber?: string | null;
  batchCode?: string | null;
  supplierBatchNumber?: string | null;
  manufacturedAt?: string | null;
  expiresAt?: string | null;
  serialNumbers?: string[] | null;
  attachments?: AttachmentInput[];
}

export interface SubmitQcInspectionInput {
  qcNotes?: string | null;
  attachments?: AttachmentInput[];
  lines: SubmitQcLineInput[];
}

export interface AcceptDeliveryInput {
  locationId?: string;
  acceptanceNotes?: string | null;
  defaultClaimType?: SupplierClaimType;
}

export type QuarantineResolutionAction =
  | "RELEASE_TO_STOCK"
  | "RETURN_TO_SUPPLIER"
  | "SUPPLIER_CLAIM"
  | "SCRAP";

export interface ResolveQuarantineInput extends BulkQuantityInput {
  resolution: QuarantineResolutionAction;
  claimType?: SupplierClaimType;
  resolutionNotes?: string | null;
}

export interface ListQuarantineQuery {
  status?: QuarantineStatus;
  itemId?: string;
  goodsReceiptId?: string;
  limit: number;
  cursor?: string;
}

export interface ListClaimsQuery {
  status?: SupplierClaimStatus;
  supplierId?: string;
  purchaseOrderId?: string;
  limit: number;
  cursor?: string;
}

export interface UpdateClaimInput {
  status: SupplierClaimStatus;
  claimAmountCents?: number;
  resolutionNotes?: string | null;
}

const ACTIVE_STAGED_STATUSES: GoodsReceiptStatus[] = [
  GoodsReceiptStatus.PENDING_QC,
  GoodsReceiptStatus.QC_IN_PROGRESS,
  GoodsReceiptStatus.QC_COMPLETED,
];

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

@Injectable()
export class DeliveriesService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(AttachmentsService)
    private readonly attachmentsService: AttachmentsService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  async getDeliveryPreview(tenant: AuthenticatedTenant, poId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const po = await this.prismaService.raw.purchaseOrder.findFirst({
      where: { id: poId, organizationId },
      include: {
        supplier: { select: { id: true, code: true, name: true, currency: true } },
        location: { select: { id: true, code: true, name: true, type: true } },
        lines: {
          include: {
            item: {
              select: {
                id: true,
                sku: true,
                name: true,
                unitOfMeasure: true,
                trackInventory: true,
                packs: {
                  where: { isActive: true },
                  orderBy: [{ unitsPerPack: "asc" }, { code: "asc" }],
                },
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
          where: { status: { in: ACTIVE_STAGED_STATUSES } },
          include: { lines: true },
        },
      },
    });

    if (!po) {
      throw new NotFoundException("Purchase order was not found.");
    }

    const pendingByPoLine = new Map<string, number>();
    for (const receipt of po.goodsReceipts) {
      for (const rLine of receipt.lines) {
        pendingByPoLine.set(
          rLine.purchaseOrderLineId,
          (pendingByPoLine.get(rLine.purchaseOrderLineId) ?? 0) +
            rLine.receivedBaseQty,
        );
      }
    }

    const lines = po.lines.map((line) => {
      const pendingQcBaseQty = pendingByPoLine.get(line.id) ?? 0;
      const cap = computePoLineCapacity(line, pendingQcBaseQty);
      const packLabel = line.pack?.unitOfMeasure ?? line.pack?.name ?? null;
      const baseLabel = line.item.unitOfMeasure;

      return {
        purchaseOrderLineId: line.id,
        itemId: line.itemId,
        sku: line.item.sku,
        itemName: line.item.name,
        baseUnitOfMeasure: baseLabel,
        orderedPack: line.pack,
        unitsPerPack: line.unitsPerPack,
        orderedQty: line.orderedQty,
        orderedBaseQty: cap.effectiveOrderedBaseQty,
        orderedSummary: decomposeBaseToBulk(
          cap.effectiveOrderedBaseQty,
          line.unitsPerPack,
          packLabel,
          baseLabel,
        ),
        acceptedBaseQty: line.acceptedBaseQty,
        rejectedBaseQty: line.rejectedBaseQty,
        quarantinedBaseQty: line.quarantinedBaseQty,
        creditedClaimBaseQty: line.creditedClaimBaseQty,
        pendingQcBaseQty,
        openBaseQty: cap.openBaseQty,
        openBreakdown: decomposeBaseToBulk(
          cap.openBaseQty,
          line.unitsPerPack,
          packLabel,
          baseLabel,
        ),
        unitCostCents: line.unitCostCents,
        availablePacks: line.item.packs,
      };
    });

    return {
      purchaseOrderId: po.id,
      poNumber: po.poNumber,
      status: po.status,
      currency: po.currency,
      supplier: po.supplier,
      defaultLocation: po.location,
      canReceiveDelivery:
        po.status === PurchaseOrderStatus.SUBMITTED ||
        po.status === PurchaseOrderStatus.PARTIALLY_RECEIVED,
      lines,
    };
  }

  async createDelivery(
    tenant: AuthenticatedTenant,
    poId: string,
    input: CreateDeliveryInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const receiptNumber =
      input.receiptNumber?.trim().toUpperCase() ||
      `DLV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    try {
      const result = await this.prismaService.raw.$transaction(async (tx) => {
        const po = await tx.purchaseOrder.findFirst({
          where: { id: poId, organizationId },
          include: {
            supplier: { select: { id: true, code: true, name: true } },
            lines: {
              include: {
                item: {
                  select: {
                    id: true,
                    sku: true,
                    name: true,
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
              where: { status: { in: ACTIVE_STAGED_STATUSES } },
              include: { lines: true },
            },
          },
        });

        if (!po) {
          throw new NotFoundException("Purchase order was not found.");
        }
        if (
          po.status !== PurchaseOrderStatus.SUBMITTED &&
          po.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED
        ) {
          throw new BadRequestException(
            `Purchase order must be SUBMITTED or PARTIALLY_RECEIVED to log a delivery (current status: ${po.status}).`,
          );
        }

        const receivingLocationId = input.locationId ?? po.locationId;
        const location = await tx.location.findFirst({
          where: { id: receivingLocationId, organizationId },
        });
        if (!location || location.status !== LocationStatus.ACTIVE) {
          throw new BadRequestException(
            "Receiving location must exist and be ACTIVE.",
          );
        }

        const pendingByPoLine = new Map<string, number>();
        for (const receipt of po.goodsReceipts) {
          for (const rLine of receipt.lines) {
            pendingByPoLine.set(
              rLine.purchaseOrderLineId,
              (pendingByPoLine.get(rLine.purchaseOrderLineId) ?? 0) +
                rLine.receivedBaseQty,
            );
          }
        }

        const requestedPackIds = Array.from(
          new Set(
            input.lines
              .map((l) => l.packId)
              .filter((id): id is string => Boolean(id)),
          ),
        );
        const packRecords =
          requestedPackIds.length > 0
            ? await tx.itemPack.findMany({
                where: {
                  organizationId,
                  id: { in: requestedPackIds },
                  isActive: true,
                },
              })
            : [];
        const packMap = new Map(packRecords.map((p) => [p.id, p]));
        const poLineMap = new Map(po.lines.map((l) => [l.id, l]));

        const supplierItems =
          po.lines.length > 0
            ? await tx.supplierItem.findMany({
                where: {
                  organizationId,
                  supplierId: po.supplierId,
                  itemId: { in: po.lines.map((l) => l.itemId) },
                },
                select: { id: true, itemId: true },
              })
            : [];
        const supplierItemMap = new Map(
          supplierItems.map((si) => [si.itemId, si.id]),
        );

        const requestedBaseByPoLine = new Map<string, number>();
        const builtLines: Array<{
          data: Prisma.GoodsReceiptLineCreateWithoutGoodsReceiptInput;
          attachments?: AttachmentInput[];
        }> = [];

        for (const reqLine of input.lines) {
          const poLine = poLineMap.get(reqLine.purchaseOrderLineId);
          if (!poLine) {
            throw new NotFoundException(
              `Purchase order line "${reqLine.purchaseOrderLineId}" does not belong to this purchase order.`,
            );
          }

          let effectivePack = poLine.pack;
          if (reqLine.packId !== undefined) {
            if (reqLine.packId === null) {
              effectivePack = null;
            } else {
              const chosenPack = packMap.get(reqLine.packId);
              if (!chosenPack || chosenPack.itemId !== poLine.itemId) {
                throw new BadRequestException(
                  `Pack "${reqLine.packId}" was not found or does not belong to SKU "${poLine.item.sku}".`,
                );
              }
              effectivePack = chosenPack;
            }
          }

          const unitsPerPack = effectivePack?.unitsPerPack ?? 1;
          const packLabel =
            effectivePack?.unitOfMeasure ?? effectivePack?.name ?? null;
          const normalized = normalizeBulkQuantity(reqLine, {
            unitsPerPack,
            packLabel,
            baseLabel: poLine.item.unitOfMeasure,
            allowZero: false,
            fieldLabel: `SKU "${poLine.item.sku}"`,
          });

          const manufacturedAt = reqLine.manufacturedAt
            ? new Date(reqLine.manufacturedAt)
            : null;
          const expiresAt = reqLine.expiresAt ? new Date(reqLine.expiresAt) : null;
          if (
            manufacturedAt &&
            expiresAt &&
            expiresAt.getTime() <= manufacturedAt.getTime()
          ) {
            throw new BadRequestException(
              `Expiration date must be after manufacturing date for SKU "${poLine.item.sku}".`,
            );
          }

          requestedBaseByPoLine.set(
            poLine.id,
            (requestedBaseByPoLine.get(poLine.id) ?? 0) + normalized.totalBaseQty,
          );

          const effectivePackUnitCost = computeBaseUnitValueCents(
            poLine.unitCostCents,
            poLine.unitsPerPack,
            unitsPerPack,
          );
          const supplierItemId = supplierItemMap.get(poLine.itemId);

          builtLines.push({
            attachments: reqLine.attachments,
            data: {
              organization: { connect: { id: organizationId } },
              purchaseOrderLine: { connect: { id: poLine.id } },
              item: { connect: { id: poLine.itemId } },
              ...(supplierItemId
                ? { supplierItem: { connect: { id: supplierItemId } } }
                : {}),
              ...(effectivePack
                ? { pack: { connect: { id: effectivePack.id } } }
                : {}),
              unitsPerPack,
              packQty: normalized.packQty,
              looseBaseQty: normalized.looseBaseQty,
              receivedQty: normalized.packEquivalentCeil,
              receivedBaseQty: normalized.totalBaseQty,
              unitCostCents: effectivePackUnitCost,
              lotNumber: reqLine.lotNumber?.trim() || null,
              batchCode: reqLine.batchCode?.trim() || null,
              supplierBatchNumber: reqLine.supplierBatchNumber?.trim() || null,
              manufacturedAt,
              expiresAt,
              serialNumbers:
                reqLine.serialNumbers && reqLine.serialNumbers.length > 0
                  ? (reqLine.serialNumbers as Prisma.InputJsonValue)
                  : Prisma.DbNull,
              qcStatus: DeliveryLineQcStatus.PENDING,
              acceptedBaseQty: 0,
              rejectedBaseQty: 0,
              quarantinedBaseQty: 0,
            },
          });
        }

        for (const [poLineId, reqBaseQty] of requestedBaseByPoLine.entries()) {
          const poLine = poLineMap.get(poLineId)!;
          const pendingQty = pendingByPoLine.get(poLineId) ?? 0;
          const cap = computePoLineCapacity(poLine, pendingQty);

          if (reqBaseQty > cap.openBaseQty) {
            throw new BadRequestException(
              `Cannot deliver ${reqBaseQty} base units for SKU "${poLine.item.sku}" (remaining open base quantity: ${cap.openBaseQty}, pending QC: ${pendingQty}).`,
            );
          }
        }

        const deliveredAt = input.deliveredAt
          ? new Date(input.deliveredAt)
          : new Date();

        const createdReceipt = await tx.goodsReceipt.create({
          data: {
            organizationId,
            receiptNumber,
            purchaseOrderId: po.id,
            locationId: location.id,
            status: GoodsReceiptStatus.PENDING_QC,
            carrier: input.carrier?.trim() || null,
            trackingNumber: input.trackingNumber?.trim() || null,
            packingSlipNumber: input.packingSlipNumber?.trim() || null,
            notes: input.notes?.trim() || null,
            receivedByUserId: tenant.userId,
            receivedAt: deliveredAt,
            deliveredAt,
          },
        });

        for (const built of builtLines) {
          const createdLine = await tx.goodsReceiptLine.create({
            data: {
              ...built.data,
              goodsReceipt: { connect: { id: createdReceipt.id } },
            },
          });

          if (built.attachments?.length) {
            for (const att of built.attachments) {
              await this.attachmentsService.attachStoredObject(
                tx,
                tenant,
                {
                  storedObjectId: att.storedObjectId,
                  documentType: att.documentType,
                  caption: att.caption,
                  target: { goodsReceiptLineId: createdLine.id },
                },
                ipAddress,
              );
            }
          }
        }

        if (input.attachments?.length) {
          for (const att of input.attachments) {
            await this.attachmentsService.attachStoredObject(
              tx,
              tenant,
              {
                storedObjectId: att.storedObjectId,
                documentType: att.documentType,
                caption: att.caption,
                target: { goodsReceiptId: createdReceipt.id },
              },
              ipAddress,
            );
          }
        }

        const delivery = await tx.goodsReceipt.findFirstOrThrow({
          where: { id: createdReceipt.id, organizationId },
          include: this.deliveryInclude(),
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "delivery.created",
            resourceType: "GoodsReceipt",
            resourceId: delivery.id,
            metadata: {
              receiptNumber: delivery.receiptNumber,
              purchaseOrderId: po.id,
              poNumber: po.poNumber,
              locationCode: location.code,
              status: delivery.status,
              lineCount: delivery.lines.length,
              totalDeliveredBaseQty: delivery.lines.reduce(
                (s, l) => s + l.receivedBaseQty,
                0,
              ),
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return this.formatDeliveryResponse(delivery);
      });

      this.analyticsService.captureDomainEvent({
        event: "delivery.received",
        distinctId: tenant.userId,
        organizationId,
        properties: {
          delivery_id: result.id,
          receipt_number: result.receiptNumber,
          purchase_order_id: poId,
          status: result.status,
          line_count: result.lines.length,
        },
      });

      return result;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `Delivery / receipt number "${receiptNumber}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async listDeliveries(
    tenant: AuthenticatedTenant,
    query: ListDeliveriesQuery,
  ) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const records = await this.prismaService.scoped.goodsReceipt.findMany({
      where: {
        ...(query.purchaseOrderId
          ? { purchaseOrderId: query.purchaseOrderId }
          : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.supplierId
          ? { purchaseOrder: { supplierId: query.supplierId } }
          : {}),
        ...(search
          ? {
              OR: [
                { receiptNumber: { contains: search, mode: "insensitive" } },
                { trackingNumber: { contains: search, mode: "insensitive" } },
                { packingSlipNumber: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: this.deliveryInclude(),
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ deliveredAt: "desc" }, { id: "desc" }],
    });

    const hasMore = records.length > take;
    const sliced = hasMore ? records.slice(0, take) : records;
    const nextCursor = hasMore ? (sliced[sliced.length - 1]?.id ?? null) : null;

    return {
      organizationId: tenant.organizationId,
      items: sliced.map((d) => this.formatDeliveryResponse(d)),
      nextCursor,
    };
  }

  async getDelivery(tenant: AuthenticatedTenant, deliveryId: string) {
    this.resolveVerifiedOrganizationId(tenant);

    const delivery = await this.prismaService.scoped.goodsReceipt.findUnique({
      where: { id: deliveryId },
      include: {
        ...this.deliveryInclude(),
        quarantineHolds: {
          orderBy: { createdAt: "desc" },
        },
        supplierClaims: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!delivery) {
      throw new NotFoundException("Supplier delivery was not found.");
    }

    return this.formatDeliveryResponse(delivery);
  }

  async submitQcInspection(
    tenant: AuthenticatedTenant,
    deliveryId: string,
    input: SubmitQcInspectionInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const result = await this.prismaService.raw.$transaction(async (tx) => {
      const delivery = await tx.goodsReceipt.findFirst({
        where: { id: deliveryId, organizationId },
        include: {
          lines: {
            include: {
              item: { select: { id: true, sku: true, name: true, unitOfMeasure: true } },
              pack: { select: { id: true, code: true, name: true, unitOfMeasure: true, unitsPerPack: true } },
            },
          },
        },
      });

      if (!delivery) {
        throw new NotFoundException("Supplier delivery was not found.");
      }

      if (
        delivery.status !== GoodsReceiptStatus.PENDING_QC &&
        delivery.status !== GoodsReceiptStatus.QC_IN_PROGRESS &&
        delivery.status !== GoodsReceiptStatus.QC_COMPLETED
      ) {
        throw new BadRequestException(
          `Delivery cannot undergo QC inspection in status "${delivery.status}".`,
        );
      }

      const lineMap = new Map(delivery.lines.map((l) => [l.id, l]));
      const seen = new Set<string>();
      const now = new Date();

      for (const qcLine of input.lines) {
        if (seen.has(qcLine.deliveryLineId)) {
          throw new BadRequestException(
            `Duplicate deliveryLineId "${qcLine.deliveryLineId}" in QC payload.`,
          );
        }
        seen.add(qcLine.deliveryLineId);

        const existingLine = lineMap.get(qcLine.deliveryLineId);
        if (!existingLine) {
          throw new NotFoundException(
            `Delivery line "${qcLine.deliveryLineId}" does not belong to this delivery.`,
          );
        }

        const packLabel =
          existingLine.pack?.unitOfMeasure ?? existingLine.pack?.name ?? null;
        const baseLabel = existingLine.item.unitOfMeasure;

        const acceptedNorm = normalizeBulkQuantity(
          qcLine.accepted ?? { baseQty: qcLine.acceptedBaseQty ?? 0 },
          {
            unitsPerPack: existingLine.unitsPerPack,
            packLabel,
            baseLabel,
            allowZero: true,
            fieldLabel: `accepted quantity for "${existingLine.item.sku}"`,
          },
        );
        const rejectedNorm = normalizeBulkQuantity(
          qcLine.rejected ?? { baseQty: qcLine.rejectedBaseQty ?? 0 },
          {
            unitsPerPack: existingLine.unitsPerPack,
            packLabel,
            baseLabel,
            allowZero: true,
            fieldLabel: `rejected quantity for "${existingLine.item.sku}"`,
          },
        );
        const quarantinedNorm = normalizeBulkQuantity(
          qcLine.quarantined ?? { baseQty: qcLine.quarantinedBaseQty ?? 0 },
          {
            unitsPerPack: existingLine.unitsPerPack,
            packLabel,
            baseLabel,
            allowZero: true,
            fieldLabel: `quarantined quantity for "${existingLine.item.sku}"`,
          },
        );

        const sumBase =
          acceptedNorm.totalBaseQty +
          rejectedNorm.totalBaseQty +
          quarantinedNorm.totalBaseQty;

        if (sumBase !== existingLine.receivedBaseQty) {
          throw new BadRequestException(
            `QC split total (${sumBase} base units) for SKU "${existingLine.item.sku}" must equal delivered base quantity (${existingLine.receivedBaseQty}).`,
          );
        }

        if (rejectedNorm.totalBaseQty > 0 && !qcLine.rejectionDisposition) {
          throw new BadRequestException(
            `rejectionDisposition is required when rejected quantity > 0 for SKU "${existingLine.item.sku}".`,
          );
        }

        const manufacturedAt =
          qcLine.manufacturedAt !== undefined
            ? qcLine.manufacturedAt
              ? new Date(qcLine.manufacturedAt)
              : null
            : existingLine.manufacturedAt;
        const expiresAt =
          qcLine.expiresAt !== undefined
            ? qcLine.expiresAt
              ? new Date(qcLine.expiresAt)
              : null
            : existingLine.expiresAt;
        if (
          manufacturedAt &&
          expiresAt &&
          expiresAt.getTime() <= manufacturedAt.getTime()
        ) {
          throw new BadRequestException(
            `Expiration date must be after manufacturing date for SKU "${existingLine.item.sku}".`,
          );
        }

        let qcStatus: DeliveryLineQcStatus;
        if (acceptedNorm.totalBaseQty === existingLine.receivedBaseQty) {
          qcStatus = DeliveryLineQcStatus.PASSED;
        } else if (quarantinedNorm.totalBaseQty === existingLine.receivedBaseQty) {
          qcStatus = DeliveryLineQcStatus.QUARANTINED;
        } else if (rejectedNorm.totalBaseQty === existingLine.receivedBaseQty) {
          qcStatus = DeliveryLineQcStatus.FAILED;
        } else {
          qcStatus = DeliveryLineQcStatus.PARTIAL;
        }

        await tx.goodsReceiptLine.update({
          where: { id: existingLine.id },
          data: {
            qcStatus,
            acceptedBaseQty: acceptedNorm.totalBaseQty,
            rejectedBaseQty: rejectedNorm.totalBaseQty,
            quarantinedBaseQty: quarantinedNorm.totalBaseQty,
            rejectionDisposition:
              rejectedNorm.totalBaseQty > 0
                ? (qcLine.rejectionDisposition ?? null)
                : null,
            defectReasonCode: qcLine.defectReasonCode?.trim() ?? null,
            qcNotes: qcLine.qcNotes?.trim() ?? null,
            qcInspectedByUserId: tenant.userId,
            qcInspectedAt: now,
            ...(qcLine.lotNumber !== undefined
              ? { lotNumber: qcLine.lotNumber?.trim() || null }
              : {}),
            ...(qcLine.batchCode !== undefined
              ? { batchCode: qcLine.batchCode?.trim() || null }
              : {}),
            ...(qcLine.supplierBatchNumber !== undefined
              ? {
                  supplierBatchNumber:
                    qcLine.supplierBatchNumber?.trim() || null,
                }
              : {}),
            ...(qcLine.manufacturedAt !== undefined ? { manufacturedAt } : {}),
            ...(qcLine.expiresAt !== undefined ? { expiresAt } : {}),
            ...(qcLine.serialNumbers !== undefined
              ? {
                  serialNumbers:
                    qcLine.serialNumbers && qcLine.serialNumbers.length > 0
                      ? (qcLine.serialNumbers as Prisma.InputJsonValue)
                      : Prisma.DbNull,
                }
              : {}),
          },
        });

        if (qcLine.attachments?.length) {
          for (const att of qcLine.attachments) {
            await this.attachmentsService.attachStoredObject(
              tx,
              tenant,
              {
                storedObjectId: att.storedObjectId,
                documentType: att.documentType,
                caption: att.caption,
                target: { goodsReceiptLineId: existingLine.id },
              },
              ipAddress,
            );
          }
        }
      }

      if (input.attachments?.length) {
        for (const att of input.attachments) {
          await this.attachmentsService.attachStoredObject(
            tx,
            tenant,
            {
              storedObjectId: att.storedObjectId,
              documentType: att.documentType,
              caption: att.caption,
              target: { goodsReceiptId: delivery.id },
            },
            ipAddress,
          );
        }
      }

      const refreshedLines = await tx.goodsReceiptLine.findMany({
        where: { organizationId, goodsReceiptId: delivery.id },
      });
      const allInspected = refreshedLines.every(
        (l) => l.qcStatus !== DeliveryLineQcStatus.PENDING,
      );
      const nextStatus = allInspected
        ? GoodsReceiptStatus.QC_COMPLETED
        : GoodsReceiptStatus.QC_IN_PROGRESS;

      const updatedDelivery = await tx.goodsReceipt.update({
        where: { id: delivery.id },
        data: {
          status: nextStatus,
          qcStartedAt: delivery.qcStartedAt ?? now,
          ...(allInspected ? { qcCompletedAt: now } : {}),
          qcByUserId: tenant.userId,
          ...(input.qcNotes !== undefined
            ? { qcNotes: input.qcNotes?.trim() || null }
            : {}),
        },
        include: this.deliveryInclude(),
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "delivery.qc_recorded",
          resourceType: "GoodsReceipt",
          resourceId: delivery.id,
          metadata: {
            receiptNumber: delivery.receiptNumber,
            nextStatus,
            inspectedLineCount: input.lines.length,
            allInspected,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return this.formatDeliveryResponse(updatedDelivery);
    });

    this.analyticsService.captureDomainEvent({
      event: "delivery.qc_inspected",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        delivery_id: result.id,
        receipt_number: result.receiptNumber,
        status: result.status,
        inspected_line_count: input.lines.length,
      },
    });

    return result;
  }

  async acceptDelivery(
    tenant: AuthenticatedTenant,
    deliveryId: string,
    input: AcceptDeliveryInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const result = await this.prismaService.raw.$transaction(async (tx) => {
      const delivery = await tx.goodsReceipt.findFirst({
        where: { id: deliveryId, organizationId },
        include: {
          purchaseOrder: {
            include: { supplier: true },
          },
          location: true,
          lines: {
            include: {
              item: true,
              pack: true,
              purchaseOrderLine: true,
              documentAttachments: true,
            },
          },
        },
      });

      if (!delivery) {
        throw new NotFoundException("Supplier delivery was not found.");
      }

      if (
        delivery.status !== GoodsReceiptStatus.QC_COMPLETED &&
        delivery.status !== GoodsReceiptStatus.QC_IN_PROGRESS
      ) {
        throw new BadRequestException(
          `Delivery must finish QC before acceptance (current status: ${delivery.status}).`,
        );
      }

      const pendingLines = delivery.lines.filter(
        (l) => l.qcStatus === DeliveryLineQcStatus.PENDING,
      );
      if (pendingLines.length > 0) {
        throw new BadRequestException(
          `Cannot accept delivery while ${pendingLines.length} line(s) still have PENDING QC status.`,
        );
      }

      const targetLocationId = input.locationId ?? delivery.locationId;
      const location = await tx.location.findFirst({
        where: { id: targetLocationId, organizationId },
      });
      if (!location || location.status !== LocationStatus.ACTIVE) {
        throw new BadRequestException(
          "Destination stock location must exist and be ACTIVE.",
        );
      }

      const claimed = await tx.goodsReceipt.updateMany({
        where: {
          id: delivery.id,
          organizationId,
          status: delivery.status,
        },
        data: {
          locationId: location.id,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          "Delivery state changed concurrently. Refresh and retry.",
        );
      }

      const now = new Date();
      let totalAcceptedBase = 0;
      let totalRejectedBase = 0;
      let totalQuarantinedBase = 0;

      for (const line of delivery.lines) {
        const effectiveQuarantinedBase =
          line.quarantinedBaseQty +
          (line.rejectionDisposition === RejectionDisposition.QUARANTINE
            ? line.rejectedBaseQty
            : 0);

        const nonQuarantineRejectedBase =
          line.rejectionDisposition === RejectionDisposition.QUARANTINE
            ? 0
            : line.rejectedBaseQty;

        totalAcceptedBase += line.acceptedBaseQty;
        totalRejectedBase += nonQuarantineRejectedBase;
        totalQuarantinedBase += effectiveQuarantinedBase;

        // 1. Create StockLot linked to supplier, supplier item, and supplier batch
        let stockLotId: string | null = null;
        const hasTraceability =
          Boolean(line.lotNumber) ||
          Boolean(line.batchCode) ||
          Boolean(line.supplierBatchNumber) ||
          Boolean(line.expiresAt) ||
          Boolean(line.serialNumbers);

        if (
          ((line.item.trackInventory || hasTraceability || line.item.trackExpiry) &&
            (line.acceptedBaseQty > 0 || effectiveQuarantinedBase > 0)) ||
          effectiveQuarantinedBase > 0
        ) {
          const computedExpiresAt =
            line.expiresAt ??
            (line.item.trackExpiry
              ? computeExpiresAtFromShelfLife(
                  line.manufacturedAt ?? delivery.deliveredAt ?? new Date(),
                  line.item.shelfLifeDays,
                )
              : null);

          const lot = await tx.stockLot.create({
            data: {
              organizationId,
              itemId: line.itemId,
              locationId: location.id,
              supplierId: delivery.purchaseOrder.supplierId,
              supplierItemId: line.supplierItemId ?? null,
              supplierSku: line.purchaseOrderLine.supplierSku ?? null,
              supplierBatchNumber:
                line.supplierBatchNumber ?? line.batchCode ?? null,
              goodsReceiptLineId: line.id,
              lotNumber:
                line.lotNumber ||
                `${delivery.receiptNumber}-${line.item.sku}`.slice(0, 80),
              batchCode: line.batchCode ?? null,
              manufacturedAt: line.manufacturedAt ?? null,
              expiresAt: computedExpiresAt,
              serialNumbers:
                line.serialNumbers === null
                  ? Prisma.DbNull
                  : (line.serialNumbers as Prisma.InputJsonValue),
              initialQty: line.acceptedBaseQty + effectiveQuarantinedBase,
              onHandQty: line.acceptedBaseQty,
              quarantinedQty: effectiveQuarantinedBase,
              consumedQty: 0,
              unitCostCents: computeBaseUnitValueCents(
                line.unitCostCents,
                line.unitsPerPack,
                1,
              ),
            },
          });
          stockLotId = lot.id;

          // Auto-propagate line attachments (e.g., CoAs, QC photos) onto the created StockLot
          if (line.documentAttachments?.length) {
            for (const att of line.documentAttachments) {
              await tx.documentAttachment.create({
                data: {
                  organizationId,
                  storedObjectId: att.storedObjectId,
                  documentType: att.documentType,
                  caption: att.caption,
                  stockLotId: lot.id,
                  uploadedByUserId: att.uploadedByUserId ?? tenant.userId,
                },
              });
            }
          }
        }

        // 2. Credit sellable stock ONLY for acceptedBaseQty
        if (line.acceptedBaseQty > 0 && line.item.trackInventory) {
          const bal = await tx.stockBalance.upsert({
            where: {
              organizationId_itemId_locationId: {
                organizationId,
                itemId: line.itemId,
                locationId: location.id,
              },
            },
            create: {
              organizationId,
              itemId: line.itemId,
              locationId: location.id,
              onHandQty: line.acceptedBaseQty,
              reservedQty: 0,
            },
            update: {
              onHandQty: { increment: line.acceptedBaseQty },
            },
          });

          const packText =
            line.unitsPerPack > 1
              ? ` (${decomposeBaseToBulk(line.acceptedBaseQty, line.unitsPerPack, line.pack?.unitOfMeasure ?? line.pack?.name, line.item.unitOfMeasure).formattedSummary})`
              : "";

          await tx.stockMovement.create({
            data: {
              organizationId,
              itemId: line.itemId,
              locationId: location.id,
              type: StockMovementType.RECEIPT,
              quantityDelta: line.acceptedBaseQty,
              balanceAfter: bal.onHandQty,
              stockLotId,
              referenceType: "GoodsReceipt",
              referenceId: delivery.id,
              reason: `QC accepted delivery ${delivery.receiptNumber} for PO ${delivery.purchaseOrder.poNumber}${packText}`,
              actorUserId: tenant.userId,
            },
          });
        }

        // 3. Create QuarantineHold for quarantined units
        if (effectiveQuarantinedBase > 0) {
          await tx.quarantineHold.create({
            data: {
              organizationId,
              goodsReceiptId: delivery.id,
              goodsReceiptLineId: line.id,
              itemId: line.itemId,
              locationId: location.id,
              stockLotId,
              quantityBase: effectiveQuarantinedBase,
              resolvedBaseQty: 0,
              status: QuarantineStatus.OPEN,
              reasonCode: line.defectReasonCode ?? null,
              notes: line.qcNotes ?? null,
            },
          });
        }

        // 4. Create SupplierClaim when disposition is SUPPLIER_CLAIM
        let claimBaseIncrement = 0;
        if (
          nonQuarantineRejectedBase > 0 &&
          line.rejectionDisposition === RejectionDisposition.SUPPLIER_CLAIM
        ) {
          const claimAmountCents = computeBaseUnitValueCents(
            line.unitCostCents,
            line.unitsPerPack,
            nonQuarantineRejectedBase,
          );
          const claimNumber = `CLM-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

          await tx.supplierClaim.create({
            data: {
              organizationId,
              claimNumber,
              supplierId: delivery.purchaseOrder.supplierId,
              purchaseOrderId: delivery.purchaseOrderId,
              goodsReceiptId: delivery.id,
              goodsReceiptLineId: line.id,
              itemId: line.itemId,
              claimType: input.defaultClaimType ?? SupplierClaimType.CREDIT,
              status: SupplierClaimStatus.OPEN,
              rejectedBaseQty: nonQuarantineRejectedBase,
              claimAmountCents,
              currency: delivery.purchaseOrder.currency,
              reasonCode: line.defectReasonCode ?? null,
              notes: line.qcNotes ?? null,
              createdByUserId: tenant.userId,
            },
          });
          claimBaseIncrement = nonQuarantineRejectedBase;
        } else if (
          nonQuarantineRejectedBase > 0 &&
          line.rejectionDisposition === RejectionDisposition.SCRAP
        ) {
          claimBaseIncrement = nonQuarantineRejectedBase;
        }

        // 5. Update PurchaseOrderLine fulfillment counters
        const poLine = line.purchaseOrderLine;
        const nextAcceptedBase = poLine.acceptedBaseQty + line.acceptedBaseQty;
        const nextReceivedQty =
          poLine.unitsPerPack > 1
            ? Math.floor(nextAcceptedBase / poLine.unitsPerPack)
            : nextAcceptedBase;

        await tx.purchaseOrderLine.update({
          where: { id: poLine.id },
          data: {
            acceptedBaseQty: { increment: line.acceptedBaseQty },
            rejectedBaseQty: { increment: nonQuarantineRejectedBase },
            quarantinedBaseQty: { increment: effectiveQuarantinedBase },
            creditedClaimBaseQty: { increment: claimBaseIncrement },
            receivedBaseQty: { increment: line.acceptedBaseQty },
            receivedQty: nextReceivedQty,
          },
        });
      }

      const finalDeliveryStatus =
        totalAcceptedBase > 0 &&
        totalRejectedBase === 0 &&
        totalQuarantinedBase === 0
          ? GoodsReceiptStatus.ACCEPTED
          : totalAcceptedBase > 0 || totalQuarantinedBase > 0
            ? GoodsReceiptStatus.PARTIALLY_ACCEPTED
            : GoodsReceiptStatus.REJECTED;

      const updatedDelivery = await tx.goodsReceipt.update({
        where: { id: delivery.id },
        data: {
          status: finalDeliveryStatus,
          acceptedAt: now,
          acceptedByUserId: tenant.userId,
          acceptanceNotes: input.acceptanceNotes?.trim() || null,
        },
        include: {
          ...this.deliveryInclude(),
          quarantineHolds: true,
          supplierClaims: true,
        },
      });

      const updatedPo = await this.recomputePurchaseOrderStatus(
        tx,
        organizationId,
        delivery.purchaseOrderId,
        tenant.userId,
      );

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "delivery.accepted",
          resourceType: "GoodsReceipt",
          resourceId: delivery.id,
          metadata: {
            receiptNumber: delivery.receiptNumber,
            purchaseOrderId: delivery.purchaseOrderId,
            poNumber: delivery.purchaseOrder.poNumber,
            finalDeliveryStatus,
            nextPoStatus: updatedPo.status,
            totalAcceptedBase,
            totalRejectedBase,
            totalQuarantinedBase,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        delivery: this.formatDeliveryResponse(updatedDelivery),
        purchaseOrder: updatedPo,
      };
    });

    this.analyticsService.captureDomainEvent({
      event: "delivery.accepted",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        delivery_id: result.delivery.id,
        receipt_number: result.delivery.receiptNumber,
        status: result.delivery.status,
        purchase_order_id: result.purchaseOrder.id,
        next_po_status: result.purchaseOrder.status,
      },
    });

    return result;
  }

  async cancelDelivery(
    tenant: AuthenticatedTenant,
    deliveryId: string,
    reason?: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.goodsReceipt.findFirst({
        where: { id: deliveryId, organizationId },
      });

      if (!existing) {
        throw new NotFoundException("Supplier delivery was not found.");
      }
      if (!ACTIVE_STAGED_STATUSES.includes(existing.status)) {
        throw new BadRequestException(
          `Only staged unaccepted deliveries can be cancelled (current status: ${existing.status}).`,
        );
      }

      const claimed = await tx.goodsReceipt.updateMany({
        where: { id: deliveryId, organizationId, status: existing.status },
        data: {
          status: GoodsReceiptStatus.CANCELLED,
          cancelledAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          "Delivery state changed concurrently. Refresh and retry.",
        );
      }

      const cancelled = await tx.goodsReceipt.findFirstOrThrow({
        where: { id: deliveryId, organizationId },
        include: this.deliveryInclude(),
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "delivery.cancelled",
          resourceType: "GoodsReceipt",
          resourceId: cancelled.id,
          metadata: {
            receiptNumber: cancelled.receiptNumber,
            previousStatus: existing.status,
            ...(reason ? { reason } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return this.formatDeliveryResponse(cancelled);
    });
  }

  async listQuarantineHolds(
    tenant: AuthenticatedTenant,
    query: ListQuarantineQuery,
  ) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);

    const records = await this.prismaService.scoped.quarantineHold.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.itemId ? { itemId: query.itemId } : {}),
        ...(query.goodsReceiptId
          ? { goodsReceiptId: query.goodsReceiptId }
          : {}),
      },
      include: {
        item: { select: { id: true, sku: true, name: true, unitOfMeasure: true } },
        location: { select: { id: true, code: true, name: true } },
        goodsReceipt: {
          select: { id: true, receiptNumber: true, purchaseOrderId: true },
        },
        stockLot: {
          select: { id: true, lotNumber: true, batchCode: true, expiresAt: true },
        },
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
      items: items.map((h) => ({
        ...h,
        remainingBaseQty: Math.max(0, h.quantityBase - h.resolvedBaseQty),
      })),
      nextCursor,
    };
  }

  async resolveQuarantineHold(
    tenant: AuthenticatedTenant,
    holdId: string,
    input: ResolveQuarantineInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const hold = await tx.quarantineHold.findFirst({
        where: { id: holdId, organizationId },
        include: {
          item: true,
          location: true,
          goodsReceipt: {
            include: { purchaseOrder: true },
          },
          goodsReceiptLine: {
            include: { pack: true, purchaseOrderLine: true },
          },
          stockLot: true,
        },
      });

      if (!hold) {
        throw new NotFoundException("Quarantine hold was not found.");
      }
      if (hold.status !== QuarantineStatus.OPEN) {
        throw new BadRequestException(
          `Quarantine hold is already resolved (status: ${hold.status}).`,
        );
      }

      const remaining = Math.max(0, hold.quantityBase - hold.resolvedBaseQty);
      if (remaining <= 0) {
        throw new BadRequestException("Quarantine hold has no remaining units.");
      }

      const line = hold.goodsReceiptLine;
      const packLabel = line.pack?.unitOfMeasure ?? line.pack?.name ?? null;
      const requested =
        input.packQty !== undefined ||
        input.looseBaseQty !== undefined ||
        input.baseQty !== undefined
          ? normalizeBulkQuantity(input, {
              unitsPerPack: line.unitsPerPack,
              packLabel,
              baseLabel: hold.item.unitOfMeasure,
              allowZero: false,
              fieldLabel: "quarantine resolution quantity",
            }).totalBaseQty
          : remaining;

      if (requested > remaining) {
        throw new BadRequestException(
          `Cannot resolve ${requested} base units from quarantine hold (remaining: ${remaining}).`,
        );
      }

      const poLine = line.purchaseOrderLine;
      const now = new Date();
      let nextHoldStatus: QuarantineStatus = QuarantineStatus.OPEN;
      const nextResolvedQty = hold.resolvedBaseQty + requested;
      const fullyResolved = nextResolvedQty >= hold.quantityBase;

      if (input.resolution === "RELEASE_TO_STOCK") {
        nextHoldStatus = fullyResolved
          ? QuarantineStatus.RELEASED_TO_STOCK
          : QuarantineStatus.OPEN;

        if (hold.item.trackInventory) {
          const bal = await tx.stockBalance.upsert({
            where: {
              organizationId_itemId_locationId: {
                organizationId,
                itemId: hold.itemId,
                locationId: hold.locationId,
              },
            },
            create: {
              organizationId,
              itemId: hold.itemId,
              locationId: hold.locationId,
              onHandQty: requested,
              reservedQty: 0,
            },
            update: {
              onHandQty: { increment: requested },
            },
          });

          await tx.stockMovement.create({
            data: {
              organizationId,
              itemId: hold.itemId,
              locationId: hold.locationId,
              type: StockMovementType.RECEIPT,
              quantityDelta: requested,
              balanceAfter: bal.onHandQty,
              referenceType: "QuarantineHold",
              referenceId: hold.id,
              reason: `Released ${requested} base unit(s) from quarantine (${hold.goodsReceipt.receiptNumber})`,
              actorUserId: tenant.userId,
            },
          });
        }

        if (hold.stockLot) {
          await tx.stockLot.update({
            where: { id: hold.stockLot.id },
            data: {
              quarantinedQty: { decrement: Math.min(requested, hold.stockLot.quarantinedQty) },
              onHandQty: { increment: requested },
            },
          });
        }

        const nextAcceptedBase = poLine.acceptedBaseQty + requested;
        await tx.purchaseOrderLine.update({
          where: { id: poLine.id },
          data: {
            quarantinedBaseQty: {
              decrement: Math.min(requested, poLine.quarantinedBaseQty),
            },
            acceptedBaseQty: { increment: requested },
            receivedBaseQty: { increment: requested },
            receivedQty:
              poLine.unitsPerPack > 1
                ? Math.floor(nextAcceptedBase / poLine.unitsPerPack)
                : nextAcceptedBase,
          },
        });

        await tx.goodsReceiptLine.update({
          where: { id: line.id },
          data: {
            quarantinedBaseQty: {
              decrement: Math.min(requested, line.quarantinedBaseQty),
            },
            acceptedBaseQty: { increment: requested },
          },
        });
      } else {
        if (hold.stockLot) {
          await tx.stockLot.update({
            where: { id: hold.stockLot.id },
            data: {
              quarantinedQty: { decrement: Math.min(requested, hold.stockLot.quarantinedQty) },
            },
          });
        }

        if (input.resolution === "RETURN_TO_SUPPLIER") {
          nextHoldStatus = fullyResolved
            ? QuarantineStatus.RETURNED_TO_SUPPLIER
            : QuarantineStatus.OPEN;

          await tx.purchaseOrderLine.update({
            where: { id: poLine.id },
            data: {
              quarantinedBaseQty: {
                decrement: Math.min(requested, poLine.quarantinedBaseQty),
              },
              rejectedBaseQty: { increment: requested },
            },
          });
        } else if (input.resolution === "SUPPLIER_CLAIM") {
          nextHoldStatus = fullyResolved
            ? QuarantineStatus.CLAIMED
            : QuarantineStatus.OPEN;

          const claimNumber = `CLM-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
          const claimAmountCents = computeBaseUnitValueCents(
            line.unitCostCents,
            line.unitsPerPack,
            requested,
          );

          await tx.supplierClaim.create({
            data: {
              organizationId,
              claimNumber,
              supplierId: hold.goodsReceipt.purchaseOrder.supplierId,
              purchaseOrderId: hold.goodsReceipt.purchaseOrderId,
              goodsReceiptId: hold.goodsReceiptId,
              goodsReceiptLineId: hold.goodsReceiptLineId,
              itemId: hold.itemId,
              claimType: input.claimType ?? SupplierClaimType.CREDIT,
              status: SupplierClaimStatus.OPEN,
              rejectedBaseQty: requested,
              claimAmountCents,
              currency: hold.goodsReceipt.purchaseOrder.currency,
              reasonCode: hold.reasonCode ?? null,
              notes: input.resolutionNotes?.trim() ?? hold.notes ?? null,
              createdByUserId: tenant.userId,
            },
          });

          await tx.purchaseOrderLine.update({
            where: { id: poLine.id },
            data: {
              quarantinedBaseQty: {
                decrement: Math.min(requested, poLine.quarantinedBaseQty),
              },
              rejectedBaseQty: { increment: requested },
              creditedClaimBaseQty: { increment: requested },
            },
          });
        } else {
          // SCRAP
          nextHoldStatus = fullyResolved
            ? QuarantineStatus.SCRAPPED
            : QuarantineStatus.OPEN;

          await tx.purchaseOrderLine.update({
            where: { id: poLine.id },
            data: {
              quarantinedBaseQty: {
                decrement: Math.min(requested, poLine.quarantinedBaseQty),
              },
              rejectedBaseQty: { increment: requested },
              creditedClaimBaseQty: { increment: requested },
            },
          });
        }
      }

      const updatedHold = await tx.quarantineHold.update({
        where: { id: hold.id },
        data: {
          resolvedBaseQty: nextResolvedQty,
          status: nextHoldStatus,
          resolutionNotes: input.resolutionNotes?.trim() ?? hold.resolutionNotes,
          ...(fullyResolved
            ? { resolvedByUserId: tenant.userId, resolvedAt: now }
            : {}),
        },
      });

      const updatedPo = await this.recomputePurchaseOrderStatus(
        tx,
        organizationId,
        hold.goodsReceipt.purchaseOrderId,
        tenant.userId,
      );

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "quarantine.resolved",
          resourceType: "QuarantineHold",
          resourceId: hold.id,
          metadata: {
            resolution: input.resolution,
            resolvedQtyBase: requested,
            nextStatus: nextHoldStatus,
            purchaseOrderId: updatedPo.id,
            nextPoStatus: updatedPo.status,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        quarantineHold: {
          ...updatedHold,
          remainingBaseQty: Math.max(
            0,
            updatedHold.quantityBase - updatedHold.resolvedBaseQty,
          ),
        },
        purchaseOrder: updatedPo,
      };
    });
  }

  async listSupplierClaims(
    tenant: AuthenticatedTenant,
    query: ListClaimsQuery,
  ) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);

    const records = await this.prismaService.scoped.supplierClaim.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
        ...(query.purchaseOrderId
          ? { purchaseOrderId: query.purchaseOrderId }
          : {}),
      },
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        purchaseOrder: { select: { id: true, poNumber: true, status: true } },
        item: { select: { id: true, sku: true, name: true, unitOfMeasure: true } },
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

  async updateSupplierClaim(
    tenant: AuthenticatedTenant,
    claimId: string,
    input: UpdateClaimInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.supplierClaim.findFirst({
        where: { id: claimId, organizationId },
      });

      if (!existing) {
        throw new NotFoundException("Supplier claim was not found.");
      }

      const isClosingStatus =
        input.status === SupplierClaimStatus.CREDITED ||
        input.status === SupplierClaimStatus.REPLACED ||
        input.status === SupplierClaimStatus.CLOSED;

      const updated = await tx.supplierClaim.update({
        where: { id: claimId },
        data: {
          status: input.status,
          ...(input.claimAmountCents !== undefined
            ? { claimAmountCents: input.claimAmountCents }
            : {}),
          ...(input.resolutionNotes !== undefined
            ? { resolutionNotes: input.resolutionNotes?.trim() || null }
            : {}),
          ...(isClosingStatus
            ? { resolvedByUserId: tenant.userId, resolvedAt: new Date() }
            : {}),
        },
        include: {
          supplier: { select: { id: true, code: true, name: true } },
          purchaseOrder: { select: { id: true, poNumber: true } },
          item: { select: { id: true, sku: true, name: true } },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "supplier_claim.updated",
          resourceType: "SupplierClaim",
          resourceId: updated.id,
          metadata: {
            claimNumber: updated.claimNumber,
            previousStatus: existing.status,
            nextStatus: updated.status,
            claimAmountCents: updated.claimAmountCents,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  private async recomputePurchaseOrderStatus(
    tx: Prisma.TransactionClient,
    organizationId: string,
    purchaseOrderId: string,
    actorUserId: string,
  ) {
    const [poLines, pendingStagedCount] = await Promise.all([
      tx.purchaseOrderLine.findMany({
        where: { organizationId, purchaseOrderId },
      }),
      tx.goodsReceipt.count({
        where: {
          organizationId,
          purchaseOrderId,
          status: { in: ACTIVE_STAGED_STATUSES },
        },
      }),
    ]);

    const allClosed =
      pendingStagedCount === 0 &&
      poLines.every((l) => computePoLineCapacity(l, 0).openBaseQty === 0);

    const anyProgress = poLines.some(
      (l) =>
        l.acceptedBaseQty > 0 ||
        l.creditedClaimBaseQty > 0 ||
        l.quarantinedBaseQty > 0,
    );

    const nextPoStatus = allClosed
      ? PurchaseOrderStatus.RECEIVED
      : anyProgress
        ? PurchaseOrderStatus.PARTIALLY_RECEIVED
        : PurchaseOrderStatus.SUBMITTED;

    return tx.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: {
        status: nextPoStatus,
        updatedByUserId: actorUserId,
      },
    });
  }

  async listFiles(tenant: AuthenticatedTenant, deliveryId: string) {
    this.resolveVerifiedOrganizationId(tenant);
    return this.attachmentsService.listForDelivery(tenant, deliveryId);
  }

  async addDeliveryFile(
    tenant: AuthenticatedTenant,
    deliveryId: string,
    req: FastifyRequest,
    body: unknown,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing = await this.prismaService.scoped.goodsReceipt.findFirst({
      where: { id: deliveryId, organizationId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException("Supplier delivery was not found.");
    }

    return this.attachmentsService.handleUploadOrLinkRequest(tenant, req, body, {
      entityType: StorageEntityType.GOODS_RECEIPT,
      entityId: deliveryId,
      target: { goodsReceiptId: deliveryId },
    });
  }

  async addDeliveryLineFile(
    tenant: AuthenticatedTenant,
    deliveryId: string,
    lineId: string,
    req: FastifyRequest,
    body: unknown,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const line = await this.prismaService.scoped.goodsReceiptLine.findFirst({
      where: { id: lineId, goodsReceiptId: deliveryId, organizationId },
      select: { id: true },
    });
    if (!line) {
      throw new NotFoundException(
        "Supplier delivery line was not found on this delivery.",
      );
    }

    return this.attachmentsService.handleUploadOrLinkRequest(tenant, req, body, {
      entityType: StorageEntityType.GOODS_RECEIPT_LINE,
      entityId: lineId,
      target: { goodsReceiptLineId: lineId },
    });
  }

  async removeDeliveryFile(
    tenant: AuthenticatedTenant,
    deliveryId: string,
    attachmentId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing = await this.prismaService.scoped.goodsReceipt.findFirst({
      where: { id: deliveryId, organizationId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException("Supplier delivery was not found.");
    }

    return this.attachmentsService.removeAttachment(
      tenant,
      attachmentId,
      {
        OR: [
          { goodsReceiptId: deliveryId },
          { goodsReceiptLine: { goodsReceiptId: deliveryId } },
        ],
      },
      ipAddress,
    );
  }

  private deliveryInclude() {
    return {
      purchaseOrder: {
        select: {
          id: true,
          poNumber: true,
          status: true,
          currency: true,
          supplier: { select: { id: true, code: true, name: true } },
        },
      },
      location: { select: { id: true, code: true, name: true, type: true } },
      documentAttachments: {
        include: {
          storedObject: { select: STORED_OBJECT_SUMMARY_SELECT },
        },
        orderBy: { createdAt: "desc" },
      },
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
          supplierItem: {
            select: {
              id: true,
              supplierSku: true,
              unitCostCents: true,
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
          documentAttachments: {
            include: {
              storedObject: { select: STORED_OBJECT_SUMMARY_SELECT },
            },
            orderBy: { createdAt: "desc" },
          },
        },
      },
    } as const;
  }

  private formatDeliveryResponse<
    T extends {
      documentAttachments?: Array<{
        storedObject?: {
          id: string;
          originalName: string;
          mimeType: string;
          sizeBytes: bigint | number;
          status: any;
          entityType: any;
          entityId: string | null;
          createdAt: Date;
        } | null;
      }>;
      lines: Array<{
        unitsPerPack: number;
        receivedBaseQty: number;
        acceptedBaseQty: number;
        rejectedBaseQty: number;
        quarantinedBaseQty: number;
        billedBaseQty: number;
        item?: { unitOfMeasure?: string | null } | null;
        pack?: { unitOfMeasure?: string | null; name?: string | null } | null;
        documentAttachments?: Array<{
          storedObject?: {
            id: string;
            originalName: string;
            mimeType: string;
            sizeBytes: bigint | number;
            status: any;
            entityType: any;
            entityId: string | null;
            createdAt: Date;
          } | null;
        }>;
      }>;
    },
  >(delivery: T) {
    return {
      ...delivery,
      ...(delivery.documentAttachments
        ? {
            documentAttachments: delivery.documentAttachments.map((a) =>
              this.attachmentsService.serializeAttachment(a),
            ),
          }
        : {}),
      lines: delivery.lines.map((line) => {
        const packLabel = line.pack?.unitOfMeasure ?? line.pack?.name ?? null;
        const baseLabel = line.item?.unitOfMeasure ?? "unit";
        return {
          ...line,
          ...(line.documentAttachments
            ? {
                documentAttachments: line.documentAttachments.map((a) =>
                  this.attachmentsService.serializeAttachment(a),
                ),
              }
            : {}),
          deliveredBreakdown: decomposeBaseToBulk(
            line.receivedBaseQty,
            line.unitsPerPack,
            packLabel,
            baseLabel,
          ),
          acceptedBreakdown: decomposeBaseToBulk(
            line.acceptedBaseQty,
            line.unitsPerPack,
            packLabel,
            baseLabel,
          ),
          billableRemainingBaseQty: Math.max(
            0,
            line.acceptedBaseQty - line.billedBaseQty,
          ),
        };
      }),
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

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  GoodsReceiptStatus,
  Prisma,
  SupplierStatus,
  OrganizationContext,
  VendorBillStatus,
} from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { computeBaseUnitValueCents } from "./delivery-units.utils.js";

export interface CreateVendorBillInput {
  billNumber: string;
  supplierId: string;
  purchaseOrderId?: string | null;
  goodsReceiptId?: string | null;
  status?: "DRAFT" | "OPEN";
  currency?: string;
  taxCents?: number;
  issuedAt?: string;
  dueAt?: string | null;
  notes?: string | null;
  lines: Array<{
    itemId?: string | null;
    goodsReceiptLineId?: string | null;
    description: string;
    quantity: number;
    baseQty?: number;
    unitCostCents: number;
  }>;
}

export interface CreateVendorBillFromDeliveryInput {
  billNumber: string;
  status?: "DRAFT" | "OPEN";
  taxCents?: number;
  issuedAt?: string;
  dueAt?: string | null;
  notes?: string | null;
}

export interface ListVendorBillsQuery {
  status?: VendorBillStatus;
  supplierId?: string;
  purchaseOrderId?: string;
  search?: string;
  limit: number;
  cursor?: string;
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
export class VendorBillsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  async createVendorBill(
    tenant: AuthenticatedOrganization,
    input: CreateVendorBillInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const billNumber = input.billNumber.trim();

    try {
      const created = await this.prismaService.raw.$transaction(async (tx) => {
        const supplier = await tx.supplier.findFirst({
          where: { id: input.supplierId, organizationId },
        });
        if (!supplier || supplier.status === SupplierStatus.ARCHIVED) {
          throw new BadRequestException(
            "Supplier must exist and not be archived.",
          );
        }

        let linkedPo: {
          id: string;
          supplierId: string;
          lines: Array<{
            id: string;
            itemId: string;
            acceptedBaseQty: number;
            billedBaseQty: number;
          }>;
        } | null = null;

        if (input.purchaseOrderId) {
          const po = await tx.purchaseOrder.findFirst({
            where: { id: input.purchaseOrderId, organizationId },
            include: {
              lines: {
                select: {
                  id: true,
                  itemId: true,
                  acceptedBaseQty: true,
                  billedBaseQty: true,
                },
              },
            },
          });
          if (!po) {
            throw new NotFoundException("Linked purchase order was not found.");
          }
          if (po.supplierId !== supplier.id) {
            throw new BadRequestException(
              "Linked purchase order belongs to a different supplier.",
            );
          }
          linkedPo = po;
        }

        let linkedReceipt: {
          id: string;
          purchaseOrderId: string;
          status: GoodsReceiptStatus;
          purchaseOrder: { supplierId: string };
          lines: Array<{
            id: string;
            purchaseOrderLineId: string;
            itemId: string;
            acceptedBaseQty: number;
            billedBaseQty: number;
          }>;
        } | null = null;

        if (input.goodsReceiptId) {
          const receipt = await tx.goodsReceipt.findFirst({
            where: { id: input.goodsReceiptId, organizationId },
            include: {
              purchaseOrder: { select: { supplierId: true } },
              lines: {
                select: {
                  id: true,
                  purchaseOrderLineId: true,
                  itemId: true,
                  acceptedBaseQty: true,
                  billedBaseQty: true,
                },
              },
            },
          });
          if (!receipt) {
            throw new NotFoundException("Linked goods receipt / delivery was not found.");
          }
          if (receipt.purchaseOrder.supplierId !== supplier.id) {
            throw new BadRequestException(
              "Linked delivery belongs to a different supplier.",
            );
          }
          if (
            input.purchaseOrderId &&
            receipt.purchaseOrderId !== input.purchaseOrderId
          ) {
            throw new BadRequestException(
              "Linked delivery does not match the specified purchase order.",
            );
          }
          if (
            receipt.status !== GoodsReceiptStatus.ACCEPTED &&
            receipt.status !== GoodsReceiptStatus.PARTIALLY_ACCEPTED
          ) {
            throw new BadRequestException(
              `Only QC-accepted deliveries can be billed (current delivery status: ${receipt.status}).`,
            );
          }
          linkedReceipt = receipt;
        }

        const itemIds = input.lines
          .map((l) => l.itemId)
          .filter((id): id is string => Boolean(id));
        if (itemIds.length > 0) {
          const foundItems = await tx.item.findMany({
            where: { organizationId, id: { in: itemIds } },
            select: { id: true },
          });
          const foundSet = new Set(foundItems.map((i) => i.id));
          for (const id of itemIds) {
            if (!foundSet.has(id)) {
              throw new NotFoundException(`Catalog item "${id}" was not found.`);
            }
          }
        }

        // Enforce accepted-only billing allocations when linked to a delivery or PO
        const receiptLineAllocations = new Map<string, number>();
        const poLineAllocations = new Map<string, number>();

        const builtLines = input.lines.map((line) => {
          const resolvedBaseQty = line.baseQty ?? line.quantity;

          if (linkedReceipt) {
            if (line.goodsReceiptLineId) {
              const rLine = linkedReceipt.lines.find(
                (rl) => rl.id === line.goodsReceiptLineId,
              );
              if (!rLine) {
                throw new BadRequestException(
                  `Delivery line "${line.goodsReceiptLineId}" does not belong to the linked delivery.`,
                );
              }
              const alreadyAllocated = receiptLineAllocations.get(rLine.id) ?? 0;
              const remaining = Math.max(
                0,
                rLine.acceptedBaseQty - rLine.billedBaseQty - alreadyAllocated,
              );
              if (resolvedBaseQty > remaining) {
                throw new BadRequestException(
                  `Cannot bill ${resolvedBaseQty} base unit(s) for "${line.description}" (remaining QC-accepted billable units: ${remaining}).`,
                );
              }
              receiptLineAllocations.set(rLine.id, alreadyAllocated + resolvedBaseQty);
              poLineAllocations.set(
                rLine.purchaseOrderLineId,
                (poLineAllocations.get(rLine.purchaseOrderLineId) ?? 0) +
                  resolvedBaseQty,
              );
            } else if (line.itemId) {
              const matchingLines = linkedReceipt.lines.filter(
                (rl) => rl.itemId === line.itemId,
              );
              if (matchingLines.length === 0) {
                throw new BadRequestException(
                  `Item "${line.itemId}" is not present on the linked delivery.`,
                );
              }
              let needed = resolvedBaseQty;
              for (const rLine of matchingLines) {
                if (needed <= 0) break;
                const alreadyAllocated = receiptLineAllocations.get(rLine.id) ?? 0;
                const avail = Math.max(
                  0,
                  rLine.acceptedBaseQty - rLine.billedBaseQty - alreadyAllocated,
                );
                if (avail > 0) {
                  const take = Math.min(needed, avail);
                  receiptLineAllocations.set(rLine.id, alreadyAllocated + take);
                  poLineAllocations.set(
                    rLine.purchaseOrderLineId,
                    (poLineAllocations.get(rLine.purchaseOrderLineId) ?? 0) + take,
                  );
                  needed -= take;
                }
              }
              if (needed > 0) {
                throw new BadRequestException(
                  `Cannot bill ${resolvedBaseQty} base unit(s) for "${line.description}" — exceeds QC-accepted unbilled quantity on this delivery.`,
                );
              }
            }
          } else if (linkedPo && line.itemId) {
            const matchingPoLines = linkedPo.lines.filter(
              (pl) => pl.itemId === line.itemId,
            );
            if (matchingPoLines.length > 0) {
              let needed = resolvedBaseQty;
              for (const pl of matchingPoLines) {
                if (needed <= 0) break;
                const alreadyAllocated = poLineAllocations.get(pl.id) ?? 0;
                const avail = Math.max(
                  0,
                  pl.acceptedBaseQty - pl.billedBaseQty - alreadyAllocated,
                );
                if (avail > 0) {
                  const take = Math.min(needed, avail);
                  poLineAllocations.set(pl.id, alreadyAllocated + take);
                  needed -= take;
                }
              }
              if (needed > 0) {
                throw new BadRequestException(
                  `Cannot bill ${resolvedBaseQty} base unit(s) for "${line.description}" — exceeds QC-accepted unbilled quantity on this purchase order.`,
                );
              }
            }
          }

          return {
            organizationId,
            itemId: line.itemId ?? null,
            goodsReceiptLineId: line.goodsReceiptLineId ?? null,
            description: line.description.trim(),
            quantity: line.quantity,
            baseQty: resolvedBaseQty,
            unitCostCents: line.unitCostCents,
            lineTotalCents: line.quantity * line.unitCostCents,
          };
        });

        const subtotalCents = builtLines.reduce(
          (sum, l) => sum + l.lineTotalCents,
          0,
        );
        const taxCents = input.taxCents ?? 0;
        const totalCents = subtotalCents + taxCents;

        const issuedAt = input.issuedAt ? new Date(input.issuedAt) : new Date();
        const dueAt = input.dueAt
          ? new Date(input.dueAt)
          : new Date(
              issuedAt.getTime() + supplier.paymentTermsDays * 86_400_000,
            );

        const created = await tx.vendorBill.create({
          data: {
            organizationId,
            billNumber,
            supplierId: supplier.id,
            purchaseOrderId:
              input.purchaseOrderId ?? linkedReceipt?.purchaseOrderId ?? null,
            goodsReceiptId: input.goodsReceiptId ?? null,
            status: input.status ?? VendorBillStatus.OPEN,
            currency: input.currency ?? supplier.currency,
            subtotalCents,
            taxCents,
            totalCents,
            paidAmountCents: 0,
            issuedAt,
            dueAt,
            notes: input.notes ?? null,
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
            lines: { create: builtLines },
          },
          include: {
            supplier: { select: { id: true, code: true, name: true } },
            lines: true,
          },
        });

        for (const [rLineId, qty] of receiptLineAllocations.entries()) {
          await tx.goodsReceiptLine.update({
            where: { id: rLineId },
            data: { billedBaseQty: { increment: qty } },
          });
        }

        for (const [poLineId, qty] of poLineAllocations.entries()) {
          await tx.purchaseOrderLine.update({
            where: { id: poLineId },
            data: { billedBaseQty: { increment: qty } },
          });
        }

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "vendor_bill.created",
            resourceType: "VendorBill",
            resourceId: created.id,
            metadata: {
              billNumber: created.billNumber,
              supplierCode: supplier.code,
              status: created.status,
              totalCents: created.totalCents,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return created;
      });

      this.analyticsService.captureDomainEvent({
        event: "vendor_bill.created",
        distinctId: tenant.userId,
        organizationId,
        properties: {
          vendor_bill_id: created.id,
          bill_number: created.billNumber,
          status: created.status,
          currency: created.currency,
          total_cents: created.totalCents,
        },
      });

      return created;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `Bill number "${billNumber}" already exists for this supplier.`,
        );
      }
      throw error;
    }
  }

  async createVendorBillFromDelivery(
    tenant: AuthenticatedOrganization,
    deliveryId: string,
    input: CreateVendorBillFromDeliveryInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const billNumber = input.billNumber.trim();

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        const delivery = await tx.goodsReceipt.findFirst({
          where: { id: deliveryId, organizationId },
          include: {
            purchaseOrder: {
              include: { supplier: true },
            },
            lines: {
              include: {
                item: { select: { id: true, sku: true, name: true, unitOfMeasure: true } },
              },
            },
          },
        });

        if (!delivery) {
          throw new NotFoundException("Supplier delivery was not found.");
        }

        if (
          delivery.status !== GoodsReceiptStatus.ACCEPTED &&
          delivery.status !== GoodsReceiptStatus.PARTIALLY_ACCEPTED
        ) {
          throw new BadRequestException(
            `Only QC-accepted deliveries can be converted into a vendor bill (current status: ${delivery.status}).`,
          );
        }

        const billableLines = delivery.lines
          .map((line) => ({
            line,
            billableBaseQty: Math.max(0, line.acceptedBaseQty - line.billedBaseQty),
          }))
          .filter((entry) => entry.billableBaseQty > 0);

        if (billableLines.length === 0) {
          throw new BadRequestException(
            "This delivery has no unbilled QC-accepted quantities remaining.",
          );
        }

        const builtLines = billableLines.map(({ line, billableBaseQty }) => {
          const lineTotalCents = computeBaseUnitValueCents(
            line.unitCostCents,
            line.unitsPerPack,
            billableBaseQty,
          );
          const perBaseUnitCostCents = Math.round(
            lineTotalCents / Math.max(1, billableBaseQty),
          );
          return {
            organizationId,
            itemId: line.itemId,
            goodsReceiptLineId: line.id,
            description: `${line.item.name} (${line.item.sku}) - ${billableBaseQty} ${line.item.unitOfMeasure} accepted`,
            quantity: billableBaseQty,
            baseQty: billableBaseQty,
            unitCostCents: perBaseUnitCostCents,
            lineTotalCents,
          };
        });

        const subtotalCents = builtLines.reduce(
          (sum, l) => sum + l.lineTotalCents,
          0,
        );
        const taxCents = input.taxCents ?? 0;
        const totalCents = subtotalCents + taxCents;

        const supplier = delivery.purchaseOrder.supplier;
        const issuedAt = input.issuedAt ? new Date(input.issuedAt) : new Date();
        const dueAt = input.dueAt
          ? new Date(input.dueAt)
          : new Date(
              issuedAt.getTime() + supplier.paymentTermsDays * 86_400_000,
            );

        const created = await tx.vendorBill.create({
          data: {
            organizationId,
            billNumber,
            supplierId: supplier.id,
            purchaseOrderId: delivery.purchaseOrderId,
            goodsReceiptId: delivery.id,
            status: input.status ?? VendorBillStatus.OPEN,
            currency: delivery.purchaseOrder.currency,
            subtotalCents,
            taxCents,
            totalCents,
            paidAmountCents: 0,
            issuedAt,
            dueAt,
            notes: input.notes ?? null,
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
            lines: { create: builtLines },
          },
          include: {
            supplier: { select: { id: true, code: true, name: true } },
            lines: true,
          },
        });

        for (const { line, billableBaseQty } of billableLines) {
          await tx.goodsReceiptLine.update({
            where: { id: line.id },
            data: { billedBaseQty: { increment: billableBaseQty } },
          });
          await tx.purchaseOrderLine.update({
            where: { id: line.purchaseOrderLineId },
            data: { billedBaseQty: { increment: billableBaseQty } },
          });
        }

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "vendor_bill.created_from_delivery",
            resourceType: "VendorBill",
            resourceId: created.id,
            metadata: {
              billNumber: created.billNumber,
              deliveryId: delivery.id,
              receiptNumber: delivery.receiptNumber,
              purchaseOrderId: delivery.purchaseOrderId,
              totalCents: created.totalCents,
              lineCount: builtLines.length,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return created;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `Bill number "${billNumber}" already exists for this supplier.`,
        );
      }
      throw error;
    }
  }

  async listVendorBills(
    tenant: AuthenticatedOrganization,
    query: ListVendorBillsQuery,
  ) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const records = await this.prismaService.scoped.vendorBill.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
        ...(query.purchaseOrderId
          ? { purchaseOrderId: query.purchaseOrderId }
          : {}),
        ...(search
          ? { billNumber: { contains: search, mode: "insensitive" } }
          : {}),
      },
      include: {
        supplier: { select: { id: true, code: true, name: true } },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    });

    const hasMore = records.length > take;
    const items = hasMore ? records.slice(0, take) : records;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return {
      organizationId: tenant.organizationId,
      items: items.map((b) => ({
        ...b,
        balanceDueCents: Math.max(0, b.totalCents - b.paidAmountCents),
      })),
      nextCursor,
    };
  }

  async getVendorBill(tenant: AuthenticatedOrganization, billId: string) {
    this.resolveVerifiedOrganizationId(tenant);

    const bill = await this.prismaService.scoped.vendorBill.findUnique({
      where: { id: billId },
      include: {
        supplier: { select: { id: true, code: true, name: true, email: true } },
        purchaseOrder: { select: { id: true, poNumber: true, status: true } },
        goodsReceipt: { select: { id: true, receiptNumber: true } },
        lines: {
          include: {
            item: { select: { id: true, sku: true, name: true } },
          },
        },
      },
    });

    if (!bill) {
      throw new NotFoundException("Vendor bill was not found.");
    }

    return {
      ...bill,
      balanceDueCents: Math.max(0, bill.totalCents - bill.paidAmountCents),
    };
  }

  async postVendorBill(
    tenant: AuthenticatedOrganization,
    billId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const posted = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.vendorBill.findFirst({
        where: { id: billId, organizationId },
      });

      if (!existing) {
        throw new NotFoundException("Vendor bill was not found.");
      }
      if (existing.status !== VendorBillStatus.DRAFT) {
        throw new BadRequestException(
          `Only DRAFT vendor bills can be posted (current status: ${existing.status}).`,
        );
      }

      const claimed = await tx.vendorBill.updateMany({
        where: { id: billId, organizationId, status: VendorBillStatus.DRAFT },
        data: {
          status: VendorBillStatus.OPEN,
          updatedByUserId: tenant.userId,
        },
      });

      if (claimed.count !== 1) {
        throw new ConflictException(
          "Vendor bill state changed concurrently. Refresh and retry.",
        );
      }

      const posted = await tx.vendorBill.findFirstOrThrow({
        where: { id: billId, organizationId },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "vendor_bill.posted",
          resourceType: "VendorBill",
          resourceId: posted.id,
          metadata: {
            billNumber: posted.billNumber,
            totalCents: posted.totalCents,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return posted;
    });

    this.analyticsService.captureDomainEvent({
      event: "vendor_bill.posted",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        vendor_bill_id: posted.id,
        bill_number: posted.billNumber,
        currency: posted.currency,
        total_cents: posted.totalCents,
      },
    });

    return posted;
  }

  async recordPayment(
    tenant: AuthenticatedOrganization,
    billId: string,
    amountCents: number,
    reference?: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const result = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.vendorBill.findFirst({
        where: { id: billId, organizationId },
      });

      if (!existing) {
        throw new NotFoundException("Vendor bill was not found.");
      }

      if (
        existing.status !== VendorBillStatus.OPEN &&
        existing.status !== VendorBillStatus.PARTIALLY_PAID
      ) {
        throw new BadRequestException(
          `Payments can only be recorded on OPEN or PARTIALLY_PAID bills (current status: ${existing.status}).`,
        );
      }

      const remainingCents = existing.totalCents - existing.paidAmountCents;
      if (amountCents > remainingCents) {
        throw new BadRequestException(
          `Payment amount (${amountCents}) exceeds remaining balance due (${remainingCents}).`,
        );
      }

      const nextPaidAmount = existing.paidAmountCents + amountCents;
      const nextStatus =
        nextPaidAmount >= existing.totalCents
          ? VendorBillStatus.PAID
          : VendorBillStatus.PARTIALLY_PAID;

      const claimed = await tx.vendorBill.updateMany({
        where: {
          id: billId,
          organizationId,
          paidAmountCents: existing.paidAmountCents,
        },
        data: {
          paidAmountCents: nextPaidAmount,
          status: nextStatus,
          ...(nextStatus === VendorBillStatus.PAID ? { paidAt: new Date() } : {}),
          updatedByUserId: tenant.userId,
        },
      });

      if (claimed.count !== 1) {
        throw new ConflictException(
          "Vendor bill balance changed concurrently. Refresh and retry.",
        );
      }

      const updated = await tx.vendorBill.findFirstOrThrow({
        where: { id: billId, organizationId },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "vendor_bill.payment_recorded",
          resourceType: "VendorBill",
          resourceId: updated.id,
          metadata: {
            billNumber: updated.billNumber,
            amountCents,
            paidAmountCents: updated.paidAmountCents,
            totalCents: updated.totalCents,
            status: updated.status,
            ...(reference ? { reference } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        ...updated,
        balanceDueCents: Math.max(
          0,
          updated.totalCents - updated.paidAmountCents,
        ),
      };
    });

    this.analyticsService.captureDomainEvent({
      event: "vendor_bill.paid",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        vendor_bill_id: result.id,
        bill_number: result.billNumber,
        status: result.status,
        currency: result.currency,
        amount_paid_cents: amountCents,
        total_cents: result.totalCents,
      },
    });

    return result;
  }

  async voidVendorBill(
    tenant: AuthenticatedOrganization,
    billId: string,
    reason?: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.vendorBill.findFirst({
        where: { id: billId, organizationId },
      });

      if (!existing) {
        throw new NotFoundException("Vendor bill was not found.");
      }
      if (existing.status === VendorBillStatus.VOID) {
        throw new BadRequestException("Vendor bill is already voided.");
      }
      if (existing.paidAmountCents > 0) {
        throw new BadRequestException(
          "Cannot void a vendor bill that has recorded payments.",
        );
      }

      const claimed = await tx.vendorBill.updateMany({
        where: {
          id: billId,
          organizationId,
          status: existing.status,
          paidAmountCents: 0,
        },
        data: {
          status: VendorBillStatus.VOID,
          voidedAt: new Date(),
          updatedByUserId: tenant.userId,
        },
      });

      if (claimed.count !== 1) {
        throw new ConflictException(
          "Vendor bill state changed concurrently. Refresh and retry.",
        );
      }

      const voided = await tx.vendorBill.findFirstOrThrow({
        where: { id: billId, organizationId },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "vendor_bill.voided",
          resourceType: "VendorBill",
          resourceId: voided.id,
          metadata: {
            billNumber: voided.billNumber,
            previousStatus: existing.status,
            ...(reason ? { reason } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return voided;
    });
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedOrganization): string {
    const contextOrgId = OrganizationContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active organization context mismatch.");
    }
    return tenant.organizationId;
  }
}

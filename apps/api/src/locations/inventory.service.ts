import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ItemStatus,
  ItemType,
  ItemVariantKind,
  LocationStatus,
  LotAllocationStrategy,
  Prisma,
  StockMovementType,
  StockTransferStatus,
  StorageEntityType,
  OrganizationContext,
} from "@scace/db";
import type { FastifyRequest } from "fastify";
import { PrismaService } from "../database/prisma.service.js";
import {
  type BulkQuantityInput,
  decomposeBaseToBulk,
  normalizeBulkQuantity,
} from "../procurement/delivery-units.utils.js";
import {
  AttachmentsService,
  STORED_OBJECT_SUMMARY_SELECT,
} from "../storage/attachments.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import {
  allocateAndDeductLotsInTx,
  recordAllocatedStockMovementsInTx,
} from "./lot-allocation.utils.js";

export interface ListBalancesQuery {
  locationId?: string;
  itemId?: string;
  lowStockOnly?: boolean;
  limit: number;
  cursor?: string;
}

export interface ListMovementsQuery {
  locationId?: string;
  itemId?: string;
  type?: StockMovementType;
  limit: number;
  cursor?: string;
}

export interface ListLotsQuery {
  locationId?: string;
  itemId?: string;
  supplierId?: string;
  supplierItemId?: string;
  supplierBatchNumber?: string;
  itemType?: ItemType;
  lotNumber?: string;
  expiringBefore?: string;
  includeZero?: boolean;
  limit: number;
  cursor?: string;
}

export interface SuggestLotsInput extends BulkQuantityInput {
  itemId: string;
  locationId: string;
  strategy?: "FEFO" | "FIFO";
  packId?: string | null;
  includeExpired?: boolean;
}

export interface AdjustStockInput {
  itemId: string;
  locationId: string;
  quantityDelta: number;
  reason: string;
}

export interface CreateTransferInput {
  transferNumber?: string;
  fromLocationId: string;
  toLocationId: string;
  notes?: string;
  lines: Array<{ itemId: string; quantity: number }>;
}

export interface ListTransfersQuery {
  status?: StockTransferStatus;
  fromLocationId?: string;
  toLocationId?: string;
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
export class InventoryService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(AttachmentsService)
    private readonly attachmentsService: AttachmentsService,
  ) {}

  async listBalances(tenant: AuthenticatedOrganization, query: ListBalancesQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);

    const records = await this.prismaService.scoped.stockBalance.findMany({
      where: {
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.itemId ? { itemId: query.itemId } : {}),
      },
      include: {
        item: {
          select: {
            id: true,
            sku: true,
            name: true,
            type: true,
            status: true,
            unitOfMeasure: true,
            reorderPoint: true,
            trackInventory: true,
            allowNegativeStock: true,
          },
        },
        location: {
          select: {
            id: true,
            code: true,
            name: true,
            type: true,
            status: true,
          },
        },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });

    const filtered = query.lowStockOnly
      ? records.filter(
          (row) =>
            row.item.reorderPoint !== null &&
            row.onHandQty <= row.item.reorderPoint,
        )
      : records;

    const hasMore = filtered.length > take;
    const sliced = hasMore ? filtered.slice(0, take) : filtered;
    const nextCursor = hasMore ? (sliced[sliced.length - 1]?.id ?? null) : null;

    return {
      organizationId: tenant.organizationId,
      items: sliced.map((row) => ({
        ...row,
        availableQty: row.onHandQty - row.reservedQty,
      })),
      nextCursor,
    };
  }

  async listMovements(tenant: AuthenticatedOrganization, query: ListMovementsQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);

    const records = await this.prismaService.scoped.stockMovement.findMany({
      where: {
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.itemId ? { itemId: query.itemId } : {}),
        ...(query.type ? { type: query.type } : {}),
      },
      include: {
        item: { select: { id: true, sku: true, name: true, unitOfMeasure: true } },
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

  async listLots(tenant: AuthenticatedOrganization, query: ListLotsQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const lotNumber = query.lotNumber?.trim();
    const supplierBatchNumber = query.supplierBatchNumber?.trim();

    const records = await this.prismaService.scoped.stockLot.findMany({
      where: {
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.itemId ? { itemId: query.itemId } : {}),
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
        ...(query.supplierItemId
          ? { supplierItemId: query.supplierItemId }
          : {}),
        ...(query.itemType ? { item: { type: query.itemType } } : {}),
        ...(lotNumber
          ? { lotNumber: { contains: lotNumber, mode: "insensitive" } }
          : {}),
        ...(supplierBatchNumber
          ? {
              supplierBatchNumber: {
                contains: supplierBatchNumber,
                mode: "insensitive",
              },
            }
          : {}),
        ...(query.expiringBefore
          ? { expiresAt: { lte: new Date(query.expiringBefore) } }
          : {}),
        ...(!query.includeZero
          ? { OR: [{ onHandQty: { gt: 0 } }, { quarantinedQty: { gt: 0 } }] }
          : {}),
      },
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
        location: { select: { id: true, code: true, name: true, type: true } },
        supplier: { select: { id: true, code: true, name: true } },
        supplierItem: {
          select: { id: true, supplierSku: true, unitCostCents: true },
        },
        documentAttachments: {
          include: {
            storedObject: { select: STORED_OBJECT_SUMMARY_SELECT },
          },
          orderBy: { createdAt: "desc" },
        },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ expiresAt: "asc" }, { createdAt: "desc" }],
    });

    const hasMore = records.length > take;
    const sliced = hasMore ? records.slice(0, take) : records;
    const nextCursor = hasMore ? (sliced[sliced.length - 1]?.id ?? null) : null;

    return {
      organizationId: tenant.organizationId,
      items: sliced.map((lot) => ({
        ...lot,
        documentAttachments: lot.documentAttachments.map((att) =>
          this.attachmentsService.serializeAttachment(att),
        ),
      })),
      nextCursor,
    };
  }

  async suggestLots(tenant: AuthenticatedOrganization, input: SuggestLotsInput) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const strategy = input.strategy ?? "FEFO";
    const includeExpired = input.includeExpired ?? false;

    const [item, location] = await Promise.all([
      this.prismaService.raw.item.findFirst({
        where: { id: input.itemId, organizationId },
      }),
      this.prismaService.raw.location.findFirst({
        where: { id: input.locationId, organizationId },
      }),
    ]);

    if (!item) {
      throw new NotFoundException("Catalog item was not found.");
    }
    if (!location) {
      throw new NotFoundException("Location was not found.");
    }

    let unitsPerPack = 1;
    let packLabel: string | null = null;
    if (input.packId) {
      const pack = await this.prismaService.raw.itemPack.findFirst({
        where: {
          id: input.packId,
          organizationId,
          itemId: item.id,
          isActive: true,
        },
      });
      if (!pack) {
        throw new BadRequestException(
          `Pack "${input.packId}" was not found or is inactive for SKU "${item.sku}".`,
        );
      }
      unitsPerPack = pack.unitsPerPack;
      packLabel = pack.unitOfMeasure ?? pack.name;
    }

    const normalized = normalizeBulkQuantity(input, {
      unitsPerPack,
      packLabel,
      baseLabel: item.unitOfMeasure,
      allowZero: false,
      fieldLabel: `lot suggestion for SKU "${item.sku}"`,
    });

    const now = new Date();
    const candidateLots = await this.prismaService.raw.stockLot.findMany({
      where: {
        organizationId,
        itemId: item.id,
        locationId: location.id,
        onHandQty: { gt: 0 },
        ...(!includeExpired
          ? { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
          : {}),
      },
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        supplierItem: { select: { id: true, supplierSku: true } },
      },
    });

    const sortedLots = [...candidateLots].sort((a, b) => {
      if (strategy === LotAllocationStrategy.FEFO) {
        const aExp = a.expiresAt ? a.expiresAt.getTime() : Number.POSITIVE_INFINITY;
        const bExp = b.expiresAt ? b.expiresAt.getTime() : Number.POSITIVE_INFINITY;
        if (aExp !== bExp) {
          return aExp - bExp;
        }
      }
      const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return a.id.localeCompare(b.id);
    });

    let remaining = normalized.totalBaseQty;
    const allocations: Array<{
      stockLotId: string;
      lotNumber: string;
      batchCode: string | null;
      supplierBatchNumber: string | null;
      supplier: { id: string; code: string; name: string } | null;
      supplierItem: { id: string; supplierSku: string | null } | null;
      supplierSku: string | null;
      manufacturedAt: Date | null;
      expiresAt: Date | null;
      availableQty: number;
      suggestedQty: number;
      suggestedBreakdown: ReturnType<typeof decomposeBaseToBulk>;
    }> = [];

    for (const lot of sortedLots) {
      if (remaining <= 0) {
        break;
      }
      const takeQty = Math.min(lot.onHandQty, remaining);
      if (takeQty <= 0) {
        continue;
      }
      allocations.push({
        stockLotId: lot.id,
        lotNumber: lot.lotNumber,
        batchCode: lot.batchCode,
        supplierBatchNumber: lot.supplierBatchNumber,
        supplier: lot.supplier,
        supplierItem: lot.supplierItem,
        supplierSku: lot.supplierSku,
        manufacturedAt: lot.manufacturedAt,
        expiresAt: lot.expiresAt,
        availableQty: lot.onHandQty,
        suggestedQty: takeQty,
        suggestedBreakdown: decomposeBaseToBulk(
          takeQty,
          unitsPerPack,
          packLabel,
          item.unitOfMeasure,
        ),
      });
      remaining -= takeQty;
    }

    const totalAllocatedQty = normalized.totalBaseQty - remaining;

    return {
      organizationId,
      itemId: item.id,
      sku: item.sku,
      itemName: item.name,
      itemType: item.type,
      locationId: location.id,
      locationCode: location.code,
      strategy,
      includeExpired,
      requestedBaseQty: normalized.totalBaseQty,
      requestedSummary: normalized.formattedSummary,
      totalAllocatedQty,
      shortfallQty: remaining,
      fullySatisfied: remaining === 0,
      allocations,
    };
  }

  async getLotTraceability(tenant: AuthenticatedOrganization, lotId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const lot = await this.prismaService.scoped.stockLot.findFirst({
      where: { id: lotId, organizationId },
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
        location: { select: { id: true, code: true, name: true, type: true } },
        supplier: { select: { id: true, code: true, name: true } },
        supplierItem: {
          select: { id: true, supplierSku: true, unitCostCents: true },
        },
        documentAttachments: {
          include: {
            storedObject: { select: STORED_OBJECT_SUMMARY_SELECT },
          },
          orderBy: { createdAt: "desc" },
        },
        goodsReceiptLine: {
          include: {
            goodsReceipt: {
              select: {
                id: true,
                receiptNumber: true,
                status: true,
                deliveredAt: true,
                acceptedAt: true,
                packingSlipNumber: true,
                purchaseOrder: {
                  select: {
                    id: true,
                    poNumber: true,
                    status: true,
                    supplierId: true,
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
            documentAttachments: {
              include: {
                storedObject: { select: STORED_OBJECT_SUMMARY_SELECT },
              },
              orderBy: { createdAt: "desc" },
            },
          },
        },
        quarantineHolds: {
          orderBy: { createdAt: "desc" },
        },
        productionConsumptions: {
          include: {
            pack: {
              select: {
                id: true,
                code: true,
                name: true,
                unitOfMeasure: true,
                unitsPerPack: true,
              },
            },
            productionBatch: {
              select: {
                id: true,
                batchNumber: true,
                name: true,
                status: true,
                plannedOutputQty: true,
                actualOutputQty: true,
                startedAt: true,
                completedAt: true,
                outputItem: {
                  select: { id: true, sku: true, name: true, unitOfMeasure: true },
                },
                outputLot: {
                  select: {
                    id: true,
                    lotNumber: true,
                    batchCode: true,
                    expiresAt: true,
                  },
                },
              },
            },
          },
          orderBy: { consumedAt: "desc" },
        },
        producedFromBatches: {
          select: {
            id: true,
            batchNumber: true,
            name: true,
            status: true,
            actualOutputQty: true,
            completedAt: true,
            location: { select: { id: true, code: true, name: true } },
          },
        },
      },
    });

    if (!lot) {
      throw new NotFoundException("Stock lot was not found.");
    }

    return {
      ...lot,
      documentAttachments: lot.documentAttachments.map((a) =>
        this.attachmentsService.serializeAttachment(a),
      ),
      goodsReceiptLine: lot.goodsReceiptLine
        ? {
            ...lot.goodsReceiptLine,
            documentAttachments: lot.goodsReceiptLine.documentAttachments.map(
              (a) => this.attachmentsService.serializeAttachment(a),
            ),
            goodsReceipt: {
              ...lot.goodsReceiptLine.goodsReceipt,
              documentAttachments:
                lot.goodsReceiptLine.goodsReceipt.documentAttachments.map((a) =>
                  this.attachmentsService.serializeAttachment(a),
                ),
            },
          }
        : null,
    };
  }

  async listLotFiles(tenant: AuthenticatedOrganization, lotId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const lot = await this.prismaService.scoped.stockLot.findFirst({
      where: { id: lotId, organizationId },
      select: { id: true, lotNumber: true },
    });
    if (!lot) {
      throw new NotFoundException("Stock lot was not found.");
    }

    const items = await this.attachmentsService.listForTarget(tenant, {
      stockLotId: lotId,
    });
    return {
      organizationId,
      stockLotId: lot.id,
      lotNumber: lot.lotNumber,
      items,
    };
  }

  async addLotFile(
    tenant: AuthenticatedOrganization,
    lotId: string,
    req: FastifyRequest,
    body: unknown,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const lot = await this.prismaService.scoped.stockLot.findFirst({
      where: { id: lotId, organizationId },
      select: { id: true },
    });
    if (!lot) {
      throw new NotFoundException("Stock lot was not found.");
    }

    return this.attachmentsService.handleUploadOrLinkRequest(tenant, req, body, {
      entityType: StorageEntityType.STOCK_LOT,
      entityId: lotId,
      target: { stockLotId: lotId },
    });
  }

  async removeLotFile(
    tenant: AuthenticatedOrganization,
    lotId: string,
    attachmentId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const lot = await this.prismaService.scoped.stockLot.findFirst({
      where: { id: lotId, organizationId },
      select: { id: true },
    });
    if (!lot) {
      throw new NotFoundException("Stock lot was not found.");
    }

    return this.attachmentsService.removeAttachment(
      tenant,
      attachmentId,
      { stockLotId: lotId },
      ipAddress,
    );
  }

  async adjustStock(
    tenant: AuthenticatedOrganization,
    input: AdjustStockInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    if (input.quantityDelta === 0) {
      throw new BadRequestException("quantityDelta must be a non-zero integer.");
    }

    return this.prismaService.raw.$transaction(async (tx) => {
      const [item, location] = await Promise.all([
        tx.item.findFirst({
          where: { id: input.itemId, organizationId },
        }),
        tx.location.findFirst({
          where: { id: input.locationId, organizationId },
        }),
      ]);

      if (!item) {
        throw new NotFoundException("Catalog item was not found.");
      }
      if (item.status === ItemStatus.ARCHIVED) {
        throw new BadRequestException(
          "Cannot adjust stock for an archived catalog item.",
        );
      }
      if (item.variantKind === ItemVariantKind.TEMPLATE) {
        throw new BadRequestException(
          `Item "${item.sku}" is a product template. Adjust stock on concrete variant SKUs instead.`,
        );
      }
      if (!item.trackInventory) {
        throw new BadRequestException(
          `Item "${item.sku}" has trackInventory disabled and cannot hold stock.`,
        );
      }
      if (!location) {
        throw new NotFoundException("Location was not found.");
      }
      if (location.status !== LocationStatus.ACTIVE) {
        throw new BadRequestException(
          "Stock adjustments are only allowed on ACTIVE locations.",
        );
      }

      const existingBalance = await tx.stockBalance.findUnique({
        where: {
          organizationId_itemId_locationId: {
            organizationId,
            itemId: item.id,
            locationId: location.id,
          },
        },
      });

      const currentQty = existingBalance?.onHandQty ?? 0;
      const nextQty = currentQty + input.quantityDelta;

      if (nextQty < 0 && !item.allowNegativeStock) {
        throw new BadRequestException(
          `Insufficient stock for SKU "${item.sku}" at location "${location.code}" (on hand: ${currentQty}, delta: ${input.quantityDelta}).`,
        );
      }

      const balance = existingBalance
        ? await tx.stockBalance.update({
            where: { id: existingBalance.id },
            data: { onHandQty: nextQty },
          })
        : await tx.stockBalance.create({
            data: {
              organizationId,
              itemId: item.id,
              locationId: location.id,
              onHandQty: nextQty,
              reservedQty: 0,
            },
          });

      const movement = await tx.stockMovement.create({
        data: {
          organizationId,
          itemId: item.id,
          locationId: location.id,
          type: StockMovementType.ADJUSTMENT,
          quantityDelta: input.quantityDelta,
          balanceAfter: balance.onHandQty,
          referenceType: "ManualAdjustment",
          reason: input.reason,
          actorUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "inventory.adjusted",
          resourceType: "StockBalance",
          resourceId: balance.id,
          metadata: {
            itemId: item.id,
            sku: item.sku,
            locationId: location.id,
            locationCode: location.code,
            quantityDelta: input.quantityDelta,
            previousQty: currentQty,
            balanceAfter: balance.onHandQty,
            reason: input.reason,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        balance: {
          ...balance,
          availableQty: balance.onHandQty - balance.reservedQty,
        },
        movement,
      };
    });
  }

  async createTransfer(
    tenant: AuthenticatedOrganization,
    input: CreateTransferInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    if (input.fromLocationId === input.toLocationId) {
      throw new BadRequestException(
        "Source and destination locations must be different.",
      );
    }

    const dedupedLines = new Map<string, number>();
    for (const line of input.lines) {
      dedupedLines.set(
        line.itemId,
        (dedupedLines.get(line.itemId) ?? 0) + line.quantity,
      );
    }

    const transferNumber =
      input.transferNumber?.trim().toUpperCase() ||
      `TRF-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        const [fromLoc, toLoc, items] = await Promise.all([
          tx.location.findFirst({
            where: { id: input.fromLocationId, organizationId },
          }),
          tx.location.findFirst({
            where: { id: input.toLocationId, organizationId },
          }),
          tx.item.findMany({
            where: {
              organizationId,
              id: { in: Array.from(dedupedLines.keys()) },
            },
          }),
        ]);

        if (!fromLoc || fromLoc.status !== LocationStatus.ACTIVE) {
          throw new BadRequestException(
            "Source location must exist and be ACTIVE.",
          );
        }
        if (!toLoc || toLoc.status !== LocationStatus.ACTIVE) {
          throw new BadRequestException(
            "Destination location must exist and be ACTIVE.",
          );
        }

        const itemMap = new Map(items.map((it) => [it.id, it]));
        for (const itemId of dedupedLines.keys()) {
          const item = itemMap.get(itemId);
          if (!item) {
            throw new NotFoundException(`Catalog item "${itemId}" not found.`);
          }
          if (item.status === ItemStatus.ARCHIVED) {
            throw new BadRequestException(
              `Archived item "${item.sku}" cannot be transferred.`,
            );
          }
          if (item.variantKind === ItemVariantKind.TEMPLATE) {
            throw new BadRequestException(
              `Item "${item.sku}" is a product template. Transfer concrete variant SKUs instead.`,
            );
          }
          if (!item.trackInventory) {
            throw new BadRequestException(
              `Item "${item.sku}" has trackInventory disabled and cannot be transferred.`,
            );
          }
        }

        const transfer = await tx.stockTransfer.create({
          data: {
            organizationId,
            transferNumber,
            fromLocationId: fromLoc.id,
            toLocationId: toLoc.id,
            status: StockTransferStatus.DRAFT,
            notes: input.notes ?? null,
            createdByUserId: tenant.userId,
            lines: {
              create: Array.from(dedupedLines.entries()).map(
                ([itemId, quantity]) => ({
                  organizationId,
                  itemId,
                  quantity,
                }),
              ),
            },
          },
          include: {
            fromLocation: {
              select: { id: true, code: true, name: true, type: true },
            },
            toLocation: {
              select: { id: true, code: true, name: true, type: true },
            },
            lines: {
              include: {
                item: {
                  select: { id: true, sku: true, name: true, unitOfMeasure: true },
                },
              },
            },
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "inventory.transfer.created",
            resourceType: "StockTransfer",
            resourceId: transfer.id,
            metadata: {
              transferNumber: transfer.transferNumber,
              fromLocationCode: fromLoc.code,
              toLocationCode: toLoc.code,
              lineCount: transfer.lines.length,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return transfer;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `Transfer number "${transferNumber}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async listTransfers(
    tenant: AuthenticatedOrganization,
    query: ListTransfersQuery,
  ) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);

    const records = await this.prismaService.scoped.stockTransfer.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.fromLocationId
          ? { fromLocationId: query.fromLocationId }
          : {}),
        ...(query.toLocationId ? { toLocationId: query.toLocationId } : {}),
      },
      include: {
        fromLocation: { select: { id: true, code: true, name: true, type: true } },
        toLocation: { select: { id: true, code: true, name: true, type: true } },
        lines: {
          include: {
            item: { select: { id: true, sku: true, name: true, unitOfMeasure: true } },
          },
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
      items,
      nextCursor,
    };
  }

  async getTransfer(tenant: AuthenticatedOrganization, transferId: string) {
    this.resolveVerifiedOrganizationId(tenant);

    const transfer = await this.prismaService.scoped.stockTransfer.findUnique({
      where: { id: transferId },
      include: {
        fromLocation: { select: { id: true, code: true, name: true, type: true } },
        toLocation: { select: { id: true, code: true, name: true, type: true } },
        lines: {
          include: {
            item: { select: { id: true, sku: true, name: true, unitOfMeasure: true } },
          },
        },
      },
    });

    if (!transfer) {
      throw new NotFoundException("Stock transfer was not found.");
    }

    return transfer;
  }

  async dispatchTransfer(
    tenant: AuthenticatedOrganization,
    transferId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.stockTransfer.findFirst({
        where: { id: transferId, organizationId },
        include: {
          fromLocation: true,
          toLocation: true,
          lines: { include: { item: true } },
        },
      });

      if (!existing) {
        throw new NotFoundException("Stock transfer was not found.");
      }

      if (existing.status !== StockTransferStatus.DRAFT) {
        throw new BadRequestException(
          `Only DRAFT transfers can be dispatched (current status: ${existing.status}).`,
        );
      }

      if (existing.fromLocation.status !== LocationStatus.ACTIVE) {
        throw new BadRequestException("Source location must be ACTIVE to dispatch.");
      }

      const claimed = await tx.stockTransfer.updateMany({
        where: {
          id: transferId,
          organizationId,
          status: StockTransferStatus.DRAFT,
        },
        data: {
          status: StockTransferStatus.IN_TRANSIT,
          dispatchedAt: new Date(),
          dispatchedByUserId: tenant.userId,
        },
      });

      if (claimed.count !== 1) {
        throw new ConflictException(
          "Stock transfer state changed concurrently. Refresh and retry.",
        );
      }

      for (const line of existing.lines) {
        if (!line.item.trackInventory) {
          throw new BadRequestException(
            `Item "${line.item.sku}" does not track inventory.`,
          );
        }

        const bal = await tx.stockBalance.findUnique({
          where: {
            organizationId_itemId_locationId: {
              organizationId,
              itemId: line.itemId,
              locationId: existing.fromLocationId,
            },
          },
        });

        const currentQty = bal?.onHandQty ?? 0;
        const nextQty = currentQty - line.quantity;

        if (nextQty < 0 && !line.item.allowNegativeStock) {
          throw new BadRequestException(
            `Insufficient stock for SKU "${line.item.sku}" at "${existing.fromLocation.code}" (on hand: ${currentQty}, transfer qty: ${line.quantity}).`,
          );
        }

        const allocation = await allocateAndDeductLotsInTx(tx, {
          organizationId,
          itemId: line.itemId,
          sku: line.item.sku,
          trackExpiry: line.item.trackExpiry,
          allowNegativeStock: line.item.allowNegativeStock,
          lotAllocationStrategy: line.item.lotAllocationStrategy,
          locationId: existing.fromLocationId,
          locationCode: existing.fromLocation.code,
          currentBalanceOnHand: currentQty,
          baseQty: line.quantity,
        });

        if (bal) {
          await tx.stockBalance.update({
            where: { id: bal.id },
            data: { onHandQty: nextQty },
          });
        } else {
          await tx.stockBalance.create({
            data: {
              organizationId,
              itemId: line.itemId,
              locationId: existing.fromLocationId,
              onHandQty: nextQty,
              reservedQty: 0,
            },
          });
        }

        await recordAllocatedStockMovementsInTx(tx, {
          organizationId,
          itemId: line.itemId,
          locationId: existing.fromLocationId,
          type: StockMovementType.TRANSFER_OUT,
          startingBalanceOnHand: currentQty,
          usedLots: allocation.usedLots,
          unlottedQty: allocation.unlottedQty,
          referenceType: "StockTransfer",
          referenceId: existing.id,
          reason: `Dispatched transfer ${existing.transferNumber} to ${existing.toLocation.code}`,
          actorUserId: tenant.userId,
        });
      }

      const dispatched = await tx.stockTransfer.findFirstOrThrow({
        where: { id: transferId, organizationId },
        include: {
          fromLocation: { select: { id: true, code: true, name: true, type: true } },
          toLocation: { select: { id: true, code: true, name: true, type: true } },
          lines: {
            include: {
              item: { select: { id: true, sku: true, name: true, unitOfMeasure: true } },
            },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "inventory.transfer.dispatched",
          resourceType: "StockTransfer",
          resourceId: existing.id,
          metadata: {
            transferNumber: existing.transferNumber,
            fromLocationCode: existing.fromLocation.code,
            toLocationCode: existing.toLocation.code,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return dispatched;
    });
  }

  async receiveTransfer(
    tenant: AuthenticatedOrganization,
    transferId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.stockTransfer.findFirst({
        where: { id: transferId, organizationId },
        include: {
          fromLocation: true,
          toLocation: true,
          lines: { include: { item: true } },
        },
      });

      if (!existing) {
        throw new NotFoundException("Stock transfer was not found.");
      }

      if (existing.status !== StockTransferStatus.IN_TRANSIT) {
        throw new BadRequestException(
          `Only IN_TRANSIT transfers can be received (current status: ${existing.status}).`,
        );
      }

      if (existing.toLocation.status !== LocationStatus.ACTIVE) {
        throw new BadRequestException(
          "Destination location must be ACTIVE to receive stock.",
        );
      }

      const claimed = await tx.stockTransfer.updateMany({
        where: {
          id: transferId,
          organizationId,
          status: StockTransferStatus.IN_TRANSIT,
        },
        data: {
          status: StockTransferStatus.RECEIVED,
          receivedAt: new Date(),
          receivedByUserId: tenant.userId,
        },
      });

      if (claimed.count !== 1) {
        throw new ConflictException(
          "Stock transfer state changed concurrently. Refresh and retry.",
        );
      }

      for (const line of existing.lines) {
        const previousBal = await tx.stockBalance.findUnique({
          where: {
            organizationId_itemId_locationId: {
              organizationId,
              itemId: line.itemId,
              locationId: existing.toLocationId,
            },
          },
        });
        let runningBal = previousBal?.onHandQty ?? 0;

        await tx.stockBalance.upsert({
          where: {
            organizationId_itemId_locationId: {
              organizationId,
              itemId: line.itemId,
              locationId: existing.toLocationId,
            },
          },
          create: {
            organizationId,
            itemId: line.itemId,
            locationId: existing.toLocationId,
            onHandQty: line.quantity,
            reservedQty: 0,
          },
          update: {
            onHandQty: { increment: line.quantity },
          },
        });

        const outboundMovements = await tx.stockMovement.findMany({
          where: {
            organizationId,
            itemId: line.itemId,
            locationId: existing.fromLocationId,
            type: StockMovementType.TRANSFER_OUT,
            referenceType: "StockTransfer",
            referenceId: existing.id,
            stockLotId: { not: null },
          },
          include: { stockLot: true },
          orderBy: { createdAt: "asc" },
        });

        let lotTransferredTotal = 0;
        for (const outMov of outboundMovements) {
          const srcLot = outMov.stockLot;
          const moveQty = Math.abs(outMov.quantityDelta);
          if (!srcLot || moveQty <= 0) {
            continue;
          }
          lotTransferredTotal += moveQty;
          runningBal += moveQty;

          const existingDestLot = await tx.stockLot.findFirst({
            where: {
              organizationId,
              itemId: line.itemId,
              locationId: existing.toLocationId,
              lotNumber: srcLot.lotNumber,
            },
          });

          const destLot = existingDestLot
            ? await tx.stockLot.update({
                where: { id: existingDestLot.id },
                data: {
                  onHandQty: { increment: moveQty },
                  initialQty: { increment: moveQty },
                  ...(srcLot.expiresAt && !existingDestLot.expiresAt
                    ? { expiresAt: srcLot.expiresAt }
                    : {}),
                },
              })
            : await tx.stockLot.create({
                data: {
                  organizationId,
                  itemId: line.itemId,
                  locationId: existing.toLocationId,
                  supplierId: srcLot.supplierId,
                  supplierItemId: srcLot.supplierItemId,
                  supplierSku: srcLot.supplierSku,
                  supplierBatchNumber: srcLot.supplierBatchNumber,
                  goodsReceiptLineId: srcLot.goodsReceiptLineId,
                  lotNumber: srcLot.lotNumber,
                  batchCode: srcLot.batchCode,
                  manufacturedAt: srcLot.manufacturedAt,
                  expiresAt: srcLot.expiresAt,
                  initialQty: moveQty,
                  onHandQty: moveQty,
                  quarantinedQty: 0,
                  consumedQty: 0,
                  unitCostCents: srcLot.unitCostCents,
                },
              });

          await tx.stockMovement.create({
            data: {
              organizationId,
              itemId: line.itemId,
              locationId: existing.toLocationId,
              type: StockMovementType.TRANSFER_IN,
              quantityDelta: moveQty,
              balanceAfter: runningBal,
              stockLotId: destLot.id,
              referenceType: "StockTransfer",
              referenceId: existing.id,
              reason: `Received transfer ${existing.transferNumber} from ${existing.fromLocation.code} [Lot ${destLot.lotNumber}]`,
              actorUserId: tenant.userId,
            },
          });
        }

        const unlottedRemainder = Math.max(0, line.quantity - lotTransferredTotal);
        if (unlottedRemainder > 0) {
          runningBal += unlottedRemainder;
          await tx.stockMovement.create({
            data: {
              organizationId,
              itemId: line.itemId,
              locationId: existing.toLocationId,
              type: StockMovementType.TRANSFER_IN,
              quantityDelta: unlottedRemainder,
              balanceAfter: runningBal,
              referenceType: "StockTransfer",
              referenceId: existing.id,
              reason: `Received transfer ${existing.transferNumber} from ${existing.fromLocation.code}`,
              actorUserId: tenant.userId,
            },
          });
        }
      }

      const received = await tx.stockTransfer.findFirstOrThrow({
        where: { id: transferId, organizationId },
        include: {
          fromLocation: { select: { id: true, code: true, name: true, type: true } },
          toLocation: { select: { id: true, code: true, name: true, type: true } },
          lines: {
            include: {
              item: { select: { id: true, sku: true, name: true, unitOfMeasure: true } },
            },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "inventory.transfer.received",
          resourceType: "StockTransfer",
          resourceId: existing.id,
          metadata: {
            transferNumber: existing.transferNumber,
            toLocationCode: existing.toLocation.code,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return received;
    });
  }

  async cancelTransfer(
    tenant: AuthenticatedOrganization,
    transferId: string,
    reason?: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.stockTransfer.findFirst({
        where: { id: transferId, organizationId },
        include: {
          fromLocation: true,
          toLocation: true,
          lines: { include: { item: true } },
        },
      });

      if (!existing) {
        throw new NotFoundException("Stock transfer was not found.");
      }

      if (
        existing.status !== StockTransferStatus.DRAFT &&
        existing.status !== StockTransferStatus.IN_TRANSIT
      ) {
        throw new BadRequestException(
          `Transfers in status "${existing.status}" cannot be cancelled.`,
        );
      }

      const claimed = await tx.stockTransfer.updateMany({
        where: {
          id: transferId,
          organizationId,
          status: existing.status,
        },
        data: {
          status: StockTransferStatus.CANCELLED,
          cancelledAt: new Date(),
        },
      });

      if (claimed.count !== 1) {
        throw new ConflictException(
          "Stock transfer state changed concurrently. Refresh and retry.",
        );
      }

      if (existing.status === StockTransferStatus.IN_TRANSIT) {
        for (const line of existing.lines) {
          const bal = await tx.stockBalance.upsert({
            where: {
              organizationId_itemId_locationId: {
                organizationId,
                itemId: line.itemId,
                locationId: existing.fromLocationId,
              },
            },
            create: {
              organizationId,
              itemId: line.itemId,
              locationId: existing.fromLocationId,
              onHandQty: line.quantity,
              reservedQty: 0,
            },
            update: {
              onHandQty: { increment: line.quantity },
            },
          });

          await tx.stockMovement.create({
            data: {
              organizationId,
              itemId: line.itemId,
              locationId: existing.fromLocationId,
              type: StockMovementType.ADJUSTMENT,
              quantityDelta: line.quantity,
              balanceAfter: bal.onHandQty,
              referenceType: "StockTransfer",
              referenceId: existing.id,
              reason: reason
                ? `Cancelled in-transit transfer ${existing.transferNumber}: ${reason}`
                : `Cancelled in-transit transfer ${existing.transferNumber}`,
              actorUserId: tenant.userId,
            },
          });
        }
      }

      const cancelled = await tx.stockTransfer.findFirstOrThrow({
        where: { id: transferId, organizationId },
        include: {
          fromLocation: { select: { id: true, code: true, name: true, type: true } },
          toLocation: { select: { id: true, code: true, name: true, type: true } },
          lines: {
            include: {
              item: { select: { id: true, sku: true, name: true, unitOfMeasure: true } },
            },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "inventory.transfer.cancelled",
          resourceType: "StockTransfer",
          resourceId: existing.id,
          metadata: {
            transferNumber: existing.transferNumber,
            previousStatus: existing.status,
            ...(reason ? { reason } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return cancelled;
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

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  BomIssueMethod,
  ExpiryAlertStatus,
  ExpiryEnforcementMode,
  ItemStatus,
  ItemType,
  LocationStatus,
  LotAllocationStrategy,
  Prisma,
  ProductionBatchStatus,
  ProductionCostCategory,
  ProductionOperationStatus,
  ProductionPriority,
  ProductionQcCheckpointStatus,
  ProductionQcCheckpointType,
  ProductionQcStatus,
  StockMovementType,
  StorageEntityType,
  TenantContext,
} from "@scace/db";
import type { FastifyRequest } from "fastify";
import { PrismaService } from "../database/prisma.service.js";
import { resolveEffectiveExpiryPolicyTx } from "../locations/lot-allocation.utils.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import {
  type BulkQuantityInput,
  decomposeBaseToBulk,
  normalizeBulkQuantity,
} from "../procurement/delivery-units.utils.js";
import {
  AttachmentsService,
  STORED_OBJECT_SUMMARY_SELECT,
} from "../storage/attachments.service.js";
import type { AuthenticatedTenant } from "../tenancy/tenant.decorators.js";
import {
  computeTimeLogCosts,
  recalculateBatchCosting,
  resolveLotUnitCostCents,
} from "./production-costing.utils.js";

export interface ScheduleBatchInput {
  startAt?: string | null;
}

export interface DispatchQueueQuery {
  statuses?: ProductionOperationStatus[];
  from?: string;
  to?: string;
  limit: number;
}

export interface LogOperationTimeInput {
  timeLogId?: string | null;
  staffId?: string | null;
  logType?: "SETUP" | "RUN" | "REWORK";
  startedAt?: string | null;
  endedAt?: string | null;
  durationMinutes?: number;
  notes?: string | null;
}

export interface CompleteOperationInput {
  completedQty?: number;
  scrapQty?: number;
  signOffNotes?: string | null;
  backflushMaterials?: boolean;
  includeExpired?: boolean;
}

export interface CreateQcCheckpointInput {
  productionOperationId?: string | null;
  checkpointType?: ProductionQcCheckpointType;
  code: string;
  name: string;
  checklistTemplate?: Record<string, unknown>[] | Record<string, unknown> | null;
  notes?: string | null;
}

export interface InspectQcCheckpointInput {
  status: "PASSED" | "FAILED" | "WAIVED";
  checklistResults?: Record<string, unknown>[] | Record<string, unknown> | null;
  disposition?: string | null;
  notes?: string | null;
}

export interface QcReleaseBatchInput {
  disposition: "RELEASE" | "QUARANTINE" | "SCRAP";
  waivePendingCheckpoints?: boolean;
  notes?: string | null;
}

export interface AddCostEntryInput {
  category: ProductionCostCategory;
  description: string;
  quantity?: number;
  unitCostCents?: number;
  totalCostCents: number;
}

export interface ConsumeLineTxInput extends BulkQuantityInput {
  itemId: string;
  locationId?: string;
  packId?: string | null;
  stockLotId?: string | null;
  allocationStrategy?: "FEFO" | "FIFO";
  includeExpired?: boolean;
  notes?: string | null;
  productionOperationId?: string | null;
  reservationId?: string | null;
}

const PRIORITY_WEIGHT: Record<ProductionPriority, number> = {
  URGENT: 4,
  HIGH: 3,
  NORMAL: 2,
  LOW: 1,
};

@Injectable()
export class ProductionExecutionService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(AttachmentsService)
    private readonly attachmentsService: AttachmentsService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  // ==========================================
  // Shared Material Reservation & Consumption Engine (Transactional)
  // ==========================================

  async reserveBatchMaterialsTx(
    tx: Prisma.TransactionClient,
    tenant: AuthenticatedTenant,
    batchId: string,
    strictStockCheck = true,
  ) {
    const organizationId = tenant.organizationId;
    const reservations = await tx.productionMaterialReservation.findMany({
      where: { organizationId, productionBatchId: batchId, isReleased: false },
      include: {
        item: {
          select: {
            id: true,
            sku: true,
            name: true,
            trackInventory: true,
            allowNegativeStock: true,
          },
        },
        location: { select: { id: true, code: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    for (const res of reservations) {
      const targetToReserve = Math.max(
        0,
        res.requiredBaseQty - res.issuedBaseQty - res.reservedBaseQty,
      );
      if (targetToReserve <= 0) continue;

      if (!res.item.trackInventory) {
        await tx.productionMaterialReservation.update({
          where: { id: res.id },
          data: { reservedBaseQty: { increment: targetToReserve } },
        });
        continue;
      }

      const bal = await tx.stockBalance.findUnique({
        where: {
          organizationId_itemId_locationId: {
            organizationId,
            itemId: res.itemId,
            locationId: res.locationId,
          },
        },
      });

      const available = Math.max(
        0,
        (bal?.onHandQty ?? 0) - (bal?.reservedQty ?? 0),
      );

      if (strictStockCheck && !res.item.allowNegativeStock && available < targetToReserve) {
        throw new BadRequestException(
          `Insufficient unreserved stock to reserve SKU "${res.item.sku}" at "${res.location.code}" (needed: ${targetToReserve}, available: ${available}).`,
        );
      }

      const reserveQty = res.item.allowNegativeStock
        ? targetToReserve
        : Math.min(targetToReserve, available);

      if (reserveQty > 0) {
        await tx.stockBalance.upsert({
          where: {
            organizationId_itemId_locationId: {
              organizationId,
              itemId: res.itemId,
              locationId: res.locationId,
            },
          },
          create: {
            organizationId,
            itemId: res.itemId,
            locationId: res.locationId,
            onHandQty: 0,
            reservedQty: reserveQty,
          },
          update: {
            reservedQty: { increment: reserveQty },
          },
        });

        await tx.productionMaterialReservation.update({
          where: { id: res.id },
          data: { reservedBaseQty: { increment: reserveQty } },
        });
      }
    }
  }

  async releaseUnusedReservationsTx(
    tx: Prisma.TransactionClient,
    organizationId: string,
    batchId: string,
  ) {
    const activeReservations = await tx.productionMaterialReservation.findMany({
      where: { organizationId, productionBatchId: batchId, isReleased: false },
    });

    for (const res of activeReservations) {
      if (res.reservedBaseQty > 0) {
        const bal = await tx.stockBalance.findUnique({
          where: {
            organizationId_itemId_locationId: {
              organizationId,
              itemId: res.itemId,
              locationId: res.locationId,
            },
          },
        });
        if (bal && bal.reservedQty > 0) {
          const releaseAmount = Math.min(bal.reservedQty, res.reservedBaseQty);
          await tx.stockBalance.update({
            where: { id: bal.id },
            data: { reservedQty: { decrement: releaseAmount } },
          });
        }
      }

      await tx.productionMaterialReservation.update({
        where: { id: res.id },
        data: { reservedBaseQty: 0, isReleased: true },
      });
    }
  }

  async consumeMaterialLineTx(
    tx: Prisma.TransactionClient,
    tenant: AuthenticatedTenant,
    batch: {
      id: string;
      batchNumber: string;
      locationId: string;
    },
    reqLine: ConsumeLineTxInput,
    now: Date,
  ) {
    const organizationId = tenant.organizationId;

    const item = await tx.item.findFirst({
      where: { id: reqLine.itemId, organizationId },
    });
    if (!item) {
      throw new NotFoundException(`Catalog item "${reqLine.itemId}" was not found.`);
    }
    if (item.status === ItemStatus.ARCHIVED) {
      throw new BadRequestException(
        `Archived item "${item.sku}" cannot be consumed in production.`,
      );
    }
    if (item.type === ItemType.SERVICE) {
      throw new BadRequestException(
        `Service item "${item.sku}" cannot be consumed from inventory lots.`,
      );
    }

    const targetLocationId = reqLine.locationId ?? batch.locationId;
    const location = await tx.location.findFirst({
      where: { id: targetLocationId, organizationId },
    });
    if (!location || location.status !== LocationStatus.ACTIVE) {
      throw new BadRequestException(
        `Location "${targetLocationId}" must exist and be ACTIVE.`,
      );
    }

    let pack: {
      id: string;
      unitsPerPack: number;
      unitOfMeasure: string;
      name: string;
    } | null = null;
    if (reqLine.packId) {
      pack = await tx.itemPack.findFirst({
        where: {
          id: reqLine.packId,
          organizationId,
          itemId: item.id,
          isActive: true,
        },
        select: {
          id: true,
          unitsPerPack: true,
          unitOfMeasure: true,
          name: true,
        },
      });
      if (!pack) {
        throw new BadRequestException(
          `Pack "${reqLine.packId}" was not found or is inactive for SKU "${item.sku}".`,
        );
      }
    }

    const unitsPerPack = pack?.unitsPerPack ?? 1;
    const packLabel = pack?.unitOfMeasure ?? pack?.name ?? null;
    const normalized = normalizeBulkQuantity(reqLine, {
      unitsPerPack,
      packLabel,
      baseLabel: item.unitOfMeasure,
      allowZero: false,
      fieldLabel: `consumption for SKU "${item.sku}"`,
    });

    const policy = await resolveEffectiveExpiryPolicyTx(tx, organizationId);
    const includeExpired = reqLine.includeExpired ?? false;
    if (
      includeExpired &&
      policy.enforcementMode === ExpiryEnforcementMode.BLOCK_EXPIRED
    ) {
      throw new BadRequestException(
        `Organization expiry policy (${policy.enforcementMode}) forbids consuming expired stock lots.`,
      );
    }

    let allocationStrategy: LotAllocationStrategy;
    const plan: Array<{
      lot: { id: string; lotNumber: string; onHandQty: number; quarantinedQty: number };
      takeQty: number;
    }> = [];

    if (reqLine.stockLotId) {
      allocationStrategy = LotAllocationStrategy.MANUAL;
      const manualLot = await tx.stockLot.findFirst({
        where: { id: reqLine.stockLotId, organizationId },
      });
      if (!manualLot) {
        throw new NotFoundException(`Stock lot "${reqLine.stockLotId}" was not found.`);
      }
      if (manualLot.itemId !== item.id) {
        throw new BadRequestException(
          `Stock lot "${manualLot.lotNumber}" does not belong to SKU "${item.sku}".`,
        );
      }
      if (manualLot.locationId !== location.id) {
        throw new BadRequestException(
          `Stock lot "${manualLot.lotNumber}" is stored at a different location than "${location.code}".`,
        );
      }
      if (
        !includeExpired &&
        manualLot.expiresAt &&
        manualLot.expiresAt.getTime() <= now.getTime()
      ) {
        throw new BadRequestException(
          `Stock lot "${manualLot.lotNumber}" expired on ${manualLot.expiresAt.toISOString()}. Pass includeExpired: true to override.`,
        );
      }
      if (manualLot.onHandQty < normalized.totalBaseQty) {
        throw new BadRequestException(
          `Stock lot "${manualLot.lotNumber}" only has ${manualLot.onHandQty} base unit(s) on hand (requested: ${normalized.totalBaseQty}).`,
        );
      }
      plan.push({
        lot: {
          id: manualLot.id,
          lotNumber: manualLot.lotNumber,
          onHandQty: manualLot.onHandQty,
          quarantinedQty: manualLot.quarantinedQty,
        },
        takeQty: normalized.totalBaseQty,
      });
    } else {
      allocationStrategy =
        reqLine.allocationStrategy === "FIFO"
          ? LotAllocationStrategy.FIFO
          : reqLine.allocationStrategy === "FEFO"
            ? LotAllocationStrategy.FEFO
            : item.lotAllocationStrategy === LotAllocationStrategy.FIFO
              ? LotAllocationStrategy.FIFO
              : LotAllocationStrategy.FEFO;

      const candidateLots = await tx.stockLot.findMany({
        where: {
          organizationId,
          itemId: item.id,
          locationId: location.id,
          onHandQty: { gt: 0 },
          ...(!includeExpired
            ? { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
            : {}),
        },
      });

      const sortedLots = [...candidateLots].sort((a, b) => {
        if (allocationStrategy === LotAllocationStrategy.FEFO) {
          const aExp = a.expiresAt
            ? a.expiresAt.getTime()
            : Number.POSITIVE_INFINITY;
          const bExp = b.expiresAt
            ? b.expiresAt.getTime()
            : Number.POSITIVE_INFINITY;
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
      for (const candidate of sortedLots) {
        if (remaining <= 0) break;
        const takeQty = Math.min(candidate.onHandQty, remaining);
        if (takeQty > 0) {
          plan.push({
            lot: {
              id: candidate.id,
              lotNumber: candidate.lotNumber,
              onHandQty: candidate.onHandQty,
              quarantinedQty: candidate.quarantinedQty,
            },
            takeQty,
          });
          remaining -= takeQty;
        }
      }

      if (remaining > 0) {
        throw new BadRequestException(
          `Insufficient eligible stock lots for SKU "${item.sku}" at "${location.code}" using ${allocationStrategy} (requested: ${normalized.totalBaseQty}, available: ${normalized.totalBaseQty - remaining}).`,
        );
      }
    }

    const createdConsumptions: Array<{
      id: string;
      itemId: string;
      stockLotId: string;
      consumedBaseQty: number;
      unitCostCents: number;
      totalCostCents: number;
      allocationStrategy: LotAllocationStrategy;
    }> = [];

    // Locate matching reservation (if any) so we release reservedQty smoothly
    let remainingToUnreserveFromBatch = normalized.totalBaseQty;
    const matchingReservations = await tx.productionMaterialReservation.findMany({
      where: {
        organizationId,
        productionBatchId: batch.id,
        itemId: item.id,
        locationId: location.id,
        isReleased: false,
        ...(reqLine.reservationId ? { id: reqLine.reservationId } : {}),
      },
      orderBy: { createdAt: "asc" },
    });

    let totalUnreserved = 0;
    for (const res of matchingReservations) {
      if (remainingToUnreserveFromBatch <= 0) break;
      const issueDelta = remainingToUnreserveFromBatch;
      const unreserveDelta = Math.min(res.reservedBaseQty, issueDelta);
      await tx.productionMaterialReservation.update({
        where: { id: res.id },
        data: {
          reservedBaseQty: { decrement: unreserveDelta },
          issuedBaseQty: { increment: issueDelta },
        },
      });
      totalUnreserved += unreserveDelta;
      remainingToUnreserveFromBatch -= issueDelta;
    }

    let pendingUnreserveOnBalance = totalUnreserved;

    for (const step of plan) {
      const lotUpdate = await tx.stockLot.updateMany({
        where: {
          id: step.lot.id,
          organizationId,
          onHandQty: { gte: step.takeQty },
        },
        data: {
          onHandQty: { decrement: step.takeQty },
          consumedQty: { increment: step.takeQty },
        },
      });
      if (lotUpdate.count !== 1) {
        throw new ConflictException(
          `Stock lot "${step.lot.lotNumber}" no longer has ${step.takeQty} base unit(s) available.`,
        );
      }

      if (step.lot.onHandQty - step.takeQty === 0 && step.lot.quarantinedQty === 0) {
        await tx.stockExpiryAlert.updateMany({
          where: {
            organizationId,
            stockLotId: step.lot.id,
            status: { in: [ExpiryAlertStatus.OPEN, ExpiryAlertStatus.ACKNOWLEDGED] },
          },
          data: {
            status: ExpiryAlertStatus.RESOLVED,
            resolvedAt: now,
            resolvedByUserId: tenant.userId,
            resolutionNotes: "Lot depleted in production consumption.",
          },
        });
      }

      const unitCostCents = await resolveLotUnitCostCents(
        tx,
        organizationId,
        step.lot.id,
      );
      const totalCostCents = unitCostCents * step.takeQty;

      if (item.trackInventory) {
        const existingBal = await tx.stockBalance.findUnique({
          where: {
            organizationId_itemId_locationId: {
              organizationId,
              itemId: item.id,
              locationId: location.id,
            },
          },
        });

        const currentBalQty = existingBal?.onHandQty ?? 0;
        const nextBalQty = currentBalQty - step.takeQty;
        if (nextBalQty < 0 && !item.allowNegativeStock) {
          throw new BadRequestException(
            `Insufficient stock balance for SKU "${item.sku}" at "${location.code}" (on hand: ${currentBalQty}, consuming: ${step.takeQty}).`,
          );
        }

        const unreserveBalDelta = Math.min(
          existingBal?.reservedQty ?? 0,
          pendingUnreserveOnBalance,
        );
        pendingUnreserveOnBalance = Math.max(
          0,
          pendingUnreserveOnBalance - unreserveBalDelta,
        );

        const updatedBal = existingBal
          ? await tx.stockBalance.update({
              where: { id: existingBal.id },
              data: {
                onHandQty: nextBalQty,
                ...(unreserveBalDelta > 0
                  ? { reservedQty: { decrement: unreserveBalDelta } }
                  : {}),
              },
            })
          : await tx.stockBalance.create({
              data: {
                organizationId,
                itemId: item.id,
                locationId: location.id,
                onHandQty: nextBalQty,
                reservedQty: 0,
              },
            });

        await tx.stockMovement.create({
          data: {
            organizationId,
            itemId: item.id,
            locationId: location.id,
            type: StockMovementType.PRODUCTION_CONSUMPTION,
            quantityDelta: -step.takeQty,
            balanceAfter: updatedBal.onHandQty,
            stockLotId: step.lot.id,
            referenceType: "ProductionBatch",
            referenceId: batch.id,
            reason: `Consumed ${step.takeQty} ${item.unitOfMeasure} from lot ${step.lot.lotNumber} in batch ${batch.batchNumber}`,
            actorUserId: tenant.userId,
          },
        });
      }

      const stepBreakdown = decomposeBaseToBulk(
        step.takeQty,
        unitsPerPack,
        packLabel,
        item.unitOfMeasure,
      );

      const consumption = await tx.productionConsumption.create({
        data: {
          organizationId,
          productionBatchId: batch.id,
          productionOperationId: reqLine.productionOperationId ?? null,
          itemId: item.id,
          stockLotId: step.lot.id,
          locationId: location.id,
          packId: pack?.id ?? null,
          unitsPerPack,
          packQty: unitsPerPack > 1 ? stepBreakdown.packQty : 0,
          looseBaseQty:
            unitsPerPack > 1 ? stepBreakdown.looseBaseQty : step.takeQty,
          consumedBaseQty: step.takeQty,
          unitCostCents,
          totalCostCents,
          allocationStrategy,
          notes: reqLine.notes?.trim() || null,
          consumedByUserId: tenant.userId,
          consumedAt: now,
        },
      });

      createdConsumptions.push({
        id: consumption.id,
        itemId: consumption.itemId,
        stockLotId: consumption.stockLotId,
        consumedBaseQty: consumption.consumedBaseQty,
        unitCostCents: consumption.unitCostCents,
        totalCostCents: consumption.totalCostCents,
        allocationStrategy: consumption.allocationStrategy,
      });
    }

    return createdConsumptions;
  }

  async backflushReservationsTx(
    tx: Prisma.TransactionClient,
    tenant: AuthenticatedTenant,
    batch: { id: string; batchNumber: string; locationId: string },
    options: {
      operationSequence?: number | null;
      productionOperationId?: string | null;
      includeExpired?: boolean;
      now: Date;
    },
  ) {
    const reservations = await tx.productionMaterialReservation.findMany({
      where: {
        organizationId: tenant.organizationId,
        productionBatchId: batch.id,
        issueMethod: BomIssueMethod.BACKFLUSH,
        isReleased: false,
        ...(options.operationSequence !== undefined &&
        options.operationSequence !== null
          ? { operationSequence: options.operationSequence }
          : {}),
      },
      orderBy: { createdAt: "asc" },
    });

    const allConsumptions = [];
    for (const res of reservations) {
      const remainingToIssue = Math.max(
        0,
        res.requiredBaseQty - res.issuedBaseQty,
      );
      if (remainingToIssue <= 0) continue;

      const created = await this.consumeMaterialLineTx(
        tx,
        tenant,
        batch,
        {
          itemId: res.itemId,
          locationId: res.locationId,
          packId: null,
          baseQty: remainingToIssue,
          stockLotId: res.stockLotId,
          allocationStrategy:
            res.allocationStrategy === LotAllocationStrategy.FIFO
              ? "FIFO"
              : "FEFO",
          includeExpired: options.includeExpired ?? false,
          notes: options.operationSequence
            ? `Auto-backflush on operation #${options.operationSequence}`
            : `Auto-backflush on batch ${batch.batchNumber}`,
          productionOperationId: options.productionOperationId ?? null,
          reservationId: res.id,
        },
        options.now,
      );
      allConsumptions.push(...created);
    }

    return allConsumptions;
  }

  // ==========================================
  // Capacity Scheduling & Work Center Dispatch Queues
  // ==========================================

  async scheduleBatch(
    tenant: AuthenticatedTenant,
    batchId: string,
    input: ScheduleBatchInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const batch = await tx.productionBatch.findFirst({
        where: { id: batchId, organizationId },
        include: {
          operations: {
            include: { workCenter: true },
            orderBy: { sequence: "asc" },
          },
        },
      });
      if (!batch) {
        throw new NotFoundException("Production batch was not found.");
      }
      if (
        batch.status === ProductionBatchStatus.COMPLETED ||
        batch.status === ProductionBatchStatus.CLOSED ||
        batch.status === ProductionBatchStatus.CANCELLED
      ) {
        throw new BadRequestException(
          `Cannot schedule batch in status "${batch.status}".`,
        );
      }
      if (batch.operations.length === 0) {
        throw new BadRequestException(
          "Batch has no routing operations to schedule.",
        );
      }

      const baselineStart = input.startAt
        ? new Date(input.startAt)
        : batch.scheduledStartAt ?? new Date();
      let cursorTime = baselineStart;
      const scheduledOps = [];

      for (const op of batch.operations) {
        const durationMinutes = Math.max(
          1,
          op.plannedSetupMinutes + op.plannedRunMinutes,
        );
        const dailyCap = Math.max(1, op.workCenter.dailyCapacityMinutes || 480);

        // Find already scheduled active operations on this work center excluding current batch
        const existingOps = await tx.productionOperation.findMany({
          where: {
            organizationId,
            workCenterId: op.workCenterId,
            productionBatchId: { not: batch.id },
            status: {
              in: [
                ProductionOperationStatus.PENDING,
                ProductionOperationStatus.READY,
                ProductionOperationStatus.IN_PROGRESS,
                ProductionOperationStatus.PAUSED,
                ProductionOperationStatus.QC_PENDING,
              ],
            },
            scheduledEndAt: { gte: cursorTime },
          },
          orderBy: { scheduledStartAt: "asc" },
        });

        let slotStart = new Date(cursorTime);
        const slotDurationMs = durationMinutes * 60_000;

        // Advance day-by-day if daily capacity would be exceeded, and avoid overlapping higher/existing slots
        for (let guard = 0; guard < 365; guard++) {
          const dayStart = new Date(
            Date.UTC(
              slotStart.getUTCFullYear(),
              slotStart.getUTCMonth(),
              slotStart.getUTCDate(),
              0,
              0,
              0,
            ),
          );
          const dayEnd = new Date(dayStart.getTime() + 86_400_000);

          const usedTodayMins = existingOps.reduce((acc, ex) => {
            if (!ex.scheduledStartAt || !ex.scheduledEndAt) return acc;
            const overlapStart = Math.max(
              ex.scheduledStartAt.getTime(),
              dayStart.getTime(),
            );
            const overlapEnd = Math.min(
              ex.scheduledEndAt.getTime(),
              dayEnd.getTime(),
            );
            if (overlapEnd > overlapStart) {
              return acc + Math.ceil((overlapEnd - overlapStart) / 60_000);
            }
            return acc;
          }, 0);

          if (usedTodayMins + durationMinutes <= dailyCap || durationMinutes > dailyCap) {
            // Find non-overlapping start on this day
            let candidateStart = slotStart.getTime();
            for (const ex of existingOps) {
              if (!ex.scheduledStartAt || !ex.scheduledEndAt) continue;
              const exStart = ex.scheduledStartAt.getTime();
              const exEnd = ex.scheduledEndAt.getTime();
              if (
                candidateStart < exEnd &&
                candidateStart + slotDurationMs > exStart
              ) {
                candidateStart = exEnd;
              }
            }
            if (candidateStart < dayEnd.getTime()) {
              slotStart = new Date(candidateStart);
              break;
            }
          }
          // Move to start of next UTC day
          slotStart = new Date(dayEnd.getTime() + 8 * 3_600_000);
        }

        const slotEnd = new Date(slotStart.getTime() + slotDurationMs);
        const updatedOp = await tx.productionOperation.update({
          where: { id: op.id },
          data: {
            scheduledStartAt: slotStart,
            scheduledEndAt: slotEnd,
          },
          include: {
            workCenter: { select: { id: true, code: true, name: true } },
          },
        });
        scheduledOps.push(updatedOp);
        cursorTime = slotEnd;
      }

      const firstStart = scheduledOps[0]?.scheduledStartAt ?? baselineStart;
      const lastEnd =
        scheduledOps[scheduledOps.length - 1]?.scheduledEndAt ?? cursorTime;

      const updatedBatch = await tx.productionBatch.update({
        where: { id: batch.id },
        data: {
          scheduledStartAt: firstStart,
          scheduledEndAt: lastEnd,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.batch.scheduled",
          resourceType: "ProductionBatch",
          resourceId: batch.id,
          metadata: {
            batchNumber: batch.batchNumber,
            scheduledStartAt: firstStart.toISOString(),
            scheduledEndAt: lastEnd.toISOString(),
            operationCount: scheduledOps.length,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        productionBatchId: updatedBatch.id,
        batchNumber: updatedBatch.batchNumber,
        scheduledStartAt: updatedBatch.scheduledStartAt,
        scheduledEndAt: updatedBatch.scheduledEndAt,
        operations: scheduledOps,
      };
    });
  }

  async getWorkCenterDispatchQueue(
    tenant: AuthenticatedTenant,
    workCenterId: string,
    query: DispatchQueueQuery,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const wc = await this.prismaService.scoped.workCenter.findFirst({
      where: { id: workCenterId, organizationId },
      include: {
        location: { select: { id: true, code: true, name: true } },
      },
    });
    if (!wc) {
      throw new NotFoundException("Work center was not found.");
    }

    const activeStatuses =
      query.statuses && query.statuses.length > 0
        ? query.statuses
        : [
            ProductionOperationStatus.IN_PROGRESS,
            ProductionOperationStatus.PAUSED,
            ProductionOperationStatus.READY,
            ProductionOperationStatus.QC_PENDING,
            ProductionOperationStatus.PENDING,
          ];

    const ops = await this.prismaService.scoped.productionOperation.findMany({
      where: {
        organizationId,
        workCenterId: wc.id,
        status: { in: activeStatuses },
        ...(query.from || query.to
          ? {
              scheduledStartAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      },
      include: {
        productionBatch: {
          select: {
            id: true,
            batchNumber: true,
            name: true,
            priority: true,
            status: true,
            plannedOutputQty: true,
            outputItem: {
              select: { id: true, sku: true, name: true, unitOfMeasure: true },
            },
          },
        },
        assignedStaff: {
          select: { id: true, displayName: true, employeeCode: true },
        },
      },
      take: Math.min(Math.max(query.limit, 1), 200),
    });

    const sorted = [...ops].sort((a, b) => {
      const pDiff =
        PRIORITY_WEIGHT[b.productionBatch.priority] -
        PRIORITY_WEIGHT[a.productionBatch.priority];
      if (pDiff !== 0) return pDiff;
      const aTime = a.scheduledStartAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bTime = b.scheduledStartAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      if (aTime !== bTime) return aTime - bTime;
      return a.sequence - b.sequence;
    });

    // Aggregate daily capacity load across scheduled operations
    const loadByDay = new Map<string, number>();
    for (const op of sorted) {
      if (!op.scheduledStartAt) continue;
      const dayKey = op.scheduledStartAt.toISOString().slice(0, 10);
      const mins = op.plannedSetupMinutes + op.plannedRunMinutes;
      loadByDay.set(dayKey, (loadByDay.get(dayKey) ?? 0) + mins);
    }

    const dailyLoad = Array.from(loadByDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, scheduledMinutes]) => ({
        date,
        scheduledMinutes,
        dailyCapacityMinutes: wc.dailyCapacityMinutes,
        utilizationPct: Math.round(
          (scheduledMinutes / Math.max(1, wc.dailyCapacityMinutes)) * 100,
        ),
      }));

    return {
      workCenter: wc,
      queueCount: sorted.length,
      dailyLoad,
      queue: sorted,
    };
  }

  // ==========================================
  // Operations & Labor Time Logs
  // ==========================================

  async listOperations(tenant: AuthenticatedTenant, batchId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const batch = await this.prismaService.scoped.productionBatch.findFirst({
      where: { id: batchId, organizationId },
      select: { id: true, batchNumber: true },
    });
    if (!batch) {
      throw new NotFoundException("Production batch was not found.");
    }

    const operations = await this.prismaService.scoped.productionOperation.findMany({
      where: { organizationId, productionBatchId: batch.id },
      include: this.operationInclude(),
      orderBy: { sequence: "asc" },
    });

    return {
      productionBatchId: batch.id,
      batchNumber: batch.batchNumber,
      items: operations.map((op) => this.formatOperation(op)),
    };
  }

  async getOperation(
    tenant: AuthenticatedTenant,
    batchId: string,
    operationId: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const op = await this.prismaService.scoped.productionOperation.findFirst({
      where: { id: operationId, productionBatchId: batchId, organizationId },
      include: this.operationInclude(),
    });
    if (!op) {
      throw new NotFoundException("Production operation was not found.");
    }
    return this.formatOperation(op);
  }

  async startOperation(
    tenant: AuthenticatedTenant,
    batchId: string,
    operationId: string,
    assignedStaffId?: string | null,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const batch = await tx.productionBatch.findFirst({
        where: { id: batchId, organizationId },
      });
      if (!batch) {
        throw new NotFoundException("Production batch was not found.");
      }
      if (
        batch.status !== ProductionBatchStatus.RELEASED &&
        batch.status !== ProductionBatchStatus.IN_PROGRESS &&
        batch.status !== ProductionBatchStatus.PLANNED
      ) {
        throw new BadRequestException(
          `Cannot start operation while batch is in status "${batch.status}".`,
        );
      }

      const op = await tx.productionOperation.findFirst({
        where: { id: operationId, productionBatchId: batch.id, organizationId },
      });
      if (!op) {
        throw new NotFoundException("Production operation was not found.");
      }
      if (
        op.status !== ProductionOperationStatus.PENDING &&
        op.status !== ProductionOperationStatus.READY &&
        op.status !== ProductionOperationStatus.PAUSED
      ) {
        throw new BadRequestException(
          `Operation "${op.operationCode}" cannot be started from status "${op.status}".`,
        );
      }

      if (assignedStaffId) {
        const staff = await tx.staffProfile.findFirst({
          where: { id: assignedStaffId, organizationId },
        });
        if (!staff) {
          throw new NotFoundException("Assigned staff profile was not found.");
        }
      }

      const now = new Date();
      if (
        batch.status === ProductionBatchStatus.PLANNED ||
        batch.status === ProductionBatchStatus.RELEASED
      ) {
        await tx.productionBatch.update({
          where: { id: batch.id },
          data: {
            status: ProductionBatchStatus.IN_PROGRESS,
            startedAt: batch.startedAt ?? now,
            updatedByUserId: tenant.userId,
          },
        });
      }

      const updated = await tx.productionOperation.update({
        where: { id: op.id },
        data: {
          status: ProductionOperationStatus.IN_PROGRESS,
          actualStartAt: op.actualStartAt ?? now,
          ...(assignedStaffId !== undefined ? { assignedStaffId } : {}),
        },
        include: this.operationInclude(),
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.operation.started",
          resourceType: "ProductionOperation",
          resourceId: updated.id,
          metadata: {
            productionBatchId: batch.id,
            operationCode: updated.operationCode,
            sequence: updated.sequence,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return this.formatOperation(updated);
    });
  }

  async pauseOperation(
    tenant: AuthenticatedTenant,
    batchId: string,
    operationId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const op = await tx.productionOperation.findFirst({
        where: { id: operationId, productionBatchId: batchId, organizationId },
      });
      if (!op) {
        throw new NotFoundException("Production operation was not found.");
      }
      if (op.status !== ProductionOperationStatus.IN_PROGRESS) {
        throw new BadRequestException(
          `Only IN_PROGRESS operations can be paused (current status: ${op.status}).`,
        );
      }

      const updated = await tx.productionOperation.update({
        where: { id: op.id },
        data: { status: ProductionOperationStatus.PAUSED },
        include: this.operationInclude(),
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.operation.paused",
          resourceType: "ProductionOperation",
          resourceId: updated.id,
          metadata: {
            productionBatchId: batchId,
            operationCode: updated.operationCode,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return this.formatOperation(updated);
    });
  }

  async logTime(
    tenant: AuthenticatedTenant,
    batchId: string,
    operationId: string,
    input: LogOperationTimeInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const op = await tx.productionOperation.findFirst({
        where: { id: operationId, productionBatchId: batchId, organizationId },
        include: { workCenter: true, productionBatch: true },
      });
      if (!op) {
        throw new NotFoundException("Production operation was not found.");
      }

      if (input.staffId) {
        const staff = await tx.staffProfile.findFirst({
          where: { id: input.staffId, organizationId },
        });
        if (!staff) {
          throw new NotFoundException("Staff profile was not found.");
        }
      }

      const now = new Date();
      let savedLog;

      if (input.timeLogId) {
        const openLog = await tx.productionTimeLog.findFirst({
          where: {
            id: input.timeLogId,
            organizationId,
            productionOperationId: op.id,
          },
        });
        if (!openLog) {
          throw new NotFoundException("Time log entry was not found.");
        }
        const endedAt = input.endedAt ? new Date(input.endedAt) : now;
        const computedMinutes =
          input.durationMinutes ??
          Math.max(
            1,
            Math.round((endedAt.getTime() - openLog.startedAt.getTime()) / 60_000),
          );
        const costs = computeTimeLogCosts({
          durationMinutes: computedMinutes,
          hourlyLaborRateCents: openLog.hourlyLaborRateCents,
          hourlyMachineRateCents: openLog.hourlyMachineRateCents,
          overheadRateCents: openLog.overheadRateCents,
          overheadType: openLog.overheadType,
          units: op.completedQty || op.productionBatch.plannedOutputQty,
        });

        savedLog = await tx.productionTimeLog.update({
          where: { id: openLog.id },
          data: {
            endedAt,
            durationMinutes: computedMinutes,
            ...costs,
            ...(input.notes !== undefined
              ? { notes: input.notes?.trim() || null }
              : {}),
          },
        });
      } else {
        const startedAt = input.startedAt ? new Date(input.startedAt) : now;
        const endedAt = input.endedAt
          ? new Date(input.endedAt)
          : input.durationMinutes !== undefined
            ? new Date(startedAt.getTime() + input.durationMinutes * 60_000)
            : null;
        const computedMinutes =
          input.durationMinutes ??
          (endedAt
            ? Math.max(
                1,
                Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000),
              )
            : 0);

        if (endedAt && endedAt.getTime() < startedAt.getTime()) {
          throw new BadRequestException("endedAt cannot be before startedAt.");
        }

        const wc = op.workCenter;
        const costs =
          computedMinutes > 0
            ? computeTimeLogCosts({
                durationMinutes: computedMinutes,
                hourlyLaborRateCents: wc.hourlyLaborRateCents,
                hourlyMachineRateCents: wc.hourlyMachineRateCents,
                overheadRateCents: wc.overheadRateCents,
                overheadType: wc.overheadType,
                units: op.completedQty || op.productionBatch.plannedOutputQty,
              })
            : { laborCostCents: 0, machineCostCents: 0, overheadCostCents: 0 };

        savedLog = await tx.productionTimeLog.create({
          data: {
            organizationId,
            productionBatchId: batchId,
            productionOperationId: op.id,
            workCenterId: op.workCenterId,
            staffId: input.staffId ?? op.assignedStaffId ?? null,
            userId: tenant.userId,
            logType: input.logType ?? "RUN",
            startedAt,
            endedAt,
            durationMinutes: computedMinutes,
            hourlyLaborRateCents: wc.hourlyLaborRateCents,
            hourlyMachineRateCents: wc.hourlyMachineRateCents,
            overheadRateCents: wc.overheadRateCents,
            overheadType: wc.overheadType,
            ...costs,
            notes: input.notes?.trim() || null,
          },
        });
      }

      // Roll up actualSetupMinutes / actualRunMinutes on the operation
      const allOpLogs = await tx.productionTimeLog.findMany({
        where: { organizationId, productionOperationId: op.id },
      });
      const actualSetupMinutes = allOpLogs
        .filter((l) => l.logType === "SETUP")
        .reduce((s, l) => s + l.durationMinutes, 0);
      const actualRunMinutes = allOpLogs
        .filter((l) => l.logType !== "SETUP")
        .reduce((s, l) => s + l.durationMinutes, 0);

      await tx.productionOperation.update({
        where: { id: op.id },
        data: { actualSetupMinutes, actualRunMinutes },
      });

      const costing = await recalculateBatchCosting(tx, organizationId, batchId);

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.operation.time_logged",
          resourceType: "ProductionTimeLog",
          resourceId: savedLog.id,
          metadata: {
            productionBatchId: batchId,
            productionOperationId: op.id,
            logType: savedLog.logType,
            durationMinutes: savedLog.durationMinutes,
            laborCostCents: savedLog.laborCostCents,
            machineCostCents: savedLog.machineCostCents,
            overheadCostCents: savedLog.overheadCostCents,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return { timeLog: savedLog, costing };
    });
  }

  async completeOperation(
    tenant: AuthenticatedTenant,
    batchId: string,
    operationId: string,
    input: CompleteOperationInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const op = await tx.productionOperation.findFirst({
        where: { id: operationId, productionBatchId: batchId, organizationId },
        include: {
          productionBatch: true,
          routingOperation: true,
          qcCheckpoints: true,
        },
      });
      if (!op) {
        throw new NotFoundException("Production operation was not found.");
      }
      if (
        op.status === ProductionOperationStatus.COMPLETED ||
        op.status === ProductionOperationStatus.SKIPPED
      ) {
        throw new BadRequestException(
          `Operation "${op.operationCode}" is already ${op.status}.`,
        );
      }

      const now = new Date();
      const batch = op.productionBatch;
      const completedQty = input.completedQty ?? batch.plannedOutputQty;
      const scrapQty = input.scrapQty ?? 0;

      if (
        batch.status === ProductionBatchStatus.PLANNED ||
        batch.status === ProductionBatchStatus.RELEASED
      ) {
        await tx.productionBatch.update({
          where: { id: batch.id },
          data: {
            status: ProductionBatchStatus.IN_PROGRESS,
            startedAt: batch.startedAt ?? now,
            updatedByUserId: tenant.userId,
          },
        });
      }

      // Close any open timer logs on this operation
      const openTimers = await tx.productionTimeLog.findMany({
        where: {
          organizationId,
          productionOperationId: op.id,
          endedAt: null,
        },
      });
      for (const timer of openTimers) {
        const mins = Math.max(
          1,
          Math.round((now.getTime() - timer.startedAt.getTime()) / 60_000),
        );
        const costs = computeTimeLogCosts({
          durationMinutes: mins,
          hourlyLaborRateCents: timer.hourlyLaborRateCents,
          hourlyMachineRateCents: timer.hourlyMachineRateCents,
          overheadRateCents: timer.overheadRateCents,
          overheadType: timer.overheadType,
          units: completedQty,
        });
        await tx.productionTimeLog.update({
          where: { id: timer.id },
          data: { endedAt: now, durationMinutes: mins, ...costs },
        });
      }

      // Backflush materials bound to this operation sequence
      let backflushedConsumptions: unknown[] = [];
      if (input.backflushMaterials !== false) {
        backflushedConsumptions = await this.backflushReservationsTx(tx, tenant, batch, {
          operationSequence: op.sequence,
          productionOperationId: op.id,
          includeExpired: input.includeExpired,
          now,
        });
      }

      // Check QC gate requirement
      let nextOpStatus: ProductionOperationStatus =
        ProductionOperationStatus.COMPLETED;
      if (op.requiresQcGate) {
        let checkpoints = op.qcCheckpoints;
        if (checkpoints.length === 0) {
          const createdCp = await tx.productionQcCheckpoint.create({
            data: {
              organizationId,
              productionBatchId: batch.id,
              productionOperationId: op.id,
              checkpointType: ProductionQcCheckpointType.IN_PROCESS,
              code: `QC-OP-${op.sequence}`,
              name: `In-Process QC for ${op.name}`,
              status: ProductionQcCheckpointStatus.PENDING,
              checklistTemplate:
                op.routingOperation?.qcChecklistTemplate === null ||
                op.routingOperation?.qcChecklistTemplate === undefined
                  ? undefined
                  : (op.routingOperation
                      .qcChecklistTemplate as Prisma.InputJsonValue),
            },
          });
          checkpoints = [createdCp];
        }

        const hasOpenOrFailedQc = checkpoints.some(
          (cp) =>
            cp.status !== ProductionQcCheckpointStatus.PASSED &&
            cp.status !== ProductionQcCheckpointStatus.WAIVED,
        );
        if (hasOpenOrFailedQc) {
          nextOpStatus = ProductionOperationStatus.QC_PENDING;
        }
      }

      const allOpLogs = await tx.productionTimeLog.findMany({
        where: { organizationId, productionOperationId: op.id },
      });
      const actualSetupMinutes = allOpLogs
        .filter((l) => l.logType === "SETUP")
        .reduce((s, l) => s + l.durationMinutes, 0);
      const actualRunMinutes = allOpLogs
        .filter((l) => l.logType !== "SETUP")
        .reduce((s, l) => s + l.durationMinutes, 0);

      const updatedOp = await tx.productionOperation.update({
        where: { id: op.id },
        data: {
          status: nextOpStatus,
          actualStartAt: op.actualStartAt ?? now,
          actualEndAt: now,
          completedQty,
          scrapQty,
          actualSetupMinutes,
          actualRunMinutes,
          operatorSignOffUserId: tenant.userId,
          signedOffAt: now,
          signOffNotes: input.signOffNotes?.trim() || null,
          ...(backflushedConsumptions.length > 0
            ? { backflushedAt: now }
            : {}),
        },
        include: this.operationInclude(),
      });

      // Advance next PENDING operation to READY if current step finished cleanly
      if (nextOpStatus === ProductionOperationStatus.COMPLETED) {
        const nextOp = await tx.productionOperation.findFirst({
          where: {
            organizationId,
            productionBatchId: batch.id,
            sequence: { gt: op.sequence },
            status: ProductionOperationStatus.PENDING,
          },
          orderBy: { sequence: "asc" },
        });
        if (nextOp) {
          await tx.productionOperation.update({
            where: { id: nextOp.id },
            data: { status: ProductionOperationStatus.READY },
          });
        }
      }

      const costing = await recalculateBatchCosting(tx, organizationId, batch.id);

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.operation.completed",
          resourceType: "ProductionOperation",
          resourceId: updatedOp.id,
          metadata: {
            productionBatchId: batch.id,
            operationCode: updatedOp.operationCode,
            status: updatedOp.status,
            completedQty,
            scrapQty,
            backflushedCount: backflushedConsumptions.length,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        operation: this.formatOperation(updatedOp),
        backflushedConsumptions,
        costing,
      };
    });
  }

  async listOperationFiles(
    tenant: AuthenticatedTenant,
    batchId: string,
    operationId: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const op = await this.prismaService.scoped.productionOperation.findFirst({
      where: { id: operationId, productionBatchId: batchId, organizationId },
      select: { id: true, operationCode: true },
    });
    if (!op) {
      throw new NotFoundException("Production operation was not found.");
    }
    const items = await this.attachmentsService.listForTarget(tenant, {
      productionOperationId: op.id,
    });
    return {
      organizationId,
      productionBatchId: batchId,
      productionOperationId: op.id,
      items,
    };
  }

  async addOperationFile(
    tenant: AuthenticatedTenant,
    batchId: string,
    operationId: string,
    req: FastifyRequest,
    body: unknown,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const op = await this.prismaService.scoped.productionOperation.findFirst({
      where: { id: operationId, productionBatchId: batchId, organizationId },
      select: { id: true },
    });
    if (!op) {
      throw new NotFoundException("Production operation was not found.");
    }

    return this.attachmentsService.handleUploadOrLinkRequest(tenant, req, body, {
      entityType: StorageEntityType.PRODUCTION_OPERATION,
      entityId: op.id,
      target: { productionOperationId: op.id },
    });
  }

  async removeOperationFile(
    tenant: AuthenticatedTenant,
    batchId: string,
    operationId: string,
    attachmentId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const op = await this.prismaService.scoped.productionOperation.findFirst({
      where: { id: operationId, productionBatchId: batchId, organizationId },
      select: { id: true },
    });
    if (!op) {
      throw new NotFoundException("Production operation was not found.");
    }
    return this.attachmentsService.removeAttachment(
      tenant,
      attachmentId,
      { productionOperationId: op.id },
      ipAddress,
    );
  }

  // ==========================================
  // QC Checkpoints & Batch Release Gate
  // ==========================================

  async createQcCheckpoint(
    tenant: AuthenticatedTenant,
    batchId: string,
    input: CreateQcCheckpointInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const batch = await tx.productionBatch.findFirst({
        where: { id: batchId, organizationId },
      });
      if (!batch) {
        throw new NotFoundException("Production batch was not found.");
      }

      if (input.productionOperationId) {
        const op = await tx.productionOperation.findFirst({
          where: {
            id: input.productionOperationId,
            productionBatchId: batch.id,
            organizationId,
          },
        });
        if (!op) {
          throw new NotFoundException("Production operation was not found.");
        }
      }

      const created = await tx.productionQcCheckpoint.create({
        data: {
          organizationId,
          productionBatchId: batch.id,
          productionOperationId: input.productionOperationId ?? null,
          checkpointType:
            input.checkpointType ??
            (input.productionOperationId
              ? ProductionQcCheckpointType.IN_PROCESS
              : ProductionQcCheckpointType.FINAL_RELEASE),
          code: input.code.trim().toUpperCase(),
          name: input.name.trim(),
          status: ProductionQcCheckpointStatus.PENDING,
          checklistTemplate:
            input.checklistTemplate === undefined
              ? undefined
              : input.checklistTemplate === null
                ? Prisma.DbNull
                : (input.checklistTemplate as Prisma.InputJsonValue),
          notes: input.notes?.trim() || null,
        },
        include: this.qcCheckpointInclude(),
      });

      if (batch.qcStatus === ProductionQcStatus.NOT_REQUIRED) {
        await tx.productionBatch.update({
          where: { id: batch.id },
          data: { qcStatus: ProductionQcStatus.PENDING },
        });
      }

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.qc_checkpoint.created",
          resourceType: "ProductionQcCheckpoint",
          resourceId: created.id,
          metadata: {
            productionBatchId: batch.id,
            code: created.code,
            checkpointType: created.checkpointType,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return this.formatQcCheckpoint(created);
    });
  }

  async inspectQcCheckpoint(
    tenant: AuthenticatedTenant,
    batchId: string,
    checkpointId: string,
    input: InspectQcCheckpointInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const result = await this.prismaService.raw.$transaction(async (tx) => {
      const cp = await tx.productionQcCheckpoint.findFirst({
        where: { id: checkpointId, productionBatchId: batchId, organizationId },
      });
      if (!cp) {
        throw new NotFoundException("QC checkpoint was not found.");
      }

      const now = new Date();
      const status =
        input.status === "PASSED"
          ? ProductionQcCheckpointStatus.PASSED
          : input.status === "FAILED"
            ? ProductionQcCheckpointStatus.FAILED
            : ProductionQcCheckpointStatus.WAIVED;

      const updated = await tx.productionQcCheckpoint.update({
        where: { id: cp.id },
        data: {
          status,
          checklistResults:
            input.checklistResults === undefined
              ? undefined
              : input.checklistResults === null
                ? Prisma.DbNull
                : (input.checklistResults as Prisma.InputJsonValue),
          disposition: input.disposition?.trim() || null,
          inspectorUserId: tenant.userId,
          inspectedAt: now,
          ...(input.notes !== undefined
            ? { notes: input.notes?.trim() || null }
            : {}),
        },
        include: this.qcCheckpointInclude(),
      });

      // If linked to a QC_PENDING operation and all checkpoints for that operation are now PASSED/WAIVED, mark operation COMPLETED and advance next step
      if (cp.productionOperationId) {
        const op = await tx.productionOperation.findFirst({
          where: { id: cp.productionOperationId, organizationId },
          include: { qcCheckpoints: true },
        });
        if (
          op &&
          op.status === ProductionOperationStatus.QC_PENDING &&
          op.qcCheckpoints.every(
            (c) =>
              c.status === ProductionQcCheckpointStatus.PASSED ||
              c.status === ProductionQcCheckpointStatus.WAIVED,
          )
        ) {
          await tx.productionOperation.update({
            where: { id: op.id },
            data: { status: ProductionOperationStatus.COMPLETED },
          });

          const nextOp = await tx.productionOperation.findFirst({
            where: {
              organizationId,
              productionBatchId: batchId,
              sequence: { gt: op.sequence },
              status: ProductionOperationStatus.PENDING,
            },
            orderBy: { sequence: "asc" },
          });
          if (nextOp) {
            await tx.productionOperation.update({
              where: { id: nextOp.id },
              data: { status: ProductionOperationStatus.READY },
            });
          }
        }
      }

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.qc_checkpoint.inspected",
          resourceType: "ProductionQcCheckpoint",
          resourceId: updated.id,
          metadata: {
            productionBatchId: batchId,
            code: updated.code,
            status: updated.status,
            disposition: updated.disposition,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return this.formatQcCheckpoint(updated);
    });

    this.analyticsService.captureDomainEvent({
      event: "production_qc.inspected",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        production_batch_id: batchId,
        checkpoint_id: result.id,
        checkpoint_code: result.code,
        status: result.status,
      },
    });

    return result;
  }

  async qcReleaseBatch(
    tenant: AuthenticatedTenant,
    batchId: string,
    input: QcReleaseBatchInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const result = await this.prismaService.raw.$transaction(async (tx) => {
      const batch = await tx.productionBatch.findFirst({
        where: { id: batchId, organizationId },
        include: {
          outputItem: true,
          outputLot: true,
          qcCheckpoints: true,
        },
      });
      if (!batch) {
        throw new NotFoundException("Production batch was not found.");
      }

      if (
        batch.status !== ProductionBatchStatus.QC_HOLD &&
        !(
          batch.status === ProductionBatchStatus.COMPLETED &&
          batch.qcStatus === ProductionQcStatus.PENDING
        )
      ) {
        throw new BadRequestException(
          `Batch cannot undergo QC release from status "${batch.status}" / qcStatus "${batch.qcStatus}".`,
        );
      }

      const now = new Date();

      if (input.disposition === "RELEASE") {
        const failed = batch.qcCheckpoints.filter(
          (cp) => cp.status === ProductionQcCheckpointStatus.FAILED,
        );
        if (failed.length > 0) {
          throw new BadRequestException(
            `Cannot release batch while ${failed.length} QC checkpoint(s) have FAILED status.`,
          );
        }

        const pending = batch.qcCheckpoints.filter(
          (cp) => cp.status === ProductionQcCheckpointStatus.PENDING,
        );
        if (pending.length > 0) {
          if (!input.waivePendingCheckpoints) {
            throw new BadRequestException(
              `Cannot release batch while ${pending.length} QC checkpoint(s) are still PENDING. Pass waivePendingCheckpoints: true or inspect them first.`,
            );
          }
          await tx.productionQcCheckpoint.updateMany({
            where: {
              organizationId,
              productionBatchId: batch.id,
              status: ProductionQcCheckpointStatus.PENDING,
            },
            data: {
              status: ProductionQcCheckpointStatus.WAIVED,
              inspectorUserId: tenant.userId,
              inspectedAt: now,
              notes: input.notes?.trim() || "Waived during final QC release",
            },
          });
        }

        const releaseQty =
          batch.outputLot && batch.outputLot.quarantinedQty > 0
            ? batch.outputLot.quarantinedQty
            : batch.actualOutputQty;

        if (batch.outputLot && batch.outputLot.quarantinedQty > 0) {
          await tx.stockLot.update({
            where: { id: batch.outputLot.id },
            data: {
              quarantinedQty: 0,
              onHandQty: { increment: batch.outputLot.quarantinedQty },
            },
          });
        }

        if (batch.outputItem?.trackInventory && releaseQty > 0) {
          const bal = await tx.stockBalance.upsert({
            where: {
              organizationId_itemId_locationId: {
                organizationId,
                itemId: batch.outputItem.id,
                locationId: batch.locationId,
              },
            },
            create: {
              organizationId,
              itemId: batch.outputItem.id,
              locationId: batch.locationId,
              onHandQty: releaseQty,
              reservedQty: 0,
            },
            update: {
              onHandQty: { increment: releaseQty },
            },
          });

          await tx.stockMovement.create({
            data: {
              organizationId,
              itemId: batch.outputItem.id,
              locationId: batch.locationId,
              type: StockMovementType.PRODUCTION_OUTPUT,
              quantityDelta: releaseQty,
              balanceAfter: bal.onHandQty,
              referenceType: "ProductionBatch",
              referenceId: batch.id,
              reason: `QC released production batch ${batch.batchNumber}`,
              actorUserId: tenant.userId,
            },
          });
        }

        await tx.productionBatch.update({
          where: { id: batch.id },
          data: {
            status: ProductionBatchStatus.COMPLETED,
            qcStatus: ProductionQcStatus.PASSED,
            qcReleasedAt: now,
            qcReleasedByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
          },
        });
      } else if (input.disposition === "SCRAP") {
        const scrappedQty =
          batch.outputLot?.quarantinedQty ?? batch.actualOutputQty;
        if (batch.outputLot && batch.outputLot.quarantinedQty > 0) {
          await tx.stockLot.update({
            where: { id: batch.outputLot.id },
            data: {
              quarantinedQty: 0,
              consumedQty: { increment: batch.outputLot.quarantinedQty },
            },
          });
        }

        await tx.productionBatch.update({
          where: { id: batch.id },
          data: {
            status: ProductionBatchStatus.COMPLETED,
            qcStatus: ProductionQcStatus.FAILED,
            actualOutputQty: 0,
            scrapQty: { increment: scrappedQty },
            qcReleasedAt: now,
            qcReleasedByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
          },
        });
      } else {
        // QUARANTINE
        await tx.productionBatch.update({
          where: { id: batch.id },
          data: {
            status: ProductionBatchStatus.QC_HOLD,
            qcStatus: ProductionQcStatus.FAILED,
            updatedByUserId: tenant.userId,
          },
        });
      }

      const costing = await recalculateBatchCosting(tx, organizationId, batch.id);

      const refreshed = await tx.productionBatch.findFirstOrThrow({
        where: { id: batch.id, organizationId },
        include: {
          outputLot: true,
          qcCheckpoints: {
            include: this.qcCheckpointInclude(),
          },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.batch.qc_released",
          resourceType: "ProductionBatch",
          resourceId: batch.id,
          metadata: {
            batchNumber: batch.batchNumber,
            disposition: input.disposition,
            qcStatus: refreshed.qcStatus,
            status: refreshed.status,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        id: refreshed.id,
        batchNumber: refreshed.batchNumber,
        status: refreshed.status,
        qcStatus: refreshed.qcStatus,
        qcReleasedAt: refreshed.qcReleasedAt,
        qcReleasedByUserId: refreshed.qcReleasedByUserId,
        outputLot: refreshed.outputLot,
        qcCheckpoints: refreshed.qcCheckpoints.map((c) =>
          this.formatQcCheckpoint(c),
        ),
        costing,
      };
    });

    this.analyticsService.captureDomainEvent({
      event: "production_batch.qc_released",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        production_batch_id: result.id,
        batch_number: result.batchNumber,
        disposition: input.disposition,
        qc_status: result.qcStatus,
        status: result.status,
      },
    });

    return result;
  }

  async listQcCheckpointFiles(
    tenant: AuthenticatedTenant,
    batchId: string,
    checkpointId: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const cp = await this.prismaService.scoped.productionQcCheckpoint.findFirst({
      where: { id: checkpointId, productionBatchId: batchId, organizationId },
      select: { id: true, code: true },
    });
    if (!cp) {
      throw new NotFoundException("QC checkpoint was not found.");
    }
    const items = await this.attachmentsService.listForTarget(tenant, {
      productionQcCheckpointId: cp.id,
    });
    return {
      organizationId,
      productionBatchId: batchId,
      productionQcCheckpointId: cp.id,
      items,
    };
  }

  async addQcCheckpointFile(
    tenant: AuthenticatedTenant,
    batchId: string,
    checkpointId: string,
    req: FastifyRequest,
    body: unknown,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const cp = await this.prismaService.scoped.productionQcCheckpoint.findFirst({
      where: { id: checkpointId, productionBatchId: batchId, organizationId },
      select: { id: true },
    });
    if (!cp) {
      throw new NotFoundException("QC checkpoint was not found.");
    }

    return this.attachmentsService.handleUploadOrLinkRequest(tenant, req, body, {
      entityType: StorageEntityType.PRODUCTION_QC_CHECKPOINT,
      entityId: cp.id,
      target: { productionQcCheckpointId: cp.id },
    });
  }

  async removeQcCheckpointFile(
    tenant: AuthenticatedTenant,
    batchId: string,
    checkpointId: string,
    attachmentId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const cp = await this.prismaService.scoped.productionQcCheckpoint.findFirst({
      where: { id: checkpointId, productionBatchId: batchId, organizationId },
      select: { id: true },
    });
    if (!cp) {
      throw new NotFoundException("QC checkpoint was not found.");
    }
    return this.attachmentsService.removeAttachment(
      tenant,
      attachmentId,
      { productionQcCheckpointId: cp.id },
      ipAddress,
    );
  }

  // ==========================================
  // Costing, Variance & Batch Close
  // ==========================================

  async addCostEntry(
    tenant: AuthenticatedTenant,
    batchId: string,
    input: AddCostEntryInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const batch = await tx.productionBatch.findFirst({
        where: { id: batchId, organizationId },
      });
      if (!batch) {
        throw new NotFoundException("Production batch was not found.");
      }
      if (
        batch.status === ProductionBatchStatus.CLOSED ||
        batch.status === ProductionBatchStatus.CANCELLED
      ) {
        throw new BadRequestException(
          `Cannot add cost entries to batch in status "${batch.status}".`,
        );
      }

      const entry = await tx.productionCostEntry.create({
        data: {
          organizationId,
          productionBatchId: batch.id,
          category: input.category,
          description: input.description.trim(),
          quantity: input.quantity ?? 1,
          unitCostCents: input.unitCostCents ?? input.totalCostCents,
          totalCostCents: input.totalCostCents,
          isStandard: false,
          createdByUserId: tenant.userId,
        },
      });

      const costing = await recalculateBatchCosting(tx, organizationId, batch.id);

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.cost_entry.added",
          resourceType: "ProductionCostEntry",
          resourceId: entry.id,
          metadata: {
            productionBatchId: batch.id,
            category: entry.category,
            totalCostCents: entry.totalCostCents,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return { entry, costing };
    });
  }

  async getBatchCosting(tenant: AuthenticatedTenant, batchId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const summary = await recalculateBatchCosting(tx, organizationId, batchId);
      if (!summary) {
        throw new NotFoundException("Production batch was not found.");
      }
      const entries = await tx.productionCostEntry.findMany({
        where: { organizationId, productionBatchId: batchId },
        orderBy: { createdAt: "asc" },
      });
      return {
        ...summary,
        costEntries: entries,
      };
    });
  }

  async closeBatch(
    tenant: AuthenticatedTenant,
    batchId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const batch = await tx.productionBatch.findFirst({
        where: { id: batchId, organizationId },
      });
      if (!batch) {
        throw new NotFoundException("Production batch was not found.");
      }
      if (batch.status !== ProductionBatchStatus.COMPLETED) {
        throw new BadRequestException(
          `Only COMPLETED batches can be financially closed (current status: ${batch.status}).`,
        );
      }

      await this.releaseUnusedReservationsTx(tx, organizationId, batch.id);
      const costing = await recalculateBatchCosting(tx, organizationId, batch.id);

      const closed = await tx.productionBatch.update({
        where: { id: batch.id },
        data: {
          status: ProductionBatchStatus.CLOSED,
          closedAt: new Date(),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.batch.closed",
          resourceType: "ProductionBatch",
          resourceId: closed.id,
          metadata: {
            batchNumber: closed.batchNumber,
            actualTotalCostCents: closed.actualTotalCostCents,
            costVarianceCents: closed.costVarianceCents,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        id: closed.id,
        batchNumber: closed.batchNumber,
        status: closed.status,
        closedAt: closed.closedAt,
        costing,
      };
    });
  }

  // ==========================================
  // Electronic Batch Record (eBR)
  // ==========================================

  async getElectronicBatchRecord(tenant: AuthenticatedTenant, batchId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const batch = await this.prismaService.scoped.productionBatch.findFirst({
      where: { id: batchId, organizationId },
      include: {
        location: { select: { id: true, code: true, name: true, type: true } },
        bom: {
          include: {
            lines: {
              include: {
                componentItem: {
                  select: { id: true, sku: true, name: true, unitOfMeasure: true },
                },
              },
              orderBy: { lineNumber: "asc" },
            },
          },
        },
        routing: {
          select: { id: true, code: true, name: true, version: true },
        },
        parentBatch: {
          select: { id: true, batchNumber: true, status: true },
        },
        childBatches: {
          select: {
            id: true,
            batchNumber: true,
            status: true,
            plannedOutputQty: true,
            actualOutputQty: true,
            outputItem: { select: { id: true, sku: true, name: true } },
          },
        },
        outputItem: {
          select: { id: true, sku: true, name: true, type: true, unitOfMeasure: true },
        },
        outputLot: {
          select: {
            id: true,
            lotNumber: true,
            batchCode: true,
            initialQty: true,
            onHandQty: true,
            quarantinedQty: true,
            unitCostCents: true,
            manufacturedAt: true,
            expiresAt: true,
          },
        },
        reservations: {
          include: {
            item: { select: { id: true, sku: true, name: true, unitOfMeasure: true } },
          },
          orderBy: { createdAt: "asc" },
        },
        operations: {
          include: this.operationInclude(),
          orderBy: { sequence: "asc" },
        },
        timeLogs: {
          include: {
            workCenter: { select: { id: true, code: true, name: true } },
            staff: { select: { id: true, displayName: true, employeeCode: true } },
          },
          orderBy: { startedAt: "asc" },
        },
        qcCheckpoints: {
          include: this.qcCheckpointInclude(),
          orderBy: { createdAt: "asc" },
        },
        costEntries: {
          orderBy: { createdAt: "asc" },
        },
        documentAttachments: {
          include: {
            storedObject: { select: STORED_OBJECT_SUMMARY_SELECT },
          },
          orderBy: { createdAt: "asc" },
        },
        consumptions: {
          include: {
            item: {
              select: { id: true, sku: true, name: true, type: true, unitOfMeasure: true },
            },
            pack: {
              select: { id: true, code: true, name: true, unitOfMeasure: true, unitsPerPack: true },
            },
            location: { select: { id: true, code: true, name: true } },
            stockLot: {
              include: {
                supplier: { select: { id: true, code: true, name: true } },
                supplierItem: { select: { id: true, supplierSku: true, unitCostCents: true } },
                documentAttachments: {
                  include: { storedObject: { select: STORED_OBJECT_SUMMARY_SELECT } },
                  orderBy: { createdAt: "desc" },
                },
                goodsReceiptLine: {
                  select: {
                    id: true,
                    lotNumber: true,
                    batchCode: true,
                    supplierBatchNumber: true,
                    documentAttachments: {
                      include: { storedObject: { select: STORED_OBJECT_SUMMARY_SELECT } },
                      orderBy: { createdAt: "desc" },
                    },
                    goodsReceipt: {
                      select: {
                        id: true,
                        receiptNumber: true,
                        deliveredAt: true,
                        acceptedAt: true,
                        purchaseOrder: {
                          select: { id: true, poNumber: true, supplierId: true },
                        },
                        documentAttachments: {
                          include: { storedObject: { select: STORED_OBJECT_SUMMARY_SELECT } },
                          orderBy: { createdAt: "desc" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: { consumedAt: "asc" },
        },
      },
    });

    if (!batch) {
      throw new NotFoundException("Production batch was not found.");
    }

    const costing = await this.getBatchCosting(tenant, batch.id);

    return {
      recordGeneratedAt: new Date().toISOString(),
      batch: {
        id: batch.id,
        batchNumber: batch.batchNumber,
        name: batch.name,
        status: batch.status,
        priority: batch.priority,
        qcStatus: batch.qcStatus,
        requiresFinalQcRelease: batch.requiresFinalQcRelease,
        location: batch.location,
        outputItem: batch.outputItem,
        outputLot: batch.outputLot,
        plannedOutputQty: batch.plannedOutputQty,
        actualOutputQty: batch.actualOutputQty,
        scrapQty: batch.scrapQty,
        scheduledStartAt: batch.scheduledStartAt,
        scheduledEndAt: batch.scheduledEndAt,
        releasedAt: batch.releasedAt,
        releasedByUserId: batch.releasedByUserId,
        startedAt: batch.startedAt,
        completedAt: batch.completedAt,
        qcReleasedAt: batch.qcReleasedAt,
        qcReleasedByUserId: batch.qcReleasedByUserId,
        closedAt: batch.closedAt,
        createdByUserId: batch.createdByUserId,
      },
      engineering: {
        bom: batch.bom,
        routing: batch.routing,
      },
      hierarchy: {
        parentBatch: batch.parentBatch,
        childBatches: batch.childBatches,
      },
      materialReservations: batch.reservations,
      operations: batch.operations.map((op) => this.formatOperation(op)),
      timeLogs: batch.timeLogs,
      consumedLots: batch.consumptions.map((c) => ({
        ...c,
        stockLot: {
          ...c.stockLot,
          documentAttachments: c.stockLot.documentAttachments.map((a) =>
            this.attachmentsService.serializeAttachment(a),
          ),
          goodsReceiptLine: c.stockLot.goodsReceiptLine
            ? {
                ...c.stockLot.goodsReceiptLine,
                documentAttachments:
                  c.stockLot.goodsReceiptLine.documentAttachments.map((a) =>
                    this.attachmentsService.serializeAttachment(a),
                  ),
                goodsReceipt: {
                  ...c.stockLot.goodsReceiptLine.goodsReceipt,
                  documentAttachments:
                    c.stockLot.goodsReceiptLine.goodsReceipt.documentAttachments.map(
                      (a) => this.attachmentsService.serializeAttachment(a),
                    ),
                },
              }
            : null,
        },
      })),
      qcCheckpoints: batch.qcCheckpoints.map((cp) =>
        this.formatQcCheckpoint(cp),
      ),
      batchAttachments: batch.documentAttachments.map((a) =>
        this.attachmentsService.serializeAttachment(a),
      ),
      costing,
    };
  }

  // ==========================================
  // Private Helpers
  // ==========================================

  private operationInclude() {
    return {
      workCenter: {
        select: {
          id: true,
          code: true,
          name: true,
          hourlyLaborRateCents: true,
          hourlyMachineRateCents: true,
          overheadRateCents: true,
          overheadType: true,
        },
      },
      assignedStaff: {
        select: { id: true, displayName: true, employeeCode: true },
      },
      timeLogs: {
        include: {
          staff: { select: { id: true, displayName: true, employeeCode: true } },
        },
        orderBy: { startedAt: "asc" as const },
      },
      qcCheckpoints: {
        include: this.qcCheckpointInclude(),
        orderBy: { createdAt: "asc" as const },
      },
      documentAttachments: {
        include: { storedObject: { select: STORED_OBJECT_SUMMARY_SELECT } },
        orderBy: { createdAt: "desc" as const },
      },
    } as const;
  }

  private qcCheckpointInclude() {
    return {
      documentAttachments: {
        include: { storedObject: { select: STORED_OBJECT_SUMMARY_SELECT } },
        orderBy: { createdAt: "desc" as const },
      },
    } as const;
  }

  private formatOperation<
    T extends {
      documentAttachments?: Array<{ storedObject?: any }>;
      qcCheckpoints?: Array<{ documentAttachments?: Array<{ storedObject?: any }> }>;
    },
  >(op: T) {
    return {
      ...op,
      ...(op.documentAttachments
        ? {
            documentAttachments: op.documentAttachments.map((a) =>
              this.attachmentsService.serializeAttachment(a),
            ),
          }
        : {}),
      ...(op.qcCheckpoints
        ? {
            qcCheckpoints: op.qcCheckpoints.map((cp) =>
              this.formatQcCheckpoint(cp),
            ),
          }
        : {}),
    };
  }

  private formatQcCheckpoint<
    T extends {
      documentAttachments?: Array<{ storedObject?: any }>;
    },
  >(cp: T) {
    return {
      ...cp,
      ...(cp.documentAttachments
        ? {
            documentAttachments: cp.documentAttachments.map((a) =>
              this.attachmentsService.serializeAttachment(a),
            ),
          }
        : {}),
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

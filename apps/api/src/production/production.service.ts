import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  BomStatus,
  ItemStatus,
  LocationStatus,
  LotAllocationStrategy,
  Prisma,
  ProductionBatchStatus,
  ProductionOperationStatus,
  ProductionPriority,
  ProductionQcCheckpointStatus,
  ProductionQcCheckpointType,
  ProductionQcStatus,
  RoutingStatus,
  StockMovementType,
  StorageEntityType,
  SubAssemblyStrategy,
  OrganizationContext,
} from "@scace/db";
import type { FastifyRequest } from "fastify";
import { PrismaService } from "../database/prisma.service.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import {
  InventoryService,
  type SuggestLotsInput,
} from "../locations/inventory.service.js";
import { computeExpiresAtFromShelfLife } from "../locations/lot-allocation.utils.js";
import {
  type BulkQuantityInput,
} from "../procurement/delivery-units.utils.js";
import {
  type AttachmentInput,
  AttachmentsService,
  STORED_OBJECT_SUMMARY_SELECT,
} from "../storage/attachments.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { ProductionEngineeringService } from "./engineering.service.js";
import {
  computeTimeLogCosts,
  recalculateBatchCosting,
  resolveItemStandardUnitCostCents,
} from "./production-costing.utils.js";
import { ProductionExecutionService } from "./production-execution.service.js";

export interface CreateProductionBatchInput {
  batchNumber?: string;
  name?: string | null;
  locationId: string;
  outputItemId?: string | null;
  bomId?: string | null;
  routingId?: string | null;
  useDefaultEngineering?: boolean;
  autoCreateSubAssemblyBatches?: boolean;
  parentBatchId?: string | null;
  plannedOutputQty?: number;
  priority?: ProductionPriority;
  requiresFinalQcRelease?: boolean;
  scheduledStartAt?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
  attachments?: AttachmentInput[];
}

export interface ReleaseProductionBatchInput {
  strictReserve?: boolean;
  autoSchedule?: boolean;
  scheduledStartAt?: string | null;
}

export interface ListProductionBatchesQuery {
  status?: ProductionBatchStatus;
  priority?: ProductionPriority;
  locationId?: string;
  outputItemId?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface ConsumeMaterialLineInput extends BulkQuantityInput {
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

export interface ConsumeMaterialsInput {
  lines: ConsumeMaterialLineInput[];
}

export interface CompleteProductionBatchInput {
  actualOutputQty?: number;
  scrapQty?: number;
  createOutputLot?: boolean;
  outputLotNumber?: string | null;
  outputBatchCode?: string | null;
  manufacturedAt?: string | null;
  expiresAt?: string | null;
  backflushRemaining?: boolean;
  includeExpired?: boolean;
  notes?: string | null;
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
export class ProductionService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(InventoryService)
    private readonly inventoryService: InventoryService,
    @Inject(AttachmentsService)
    private readonly attachmentsService: AttachmentsService,
    @Inject(ProductionEngineeringService)
    private readonly engineeringService: ProductionEngineeringService,
    @Inject(ProductionExecutionService)
    private readonly executionService: ProductionExecutionService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  async createBatch(
    tenant: AuthenticatedOrganization,
    input: CreateProductionBatchInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const batchNumber =
      input.batchNumber?.trim().toUpperCase() ||
      `PRD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    try {
      const createdId = await this.prismaService.raw.$transaction(async (tx) => {
        const created = await this.createBatchTreeTx(
          tx,
          tenant,
          { ...input, batchNumber },
          new Set<string>(),
          ipAddress,
        );
        return created.id;
      });

      const batch = await this.prismaService.scoped.productionBatch.findFirstOrThrow({
        where: { id: createdId, organizationId },
        include: this.batchInclude(),
      });

      this.analyticsService.captureDomainEvent({
        event: "production_batch.created",
        distinctId: tenant.userId,
        organizationId,
        properties: {
          production_batch_id: batch.id,
          batch_number: batch.batchNumber,
          location_id: batch.locationId,
          planned_output_qty: batch.plannedOutputQty,
          priority: batch.priority,
          requires_final_qc_release: batch.requiresFinalQcRelease,
        },
      });

      return this.formatBatchResponse(batch);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `Production batch number "${batchNumber}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  private async createBatchTreeTx(
    tx: Prisma.TransactionClient,
    tenant: AuthenticatedOrganization,
    input: CreateProductionBatchInput & { batchNumber: string },
    visitedItems: Set<string>,
    ipAddress?: string,
  ) {
    const organizationId = tenant.organizationId;

    const location = await tx.location.findFirst({
      where: { id: input.locationId, organizationId },
    });
    if (!location || location.status !== LocationStatus.ACTIVE) {
      throw new BadRequestException(
        "Production location must exist and be ACTIVE.",
      );
    }

    let resolvedOutputItemId = input.outputItemId ?? null;
    if (resolvedOutputItemId) {
      const outputItem = await tx.item.findFirst({
        where: { id: resolvedOutputItemId, organizationId },
      });
      if (!outputItem) {
        throw new NotFoundException("Output catalog item was not found.");
      }
      if (outputItem.status === ItemStatus.ARCHIVED) {
        throw new BadRequestException(
          `Output item "${outputItem.sku}" is archived.`,
        );
      }
    }

    // Resolve BOM
    let bom = null;
    if (input.bomId) {
      bom = await tx.billOfMaterial.findFirst({
        where: { id: input.bomId, organizationId },
        include: {
          lines: {
            include: { componentItem: true },
            orderBy: { lineNumber: "asc" },
          },
        },
      });
      if (!bom) {
        throw new NotFoundException("Bill of materials was not found.");
      }
      if (bom.status === BomStatus.OBSOLETE) {
        throw new BadRequestException(
          `BOM "${bom.code}" v${bom.version} is OBSOLETE.`,
        );
      }
      if (!resolvedOutputItemId) {
        resolvedOutputItemId = bom.itemId;
      } else if (bom.itemId !== resolvedOutputItemId) {
        throw new BadRequestException(
          "Selected BOM does not match the batch outputItemId.",
        );
      }
    } else if (resolvedOutputItemId && input.useDefaultEngineering !== false) {
      bom = await tx.billOfMaterial.findFirst({
        where: {
          organizationId,
          itemId: resolvedOutputItemId,
          status: BomStatus.ACTIVE,
        },
        include: {
          lines: {
            include: { componentItem: true },
            orderBy: { lineNumber: "asc" },
          },
        },
        orderBy: [{ isDefault: "desc" }, { version: "desc" }],
      });
    }

    // Resolve Routing
    let routing = null;
    if (input.routingId) {
      routing = await tx.routing.findFirst({
        where: { id: input.routingId, organizationId },
        include: {
          operations: {
            include: { workCenter: true },
            orderBy: { sequence: "asc" },
          },
        },
      });
      if (!routing) {
        throw new NotFoundException("Routing was not found.");
      }
      if (routing.status === RoutingStatus.OBSOLETE) {
        throw new BadRequestException(
          `Routing "${routing.code}" v${routing.version} is OBSOLETE.`,
        );
      }
    } else if (resolvedOutputItemId && input.useDefaultEngineering !== false) {
      routing = await tx.routing.findFirst({
        where: {
          organizationId,
          itemId: resolvedOutputItemId,
          status: RoutingStatus.ACTIVE,
        },
        include: {
          operations: {
            include: { workCenter: true },
            orderBy: { sequence: "asc" },
          },
        },
        orderBy: [{ isDefault: "desc" }, { version: "desc" }],
      });
    }

    const plannedOutputQty = input.plannedOutputQty ?? (bom ? bom.yieldQty : 0);
    const requiresFinalQcRelease = Boolean(input.requiresFinalQcRelease);

    // Compute Standard Costs
    let standardMaterialCostCents = 0;
    const reservationCreates: Array<{
      organizationId: string;
      bomLineId: string;
      itemId: string;
      locationId: string;
      packId: string | null;
      unitsPerPack: number;
      requiredBaseQty: number;
      scrapAllowanceQty: number;
      issueMethod: any;
      allocationStrategy: LotAllocationStrategy;
      operationSequence: number | null;
    }> = [];

    const subAssemblyPlan: Array<{
      itemId: string;
      childBomId: string;
      qty: number;
    }> = [];

    if (bom) {
      const effectiveTargetQty = Math.max(1, plannedOutputQty || bom.yieldQty);
      const scale = effectiveTargetQty / Math.max(1, bom.yieldQty);

      for (const line of bom.lines) {
        const netReq = Math.max(1, Math.ceil(line.baseQuantity * scale));
        const scrapAllowanceQty =
          line.scrapBps > 0 ? Math.ceil((netReq * line.scrapBps) / 10000) : 0;
        const grossReq = netReq + scrapAllowanceQty;
        const unitCost = await resolveItemStandardUnitCostCents(
          tx,
          organizationId,
          line.componentItemId,
        );
        standardMaterialCostCents += unitCost * grossReq;

        reservationCreates.push({
          organizationId,
          bomLineId: line.id,
          itemId: line.componentItemId,
          locationId: location.id,
          packId: line.packId,
          unitsPerPack: line.unitsPerPack,
          requiredBaseQty: grossReq,
          scrapAllowanceQty,
          issueMethod: line.issueMethod,
          allocationStrategy: LotAllocationStrategy.FEFO,
          operationSequence: line.operationSequence,
        });

        if (
          input.autoCreateSubAssemblyBatches &&
          line.subAssemblyStrategy !== SubAssemblyStrategy.CONSUME_STOCK_ONLY &&
          !visitedItems.has(line.componentItemId)
        ) {
          const childBom = await tx.billOfMaterial.findFirst({
            where: {
              organizationId,
              itemId: line.componentItemId,
              status: BomStatus.ACTIVE,
            },
            orderBy: [{ isDefault: "desc" }, { version: "desc" }],
            select: { id: true },
          });
          if (childBom) {
            let childQty = 0;
            if (
              line.subAssemblyStrategy === SubAssemblyStrategy.ALWAYS_EXPLODE
            ) {
              childQty = grossReq;
            } else {
              const bal = await tx.stockBalance.findUnique({
                where: {
                  organizationId_itemId_locationId: {
                    organizationId,
                    itemId: line.componentItemId,
                    locationId: location.id,
                  },
                },
              });
              const avail = Math.max(
                0,
                (bal?.onHandQty ?? 0) - (bal?.reservedQty ?? 0),
              );
              childQty = Math.max(0, grossReq - avail);
            }
            if (childQty > 0) {
              subAssemblyPlan.push({
                itemId: line.componentItemId,
                childBomId: childBom.id,
                qty: childQty,
              });
            }
          }
        }
      }
    }

    let standardLaborCostCents = 0;
    let standardMachineCostCents = 0;
    let standardOverheadCostCents = bom?.standardOverheadCents ?? 0;

    const operationCreates: Array<{
      organizationId: string;
      routingOperationId: string;
      workCenterId: string;
      sequence: number;
      operationCode: string;
      name: string;
      status: ProductionOperationStatus;
      plannedSetupMinutes: number;
      plannedRunMinutes: number;
      requiresQcGate: boolean;
      instructions: string | null;
    }> = [];

    if (routing) {
      const unitQty = Math.max(1, plannedOutputQty || 1);
      for (const op of routing.operations) {
        const plannedRunMinutes = Math.ceil(op.runMinutesPerUnit * unitQty);
        const totalMins = op.setupMinutes + plannedRunMinutes;
        const costs = computeTimeLogCosts({
          durationMinutes: totalMins,
          hourlyLaborRateCents: op.workCenter.hourlyLaborRateCents,
          hourlyMachineRateCents: op.workCenter.hourlyMachineRateCents,
          overheadRateCents: op.workCenter.overheadRateCents,
          overheadType: op.workCenter.overheadType,
          units: unitQty,
        });
        standardLaborCostCents += costs.laborCostCents;
        standardMachineCostCents += costs.machineCostCents;
        standardOverheadCostCents += costs.overheadCostCents;

        operationCreates.push({
          organizationId,
          routingOperationId: op.id,
          workCenterId: op.workCenterId,
          sequence: op.sequence,
          operationCode: op.operationCode,
          name: op.name,
          status: ProductionOperationStatus.PENDING,
          plannedSetupMinutes: op.setupMinutes,
          plannedRunMinutes,
          requiresQcGate: op.requiresQcGate,
          instructions: op.instructions,
        });
      }
    }

    const standardTotalCostCents =
      standardMaterialCostCents +
      standardLaborCostCents +
      standardMachineCostCents +
      standardOverheadCostCents;

    const hasQcGates =
      requiresFinalQcRelease ||
      operationCreates.some((op) => op.requiresQcGate);

    const created = await tx.productionBatch.create({
      data: {
        organizationId,
        batchNumber: input.batchNumber,
        name: input.name?.trim() || null,
        locationId: location.id,
        bomId: bom?.id ?? null,
        routingId: routing?.id ?? null,
        parentBatchId: input.parentBatchId ?? null,
        outputItemId: resolvedOutputItemId,
        plannedOutputQty,
        actualOutputQty: 0,
        scrapQty: 0,
        status: ProductionBatchStatus.PLANNED,
        priority: input.priority ?? ProductionPriority.NORMAL,
        qcStatus: hasQcGates
          ? ProductionQcStatus.PENDING
          : ProductionQcStatus.NOT_REQUIRED,
        requiresFinalQcRelease,
        scheduledStartAt: input.scheduledStartAt
          ? new Date(input.scheduledStartAt)
          : null,
        standardMaterialCostCents,
        standardLaborCostCents,
        standardMachineCostCents,
        standardOverheadCostCents,
        standardTotalCostCents,
        notes: input.notes?.trim() || null,
        metadata:
          input.metadata === undefined
            ? undefined
            : input.metadata === null
              ? Prisma.DbNull
              : (input.metadata as Prisma.InputJsonValue),
        createdByUserId: tenant.userId,
        updatedByUserId: tenant.userId,
        ...(reservationCreates.length > 0
          ? { reservations: { create: reservationCreates } }
          : {}),
        ...(operationCreates.length > 0
          ? { operations: { create: operationCreates } }
          : {}),
      },
    });

    if (requiresFinalQcRelease) {
      await tx.productionQcCheckpoint.create({
        data: {
          organizationId,
          productionBatchId: created.id,
          checkpointType: ProductionQcCheckpointType.FINAL_RELEASE,
          code: "FINAL-QA-RELEASE",
          name: "Final Batch Quality Release",
          status: ProductionQcCheckpointStatus.PENDING,
        },
      });
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
            target: { productionBatchId: created.id },
          },
          ipAddress,
        );
      }
    }

    // Recursively spawn sub-assembly batches if requested
    if (subAssemblyPlan.length > 0 && resolvedOutputItemId) {
      const nextVisited = new Set(visitedItems);
      nextVisited.add(resolvedOutputItemId);
      let idx = 1;
      for (const sub of subAssemblyPlan) {
        await this.createBatchTreeTx(
          tx,
          tenant,
          {
            batchNumber: `${created.batchNumber}-SUB${idx++}`,
            name: `Sub-assembly for ${created.batchNumber}`,
            locationId: location.id,
            outputItemId: sub.itemId,
            bomId: sub.childBomId,
            useDefaultEngineering: true,
            autoCreateSubAssemblyBatches: true,
            parentBatchId: created.id,
            plannedOutputQty: sub.qty,
            priority: input.priority ?? ProductionPriority.NORMAL,
            requiresFinalQcRelease: false,
          },
          nextVisited,
          ipAddress,
        );
      }
    }

    await tx.auditLog.create({
      data: {
        organizationId,
        actorUserId: tenant.userId,
        action: "production.batch.created",
        resourceType: "ProductionBatch",
        resourceId: created.id,
        metadata: {
          batchNumber: created.batchNumber,
          locationCode: location.code,
          outputItemId: created.outputItemId,
          bomId: created.bomId,
          routingId: created.routingId,
          plannedOutputQty: created.plannedOutputQty,
          standardTotalCostCents: created.standardTotalCostCents,
        } as Prisma.InputJsonValue,
        ipAddress: ipAddress ?? null,
      },
    });

    return created;
  }

  async releaseBatch(
    tenant: AuthenticatedOrganization,
    batchId: string,
    input: ReleaseProductionBatchInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const hasOperations = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.productionBatch.findFirst({
        where: { id: batchId, organizationId },
        include: {
          operations: { orderBy: { sequence: "asc" } },
        },
      });
      if (!existing) {
        throw new NotFoundException("Production batch was not found.");
      }
      if (existing.status !== ProductionBatchStatus.PLANNED) {
        throw new BadRequestException(
          `Only PLANNED batches can be released (current status: ${existing.status}).`,
        );
      }

      await this.executionService.reserveBatchMaterialsTx(
        tx,
        tenant,
        existing.id,
        input.strictReserve ?? true,
      );

      if (existing.operations.length > 0) {
        const firstOp = existing.operations[0]!;
        if (firstOp.status === ProductionOperationStatus.PENDING) {
          await tx.productionOperation.update({
            where: { id: firstOp.id },
            data: { status: ProductionOperationStatus.READY },
          });
        }
      }

      const now = new Date();
      await tx.productionBatch.update({
        where: { id: existing.id },
        data: {
          status: ProductionBatchStatus.RELEASED,
          releasedAt: now,
          releasedByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.batch.released",
          resourceType: "ProductionBatch",
          resourceId: existing.id,
          metadata: {
            batchNumber: existing.batchNumber,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return existing.operations.length > 0;
    });

    if (input.autoSchedule && hasOperations) {
      await this.executionService.scheduleBatch(
        tenant,
        batchId,
        { startAt: input.scheduledStartAt },
        ipAddress,
      );
    }

    const released = await this.getBatch(tenant, batchId);
    this.analyticsService.captureDomainEvent({
      event: "production_batch.released",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        production_batch_id: released.id,
        batch_number: released.batchNumber,
        auto_scheduled: Boolean(input.autoSchedule && hasOperations),
      },
    });
    return released;
  }

  async listBatches(
    tenant: AuthenticatedOrganization,
    query: ListProductionBatchesQuery,
  ) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const records = await this.prismaService.scoped.productionBatch.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.priority ? { priority: query.priority } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.outputItemId ? { outputItemId: query.outputItemId } : {}),
        ...(search
          ? {
              OR: [
                { batchNumber: { contains: search, mode: "insensitive" } },
                { name: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        location: { select: { id: true, code: true, name: true, type: true } },
        bom: { select: { id: true, code: true, name: true, version: true } },
        routing: { select: { id: true, code: true, name: true, version: true } },
        outputItem: {
          select: {
            id: true,
            sku: true,
            name: true,
            type: true,
            unitOfMeasure: true,
          },
        },
        outputLot: {
          select: {
            id: true,
            lotNumber: true,
            batchCode: true,
            onHandQty: true,
            quarantinedQty: true,
            unitCostCents: true,
            expiresAt: true,
          },
        },
        _count: {
          select: {
            consumptions: true,
            operations: true,
            reservations: true,
            qcCheckpoints: true,
            documentAttachments: true,
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

  async getBatch(tenant: AuthenticatedOrganization, batchId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const batch = await this.prismaService.scoped.productionBatch.findFirst({
      where: { id: batchId, organizationId },
      include: this.batchInclude(),
    });

    if (!batch) {
      throw new NotFoundException("Production batch was not found.");
    }

    return this.formatBatchResponse(batch);
  }

  async startBatch(
    tenant: AuthenticatedOrganization,
    batchId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.productionBatch.findFirst({
        where: { id: batchId, organizationId },
        include: { operations: { orderBy: { sequence: "asc" } } },
      });
      if (!existing) {
        throw new NotFoundException("Production batch was not found.");
      }
      if (
        existing.status !== ProductionBatchStatus.PLANNED &&
        existing.status !== ProductionBatchStatus.RELEASED
      ) {
        throw new BadRequestException(
          `Only PLANNED or RELEASED production batches can be started (current status: ${existing.status}).`,
        );
      }

      const now = new Date();
      const claimed = await tx.productionBatch.updateMany({
        where: {
          id: batchId,
          organizationId,
          status: existing.status,
        },
        data: {
          status: ProductionBatchStatus.IN_PROGRESS,
          startedAt: existing.startedAt ?? now,
          updatedByUserId: tenant.userId,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          "Production batch state changed concurrently. Refresh and retry.",
        );
      }

      if (existing.operations.length > 0) {
        const firstOp = existing.operations[0]!;
        if (firstOp.status === ProductionOperationStatus.PENDING) {
          await tx.productionOperation.update({
            where: { id: firstOp.id },
            data: { status: ProductionOperationStatus.READY },
          });
        }
      }

      const started = await tx.productionBatch.findFirstOrThrow({
        where: { id: batchId, organizationId },
        include: this.batchInclude(),
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.batch.started",
          resourceType: "ProductionBatch",
          resourceId: started.id,
          metadata: {
            batchNumber: started.batchNumber,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return this.formatBatchResponse(started);
    });
  }

  async suggestLotsForBatch(
    tenant: AuthenticatedOrganization,
    batchId: string,
    input: Omit<SuggestLotsInput, "locationId"> & { locationId?: string },
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const batch = await this.prismaService.scoped.productionBatch.findFirst({
      where: { id: batchId, organizationId },
      select: { id: true, locationId: true },
    });
    if (!batch) {
      throw new NotFoundException("Production batch was not found.");
    }

    return this.inventoryService.suggestLots(tenant, {
      ...input,
      locationId: input.locationId ?? batch.locationId,
    });
  }

  async consumeMaterials(
    tenant: AuthenticatedOrganization,
    batchId: string,
    input: ConsumeMaterialsInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const result = await this.prismaService.raw.$transaction(async (tx) => {
      const batch = await tx.productionBatch.findFirst({
        where: { id: batchId, organizationId },
        include: { location: true },
      });
      if (!batch) {
        throw new NotFoundException("Production batch was not found.");
      }

      if (
        batch.status !== ProductionBatchStatus.PLANNED &&
        batch.status !== ProductionBatchStatus.RELEASED &&
        batch.status !== ProductionBatchStatus.IN_PROGRESS
      ) {
        throw new BadRequestException(
          `Cannot consume materials for batch in status "${batch.status}".`,
        );
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

      const createdConsumptions = [];
      for (const reqLine of input.lines) {
        if (reqLine.productionOperationId) {
          const op = await tx.productionOperation.findFirst({
            where: {
              id: reqLine.productionOperationId,
              productionBatchId: batch.id,
              organizationId,
            },
            select: { id: true },
          });
          if (!op) {
            throw new NotFoundException(
              `Production operation "${reqLine.productionOperationId}" was not found on this batch.`,
            );
          }
        }

        const stepConsumptions = await this.executionService.consumeMaterialLineTx(
          tx,
          tenant,
          batch,
          reqLine,
          now,
        );
        createdConsumptions.push(...stepConsumptions);
      }

      await recalculateBatchCosting(tx, organizationId, batch.id);

      const refreshed = await tx.productionBatch.findFirstOrThrow({
        where: { id: batch.id, organizationId },
        include: this.batchInclude(),
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.materials.consumed",
          resourceType: "ProductionBatch",
          resourceId: batch.id,
          metadata: {
            batchNumber: batch.batchNumber,
            consumptionCount: createdConsumptions.length,
            consumptions: createdConsumptions,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return this.formatBatchResponse(refreshed);
    });

    this.analyticsService.captureDomainEvent({
      event: "production_batch.consumed",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        production_batch_id: result.id,
        batch_number: result.batchNumber,
        line_count: input.lines.length,
      },
    });

    return result;
  }

  async completeBatch(
    tenant: AuthenticatedOrganization,
    batchId: string,
    input: CompleteProductionBatchInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const result = await this.prismaService.raw.$transaction(async (tx) => {
      const batch = await tx.productionBatch.findFirst({
        where: { id: batchId, organizationId },
        include: {
          outputItem: true,
          location: true,
          qcCheckpoints: true,
        },
      });

      if (!batch) {
        throw new NotFoundException("Production batch was not found.");
      }

      if (
        batch.status !== ProductionBatchStatus.PLANNED &&
        batch.status !== ProductionBatchStatus.RELEASED &&
        batch.status !== ProductionBatchStatus.IN_PROGRESS
      ) {
        throw new BadRequestException(
          `Production batch cannot be completed in status "${batch.status}".`,
        );
      }

      const now = new Date();
      const actualOutputQty = input.actualOutputQty ?? batch.plannedOutputQty;
      const scrapQty = input.scrapQty ?? batch.scrapQty;

      // 1. Auto-backflush any remaining BACKFLUSH material reservations
      if (input.backflushRemaining !== false) {
        await this.executionService.backflushReservationsTx(tx, tenant, batch, {
          includeExpired: input.includeExpired,
          now,
        });
      }

      // 2. Release unused material reservations back to StockBalance
      await this.executionService.releaseUnusedReservationsTx(
        tx,
        organizationId,
        batch.id,
      );

      // 3. Determine QC Release Hold gate
      const hasOpenOrFailedQc =
        batch.qcCheckpoints.some(
          (cp) =>
            cp.status === ProductionQcCheckpointStatus.PENDING ||
            cp.status === ProductionQcCheckpointStatus.FAILED,
        ) ||
        (batch.requiresFinalQcRelease && batch.qcCheckpoints.length === 0);
      const anyFailedQc = batch.qcCheckpoints.some(
        (cp) => cp.status === ProductionQcCheckpointStatus.FAILED,
      );
      const holdForQc =
        hasOpenOrFailedQc && batch.qcStatus !== ProductionQcStatus.PASSED;

      const targetStatus = holdForQc
        ? ProductionBatchStatus.QC_HOLD
        : ProductionBatchStatus.COMPLETED;
      const targetQcStatus = holdForQc
        ? anyFailedQc
          ? ProductionQcStatus.FAILED
          : ProductionQcStatus.PENDING
        : batch.qcCheckpoints.length > 0
          ? ProductionQcStatus.PASSED
          : ProductionQcStatus.NOT_REQUIRED;

      const claimed = await tx.productionBatch.updateMany({
        where: {
          id: batch.id,
          organizationId,
          status: batch.status,
        },
        data: {
          status: targetStatus,
          qcStatus: targetQcStatus,
          startedAt: batch.startedAt ?? now,
          completedAt: now,
          actualOutputQty,
          scrapQty,
          ...(input.notes !== undefined
            ? { notes: input.notes?.trim() || null }
            : {}),
          updatedByUserId: tenant.userId,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          "Production batch state changed concurrently. Refresh and retry.",
        );
      }

      // 4. Recalculate costing so outputLot gets exact actual unitCostCents
      const costing = await recalculateBatchCosting(tx, organizationId, batch.id);
      const actualUnitCostCents = costing?.actual.unitCostCents ?? 0;

      let outputLotId: string | null = batch.outputLotId;

      if (batch.outputItem && actualOutputQty > 0) {
        const manufacturedAt = input.manufacturedAt
          ? new Date(input.manufacturedAt)
          : now;
        const expiresAt = input.expiresAt
          ? new Date(input.expiresAt)
          : computeExpiresAtFromShelfLife(
              manufacturedAt,
              batch.outputItem.shelfLifeDays,
            );
        if (expiresAt && expiresAt.getTime() <= manufacturedAt.getTime()) {
          throw new BadRequestException(
            "Output lot expiration date must be after manufacturing date.",
          );
        }

        if (input.createOutputLot !== false) {
          const outLot = await tx.stockLot.create({
            data: {
              organizationId,
              itemId: batch.outputItem.id,
              locationId: batch.locationId,
              lotNumber:
                input.outputLotNumber?.trim() ||
                `${batch.batchNumber}-${batch.outputItem.sku}`.slice(0, 80),
              batchCode: input.outputBatchCode?.trim() || batch.batchNumber,
              manufacturedAt,
              expiresAt,
              initialQty: actualOutputQty,
              onHandQty: holdForQc ? 0 : actualOutputQty,
              quarantinedQty: holdForQc ? actualOutputQty : 0,
              consumedQty: 0,
              unitCostCents: actualUnitCostCents,
            },
          });
          outputLotId = outLot.id;

          await tx.productionBatch.update({
            where: { id: batch.id },
            data: { outputLotId: outLot.id },
          });
        }

        // Only credit sellable StockBalance immediately if NOT held for QC release
        if (!holdForQc && batch.outputItem.trackInventory) {
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
              onHandQty: actualOutputQty,
              reservedQty: 0,
            },
            update: {
              onHandQty: { increment: actualOutputQty },
            },
          });

          await tx.stockMovement.create({
            data: {
              organizationId,
              itemId: batch.outputItem.id,
              locationId: batch.locationId,
              type: StockMovementType.PRODUCTION_OUTPUT,
              quantityDelta: actualOutputQty,
              balanceAfter: bal.onHandQty,
              stockLotId: outputLotId,
              referenceType: "ProductionBatch",
              referenceId: batch.id,
              reason: `Completed production batch ${batch.batchNumber}`,
              actorUserId: tenant.userId,
            },
          });
        }
      }

      const completed = await tx.productionBatch.findFirstOrThrow({
        where: { id: batch.id, organizationId },
        include: this.batchInclude(),
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: holdForQc
            ? "production.batch.qc_hold"
            : "production.batch.completed",
          resourceType: "ProductionBatch",
          resourceId: completed.id,
          metadata: {
            batchNumber: completed.batchNumber,
            status: completed.status,
            actualOutputQty,
            scrapQty,
            outputLotId,
            actualTotalCostCents: completed.actualTotalCostCents,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return this.formatBatchResponse(completed);
    });

    this.analyticsService.captureDomainEvent({
      event: "production_batch.completed",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        production_batch_id: result.id,
        batch_number: result.batchNumber,
        status: result.status,
        actual_output_qty: result.actualOutputQty,
        scrap_qty: result.scrapQty,
        actual_total_cost_cents: result.actualTotalCostCents,
      },
    });

    return result;
  }

  async cancelBatch(
    tenant: AuthenticatedOrganization,
    batchId: string,
    reason?: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.productionBatch.findFirst({
        where: { id: batchId, organizationId },
        include: {
          _count: { select: { consumptions: true, timeLogs: true } },
        },
      });

      if (!existing) {
        throw new NotFoundException("Production batch was not found.");
      }

      if (
        existing.status !== ProductionBatchStatus.PLANNED &&
        existing.status !== ProductionBatchStatus.RELEASED &&
        existing.status !== ProductionBatchStatus.IN_PROGRESS
      ) {
        throw new BadRequestException(
          `Production batch cannot be cancelled in status "${existing.status}".`,
        );
      }

      if (existing._count.consumptions > 0 || existing._count.timeLogs > 0) {
        throw new BadRequestException(
          "Cannot cancel a production batch that already has recorded material consumptions or labor time logs.",
        );
      }

      await this.executionService.releaseUnusedReservationsTx(
        tx,
        organizationId,
        existing.id,
      );

      const claimed = await tx.productionBatch.updateMany({
        where: { id: batchId, organizationId, status: existing.status },
        data: {
          status: ProductionBatchStatus.CANCELLED,
          cancelledAt: new Date(),
          updatedByUserId: tenant.userId,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          "Production batch state changed concurrently. Refresh and retry.",
        );
      }

      const cancelled = await tx.productionBatch.findFirstOrThrow({
        where: { id: batchId, organizationId },
        include: this.batchInclude(),
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.batch.cancelled",
          resourceType: "ProductionBatch",
          resourceId: cancelled.id,
          metadata: {
            batchNumber: cancelled.batchNumber,
            previousStatus: existing.status,
            ...(reason ? { reason } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return this.formatBatchResponse(cancelled);
    });
  }

  async getBatchTraceability(tenant: AuthenticatedOrganization, batchId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const batch = await this.prismaService.scoped.productionBatch.findFirst({
      where: { id: batchId, organizationId },
      include: {
        location: { select: { id: true, code: true, name: true, type: true } },
        bom: { select: { id: true, code: true, name: true, version: true } },
        routing: { select: { id: true, code: true, name: true, version: true } },
        outputItem: {
          select: {
            id: true,
            sku: true,
            name: true,
            type: true,
            unitOfMeasure: true,
          },
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
        documentAttachments: {
          include: {
            storedObject: { select: STORED_OBJECT_SUMMARY_SELECT },
          },
          orderBy: { createdAt: "desc" },
        },
        consumptions: {
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
            location: { select: { id: true, code: true, name: true } },
            stockLot: {
              include: {
                supplier: { select: { id: true, code: true, name: true } },
                supplierItem: {
                  select: {
                    id: true,
                    supplierSku: true,
                    unitCostCents: true,
                  },
                },
                documentAttachments: {
                  include: {
                    storedObject: { select: STORED_OBJECT_SUMMARY_SELECT },
                  },
                  orderBy: { createdAt: "desc" },
                },
                goodsReceiptLine: {
                  select: {
                    id: true,
                    lotNumber: true,
                    batchCode: true,
                    supplierBatchNumber: true,
                    documentAttachments: {
                      include: {
                        storedObject: { select: STORED_OBJECT_SUMMARY_SELECT },
                      },
                      orderBy: { createdAt: "desc" },
                    },
                    goodsReceipt: {
                      select: {
                        id: true,
                        receiptNumber: true,
                        deliveredAt: true,
                        acceptedAt: true,
                        packingSlipNumber: true,
                        purchaseOrder: {
                          select: {
                            id: true,
                            poNumber: true,
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

    return {
      ...batch,
      documentAttachments: batch.documentAttachments.map((a) =>
        this.attachmentsService.serializeAttachment(a),
      ),
      consumptions: batch.consumptions.map((c) => ({
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
    };
  }

  async listBatchFiles(tenant: AuthenticatedOrganization, batchId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const batch = await this.prismaService.scoped.productionBatch.findFirst({
      where: { id: batchId, organizationId },
      select: { id: true, batchNumber: true },
    });
    if (!batch) {
      throw new NotFoundException("Production batch was not found.");
    }

    const items = await this.attachmentsService.listForTarget(tenant, {
      productionBatchId: batchId,
    });
    return {
      organizationId,
      productionBatchId: batch.id,
      batchNumber: batch.batchNumber,
      items,
    };
  }

  async addBatchFile(
    tenant: AuthenticatedOrganization,
    batchId: string,
    req: FastifyRequest,
    body: unknown,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const batch = await this.prismaService.scoped.productionBatch.findFirst({
      where: { id: batchId, organizationId },
      select: { id: true },
    });
    if (!batch) {
      throw new NotFoundException("Production batch was not found.");
    }

    return this.attachmentsService.handleUploadOrLinkRequest(tenant, req, body, {
      entityType: StorageEntityType.PRODUCTION_BATCH,
      entityId: batchId,
      target: { productionBatchId: batchId },
    });
  }

  async removeBatchFile(
    tenant: AuthenticatedOrganization,
    batchId: string,
    attachmentId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const batch = await this.prismaService.scoped.productionBatch.findFirst({
      where: { id: batchId, organizationId },
      select: { id: true },
    });
    if (!batch) {
      throw new NotFoundException("Production batch was not found.");
    }

    return this.attachmentsService.removeAttachment(
      tenant,
      attachmentId,
      { productionBatchId: batchId },
      ipAddress,
    );
  }

  private batchInclude() {
    return {
      location: { select: { id: true, code: true, name: true, type: true } },
      bom: { select: { id: true, code: true, name: true, version: true } },
      routing: { select: { id: true, code: true, name: true, version: true } },
      parentBatch: { select: { id: true, batchNumber: true, status: true } },
      childBatches: {
        select: {
          id: true,
          batchNumber: true,
          status: true,
          plannedOutputQty: true,
          actualOutputQty: true,
        },
      },
      outputItem: {
        select: {
          id: true,
          sku: true,
          name: true,
          type: true,
          unitOfMeasure: true,
        },
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
          expiresAt: true,
        },
      },
      reservations: {
        include: {
          item: {
            select: { id: true, sku: true, name: true, unitOfMeasure: true },
          },
        },
        orderBy: { createdAt: "asc" as const },
      },
      operations: {
        include: {
          workCenter: { select: { id: true, code: true, name: true } },
        },
        orderBy: { sequence: "asc" as const },
      },
      qcCheckpoints: {
        orderBy: { createdAt: "asc" as const },
      },
      documentAttachments: {
        include: {
          storedObject: { select: STORED_OBJECT_SUMMARY_SELECT },
        },
        orderBy: { createdAt: "desc" as const },
      },
      consumptions: {
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
          location: { select: { id: true, code: true, name: true } },
          stockLot: {
            select: {
              id: true,
              lotNumber: true,
              batchCode: true,
              supplierBatchNumber: true,
              supplierSku: true,
              expiresAt: true,
              onHandQty: true,
              consumedQty: true,
              unitCostCents: true,
              supplier: { select: { id: true, code: true, name: true } },
              supplierItem: { select: { id: true, supplierSku: true } },
            },
          },
        },
        orderBy: { consumedAt: "desc" as const },
      },
    } as const;
  }

  private formatBatchResponse<
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
    },
  >(batch: T) {
    return {
      ...batch,
      ...(batch.documentAttachments
        ? {
            documentAttachments: batch.documentAttachments.map((a) =>
              this.attachmentsService.serializeAttachment(a),
            ),
          }
        : {}),
    };
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedOrganization): string {
    const contextOrgId = OrganizationContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active organization context mismatch.");
    }
    return tenant.organizationId;
  }
}

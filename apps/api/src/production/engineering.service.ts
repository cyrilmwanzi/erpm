import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  BomIssueMethod,
  BomStatus,
  ItemStatus,
  ItemType,
  LocationStatus,
  OverheadAllocationType,
  Prisma,
  RoutingStatus,
  SubAssemblyStrategy,
  OrganizationContext,
  WorkCenterStatus,
} from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import {
  computeTimeLogCosts,
  resolveItemStandardUnitCostCents,
} from "./production-costing.utils.js";

export interface CreateWorkCenterInput {
  code: string;
  name: string;
  description?: string | null;
  locationId: string;
  status?: WorkCenterStatus;
  dailyCapacityMinutes?: number;
  hourlyLaborRateCents?: number;
  hourlyMachineRateCents?: number;
  overheadRateCents?: number;
  overheadType?: OverheadAllocationType;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateWorkCenterInput {
  name?: string;
  description?: string | null;
  locationId?: string;
  status?: WorkCenterStatus;
  dailyCapacityMinutes?: number;
  hourlyLaborRateCents?: number;
  hourlyMachineRateCents?: number;
  overheadRateCents?: number;
  overheadType?: OverheadAllocationType;
  isActive?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface ListWorkCentersQuery {
  locationId?: string;
  status?: WorkCenterStatus;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface BomLineInput {
  lineNumber?: number;
  componentItemId: string;
  packId?: string | null;
  quantity: number;
  scrapBps?: number;
  issueMethod?: BomIssueMethod;
  subAssemblyStrategy?: SubAssemblyStrategy;
  operationSequence?: number | null;
  isOptional?: boolean;
  notes?: string | null;
}

export interface CreateBomInput {
  code: string;
  name: string;
  description?: string | null;
  itemId: string;
  packId?: string | null;
  version?: number;
  yieldQty?: number;
  isDefault?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  standardOverheadCents?: number;
  notes?: string | null;
  activate?: boolean;
  lines: BomLineInput[];
}

export interface UpdateBomInput {
  name?: string;
  description?: string | null;
  packId?: string | null;
  yieldQty?: number;
  isDefault?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  standardOverheadCents?: number;
  notes?: string | null;
  lines?: BomLineInput[];
}

export interface ListBomsQuery {
  itemId?: string;
  status?: BomStatus;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface RoutingOperationInput {
  sequence: number;
  operationCode: string;
  name: string;
  workCenterId: string;
  setupMinutes?: number;
  runMinutesPerUnit?: number;
  requiresQcGate?: boolean;
  qcChecklistTemplate?: Record<string, unknown>[] | Record<string, unknown> | null;
  instructions?: string | null;
}

export interface CreateRoutingInput {
  code: string;
  name: string;
  description?: string | null;
  itemId?: string | null;
  version?: number;
  isDefault?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  notes?: string | null;
  activate?: boolean;
  operations: RoutingOperationInput[];
}

export interface UpdateRoutingInput {
  name?: string;
  description?: string | null;
  itemId?: string | null;
  isDefault?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  notes?: string | null;
  operations?: RoutingOperationInput[];
}

export interface ListRoutingsQuery {
  itemId?: string;
  status?: RoutingStatus;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface ExplodedMaterialRequirement {
  level: number;
  bomId: string;
  bomCode: string;
  bomLineId: string;
  componentItemId: string;
  sku: string;
  name: string;
  itemType: ItemType;
  unitOfMeasure: string;
  packId: string | null;
  unitsPerPack: number;
  netRequiredBaseQty: number;
  scrapAllowanceBaseQty: number;
  grossRequiredBaseQty: number;
  issueMethod: BomIssueMethod;
  subAssemblyStrategy: SubAssemblyStrategy;
  operationSequence: number | null;
  standardUnitCostCents: number;
  standardTotalCostCents: number;
  explodedSubAssembly: boolean;
  parentItemId: string;
}

export interface ExplodedSubAssemblyNode {
  level: number;
  itemId: string;
  sku: string;
  name: string;
  bomId: string;
  bomCode: string;
  bomVersion: number;
  requiredBaseQty: number;
  strategy: SubAssemblyStrategy;
  onHandAvailableQty: number;
  explodeQty: number;
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
export class ProductionEngineeringService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  // ==========================================
  // Work Centers
  // ==========================================

  async createWorkCenter(
    tenant: AuthenticatedOrganization,
    input: CreateWorkCenterInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const code = input.code.trim().toUpperCase();

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        const location = await tx.location.findFirst({
          where: { id: input.locationId, organizationId },
        });
        if (!location || location.status !== LocationStatus.ACTIVE) {
          throw new BadRequestException(
            "Work center location must exist and be ACTIVE.",
          );
        }

        const created = await tx.workCenter.create({
          data: {
            organizationId,
            code,
            name: input.name.trim(),
            description: input.description?.trim() || null,
            locationId: location.id,
            status: input.status ?? WorkCenterStatus.ACTIVE,
            dailyCapacityMinutes: input.dailyCapacityMinutes ?? 480,
            hourlyLaborRateCents: input.hourlyLaborRateCents ?? 0,
            hourlyMachineRateCents: input.hourlyMachineRateCents ?? 0,
            overheadRateCents: input.overheadRateCents ?? 0,
            overheadType:
              input.overheadType ?? OverheadAllocationType.FIXED_PER_HOUR,
            isActive: (input.status ?? WorkCenterStatus.ACTIVE) !== WorkCenterStatus.ARCHIVED,
            metadata:
              input.metadata === undefined
                ? undefined
                : input.metadata === null
                  ? Prisma.DbNull
                  : (input.metadata as Prisma.InputJsonValue),
          },
          include: {
            location: { select: { id: true, code: true, name: true, type: true } },
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "production.work_center.created",
            resourceType: "WorkCenter",
            resourceId: created.id,
            metadata: {
              code: created.code,
              name: created.name,
              locationId: created.locationId,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return created;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `Work center code "${code}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async listWorkCenters(
    tenant: AuthenticatedOrganization,
    query: ListWorkCentersQuery,
  ) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const records = await this.prismaService.scoped.workCenter.findMany({
      where: {
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search, mode: "insensitive" } },
                { name: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        location: { select: { id: true, code: true, name: true, type: true } },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ code: "asc" }],
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

  async getWorkCenter(tenant: AuthenticatedOrganization, workCenterId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const wc = await this.prismaService.scoped.workCenter.findFirst({
      where: { id: workCenterId, organizationId },
      include: {
        location: { select: { id: true, code: true, name: true, type: true } },
      },
    });
    if (!wc) {
      throw new NotFoundException("Work center was not found.");
    }
    return wc;
  }

  async updateWorkCenter(
    tenant: AuthenticatedOrganization,
    workCenterId: string,
    input: UpdateWorkCenterInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.workCenter.findFirst({
        where: { id: workCenterId, organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Work center was not found.");
      }

      if (input.locationId) {
        const location = await tx.location.findFirst({
          where: { id: input.locationId, organizationId },
        });
        if (!location || location.status !== LocationStatus.ACTIVE) {
          throw new BadRequestException(
            "Work center location must exist and be ACTIVE.",
          );
        }
      }

      const nextStatus = input.status ?? existing.status;
      const updated = await tx.workCenter.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined
            ? { description: input.description?.trim() || null }
            : {}),
          ...(input.locationId !== undefined
            ? { locationId: input.locationId }
            : {}),
          ...(input.status !== undefined ? { status: nextStatus } : {}),
          ...(input.dailyCapacityMinutes !== undefined
            ? { dailyCapacityMinutes: input.dailyCapacityMinutes }
            : {}),
          ...(input.hourlyLaborRateCents !== undefined
            ? { hourlyLaborRateCents: input.hourlyLaborRateCents }
            : {}),
          ...(input.hourlyMachineRateCents !== undefined
            ? { hourlyMachineRateCents: input.hourlyMachineRateCents }
            : {}),
          ...(input.overheadRateCents !== undefined
            ? { overheadRateCents: input.overheadRateCents }
            : {}),
          ...(input.overheadType !== undefined
            ? { overheadType: input.overheadType }
            : {}),
          ...(input.isActive !== undefined
            ? { isActive: input.isActive }
            : input.status !== undefined
              ? { isActive: nextStatus !== WorkCenterStatus.ARCHIVED }
              : {}),
          ...(input.metadata !== undefined
            ? {
                metadata:
                  input.metadata === null
                    ? Prisma.DbNull
                    : (input.metadata as Prisma.InputJsonValue),
              }
            : {}),
        },
        include: {
          location: { select: { id: true, code: true, name: true, type: true } },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.work_center.updated",
          resourceType: "WorkCenter",
          resourceId: updated.id,
          metadata: {
            code: updated.code,
            status: updated.status,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  // ==========================================
  // Multi-Level Bills of Materials (BOM)
  // ==========================================

  async createBom(
    tenant: AuthenticatedOrganization,
    input: CreateBomInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const code = input.code.trim().toUpperCase();
    const version = input.version ?? 1;

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        const parentItem = await tx.item.findFirst({
          where: { id: input.itemId, organizationId },
        });
        if (!parentItem) {
          throw new NotFoundException("BOM output item was not found.");
        }
        if (parentItem.status === ItemStatus.ARCHIVED) {
          throw new BadRequestException(
            `Output item "${parentItem.sku}" is archived.`,
          );
        }

        if (input.packId) {
          const pack = await tx.itemPack.findFirst({
            where: {
              id: input.packId,
              organizationId,
              itemId: parentItem.id,
              isActive: true,
            },
          });
          if (!pack) {
            throw new BadRequestException(
              "BOM output pack was not found or is inactive for output item.",
            );
          }
        }

        const preparedLines = await this.prepareBomLines(
          tx,
          organizationId,
          parentItem.id,
          input.lines,
        );

        const effectiveFrom = input.effectiveFrom
          ? new Date(input.effectiveFrom)
          : null;
        const effectiveTo = input.effectiveTo
          ? new Date(input.effectiveTo)
          : null;
        if (
          effectiveFrom &&
          effectiveTo &&
          effectiveTo.getTime() <= effectiveFrom.getTime()
        ) {
          throw new BadRequestException(
            "BOM effectiveTo must be after effectiveFrom.",
          );
        }

        const status = input.activate ? BomStatus.ACTIVE : BomStatus.DRAFT;
        if (input.isDefault && status === BomStatus.ACTIVE) {
          await tx.billOfMaterial.updateMany({
            where: { organizationId, itemId: parentItem.id, isDefault: true },
            data: { isDefault: false },
          });
        }

        const created = await tx.billOfMaterial.create({
          data: {
            organizationId,
            code,
            name: input.name.trim(),
            description: input.description?.trim() || null,
            itemId: parentItem.id,
            packId: input.packId ?? null,
            version,
            yieldQty: input.yieldQty ?? 1,
            status,
            isDefault: Boolean(input.isDefault),
            effectiveFrom,
            effectiveTo,
            standardOverheadCents: input.standardOverheadCents ?? 0,
            notes: input.notes?.trim() || null,
            createdByUserId: tenant.userId,
            ...(status === BomStatus.ACTIVE
              ? { approvedByUserId: tenant.userId, approvedAt: new Date() }
              : {}),
            lines: {
              create: preparedLines,
            },
          },
          include: this.bomInclude(),
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "production.bom.created",
            resourceType: "BillOfMaterial",
            resourceId: created.id,
            metadata: {
              code: created.code,
              version: created.version,
              itemId: created.itemId,
              status: created.status,
              lineCount: created.lines.length,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return created;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `BOM "${code}" version ${version} already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async listBoms(tenant: AuthenticatedOrganization, query: ListBomsQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const records = await this.prismaService.scoped.billOfMaterial.findMany({
      where: {
        ...(query.itemId ? { itemId: query.itemId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search, mode: "insensitive" } },
                { name: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
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
        _count: { select: { lines: true, productionBatches: true } },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ code: "asc" }, { version: "desc" }],
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

  async getBom(tenant: AuthenticatedOrganization, bomId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const bom = await this.prismaService.scoped.billOfMaterial.findFirst({
      where: { id: bomId, organizationId },
      include: this.bomInclude(),
    });
    if (!bom) {
      throw new NotFoundException("Bill of materials was not found.");
    }
    return bom;
  }

  async updateBom(
    tenant: AuthenticatedOrganization,
    bomId: string,
    input: UpdateBomInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.billOfMaterial.findFirst({
        where: { id: bomId, organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Bill of materials was not found.");
      }
      if (existing.status === BomStatus.OBSOLETE) {
        throw new BadRequestException(
          "OBSOLETE BOM revisions cannot be edited. Clone a new version instead.",
        );
      }

      if (input.lines) {
        if (existing.status === BomStatus.ACTIVE) {
          throw new BadRequestException(
            "Cannot modify lines on an ACTIVE BOM revision. Clone a new DRAFT version instead.",
          );
        }
        const prepared = await this.prepareBomLines(
          tx,
          organizationId,
          existing.itemId,
          input.lines,
        );
        await tx.bomLine.deleteMany({
          where: { organizationId, bomId: existing.id },
        });
        await tx.bomLine.createMany({
          data: prepared.map((l) => ({
            ...l,
            bomId: existing.id,
          })),
        });
      }

      if (input.isDefault && existing.status === BomStatus.ACTIVE) {
        await tx.billOfMaterial.updateMany({
          where: {
            organizationId,
            itemId: existing.itemId,
            id: { not: existing.id },
            isDefault: true,
          },
          data: { isDefault: false },
        });
      }

      const updated = await tx.billOfMaterial.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined
            ? { description: input.description?.trim() || null }
            : {}),
          ...(input.packId !== undefined ? { packId: input.packId } : {}),
          ...(input.yieldQty !== undefined ? { yieldQty: input.yieldQty } : {}),
          ...(input.isDefault !== undefined
            ? { isDefault: input.isDefault }
            : {}),
          ...(input.effectiveFrom !== undefined
            ? {
                effectiveFrom: input.effectiveFrom
                  ? new Date(input.effectiveFrom)
                  : null,
              }
            : {}),
          ...(input.effectiveTo !== undefined
            ? {
                effectiveTo: input.effectiveTo
                  ? new Date(input.effectiveTo)
                  : null,
              }
            : {}),
          ...(input.standardOverheadCents !== undefined
            ? { standardOverheadCents: input.standardOverheadCents }
            : {}),
          ...(input.notes !== undefined
            ? { notes: input.notes?.trim() || null }
            : {}),
        },
        include: this.bomInclude(),
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.bom.updated",
          resourceType: "BillOfMaterial",
          resourceId: updated.id,
          metadata: {
            code: updated.code,
            version: updated.version,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async activateBom(
    tenant: AuthenticatedOrganization,
    bomId: string,
    makeDefault?: boolean,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.billOfMaterial.findFirst({
        where: { id: bomId, organizationId },
        include: { lines: true },
      });
      if (!existing) {
        throw new NotFoundException("Bill of materials was not found.");
      }
      if (existing.lines.length === 0) {
        throw new BadRequestException(
          "Cannot activate a BOM that has no component lines.",
        );
      }

      const nextIsDefault = makeDefault ?? existing.isDefault;
      if (nextIsDefault) {
        await tx.billOfMaterial.updateMany({
          where: {
            organizationId,
            itemId: existing.itemId,
            id: { not: existing.id },
            isDefault: true,
          },
          data: { isDefault: false },
        });
      }

      const activated = await tx.billOfMaterial.update({
        where: { id: existing.id },
        data: {
          status: BomStatus.ACTIVE,
          isDefault: nextIsDefault,
          approvedByUserId: tenant.userId,
          approvedAt: new Date(),
        },
        include: this.bomInclude(),
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.bom.activated",
          resourceType: "BillOfMaterial",
          resourceId: activated.id,
          metadata: {
            code: activated.code,
            version: activated.version,
            isDefault: activated.isDefault,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return activated;
    });
  }

  async cloneBomVersion(
    tenant: AuthenticatedOrganization,
    bomId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const source = await tx.billOfMaterial.findFirst({
        where: { id: bomId, organizationId },
        include: { lines: { orderBy: { lineNumber: "asc" } } },
      });
      if (!source) {
        throw new NotFoundException("Source BOM was not found.");
      }

      const latest = await tx.billOfMaterial.findFirst({
        where: { organizationId, code: source.code },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const nextVersion = (latest?.version ?? source.version) + 1;

      const cloned = await tx.billOfMaterial.create({
        data: {
          organizationId,
          code: source.code,
          name: source.name,
          description: source.description,
          itemId: source.itemId,
          packId: source.packId,
          version: nextVersion,
          yieldQty: source.yieldQty,
          status: BomStatus.DRAFT,
          isDefault: false,
          effectiveFrom: source.effectiveFrom,
          effectiveTo: source.effectiveTo,
          standardOverheadCents: source.standardOverheadCents,
          notes: source.notes,
          createdByUserId: tenant.userId,
          lines: {
            create: source.lines.map((l) => ({
              organizationId,
              lineNumber: l.lineNumber,
              componentItemId: l.componentItemId,
              packId: l.packId,
              unitsPerPack: l.unitsPerPack,
              quantity: l.quantity,
              baseQuantity: l.baseQuantity,
              scrapBps: l.scrapBps,
              issueMethod: l.issueMethod,
              subAssemblyStrategy: l.subAssemblyStrategy,
              operationSequence: l.operationSequence,
              isOptional: l.isOptional,
              notes: l.notes,
            })),
          },
        },
        include: this.bomInclude(),
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.bom.cloned",
          resourceType: "BillOfMaterial",
          resourceId: cloned.id,
          metadata: {
            sourceBomId: source.id,
            code: cloned.code,
            version: cloned.version,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return cloned;
    });
  }

  async explodeBom(
    tenant: AuthenticatedOrganization,
    bomId: string,
    options: {
      quantity?: number;
      locationId?: string;
      routingId?: string;
    },
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    return this.prismaService.raw.$transaction((tx) =>
      this.explodeBomTx(tx, organizationId, bomId, options),
    );
  }

  async explodeBomTx(
    tx: Prisma.TransactionClient,
    organizationId: string,
    bomId: string,
    options: {
      quantity?: number;
      locationId?: string;
      routingId?: string;
    },
  ) {
    const rootBom = await tx.billOfMaterial.findFirst({
      where: { id: bomId, organizationId },
      include: this.bomInclude(),
    });
    if (!rootBom) {
      throw new NotFoundException("Bill of materials was not found.");
    }

    const targetQty = Math.max(1, options.quantity ?? rootBom.yieldQty);
    const requirements: ExplodedMaterialRequirement[] = [];
    const subAssemblies: ExplodedSubAssemblyNode[] = [];
    const visitedItemPath = new Set<string>([rootBom.itemId]);

    const walkBom = async (
      bom: typeof rootBom,
      requiredParentOutputQty: number,
      level: number,
    ) => {
      const scale = requiredParentOutputQty / Math.max(1, bom.yieldQty);

      for (const line of bom.lines) {
        if (visitedItemPath.has(line.componentItemId)) {
          throw new BadRequestException(
            `Circular BOM reference detected involving SKU "${line.componentItem.sku}".`,
          );
        }

        const netRequiredBaseQty = Math.max(
          1,
          Math.ceil(line.baseQuantity * scale),
        );
        const scrapAllowanceBaseQty =
          line.scrapBps > 0
            ? Math.ceil((netRequiredBaseQty * line.scrapBps) / 10000)
            : 0;
        const grossRequiredBaseQty = netRequiredBaseQty + scrapAllowanceBaseQty;

        // Check if component itself has an active BOM for multi-level explosion
        const childBom =
          line.subAssemblyStrategy !== SubAssemblyStrategy.CONSUME_STOCK_ONLY
            ? await tx.billOfMaterial.findFirst({
                where: {
                  organizationId,
                  itemId: line.componentItemId,
                  status: BomStatus.ACTIVE,
                },
                include: this.bomInclude(),
                orderBy: [{ isDefault: "desc" }, { version: "desc" }],
              })
            : null;

        let explodeQty = 0;
        let onHandAvailableQty = 0;

        if (childBom) {
          if (options.locationId) {
            const bal = await tx.stockBalance.findUnique({
              where: {
                organizationId_itemId_locationId: {
                  organizationId,
                  itemId: line.componentItemId,
                  locationId: options.locationId,
                },
              },
            });
            onHandAvailableQty = Math.max(
              0,
              (bal?.onHandQty ?? 0) - (bal?.reservedQty ?? 0),
            );
          }

          if (line.subAssemblyStrategy === SubAssemblyStrategy.ALWAYS_EXPLODE) {
            explodeQty = grossRequiredBaseQty;
          } else {
            // CONSUME_STOCK_OR_EXPLODE
            explodeQty = Math.max(0, grossRequiredBaseQty - onHandAvailableQty);
          }

          subAssemblies.push({
            level,
            itemId: line.componentItemId,
            sku: line.componentItem.sku,
            name: line.componentItem.name,
            bomId: childBom.id,
            bomCode: childBom.code,
            bomVersion: childBom.version,
            requiredBaseQty: grossRequiredBaseQty,
            strategy: line.subAssemblyStrategy,
            onHandAvailableQty,
            explodeQty,
          });
        }

        const unitCostCents = await resolveItemStandardUnitCostCents(
          tx,
          organizationId,
          line.componentItemId,
        );

        requirements.push({
          level,
          bomId: bom.id,
          bomCode: bom.code,
          bomLineId: line.id,
          componentItemId: line.componentItemId,
          sku: line.componentItem.sku,
          name: line.componentItem.name,
          itemType: line.componentItem.type,
          unitOfMeasure: line.componentItem.unitOfMeasure,
          packId: line.packId,
          unitsPerPack: line.unitsPerPack,
          netRequiredBaseQty,
          scrapAllowanceBaseQty,
          grossRequiredBaseQty,
          issueMethod: line.issueMethod,
          subAssemblyStrategy: line.subAssemblyStrategy,
          operationSequence: line.operationSequence,
          standardUnitCostCents: unitCostCents,
          standardTotalCostCents: unitCostCents * grossRequiredBaseQty,
          explodedSubAssembly: explodeQty > 0,
          parentItemId: bom.itemId,
        });

        if (childBom && explodeQty > 0) {
          visitedItemPath.add(line.componentItemId);
          await walkBom(childBom, explodeQty, level + 1);
          visitedItemPath.delete(line.componentItemId);
        }
      }
    };

    await walkBom(rootBom, targetQty, 1);

    // Leaf material cost = non-exploded items OR stock-consumed portion of sub-assemblies
    const leafMaterialCostCents = requirements.reduce(
      (sum, r) => (r.explodedSubAssembly ? sum : sum + r.standardTotalCostCents),
      0,
    );

    // Optional routing standard conversion cost preview
    let routing: {
      id: string;
      code: string;
      name: string;
      version: number;
      operations: Array<{
        id: string;
        sequence: number;
        operationCode: string;
        name: string;
        setupMinutes: number;
        runMinutesPerUnit: number;
        requiresQcGate: boolean;
        workCenter: {
          id: string;
          code: string;
          name: string;
          hourlyLaborRateCents: number;
          hourlyMachineRateCents: number;
          overheadRateCents: number;
          overheadType: OverheadAllocationType;
        };
      }>;
    } | null = null;

    if (options.routingId) {
      routing = await tx.routing.findFirst({
        where: { id: options.routingId, organizationId },
        include: {
          operations: {
            include: { workCenter: true },
            orderBy: { sequence: "asc" },
          },
        },
      });
    } else {
      routing = await tx.routing.findFirst({
        where: {
          organizationId,
          itemId: rootBom.itemId,
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

    let standardLaborCostCents = 0;
    let standardMachineCostCents = 0;
    let standardOverheadCostCents = rootBom.standardOverheadCents;

    if (routing) {
      for (const op of routing.operations) {
        const totalMinutes =
          op.setupMinutes + Math.ceil(op.runMinutesPerUnit * targetQty);
        const costs = computeTimeLogCosts({
          durationMinutes: totalMinutes,
          hourlyLaborRateCents: op.workCenter.hourlyLaborRateCents,
          hourlyMachineRateCents: op.workCenter.hourlyMachineRateCents,
          overheadRateCents: op.workCenter.overheadRateCents,
          overheadType: op.workCenter.overheadType,
          units: targetQty,
        });
        standardLaborCostCents += costs.laborCostCents;
        standardMachineCostCents += costs.machineCostCents;
        standardOverheadCostCents += costs.overheadCostCents;
      }
    }

    const standardTotalCostCents =
      leafMaterialCostCents +
      standardLaborCostCents +
      standardMachineCostCents +
      standardOverheadCostCents;

    return {
      bom: {
        id: rootBom.id,
        code: rootBom.code,
        name: rootBom.name,
        version: rootBom.version,
        yieldQty: rootBom.yieldQty,
        item: rootBom.item,
      },
      targetOutputQty: targetQty,
      requirements,
      subAssemblies,
      routing: routing
        ? { id: routing.id, code: routing.code, name: routing.name, version: routing.version }
        : null,
      standardCostEstimate: {
        materialCostCents: leafMaterialCostCents,
        laborCostCents: standardLaborCostCents,
        machineCostCents: standardMachineCostCents,
        overheadCostCents: standardOverheadCostCents,
        totalCostCents: standardTotalCostCents,
        unitCostCents: Math.round(standardTotalCostCents / targetQty),
      },
    };
  }

  // ==========================================
  // Routings & Operations
  // ==========================================

  async createRouting(
    tenant: AuthenticatedOrganization,
    input: CreateRoutingInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const code = input.code.trim().toUpperCase();
    const version = input.version ?? 1;

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        if (input.itemId) {
          const item = await tx.item.findFirst({
            where: { id: input.itemId, organizationId },
          });
          if (!item) {
            throw new NotFoundException("Routing target item was not found.");
          }
        }

        const preparedOps = await this.prepareRoutingOperations(
          tx,
          organizationId,
          input.operations,
        );

        const status = input.activate
          ? RoutingStatus.ACTIVE
          : RoutingStatus.DRAFT;

        if (input.isDefault && input.itemId && status === RoutingStatus.ACTIVE) {
          await tx.routing.updateMany({
            where: { organizationId, itemId: input.itemId, isDefault: true },
            data: { isDefault: false },
          });
        }

        const created = await tx.routing.create({
          data: {
            organizationId,
            code,
            name: input.name.trim(),
            description: input.description?.trim() || null,
            itemId: input.itemId ?? null,
            version,
            status,
            isDefault: Boolean(input.isDefault),
            effectiveFrom: input.effectiveFrom
              ? new Date(input.effectiveFrom)
              : null,
            effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
            notes: input.notes?.trim() || null,
            createdByUserId: tenant.userId,
            operations: {
              create: preparedOps,
            },
          },
          include: this.routingInclude(),
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "production.routing.created",
            resourceType: "Routing",
            resourceId: created.id,
            metadata: {
              code: created.code,
              version: created.version,
              status: created.status,
              operationCount: created.operations.length,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return created;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `Routing "${code}" version ${version} already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async listRoutings(tenant: AuthenticatedOrganization, query: ListRoutingsQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const records = await this.prismaService.scoped.routing.findMany({
      where: {
        ...(query.itemId ? { itemId: query.itemId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search, mode: "insensitive" } },
                { name: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        item: { select: { id: true, sku: true, name: true } },
        _count: { select: { operations: true, productionBatches: true } },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ code: "asc" }, { version: "desc" }],
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

  async getRouting(tenant: AuthenticatedOrganization, routingId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const routing = await this.prismaService.scoped.routing.findFirst({
      where: { id: routingId, organizationId },
      include: this.routingInclude(),
    });
    if (!routing) {
      throw new NotFoundException("Routing was not found.");
    }
    return routing;
  }

  async updateRouting(
    tenant: AuthenticatedOrganization,
    routingId: string,
    input: UpdateRoutingInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.routing.findFirst({
        where: { id: routingId, organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Routing was not found.");
      }
      if (existing.status === RoutingStatus.OBSOLETE) {
        throw new BadRequestException("OBSOLETE routing cannot be modified.");
      }

      if (input.operations) {
        if (existing.status === RoutingStatus.ACTIVE) {
          throw new BadRequestException(
            "Cannot modify operations on an ACTIVE routing.",
          );
        }
        const prepared = await this.prepareRoutingOperations(
          tx,
          organizationId,
          input.operations,
        );
        await tx.routingOperation.deleteMany({
          where: { organizationId, routingId: existing.id },
        });
        await tx.routingOperation.createMany({
          data: prepared.map((op) => ({
            ...op,
            routingId: existing.id,
          })),
        });
      }

      const updated = await tx.routing.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined
            ? { description: input.description?.trim() || null }
            : {}),
          ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
          ...(input.isDefault !== undefined
            ? { isDefault: input.isDefault }
            : {}),
          ...(input.effectiveFrom !== undefined
            ? {
                effectiveFrom: input.effectiveFrom
                  ? new Date(input.effectiveFrom)
                  : null,
              }
            : {}),
          ...(input.effectiveTo !== undefined
            ? {
                effectiveTo: input.effectiveTo
                  ? new Date(input.effectiveTo)
                  : null,
              }
            : {}),
          ...(input.notes !== undefined
            ? { notes: input.notes?.trim() || null }
            : {}),
        },
        include: this.routingInclude(),
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.routing.updated",
          resourceType: "Routing",
          resourceId: updated.id,
          metadata: {
            code: updated.code,
            version: updated.version,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async activateRouting(
    tenant: AuthenticatedOrganization,
    routingId: string,
    makeDefault?: boolean,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.routing.findFirst({
        where: { id: routingId, organizationId },
        include: { operations: true },
      });
      if (!existing) {
        throw new NotFoundException("Routing was not found.");
      }
      if (existing.operations.length === 0) {
        throw new BadRequestException(
          "Cannot activate a routing that has no operations.",
        );
      }

      const nextIsDefault = makeDefault ?? existing.isDefault;
      if (nextIsDefault && existing.itemId) {
        await tx.routing.updateMany({
          where: {
            organizationId,
            itemId: existing.itemId,
            id: { not: existing.id },
            isDefault: true,
          },
          data: { isDefault: false },
        });
      }

      const activated = await tx.routing.update({
        where: { id: existing.id },
        data: {
          status: RoutingStatus.ACTIVE,
          isDefault: nextIsDefault,
        },
        include: this.routingInclude(),
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "production.routing.activated",
          resourceType: "Routing",
          resourceId: activated.id,
          metadata: {
            code: activated.code,
            version: activated.version,
            isDefault: activated.isDefault,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return activated;
    });
  }

  // ==========================================
  // Private Helpers
  // ==========================================

  private async prepareBomLines(
    tx: Prisma.TransactionClient,
    organizationId: string,
    parentItemId: string,
    lines: BomLineInput[],
  ) {
    const itemIds = Array.from(new Set(lines.map((l) => l.componentItemId)));
    const items = await tx.item.findMany({
      where: { organizationId, id: { in: itemIds } },
    });
    const itemMap = new Map(items.map((i) => [i.id, i]));

    const packIds = Array.from(
      new Set(lines.map((l) => l.packId).filter((p): p is string => Boolean(p))),
    );
    const packs =
      packIds.length > 0
        ? await tx.itemPack.findMany({
            where: { organizationId, id: { in: packIds }, isActive: true },
          })
        : [];
    const packMap = new Map(packs.map((p) => [p.id, p]));

    return lines.map((line, index) => {
      const compItem = itemMap.get(line.componentItemId);
      if (!compItem) {
        throw new NotFoundException(
          `BOM component item "${line.componentItemId}" was not found.`,
        );
      }
      if (compItem.id === parentItemId) {
        throw new BadRequestException(
          `BOM cannot reference its own output item "${compItem.sku}" as a component.`,
        );
      }
      if (compItem.status === ItemStatus.ARCHIVED) {
        throw new BadRequestException(
          `Archived component item "${compItem.sku}" cannot be added to a BOM.`,
        );
      }
      if (compItem.type === ItemType.SERVICE) {
        throw new BadRequestException(
          `Service item "${compItem.sku}" cannot be added as a BOM material line.`,
        );
      }

      let unitsPerPack = 1;
      if (line.packId) {
        const pack = packMap.get(line.packId);
        if (!pack || pack.itemId !== compItem.id) {
          throw new BadRequestException(
            `Pack "${line.packId}" does not belong to component SKU "${compItem.sku}".`,
          );
        }
        unitsPerPack = Math.max(1, pack.unitsPerPack);
      }

      return {
        organizationId,
        lineNumber: line.lineNumber ?? index + 1,
        componentItemId: compItem.id,
        packId: line.packId ?? null,
        unitsPerPack,
        quantity: line.quantity,
        baseQuantity: line.quantity * unitsPerPack,
        scrapBps: line.scrapBps ?? 0,
        issueMethod: line.issueMethod ?? BomIssueMethod.MANUAL,
        subAssemblyStrategy:
          line.subAssemblyStrategy ??
          SubAssemblyStrategy.CONSUME_STOCK_OR_EXPLODE,
        operationSequence: line.operationSequence ?? null,
        isOptional: Boolean(line.isOptional),
        notes: line.notes?.trim() || null,
      };
    });
  }

  private async prepareRoutingOperations(
    tx: Prisma.TransactionClient,
    organizationId: string,
    operations: RoutingOperationInput[],
  ) {
    const seqSet = new Set<number>();
    const wcIds = Array.from(new Set(operations.map((o) => o.workCenterId)));
    const wcs = await tx.workCenter.findMany({
      where: { organizationId, id: { in: wcIds } },
    });
    const wcMap = new Map(wcs.map((w) => [w.id, w]));

    return operations.map((op) => {
      if (seqSet.has(op.sequence)) {
        throw new BadRequestException(
          `Duplicate routing operation sequence "${op.sequence}".`,
        );
      }
      seqSet.add(op.sequence);

      const wc = wcMap.get(op.workCenterId);
      if (!wc) {
        throw new NotFoundException(
          `Work center "${op.workCenterId}" was not found.`,
        );
      }
      if (wc.status === WorkCenterStatus.ARCHIVED) {
        throw new BadRequestException(
          `Archived work center "${wc.code}" cannot be assigned to routing operations.`,
        );
      }

      return {
        organizationId,
        sequence: op.sequence,
        operationCode: op.operationCode.trim().toUpperCase(),
        name: op.name.trim(),
        workCenterId: wc.id,
        setupMinutes: op.setupMinutes ?? 0,
        runMinutesPerUnit: op.runMinutesPerUnit ?? 0,
        requiresQcGate: Boolean(op.requiresQcGate),
        qcChecklistTemplate:
          op.qcChecklistTemplate === undefined
            ? undefined
            : op.qcChecklistTemplate === null
              ? Prisma.DbNull
              : (op.qcChecklistTemplate as Prisma.InputJsonValue),
        instructions: op.instructions?.trim() || null,
      };
    });
  }

  private bomInclude() {
    return {
      item: {
        select: {
          id: true,
          sku: true,
          name: true,
          type: true,
          unitOfMeasure: true,
          costPriceCents: true,
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
      lines: {
        include: {
          componentItem: {
            select: {
              id: true,
              sku: true,
              name: true,
              type: true,
              unitOfMeasure: true,
              costPriceCents: true,
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
        orderBy: { lineNumber: "asc" as const },
      },
    } as const;
  }

  private routingInclude() {
    return {
      item: { select: { id: true, sku: true, name: true } },
      operations: {
        include: {
          workCenter: {
            select: {
              id: true,
              code: true,
              name: true,
              locationId: true,
              status: true,
              dailyCapacityMinutes: true,
              hourlyLaborRateCents: true,
              hourlyMachineRateCents: true,
              overheadRateCents: true,
              overheadType: true,
            },
          },
        },
        orderBy: { sequence: "asc" as const },
      },
    } as const;
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedOrganization): string {
    const contextOrgId = OrganizationContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active organization context mismatch.");
    }
    return tenant.organizationId;
  }
}

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ItemStatus, Prisma, SupplierStatus, OrganizationContext, type Supplier } from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import { RedisService } from "../redis/redis.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";

export interface CreateSupplierInput {
  code: string;
  name: string;
  status?: "ACTIVE" | "INACTIVE";
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  taxId?: string | null;
  paymentTermsDays?: number;
  currency?: string;
  leadTimeDays?: number;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateSupplierInput extends Partial<CreateSupplierInput> {}

export interface ListSuppliersQuery {
  status?: SupplierStatus;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface UpsertSupplierItemInput {
  itemId: string;
  packId?: string | null;
  supplierSku?: string | null;
  unitCostCents: number;
  currency?: string;
  minOrderQty?: number;
  leadTimeDays?: number | null;
  isPreferred?: boolean;
  notes?: string | null;
}

function toNullableJsonInput(
  value: Record<string, unknown> | null | undefined,
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return Prisma.DbNull;
  }
  return value as Prisma.InputJsonValue;
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
export class SuppliersService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redisService: RedisService,
  ) {}

  async createSupplier(
    tenant: AuthenticatedOrganization,
    input: CreateSupplierInput,
    ipAddress?: string,
  ): Promise<Supplier> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const code = input.code.trim().toUpperCase();

    try {
      const supplier = await this.prismaService.raw.$transaction(async (tx) => {
        let resolvedCurrency = input.currency;
        if (!resolvedCurrency) {
          const settings = await tx.organizationSettings.findUnique({
            where: { organizationId },
            select: { defaultCurrency: true },
          });
          resolvedCurrency = settings?.defaultCurrency ?? "USD";
        }

        const created = await tx.supplier.create({
          data: {
            organizationId,
            code,
            name: input.name.trim(),
            status: input.status ?? SupplierStatus.ACTIVE,
            email: input.email ?? null,
            phone: input.phone ?? null,
            website: input.website ?? null,
            taxId: input.taxId ?? null,
            paymentTermsDays: input.paymentTermsDays ?? 30,
            currency: resolvedCurrency,
            leadTimeDays: input.leadTimeDays ?? 7,
            addressLine1: input.addressLine1 ?? null,
            city: input.city ?? null,
            state: input.state ?? null,
            postalCode: input.postalCode ?? null,
            country: input.country ?? null,
            notes: input.notes ?? null,
            metadata: toNullableJsonInput(input.metadata ?? null),
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "supplier.created",
            resourceType: "Supplier",
            resourceId: created.id,
            metadata: {
              code: created.code,
              name: created.name,
              currency: created.currency,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return created;
      });

      await this.invalidateSupplierCacheSafe(organizationId, supplier.id);
      return supplier;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `A supplier with code "${code}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async listSuppliers(tenant: AuthenticatedOrganization, query: ListSuppliersQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const where: Prisma.SupplierWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(search
        ? {
            OR: [
              { code: { contains: search, mode: "insensitive" } },
              { name: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const records = await this.prismaService.scoped.supplier.findMany({
      where,
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ name: "asc" }, { id: "asc" }],
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

  async getSupplier(
    tenant: AuthenticatedOrganization,
    supplierId: string,
  ): Promise<Supplier> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const cacheKey = `org:${organizationId}:supplier:${supplierId}`;

    try {
      const cached = await this.redisService.getJson<Supplier>(cacheKey);
      if (cached && cached.organizationId === organizationId) {
        return cached;
      }
    } catch {
      // Fallback to DB
    }

    const supplier = await this.prismaService.scoped.supplier.findUnique({
      where: { id: supplierId },
    });

    if (!supplier) {
      throw new NotFoundException("Supplier was not found.");
    }

    try {
      await this.redisService.setJson(cacheKey, supplier, 300);
    } catch {
      // Non-fatal
    }

    return supplier;
  }

  async updateSupplier(
    tenant: AuthenticatedOrganization,
    supplierId: string,
    input: UpdateSupplierInput,
    ipAddress?: string,
  ): Promise<Supplier> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const nextCode = input.code?.trim().toUpperCase();

    try {
      const updated = await this.prismaService.raw.$transaction(async (tx) => {
        const existing = await tx.supplier.findFirst({
          where: { id: supplierId, organizationId },
        });

        if (!existing) {
          throw new NotFoundException("Supplier was not found.");
        }
        if (existing.status === SupplierStatus.ARCHIVED) {
          throw new BadRequestException(
            "Archived suppliers cannot be edited. Restore the supplier first.",
          );
        }

        const saved = await tx.supplier.update({
          where: { id: supplierId },
          data: {
            ...(nextCode !== undefined ? { code: nextCode } : {}),
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.email !== undefined ? { email: input.email } : {}),
            ...(input.phone !== undefined ? { phone: input.phone } : {}),
            ...(input.website !== undefined ? { website: input.website } : {}),
            ...(input.taxId !== undefined ? { taxId: input.taxId } : {}),
            ...(input.paymentTermsDays !== undefined
              ? { paymentTermsDays: input.paymentTermsDays }
              : {}),
            ...(input.currency !== undefined
              ? { currency: input.currency }
              : {}),
            ...(input.leadTimeDays !== undefined
              ? { leadTimeDays: input.leadTimeDays }
              : {}),
            ...(input.addressLine1 !== undefined
              ? { addressLine1: input.addressLine1 }
              : {}),
            ...(input.city !== undefined ? { city: input.city } : {}),
            ...(input.state !== undefined ? { state: input.state } : {}),
            ...(input.postalCode !== undefined
              ? { postalCode: input.postalCode }
              : {}),
            ...(input.country !== undefined ? { country: input.country } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            ...(input.metadata !== undefined
              ? { metadata: toNullableJsonInput(input.metadata) }
              : {}),
            updatedByUserId: tenant.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "supplier.updated",
            resourceType: "Supplier",
            resourceId: saved.id,
            metadata: input as unknown as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return saved;
      });

      await this.invalidateSupplierCacheSafe(organizationId, supplierId);
      return updated;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `A supplier with code "${nextCode}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async archiveSupplier(
    tenant: AuthenticatedOrganization,
    supplierId: string,
    reason?: string,
    ipAddress?: string,
  ): Promise<Supplier> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const archived = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.supplier.findFirst({
        where: { id: supplierId, organizationId },
      });

      if (!existing) {
        throw new NotFoundException("Supplier was not found.");
      }
      if (existing.status === SupplierStatus.ARCHIVED) {
        throw new BadRequestException("Supplier is already archived.");
      }

      const saved = await tx.supplier.update({
        where: { id: supplierId },
        data: {
          status: SupplierStatus.ARCHIVED,
          archivedAt: new Date(),
          archivedByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "supplier.archived",
          resourceType: "Supplier",
          resourceId: saved.id,
          metadata: {
            code: saved.code,
            previousStatus: existing.status,
            ...(reason ? { reason } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });

    await this.invalidateSupplierCacheSafe(organizationId, supplierId);
    return archived;
  }

  async restoreSupplier(
    tenant: AuthenticatedOrganization,
    supplierId: string,
    targetStatus: "ACTIVE" | "INACTIVE" = SupplierStatus.ACTIVE,
    reason?: string,
    ipAddress?: string,
  ): Promise<Supplier> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const restored = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.supplier.findFirst({
        where: { id: supplierId, organizationId },
      });

      if (!existing) {
        throw new NotFoundException("Supplier was not found.");
      }
      if (existing.status !== SupplierStatus.ARCHIVED) {
        throw new BadRequestException("Only archived suppliers can be restored.");
      }

      const saved = await tx.supplier.update({
        where: { id: supplierId },
        data: {
          status: targetStatus,
          archivedAt: null,
          archivedByUserId: null,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "supplier.restored",
          resourceType: "Supplier",
          resourceId: saved.id,
          metadata: {
            code: saved.code,
            targetStatus,
            ...(reason ? { reason } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });

    await this.invalidateSupplierCacheSafe(organizationId, supplierId);
    return restored;
  }

  async listSupplierItems(tenant: AuthenticatedOrganization, supplierId: string) {
    this.resolveVerifiedOrganizationId(tenant);

    const supplier = await this.prismaService.scoped.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true, code: true, name: true, currency: true },
    });

    if (!supplier) {
      throw new NotFoundException("Supplier was not found.");
    }

    const items = await this.prismaService.scoped.supplierItem.findMany({
      where: { supplierId },
      include: {
        item: {
          select: {
            id: true,
            sku: true,
            name: true,
            type: true,
            status: true,
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
      orderBy: [{ isPreferred: "desc" }, { updatedAt: "desc" }],
    });

    return {
      supplier,
      items,
    };
  }

  async upsertSupplierItem(
    tenant: AuthenticatedOrganization,
    supplierId: string,
    input: UpsertSupplierItemInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const [supplier, item] = await Promise.all([
        tx.supplier.findFirst({ where: { id: supplierId, organizationId } }),
        tx.item.findFirst({ where: { id: input.itemId, organizationId } }),
      ]);

      if (!supplier) {
        throw new NotFoundException("Supplier was not found.");
      }
      if (supplier.status === SupplierStatus.ARCHIVED) {
        throw new BadRequestException(
          "Cannot map items for an archived supplier.",
        );
      }
      if (!item) {
        throw new NotFoundException("Catalog item was not found.");
      }
      if (item.status === ItemStatus.ARCHIVED) {
        throw new BadRequestException(
          "Cannot map an archived catalog item to a supplier.",
        );
      }

      if (input.packId) {
        const pack = await tx.itemPack.findFirst({
          where: {
            id: input.packId,
            organizationId,
            itemId: item.id,
            isActive: true,
          },
        });
        if (!pack) {
          throw new BadRequestException(
            "Selected pack was not found or is inactive for this item.",
          );
        }
      }

      if (input.isPreferred) {
        await tx.supplierItem.updateMany({
          where: {
            organizationId,
            itemId: item.id,
            supplierId: { not: supplierId },
            isPreferred: true,
          },
          data: { isPreferred: false },
        });
      }

      const mapping = await tx.supplierItem.upsert({
        where: {
          organizationId_supplierId_itemId: {
            organizationId,
            supplierId,
            itemId: item.id,
          },
        },
        create: {
          organizationId,
          supplierId,
          itemId: item.id,
          packId: input.packId ?? null,
          supplierSku: input.supplierSku ?? null,
          unitCostCents: input.unitCostCents,
          currency: input.currency ?? supplier.currency,
          minOrderQty: input.minOrderQty ?? 1,
          leadTimeDays: input.leadTimeDays ?? supplier.leadTimeDays,
          isPreferred: input.isPreferred ?? false,
          notes: input.notes ?? null,
        },
        update: {
          ...(input.packId !== undefined ? { packId: input.packId } : {}),
          ...(input.supplierSku !== undefined
            ? { supplierSku: input.supplierSku }
            : {}),
          unitCostCents: input.unitCostCents,
          ...(input.currency !== undefined
            ? { currency: input.currency }
            : {}),
          ...(input.minOrderQty !== undefined
            ? { minOrderQty: input.minOrderQty }
            : {}),
          ...(input.leadTimeDays !== undefined
            ? { leadTimeDays: input.leadTimeDays }
            : {}),
          ...(input.isPreferred !== undefined
            ? { isPreferred: input.isPreferred }
            : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
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
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "supplier.item.upserted",
          resourceType: "SupplierItem",
          resourceId: mapping.id,
          metadata: {
            supplierId,
            supplierCode: supplier.code,
            itemId: item.id,
            itemSku: item.sku,
            packId: mapping.packId,
            unitCostCents: mapping.unitCostCents,
            isPreferred: mapping.isPreferred,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return mapping;
    });
  }

  async removeSupplierItem(
    tenant: AuthenticatedOrganization,
    supplierId: string,
    itemId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.supplierItem.findUnique({
        where: {
          organizationId_supplierId_itemId: {
            organizationId,
            supplierId,
            itemId,
          },
        },
      });

      if (!existing) {
        throw new NotFoundException("Supplier item mapping was not found.");
      }

      await tx.supplierItem.delete({
        where: { id: existing.id },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "supplier.item.removed",
          resourceType: "SupplierItem",
          resourceId: existing.id,
          metadata: {
            supplierId,
            itemId,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return { deleted: true, id: existing.id };
    });
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedOrganization): string {
    const contextOrgId = OrganizationContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active organization context mismatch.");
    }
    return tenant.organizationId;
  }

  private async invalidateSupplierCacheSafe(
    organizationId: string,
    supplierId: string,
  ): Promise<void> {
    try {
      await this.redisService.invalidateOrganizationCache(
        organizationId,
        `supplier:${supplierId}`,
      );
    } catch {
      // Non-fatal
    }
  }
}

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
  Prisma,
  TenantContext,
  type Item,
} from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import { RedisService } from "../redis/redis.service.js";
import type { AuthenticatedTenant } from "../tenancy/tenant.decorators.js";

export interface CreateItemInput {
  sku: string;
  name: string;
  description?: string | null;
  type: ItemType;
  status?: "DRAFT" | "ACTIVE";
  unitOfMeasure?: string;
  currency?: string;
  salePriceCents?: number;
  costPriceCents?: number;
  trackInventory?: boolean;
  allowNegativeStock?: boolean;
  reorderPoint?: number | null;
  isBundle?: boolean;
  variantKind?: "STANDARD" | "TEMPLATE";
  tags?: string[];
  metadata?: Record<string, unknown> | null;
  reason?: string;
}

export interface UpdateItemInput {
  sku?: string;
  name?: string;
  description?: string | null;
  type?: ItemType;
  status?: "DRAFT" | "ACTIVE";
  unitOfMeasure?: string;
  currency?: string;
  salePriceCents?: number;
  costPriceCents?: number;
  trackInventory?: boolean;
  allowNegativeStock?: boolean;
  reorderPoint?: number | null;
  isBundle?: boolean;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
  expectedVersion?: number;
  reason?: string;
}

export interface ListItemsQuery {
  type?: ItemType;
  status?: ItemStatus;
  variantKind?: ItemVariantKind;
  parentItemId?: string;
  includeTemplates?: boolean;
  trackInventory?: boolean;
  tag?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface FieldChange {
  from: unknown;
  to: unknown;
}

export type FieldChangesMap = Record<string, FieldChange>;

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableSerialize(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function areValuesEqual(a: unknown, b: unknown): boolean {
  return stableSerialize(a ?? null) === stableSerialize(b ?? null);
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
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
export class ItemsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redisService: RedisService,
  ) {}

  async createItem(
    tenant: AuthenticatedTenant,
    input: CreateItemInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const variantKind =
      input.variantKind === ItemVariantKind.TEMPLATE
        ? ItemVariantKind.TEMPLATE
        : ItemVariantKind.STANDARD;

    if (variantKind === ItemVariantKind.TEMPLATE && input.trackInventory === true) {
      throw new BadRequestException(
        "Template items cannot track inventory directly; track inventory on concrete variant SKUs.",
      );
    }

    const trackInventory =
      variantKind === ItemVariantKind.TEMPLATE
        ? false
        : (input.trackInventory ?? input.type !== ItemType.SERVICE);

    if (!trackInventory) {
      if (input.allowNegativeStock === true) {
        throw new BadRequestException(
          "allowNegativeStock cannot be enabled when trackInventory is false.",
        );
      }
      if (input.reorderPoint !== undefined && input.reorderPoint !== null) {
        throw new BadRequestException(
          "reorderPoint cannot be set when trackInventory is false.",
        );
      }
    }

    const normalizedTags = normalizeTags(input.tags);
    const normalizedMetadata = input.metadata ?? null;
    const normalizedDescription = input.description ?? null;
    const normalizedUnit = input.unitOfMeasure?.trim() || "unit";
    const normalizedSku = input.sku.trim();
    const normalizedName = input.name.trim();
    const status = input.status ?? ItemStatus.ACTIVE;
    const salePriceCents = input.salePriceCents ?? 0;
    const costPriceCents = input.costPriceCents ?? 0;
    const allowNegativeStock = trackInventory
      ? (input.allowNegativeStock ?? false)
      : false;
    const reorderPoint = trackInventory ? (input.reorderPoint ?? null) : null;

    try {
      const result = await this.prismaService.raw.$transaction(async (tx) => {
        let resolvedCurrency = input.currency;
        if (!resolvedCurrency) {
          const settings = await tx.tenantSettings.findUnique({
            where: { organizationId },
            select: { defaultCurrency: true },
          });
          resolvedCurrency = settings?.defaultCurrency ?? "USD";
        }

        const item = await tx.item.create({
          data: {
            organizationId,
            sku: normalizedSku,
            name: normalizedName,
            description: normalizedDescription,
            type: input.type,
            status,
            unitOfMeasure: normalizedUnit,
            currency: resolvedCurrency,
            salePriceCents,
            costPriceCents,
            trackInventory,
            allowNegativeStock,
            reorderPoint,
            isBundle: input.isBundle ?? false,
            variantKind,
            tags: normalizedTags,
            metadata: toNullableJsonInput(normalizedMetadata),
            version: 1,
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
          },
        });

        const initialChanges: FieldChangesMap = {
          sku: { from: null, to: item.sku },
          name: { from: null, to: item.name },
          description: { from: null, to: item.description },
          type: { from: null, to: item.type },
          status: { from: null, to: item.status },
          unitOfMeasure: { from: null, to: item.unitOfMeasure },
          currency: { from: null, to: item.currency },
          salePriceCents: { from: null, to: item.salePriceCents },
          costPriceCents: { from: null, to: item.costPriceCents },
          trackInventory: { from: null, to: item.trackInventory },
          allowNegativeStock: { from: null, to: item.allowNegativeStock },
          reorderPoint: { from: null, to: item.reorderPoint },
          isBundle: { from: null, to: item.isBundle },
          variantKind: { from: null, to: item.variantKind },
          tags: { from: null, to: item.tags },
          metadata: { from: null, to: item.metadata },
        };

        const revision = await tx.itemRevision.create({
          data: {
            organizationId,
            itemId: item.id,
            version: 1,
            action: "CREATED",
            changes: initialChanges as unknown as Prisma.InputJsonValue,
            reason: input.reason ?? null,
            actorUserId: tenant.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "item.created",
            resourceType: "Item",
            resourceId: item.id,
            metadata: {
              sku: item.sku,
              name: item.name,
              type: item.type,
              status: item.status,
              version: item.version,
              ...(input.reason ? { reason: input.reason } : {}),
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return { item, revision };
      });

      await this.invalidateItemCacheSafe(organizationId, result.item.id);

      return result;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `An item with SKU "${normalizedSku}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async listItems(tenant: AuthenticatedTenant, query: ListItemsQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const where: Prisma.ItemWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.variantKind
        ? { variantKind: query.variantKind }
        : query.includeTemplates === false
          ? { variantKind: { not: ItemVariantKind.TEMPLATE } }
          : {}),
      ...(query.parentItemId ? { parentItemId: query.parentItemId } : {}),
      ...(query.trackInventory !== undefined
        ? { trackInventory: query.trackInventory }
        : {}),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      ...(search
        ? {
            OR: [
              { sku: { contains: search, mode: "insensitive" } },
              { name: { contains: search, mode: "insensitive" } },
              { description: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const records = await this.prismaService.scoped.item.findMany({
      where,
      include: {
        variantAttributes: {
          include: {
            option: { select: { id: true, code: true, name: true, displayType: true } },
            optionValue: {
              select: { id: true, code: true, label: true, swatchHex: true },
            },
          },
        },
        _count: { select: { variants: true } },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
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

  async getItem(tenant: AuthenticatedTenant, itemId: string): Promise<Item> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const cacheKey = this.itemCacheKey(organizationId, itemId);

    try {
      const cached = await this.redisService.getJson<Item>(cacheKey);
      if (cached && cached.organizationId === organizationId) {
        return cached;
      }
    } catch {
      // Fallback to PostgreSQL on Redis read error
    }

    const item = await this.prismaService.scoped.item.findUnique({
      where: { id: itemId },
    });

    if (!item) {
      throw new NotFoundException("Catalog item was not found.");
    }

    try {
      await this.redisService.setJson(cacheKey, item, 300);
    } catch {
      // Non-fatal cache population error
    }

    return item;
  }

  async updateItem(
    tenant: AuthenticatedTenant,
    itemId: string,
    input: UpdateItemInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    try {
      const result = await this.prismaService.raw.$transaction(async (tx) => {
        const existing = await tx.item.findFirst({
          where: { id: itemId, organizationId },
        });

        if (!existing) {
          throw new NotFoundException("Catalog item was not found.");
        }

        if (existing.status === ItemStatus.ARCHIVED) {
          throw new BadRequestException(
            "Archived items cannot be edited directly. Restore the item first.",
          );
        }

        if (
          input.expectedVersion !== undefined &&
          existing.version !== input.expectedVersion
        ) {
          throw new ConflictException(
            `Version mismatch: expected version ${input.expectedVersion}, current version is ${existing.version}.`,
          );
        }

        if (
          existing.variantKind === ItemVariantKind.TEMPLATE &&
          input.trackInventory === true
        ) {
          throw new BadRequestException(
            "Template items cannot track inventory directly; track inventory on concrete variant SKUs.",
          );
        }

        const nextTrackInventory =
          input.trackInventory !== undefined
            ? input.trackInventory
            : existing.trackInventory;

        if (!nextTrackInventory) {
          if (input.allowNegativeStock === true) {
            throw new BadRequestException(
              "allowNegativeStock cannot be enabled when trackInventory is false.",
            );
          }
          if (input.reorderPoint !== undefined && input.reorderPoint !== null) {
            throw new BadRequestException(
              "reorderPoint cannot be set when trackInventory is false.",
            );
          }
        }

        const nextValues: {
          sku: string;
          name: string;
          description: string | null;
          type: ItemType;
          status: ItemStatus;
          unitOfMeasure: string;
          currency: string;
          salePriceCents: number;
          costPriceCents: number;
          trackInventory: boolean;
          allowNegativeStock: boolean;
          reorderPoint: number | null;
          isBundle: boolean;
          tags: string[];
          metadata: Prisma.JsonValue | null;
        } = {
          sku: input.sku !== undefined ? input.sku.trim() : existing.sku,
          name: input.name !== undefined ? input.name.trim() : existing.name,
          description:
            input.description !== undefined
              ? input.description
              : existing.description,
          type: input.type !== undefined ? input.type : existing.type,
          status: input.status !== undefined ? input.status : existing.status,
          unitOfMeasure:
            input.unitOfMeasure !== undefined
              ? input.unitOfMeasure.trim()
              : existing.unitOfMeasure,
          currency:
            input.currency !== undefined ? input.currency : existing.currency,
          salePriceCents:
            input.salePriceCents !== undefined
              ? input.salePriceCents
              : existing.salePriceCents,
          costPriceCents:
            input.costPriceCents !== undefined
              ? input.costPriceCents
              : existing.costPriceCents,
          trackInventory: nextTrackInventory,
          allowNegativeStock: !nextTrackInventory
            ? false
            : input.allowNegativeStock !== undefined
              ? input.allowNegativeStock
              : existing.allowNegativeStock,
          reorderPoint: !nextTrackInventory
            ? null
            : input.reorderPoint !== undefined
              ? input.reorderPoint
              : existing.reorderPoint,
          isBundle:
            input.isBundle !== undefined ? input.isBundle : existing.isBundle,
          tags:
            input.tags !== undefined ? normalizeTags(input.tags) : existing.tags,
          metadata:
            input.metadata !== undefined
              ? (input.metadata as Prisma.JsonValue | null)
              : existing.metadata,
        };

        const changes: FieldChangesMap = {};
        const updateData: Prisma.ItemUpdateManyMutationInput = {};

        const trackedKeys = [
          "sku",
          "name",
          "description",
          "type",
          "status",
          "unitOfMeasure",
          "currency",
          "salePriceCents",
          "costPriceCents",
          "trackInventory",
          "allowNegativeStock",
          "reorderPoint",
          "isBundle",
          "tags",
          "metadata",
        ] as const;

        for (const key of trackedKeys) {
          const prevVal = existing[key];
          const nextVal = nextValues[key];
          if (!areValuesEqual(prevVal, nextVal)) {
            changes[key] = { from: prevVal, to: nextVal };
            if (key === "metadata") {
              updateData.metadata = toNullableJsonInput(
                nextVal as Record<string, unknown> | null,
              );
            } else {
              (updateData as Record<string, unknown>)[key] = nextVal;
            }
          }
        }

        if (Object.keys(changes).length === 0) {
          return {
            item: existing,
            revision: null,
            changed: false,
            syncedVariantIds: [] as string[],
          };
        }

        if (
          existing.variantKind === ItemVariantKind.VARIANT &&
          input.salePriceCents !== undefined
        ) {
          updateData.salePriceOverrideCents = input.salePriceCents;
        }
        if (
          existing.variantKind === ItemVariantKind.VARIANT &&
          input.costPriceCents !== undefined
        ) {
          updateData.costPriceOverrideCents = input.costPriceCents;
        }

        const nextVersion = existing.version + 1;
        const updatedCount = await tx.item.updateMany({
          where: {
            id: itemId,
            organizationId,
            version: existing.version,
          },
          data: {
            ...updateData,
            version: nextVersion,
            updatedByUserId: tenant.userId,
          },
        });

        if (updatedCount.count !== 1) {
          throw new ConflictException(
            "Catalog item was updated concurrently. Refresh and retry.",
          );
        }

        const updatedItem = await tx.item.findFirstOrThrow({
          where: { id: itemId, organizationId },
        });

        let syncedVariantIds: string[] = [];
        if (
          updatedItem.variantKind === ItemVariantKind.TEMPLATE &&
          (changes.salePriceCents !== undefined ||
            changes.costPriceCents !== undefined)
        ) {
          const affectedVariants = await tx.item.findMany({
            where: {
              organizationId,
              parentItemId: itemId,
              variantKind: ItemVariantKind.VARIANT,
              inheritParentPricing: true,
            },
            select: {
              id: true,
              salePriceOverrideCents: true,
              costPriceOverrideCents: true,
            },
          });

          if (changes.salePriceCents !== undefined) {
            const idsToSync = affectedVariants
              .filter((v) => v.salePriceOverrideCents === null)
              .map((v) => v.id);
            if (idsToSync.length > 0) {
              await tx.item.updateMany({
                where: { id: { in: idsToSync }, organizationId },
                data: {
                  salePriceCents: updatedItem.salePriceCents,
                  updatedByUserId: tenant.userId,
                },
              });
              syncedVariantIds.push(...idsToSync);
            }
          }

          if (changes.costPriceCents !== undefined) {
            const idsToSync = affectedVariants
              .filter((v) => v.costPriceOverrideCents === null)
              .map((v) => v.id);
            if (idsToSync.length > 0) {
              await tx.item.updateMany({
                where: { id: { in: idsToSync }, organizationId },
                data: {
                  costPriceCents: updatedItem.costPriceCents,
                  updatedByUserId: tenant.userId,
                },
              });
              syncedVariantIds.push(...idsToSync);
            }
          }
        }

        const revision = await tx.itemRevision.create({
          data: {
            organizationId,
            itemId,
            version: nextVersion,
            action: "UPDATED",
            changes: changes as unknown as Prisma.InputJsonValue,
            reason: input.reason ?? null,
            actorUserId: tenant.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "item.updated",
            resourceType: "Item",
            resourceId: itemId,
            metadata: {
              sku: updatedItem.sku,
              version: nextVersion,
              changedFields: Object.keys(changes),
              changes,
              ...(syncedVariantIds.length > 0
                ? { syncedInheritingVariantCount: new Set(syncedVariantIds).size }
                : {}),
              ...(input.reason ? { reason: input.reason } : {}),
            } as unknown as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return {
          item: updatedItem,
          revision,
          changed: true,
          syncedVariantIds: Array.from(new Set(syncedVariantIds)),
        };
      });

      if (result.changed) {
        await this.invalidateItemCacheSafe(organizationId, itemId);
        for (const variantId of result.syncedVariantIds) {
          await this.invalidateItemCacheSafe(organizationId, variantId);
        }
      }

      return {
        item: result.item,
        revision: result.revision,
        changed: result.changed,
      };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `An item with SKU "${input.sku?.trim()}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async archiveItem(
    tenant: AuthenticatedTenant,
    itemId: string,
    reason?: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const result = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.item.findFirst({
        where: { id: itemId, organizationId },
      });

      if (!existing) {
        throw new NotFoundException("Catalog item was not found.");
      }

      if (existing.status === ItemStatus.ARCHIVED) {
        throw new BadRequestException("Catalog item is already archived.");
      }

      const nextVersion = existing.version + 1;
      const archivedAt = new Date();

      const updatedCount = await tx.item.updateMany({
        where: {
          id: itemId,
          organizationId,
          version: existing.version,
        },
        data: {
          status: ItemStatus.ARCHIVED,
          archivedAt,
          archivedByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
          version: nextVersion,
        },
      });

      if (updatedCount.count !== 1) {
        throw new ConflictException(
          "Catalog item was updated concurrently. Refresh and retry.",
        );
      }

      const archivedItem = await tx.item.findFirstOrThrow({
        where: { id: itemId, organizationId },
      });

      const changes: FieldChangesMap = {
        status: { from: existing.status, to: ItemStatus.ARCHIVED },
        archivedAt: { from: null, to: archivedAt.toISOString() },
        archivedByUserId: { from: null, to: tenant.userId },
      };

      const revision = await tx.itemRevision.create({
        data: {
          organizationId,
          itemId,
          version: nextVersion,
          action: "ARCHIVED",
          changes: changes as unknown as Prisma.InputJsonValue,
          reason: reason ?? null,
          actorUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "item.archived",
          resourceType: "Item",
          resourceId: itemId,
          metadata: {
            sku: existing.sku,
            previousStatus: existing.status,
            version: nextVersion,
            ...(reason ? { reason } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return { item: archivedItem, revision };
    });

    await this.invalidateItemCacheSafe(organizationId, itemId);
    return result;
  }

  async restoreItem(
    tenant: AuthenticatedTenant,
    itemId: string,
    targetStatus: "ACTIVE" | "DRAFT" = ItemStatus.ACTIVE,
    reason?: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const result = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.item.findFirst({
        where: { id: itemId, organizationId },
      });

      if (!existing) {
        throw new NotFoundException("Catalog item was not found.");
      }

      if (existing.status !== ItemStatus.ARCHIVED) {
        throw new BadRequestException("Only archived items can be restored.");
      }

      const nextVersion = existing.version + 1;

      const updatedCount = await tx.item.updateMany({
        where: {
          id: itemId,
          organizationId,
          version: existing.version,
        },
        data: {
          status: targetStatus,
          archivedAt: null,
          archivedByUserId: null,
          updatedByUserId: tenant.userId,
          version: nextVersion,
        },
      });

      if (updatedCount.count !== 1) {
        throw new ConflictException(
          "Catalog item was updated concurrently. Refresh and retry.",
        );
      }

      const restoredItem = await tx.item.findFirstOrThrow({
        where: { id: itemId, organizationId },
      });

      const changes: FieldChangesMap = {
        status: { from: ItemStatus.ARCHIVED, to: targetStatus },
        archivedAt: {
          from: existing.archivedAt?.toISOString() ?? null,
          to: null,
        },
        archivedByUserId: {
          from: existing.archivedByUserId ?? null,
          to: null,
        },
      };

      const revision = await tx.itemRevision.create({
        data: {
          organizationId,
          itemId,
          version: nextVersion,
          action: "RESTORED",
          changes: changes as unknown as Prisma.InputJsonValue,
          reason: reason ?? null,
          actorUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "item.restored",
          resourceType: "Item",
          resourceId: itemId,
          metadata: {
            sku: existing.sku,
            targetStatus,
            version: nextVersion,
            ...(reason ? { reason } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return { item: restoredItem, revision };
    });

    await this.invalidateItemCacheSafe(organizationId, itemId);
    return result;
  }

  async listItemHistory(
    tenant: AuthenticatedTenant,
    itemId: string,
    limit = 25,
    cursor?: string,
  ) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(limit, 1), 100);

    const item = await this.prismaService.scoped.item.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        sku: true,
        name: true,
        type: true,
        status: true,
        version: true,
      },
    });

    if (!item) {
      throw new NotFoundException("Catalog item was not found.");
    }

    const records = await this.prismaService.scoped.itemRevision.findMany({
      where: { itemId },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { version: "desc" },
    });

    const hasMore = records.length > take;
    const revisions = hasMore ? records.slice(0, take) : records;
    const nextCursor = hasMore
      ? (revisions[revisions.length - 1]?.id ?? null)
      : null;

    return {
      item,
      revisions,
      nextCursor,
    };
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedTenant): string {
    const contextOrgId = TenantContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active tenant context mismatch.");
    }
    return tenant.organizationId;
  }

  private itemCacheKey(organizationId: string, itemId: string): string {
    return `tenant:${organizationId}:item:${itemId}`;
  }

  private async invalidateItemCacheSafe(
    organizationId: string,
    itemId: string,
  ): Promise<void> {
    try {
      await this.redisService.invalidateTenantCache(
        organizationId,
        `item:${itemId}`,
      );
    } catch {
      // Non-fatal cache invalidation error
    }
  }
}

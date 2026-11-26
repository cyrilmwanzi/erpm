import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  BillingCycle,
  DiscountScope,
  DiscountType,
  ItemStatus,
  ItemType,
  PriceBookDirection,
  PricingModel,
  Prisma,
  ServicePlanType,
  TenantContext,
} from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedTenant } from "../tenancy/tenant.decorators.js";

export interface CreateItemPackInput {
  code: string;
  name: string;
  unitOfMeasure: string;
  unitsPerPack: number;
  barcode?: string | null;
  packSku?: string | null;
  salePriceCents?: number | null;
  costPriceCents?: number | null;
  isSellable?: boolean;
  isPurchasable?: boolean;
  isDefaultSalesPack?: boolean;
  isDefaultPurchasePack?: boolean;
  minOrderPacks?: number;
  packStep?: number;
  weightGrams?: number | null;
  dimensionsJson?: Record<string, unknown> | null;
  isActive?: boolean;
  metadata?: Record<string, unknown> | null;
}

export type UpdateItemPackInput = Partial<CreateItemPackInput>;

export interface BundleComponentInput {
  componentItemId: string;
  componentPackId?: string | null;
  quantity: number;
  priceAllocationBps?: number | null;
  isOptional?: boolean;
  sortOrder?: number;
}

export interface CreateServicePlanInput {
  code: string;
  name: string;
  description?: string | null;
  planType?: ServicePlanType;
  billingCycle?: BillingCycle;
  includedUnits: number;
  unitLabel?: string;
  basePriceCents: number;
  overageUnitPriceCents?: number | null;
  setupFeeCents?: number;
  rolloverEnabled?: boolean;
  maxRolloverUnits?: number | null;
  validityDays?: number | null;
  isActive?: boolean;
  metadata?: Record<string, unknown> | null;
}

export type UpdateServicePlanInput = Partial<CreateServicePlanInput>;

export interface CreatePriceBookInput {
  code: string;
  name: string;
  description?: string | null;
  direction?: PriceBookDirection;
  currency?: string;
  priority?: number;
  isDefault?: boolean;
  isActive?: boolean;
  customerSegment?: string | null;
  externalAccountId?: string | null;
  supplierId?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  customAttributes?: Record<string, unknown> | null;
}

export type UpdatePriceBookInput = Partial<CreatePriceBookInput>;

export interface PriceTierDto {
  minQuantity: number;
  maxQuantity?: number | null;
  unitPriceCents?: number | null;
  flatFeeCents?: number | null;
  packageSize?: number | null;
  packagePriceCents?: number | null;
  discountBps?: number | null;
  sortOrder?: number;
}

export interface CreatePriceRuleInput {
  itemId: string;
  packId?: string | null;
  servicePlanId?: string | null;
  name: string;
  pricingModel?: PricingModel;
  baseUnitPriceCents: number;
  minMarginBps?: number | null;
  minQuantity?: number;
  maxQuantity?: number | null;
  conditions?: Record<string, unknown> | null;
  customAdjustment?: Record<string, unknown> | null;
  priority?: number;
  isActive?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
  tiers?: PriceTierDto[];
}

export type UpdatePriceRuleInput = Partial<Omit<CreatePriceRuleInput, "itemId">>;

export interface CreateDiscountRuleInput {
  code: string;
  name: string;
  description?: string | null;
  promoCode?: string | null;
  discountType: DiscountType;
  scope?: DiscountScope;
  valueBps?: number | null;
  amountCents?: number | null;
  fixedPriceCents?: number | null;
  buyQuantity?: number | null;
  getQuantity?: number | null;
  getDiscountBps?: number | null;
  targetItemId?: string | null;
  targetPackId?: string | null;
  targetTags?: string[];
  customerSegments?: string[];
  externalAccountIds?: string[];
  minQuantity?: number | null;
  minOrderSubtotalCents?: number | null;
  maxDiscountCents?: number | null;
  isStackable?: boolean;
  priority?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  usageLimit?: number | null;
  isActive?: boolean;
  conditions?: Record<string, unknown> | null;
}

export type UpdateDiscountRuleInput = Partial<CreateDiscountRuleInput>;

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function toNullableJson(
  val: Record<string, unknown> | null | undefined,
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue | undefined {
  if (val === undefined) return undefined;
  if (val === null) return Prisma.DbNull;
  return val as Prisma.InputJsonValue;
}

@Injectable()
export class PricingCatalogService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private resolveVerifiedOrganizationId(tenant: AuthenticatedTenant): string {
    const contextOrgId = TenantContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active tenant context mismatch.");
    }
    return tenant.organizationId;
  }

  private validateTiers(pricingModel: PricingModel, tiers: PriceTierDto[] | undefined) {
    if (!tiers || tiers.length === 0) {
      return;
    }

    const sorted = [...tiers].sort((a, b) => a.minQuantity - b.minQuantity);
    for (let i = 0; i < sorted.length; i++) {
      const tier = sorted[i]!;
      if (tier.minQuantity < 1) {
        throw new BadRequestException("Price tier minQuantity must be >= 1.");
      }
      if (tier.maxQuantity !== null && tier.maxQuantity !== undefined && tier.maxQuantity < tier.minQuantity) {
        throw new BadRequestException("Price tier maxQuantity must be >= minQuantity.");
      }
      if (pricingModel === PricingModel.PACKAGE) {
        if (!tier.packageSize || tier.packageSize < 1 || tier.packagePriceCents === null || tier.packagePriceCents === undefined) {
          throw new BadRequestException(
            "PACKAGE pricing tiers require packageSize (>= 1) and packagePriceCents.",
          );
        }
      } else if (
        (tier.unitPriceCents === null || tier.unitPriceCents === undefined) &&
        (tier.discountBps === null || tier.discountBps === undefined)
      ) {
        throw new BadRequestException(
          "Each price tier must define unitPriceCents or discountBps.",
        );
      }
      if (i > 0) {
        const prev = sorted[i - 1]!;
        if (prev.maxQuantity === null || prev.maxQuantity === undefined || tier.minQuantity <= prev.maxQuantity) {
          if (tier.minQuantity === prev.minQuantity) {
            throw new BadRequestException(
              `Duplicate tier breakpoint at minQuantity=${tier.minQuantity}.`,
            );
          }
          if (prev.maxQuantity !== null && prev.maxQuantity !== undefined && tier.minQuantity <= prev.maxQuantity) {
            throw new BadRequestException(
              `Overlapping price tiers (${prev.minQuantity}..${prev.maxQuantity} vs ${tier.minQuantity}).`,
            );
          }
        }
      }
    }
  }

  private validateDiscountFields(input: {
    discountType: DiscountType;
    valueBps?: number | null;
    amountCents?: number | null;
    fixedPriceCents?: number | null;
    buyQuantity?: number | null;
    getQuantity?: number | null;
    startsAt?: string | null;
    endsAt?: string | null;
  }) {
    if (input.startsAt && input.endsAt && new Date(input.endsAt) < new Date(input.startsAt)) {
      throw new BadRequestException("Discount endsAt must be after startsAt.");
    }
    switch (input.discountType) {
      case DiscountType.PERCENTAGE:
        if (input.valueBps === null || input.valueBps === undefined || input.valueBps < 1 || input.valueBps > 10000) {
          throw new BadRequestException("PERCENTAGE discount requires valueBps between 1 and 10000.");
        }
        break;
      case DiscountType.FIXED_AMOUNT:
        if (input.amountCents === null || input.amountCents === undefined || input.amountCents < 1) {
          throw new BadRequestException("FIXED_AMOUNT discount requires amountCents >= 1.");
        }
        break;
      case DiscountType.FIXED_PRICE:
        if (input.fixedPriceCents === null || input.fixedPriceCents === undefined || input.fixedPriceCents < 0) {
          throw new BadRequestException("FIXED_PRICE discount requires fixedPriceCents >= 0.");
        }
        break;
      case DiscountType.BUY_X_GET_Y:
        if (!input.buyQuantity || input.buyQuantity < 1 || !input.getQuantity || input.getQuantity < 1) {
          throw new BadRequestException("BUY_X_GET_Y discount requires buyQuantity >= 1 and getQuantity >= 1.");
        }
        break;
    }
  }

  async getItemPricingOptions(tenant: AuthenticatedTenant, itemId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const item = await this.prismaService.scoped.item.findUnique({
      where: { id: itemId },
      include: {
        parentItem: true,
        variantAttributes: {
          include: {
            option: { select: { id: true, code: true, name: true, displayType: true } },
            optionValue: {
              select: { id: true, code: true, label: true, swatchHex: true },
            },
          },
        },
      },
    });
    if (!item) {
      throw new NotFoundException("Catalog item was not found.");
    }

    const parentId = item.parentItemId ?? null;
    const lookupIds = parentId ? [itemId, parentId] : [itemId];
    const mergedTags = Array.from(
      new Set([...item.tags, ...(item.parentItem?.tags ?? [])]),
    );

    const [packs, bundleComponents, servicePlans, priceRules, discountRules] =
      await Promise.all([
        this.prismaService.scoped.itemPack.findMany({
          where: { organizationId, itemId: { in: lookupIds } },
          orderBy: [{ unitsPerPack: "asc" }, { code: "asc" }],
        }),
        this.prismaService.scoped.itemBundleComponent.findMany({
          where: { organizationId, bundleItemId: itemId },
          orderBy: { sortOrder: "asc" },
          include: {
            componentItem: {
              select: {
                id: true,
                sku: true,
                name: true,
                type: true,
                unitOfMeasure: true,
                salePriceCents: true,
                costPriceCents: true,
              },
            },
            componentPack: {
              select: {
                id: true,
                code: true,
                name: true,
                unitsPerPack: true,
                salePriceCents: true,
                costPriceCents: true,
              },
            },
          },
        }),
        this.prismaService.scoped.servicePlan.findMany({
          where: { organizationId, itemId },
          orderBy: { basePriceCents: "asc" },
        }),
        this.prismaService.scoped.priceRule.findMany({
          where: { organizationId, itemId: { in: lookupIds }, isActive: true },
          include: {
            priceBook: {
              select: {
                id: true,
                code: true,
                name: true,
                direction: true,
                currency: true,
                priority: true,
                customerSegment: true,
                externalAccountId: true,
                supplierId: true,
                isDefault: true,
              },
            },
            tiers: { orderBy: { minQuantity: "asc" } },
          },
        }),
        this.prismaService.scoped.discountRule.findMany({
          where: {
            organizationId,
            isActive: true,
            OR: [
              { targetItemId: { in: lookupIds } },
              ...(mergedTags.length > 0 ? [{ targetTags: { hasSome: mergedTags } }] : []),
            ],
          },
          orderBy: { priority: "asc" },
        }),
      ]);

    const ownPacks = packs.filter((p) => p.itemId === itemId);
    const ownPackCodes = new Set(ownPacks.map((p) => p.code));
    const inheritedPacks = parentId
      ? packs.filter((p) => p.itemId === parentId && !ownPackCodes.has(p.code))
      : [];

    const ownPriceRules = priceRules.filter((r) => r.itemId === itemId);
    const inheritedPriceRules =
      parentId && item.inheritParentPricing
        ? priceRules.filter((r) => r.itemId === parentId)
        : [];

    const effectiveSalePriceCents =
      item.salePriceOverrideCents ??
      (item.inheritParentPricing && item.parentItem
        ? item.parentItem.salePriceCents
        : item.salePriceCents);
    const effectiveCostPriceCents =
      item.costPriceOverrideCents ??
      (item.inheritParentPricing && item.parentItem
        ? item.parentItem.costPriceCents
        : item.costPriceCents);

    return {
      organizationId,
      item,
      effectivePricing: {
        inheritParentPricing: item.inheritParentPricing,
        salePriceCents: effectiveSalePriceCents,
        costPriceCents: effectiveCostPriceCents,
        salePriceInherited:
          Boolean(parentId) &&
          item.inheritParentPricing &&
          item.salePriceOverrideCents === null,
        costPriceInherited:
          Boolean(parentId) &&
          item.inheritParentPricing &&
          item.costPriceOverrideCents === null,
      },
      packs: ownPacks,
      inheritedPacks,
      bundleComponents,
      servicePlans,
      priceRules: ownPriceRules,
      inheritedPriceRules,
      discountRules,
    };
  }

  // ==========================================
  // Item Packs (Multi-UoM)
  // ==========================================

  async createItemPack(
    tenant: AuthenticatedTenant,
    itemId: string,
    input: CreateItemPackInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const code = input.code.trim().toUpperCase();

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        const item = await tx.item.findFirst({
          where: { id: itemId, organizationId },
        });
        if (!item) {
          throw new NotFoundException("Catalog item was not found.");
        }
        if (item.status === ItemStatus.ARCHIVED) {
          throw new BadRequestException("Cannot add packs to an archived item.");
        }

        if (input.isDefaultSalesPack) {
          await tx.itemPack.updateMany({
            where: { organizationId, itemId, isDefaultSalesPack: true },
            data: { isDefaultSalesPack: false },
          });
        }
        if (input.isDefaultPurchasePack) {
          await tx.itemPack.updateMany({
            where: { organizationId, itemId, isDefaultPurchasePack: true },
            data: { isDefaultPurchasePack: false },
          });
        }

        const created = await tx.itemPack.create({
          data: {
            organizationId,
            itemId,
            code,
            name: input.name.trim(),
            unitOfMeasure: input.unitOfMeasure.trim(),
            unitsPerPack: input.unitsPerPack,
            barcode: input.barcode?.trim() || null,
            packSku: input.packSku?.trim() || null,
            salePriceCents: input.salePriceCents ?? null,
            costPriceCents: input.costPriceCents ?? null,
            isSellable: input.isSellable ?? true,
            isPurchasable: input.isPurchasable ?? true,
            isDefaultSalesPack: input.isDefaultSalesPack ?? false,
            isDefaultPurchasePack: input.isDefaultPurchasePack ?? false,
            minOrderPacks: input.minOrderPacks ?? 1,
            packStep: input.packStep ?? 1,
            weightGrams: input.weightGrams ?? null,
            dimensionsJson: toNullableJson(input.dimensionsJson),
            isActive: input.isActive ?? true,
            metadata: toNullableJson(input.metadata),
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "pricing.pack.created",
            resourceType: "ItemPack",
            resourceId: created.id,
            metadata: {
              itemId,
              code: created.code,
              unitsPerPack: created.unitsPerPack,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return created;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`Pack code "${code}" already exists on this item.`);
      }
      throw error;
    }
  }

  async updateItemPack(
    tenant: AuthenticatedTenant,
    packId: string,
    input: UpdateItemPackInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        const existing = await tx.itemPack.findFirst({
          where: { id: packId, organizationId },
        });
        if (!existing) {
          throw new NotFoundException("Item pack was not found.");
        }

        if (input.isDefaultSalesPack) {
          await tx.itemPack.updateMany({
            where: {
              organizationId,
              itemId: existing.itemId,
              id: { not: packId },
              isDefaultSalesPack: true,
            },
            data: { isDefaultSalesPack: false },
          });
        }
        if (input.isDefaultPurchasePack) {
          await tx.itemPack.updateMany({
            where: {
              organizationId,
              itemId: existing.itemId,
              id: { not: packId },
              isDefaultPurchasePack: true,
            },
            data: { isDefaultPurchasePack: false },
          });
        }

        const updated = await tx.itemPack.update({
          where: { id: packId },
          data: {
            ...(input.code !== undefined ? { code: input.code.trim().toUpperCase() } : {}),
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.unitOfMeasure !== undefined ? { unitOfMeasure: input.unitOfMeasure.trim() } : {}),
            ...(input.unitsPerPack !== undefined ? { unitsPerPack: input.unitsPerPack } : {}),
            ...(input.barcode !== undefined ? { barcode: input.barcode?.trim() || null } : {}),
            ...(input.packSku !== undefined ? { packSku: input.packSku?.trim() || null } : {}),
            ...(input.salePriceCents !== undefined ? { salePriceCents: input.salePriceCents } : {}),
            ...(input.costPriceCents !== undefined ? { costPriceCents: input.costPriceCents } : {}),
            ...(input.isSellable !== undefined ? { isSellable: input.isSellable } : {}),
            ...(input.isPurchasable !== undefined ? { isPurchasable: input.isPurchasable } : {}),
            ...(input.isDefaultSalesPack !== undefined ? { isDefaultSalesPack: input.isDefaultSalesPack } : {}),
            ...(input.isDefaultPurchasePack !== undefined ? { isDefaultPurchasePack: input.isDefaultPurchasePack } : {}),
            ...(input.minOrderPacks !== undefined ? { minOrderPacks: input.minOrderPacks } : {}),
            ...(input.packStep !== undefined ? { packStep: input.packStep } : {}),
            ...(input.weightGrams !== undefined ? { weightGrams: input.weightGrams } : {}),
            ...(input.dimensionsJson !== undefined ? { dimensionsJson: toNullableJson(input.dimensionsJson) } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            ...(input.metadata !== undefined ? { metadata: toNullableJson(input.metadata) } : {}),
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "pricing.pack.updated",
            resourceType: "ItemPack",
            resourceId: updated.id,
            metadata: { code: updated.code, itemId: updated.itemId } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return updated;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException("Pack code already exists on this item.");
      }
      throw error;
    }
  }

  async deleteItemPack(
    tenant: AuthenticatedTenant,
    packId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.itemPack.findFirst({
        where: { id: packId, organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Item pack was not found.");
      }

      await tx.itemPack.delete({ where: { id: packId } });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "pricing.pack.deleted",
          resourceType: "ItemPack",
          resourceId: packId,
          metadata: { itemId: existing.itemId, code: existing.code } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return { deleted: true, packId };
    });
  }

  // ==========================================
  // Item Bundles / Kits
  // ==========================================

  async setBundleComponents(
    tenant: AuthenticatedTenant,
    bundleItemId: string,
    components: BundleComponentInput[],
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const parent = await tx.item.findFirst({
        where: { id: bundleItemId, organizationId },
      });
      if (!parent) {
        throw new NotFoundException("Bundle parent item was not found.");
      }
      if (parent.status === ItemStatus.ARCHIVED) {
        throw new BadRequestException("Cannot configure components on an archived item.");
      }

      const uniqueComponentIds = new Set<string>();
      for (const comp of components) {
        if (comp.componentItemId === bundleItemId) {
          throw new BadRequestException("A bundle item cannot contain itself.");
        }
        if (uniqueComponentIds.has(comp.componentItemId)) {
          throw new BadRequestException(
            `Duplicate bundle component item (${comp.componentItemId}). Combine quantities into one entry.`,
          );
        }
        uniqueComponentIds.add(comp.componentItemId);
      }

      const componentIds = Array.from(uniqueComponentIds);
      if (componentIds.length > 0) {
        const foundItems = await tx.item.findMany({
          where: {
            organizationId,
            id: { in: componentIds },
            status: { not: ItemStatus.ARCHIVED },
          },
          select: { id: true },
        });
        if (foundItems.length !== componentIds.length) {
          throw new BadRequestException(
            "One or more bundle component items were not found or are archived.",
          );
        }
      }

      const packIds = components
        .map((c) => c.componentPackId)
        .filter((id): id is string => Boolean(id));
      if (packIds.length > 0) {
        const packs = await tx.itemPack.findMany({
          where: { organizationId, id: { in: packIds }, isActive: true },
          select: { id: true, itemId: true },
        });
        const packMap = new Map(packs.map((p) => [p.id, p]));
        for (const comp of components) {
          if (comp.componentPackId) {
            const p = packMap.get(comp.componentPackId);
            if (!p || p.itemId !== comp.componentItemId) {
              throw new BadRequestException(
                `Component pack (${comp.componentPackId}) does not belong to component item (${comp.componentItemId}).`,
              );
            }
          }
        }
      }

      await tx.itemBundleComponent.deleteMany({
        where: { organizationId, bundleItemId },
      });

      if (components.length > 0) {
        await tx.itemBundleComponent.createMany({
          data: components.map((comp, idx) => ({
            organizationId,
            bundleItemId,
            componentItemId: comp.componentItemId,
            componentPackId: comp.componentPackId ?? null,
            quantity: comp.quantity,
            priceAllocationBps: comp.priceAllocationBps ?? null,
            isOptional: comp.isOptional ?? false,
            sortOrder: comp.sortOrder ?? idx,
          })),
        });
      }

      await tx.item.update({
        where: { id: bundleItemId },
        data: { isBundle: components.length > 0 },
      });

      const saved = await tx.itemBundleComponent.findMany({
        where: { organizationId, bundleItemId },
        orderBy: { sortOrder: "asc" },
        include: {
          componentItem: {
            select: {
              id: true,
              sku: true,
              name: true,
              type: true,
              unitOfMeasure: true,
              salePriceCents: true,
            },
          },
          componentPack: {
            select: {
              id: true,
              code: true,
              name: true,
              unitsPerPack: true,
              salePriceCents: true,
            },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "pricing.bundle.updated",
          resourceType: "Item",
          resourceId: bundleItemId,
          metadata: { componentCount: saved.length } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        organizationId,
        bundleItemId,
        isBundle: saved.length > 0,
        components: saved,
      };
    });
  }

  async getBundleComponents(tenant: AuthenticatedTenant, bundleItemId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const item = await this.prismaService.scoped.item.findUnique({
      where: { id: bundleItemId },
      select: { id: true, sku: true, name: true, isBundle: true },
    });
    if (!item) {
      throw new NotFoundException("Bundle item was not found.");
    }

    const components = await this.prismaService.scoped.itemBundleComponent.findMany({
      where: { organizationId, bundleItemId },
      orderBy: { sortOrder: "asc" },
      include: {
        componentItem: {
          select: {
            id: true,
            sku: true,
            name: true,
            type: true,
            unitOfMeasure: true,
            salePriceCents: true,
            costPriceCents: true,
          },
        },
        componentPack: {
          select: {
            id: true,
            code: true,
            name: true,
            unitsPerPack: true,
            salePriceCents: true,
          },
        },
      },
    });

    return {
      organizationId,
      item,
      components,
    };
  }

  // ==========================================
  // Service Retainers & Hour Packs
  // ==========================================

  async createServicePlan(
    tenant: AuthenticatedTenant,
    itemId: string,
    input: CreateServicePlanInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const code = input.code.trim().toUpperCase();

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        const item = await tx.item.findFirst({
          where: { id: itemId, organizationId },
        });
        if (!item) {
          throw new NotFoundException("Catalog item was not found.");
        }
        if (item.type !== ItemType.SERVICE) {
          throw new BadRequestException(
            "Service plans (retainers and hour packs) can only be attached to SERVICE items.",
          );
        }

        const created = await tx.servicePlan.create({
          data: {
            organizationId,
            itemId,
            code,
            name: input.name.trim(),
            description: input.description ?? null,
            planType: input.planType ?? ServicePlanType.HOUR_PACK,
            billingCycle: input.billingCycle ?? BillingCycle.ONE_TIME,
            includedUnits: input.includedUnits,
            unitLabel: input.unitLabel?.trim() || "hours",
            basePriceCents: input.basePriceCents,
            overageUnitPriceCents: input.overageUnitPriceCents ?? null,
            setupFeeCents: input.setupFeeCents ?? 0,
            rolloverEnabled: input.rolloverEnabled ?? false,
            maxRolloverUnits: input.maxRolloverUnits ?? null,
            validityDays: input.validityDays ?? null,
            isActive: input.isActive ?? true,
            metadata: toNullableJson(input.metadata),
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "pricing.service_plan.created",
            resourceType: "ServicePlan",
            resourceId: created.id,
            metadata: {
              itemId,
              code: created.code,
              planType: created.planType,
              includedUnits: created.includedUnits,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return created;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`Service plan code "${code}" already exists on this item.`);
      }
      throw error;
    }
  }

  async updateServicePlan(
    tenant: AuthenticatedTenant,
    planId: string,
    input: UpdateServicePlanInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        const existing = await tx.servicePlan.findFirst({
          where: { id: planId, organizationId },
        });
        if (!existing) {
          throw new NotFoundException("Service plan was not found.");
        }

        const updated = await tx.servicePlan.update({
          where: { id: planId },
          data: {
            ...(input.code !== undefined ? { code: input.code.trim().toUpperCase() } : {}),
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.planType !== undefined ? { planType: input.planType } : {}),
            ...(input.billingCycle !== undefined ? { billingCycle: input.billingCycle } : {}),
            ...(input.includedUnits !== undefined ? { includedUnits: input.includedUnits } : {}),
            ...(input.unitLabel !== undefined ? { unitLabel: input.unitLabel.trim() } : {}),
            ...(input.basePriceCents !== undefined ? { basePriceCents: input.basePriceCents } : {}),
            ...(input.overageUnitPriceCents !== undefined ? { overageUnitPriceCents: input.overageUnitPriceCents } : {}),
            ...(input.setupFeeCents !== undefined ? { setupFeeCents: input.setupFeeCents } : {}),
            ...(input.rolloverEnabled !== undefined ? { rolloverEnabled: input.rolloverEnabled } : {}),
            ...(input.maxRolloverUnits !== undefined ? { maxRolloverUnits: input.maxRolloverUnits } : {}),
            ...(input.validityDays !== undefined ? { validityDays: input.validityDays } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            ...(input.metadata !== undefined ? { metadata: toNullableJson(input.metadata) } : {}),
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "pricing.service_plan.updated",
            resourceType: "ServicePlan",
            resourceId: updated.id,
            metadata: { code: updated.code } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return updated;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException("Service plan code already exists on this item.");
      }
      throw error;
    }
  }

  // ==========================================
  // Price Books & Rules / Tiers
  // ==========================================

  async createPriceBook(
    tenant: AuthenticatedTenant,
    input: CreatePriceBookInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const code = input.code.trim().toUpperCase();
    const direction = input.direction ?? PriceBookDirection.SALES;
    const currency = (input.currency ?? "USD").toUpperCase();

    if (input.startsAt && input.endsAt && new Date(input.endsAt) < new Date(input.startsAt)) {
      throw new BadRequestException("Price book endsAt must be after startsAt.");
    }

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        if (input.supplierId) {
          const sup = await tx.supplier.findFirst({
            where: { id: input.supplierId, organizationId },
            select: { id: true },
          });
          if (!sup) {
            throw new NotFoundException("Supplier was not found in the active organization.");
          }
        }

        if (input.isDefault) {
          await tx.priceBook.updateMany({
            where: { organizationId, direction, currency, isDefault: true },
            data: { isDefault: false },
          });
        }

        const created = await tx.priceBook.create({
          data: {
            organizationId,
            code,
            name: input.name.trim(),
            description: input.description ?? null,
            direction,
            currency,
            priority: input.priority ?? 100,
            isDefault: input.isDefault ?? false,
            isActive: input.isActive ?? true,
            customerSegment: input.customerSegment?.trim() || null,
            externalAccountId: input.externalAccountId?.trim() || null,
            supplierId: input.supplierId ?? null,
            startsAt: input.startsAt ? new Date(input.startsAt) : null,
            endsAt: input.endsAt ? new Date(input.endsAt) : null,
            customAttributes: toNullableJson(input.customAttributes),
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "pricing.price_book.created",
            resourceType: "PriceBook",
            resourceId: created.id,
            metadata: {
              code: created.code,
              direction: created.direction,
              currency: created.currency,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return created;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`Price book code "${code}" already exists.`);
      }
      throw error;
    }
  }

  async listPriceBooks(
    tenant: AuthenticatedTenant,
    query: {
      direction?: PriceBookDirection;
      customerSegment?: string;
      externalAccountId?: string;
      supplierId?: string;
      isActive?: boolean;
    },
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const items = await this.prismaService.scoped.priceBook.findMany({
      where: {
        organizationId,
        ...(query.direction ? { direction: query.direction } : {}),
        ...(query.customerSegment ? { customerSegment: query.customerSegment } : {}),
        ...(query.externalAccountId ? { externalAccountId: query.externalAccountId } : {}),
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
        ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
      include: {
        _count: { select: { rules: true } },
      },
    });

    return { organizationId, items };
  }

  async getPriceBook(tenant: AuthenticatedTenant, priceBookId: string) {
    this.resolveVerifiedOrganizationId(tenant);
    const pb = await this.prismaService.scoped.priceBook.findUnique({
      where: { id: priceBookId },
      include: {
        rules: {
          orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
          include: {
            item: { select: { id: true, sku: true, name: true, unitOfMeasure: true } },
            pack: { select: { id: true, code: true, name: true, unitsPerPack: true } },
            servicePlan: { select: { id: true, code: true, name: true, includedUnits: true } },
            tiers: { orderBy: { minQuantity: "asc" } },
          },
        },
      },
    });
    if (!pb) {
      throw new NotFoundException("Price book was not found.");
    }
    return pb;
  }

  async updatePriceBook(
    tenant: AuthenticatedTenant,
    priceBookId: string,
    input: UpdatePriceBookInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        const existing = await tx.priceBook.findFirst({
          where: { id: priceBookId, organizationId },
        });
        if (!existing) {
          throw new NotFoundException("Price book was not found.");
        }

        const nextDirection = input.direction ?? existing.direction;
        const nextCurrency = (input.currency ?? existing.currency).toUpperCase();

        if (input.isDefault) {
          await tx.priceBook.updateMany({
            where: {
              organizationId,
              direction: nextDirection,
              currency: nextCurrency,
              id: { not: priceBookId },
              isDefault: true,
            },
            data: { isDefault: false },
          });
        }

        const updated = await tx.priceBook.update({
          where: { id: priceBookId },
          data: {
            ...(input.code !== undefined ? { code: input.code.trim().toUpperCase() } : {}),
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.direction !== undefined ? { direction: input.direction } : {}),
            ...(input.currency !== undefined ? { currency: nextCurrency } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            ...(input.customerSegment !== undefined ? { customerSegment: input.customerSegment?.trim() || null } : {}),
            ...(input.externalAccountId !== undefined ? { externalAccountId: input.externalAccountId?.trim() || null } : {}),
            ...(input.supplierId !== undefined ? { supplierId: input.supplierId } : {}),
            ...(input.startsAt !== undefined ? { startsAt: input.startsAt ? new Date(input.startsAt) : null } : {}),
            ...(input.endsAt !== undefined ? { endsAt: input.endsAt ? new Date(input.endsAt) : null } : {}),
            ...(input.customAttributes !== undefined ? { customAttributes: toNullableJson(input.customAttributes) } : {}),
            updatedByUserId: tenant.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "pricing.price_book.updated",
            resourceType: "PriceBook",
            resourceId: updated.id,
            metadata: { code: updated.code } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return updated;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException("Price book code already exists.");
      }
      throw error;
    }
  }

  async createPriceRule(
    tenant: AuthenticatedTenant,
    priceBookId: string,
    input: CreatePriceRuleInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const pricingModel = input.pricingModel ?? PricingModel.FLAT;
    this.validateTiers(pricingModel, input.tiers);

    return this.prismaService.raw.$transaction(async (tx) => {
      const [pb, item] = await Promise.all([
        tx.priceBook.findFirst({ where: { id: priceBookId, organizationId } }),
        tx.item.findFirst({ where: { id: input.itemId, organizationId } }),
      ]);
      if (!pb) throw new NotFoundException("Price book was not found.");
      if (!item) throw new NotFoundException("Catalog item was not found.");

      if (input.packId) {
        const pack = await tx.itemPack.findFirst({
          where: { id: input.packId, organizationId, itemId: item.id },
        });
        if (!pack) {
          throw new BadRequestException("Specified packId does not belong to the target item.");
        }
      }
      if (input.servicePlanId) {
        const plan = await tx.servicePlan.findFirst({
          where: { id: input.servicePlanId, organizationId, itemId: item.id },
        });
        if (!plan) {
          throw new BadRequestException("Specified servicePlanId does not belong to the target item.");
        }
      }

      const created = await tx.priceRule.create({
        data: {
          organizationId,
          priceBookId,
          itemId: item.id,
          packId: input.packId ?? null,
          servicePlanId: input.servicePlanId ?? null,
          name: input.name.trim(),
          pricingModel,
          baseUnitPriceCents: input.baseUnitPriceCents,
          minMarginBps: input.minMarginBps ?? null,
          minQuantity: input.minQuantity ?? 1,
          maxQuantity: input.maxQuantity ?? null,
          conditions: toNullableJson(input.conditions),
          customAdjustment: toNullableJson(input.customAdjustment),
          priority: input.priority ?? 100,
          isActive: input.isActive ?? true,
          startsAt: input.startsAt ? new Date(input.startsAt) : null,
          endsAt: input.endsAt ? new Date(input.endsAt) : null,
          ...(input.tiers && input.tiers.length > 0
            ? {
                tiers: {
                  create: input.tiers.map((t, idx) => ({
                    organizationId,
                    minQuantity: t.minQuantity,
                    maxQuantity: t.maxQuantity ?? null,
                    unitPriceCents: t.unitPriceCents ?? null,
                    flatFeeCents: t.flatFeeCents ?? null,
                    packageSize: t.packageSize ?? null,
                    packagePriceCents: t.packagePriceCents ?? null,
                    discountBps: t.discountBps ?? null,
                    sortOrder: t.sortOrder ?? idx,
                  })),
                },
              }
            : {}),
        },
        include: { tiers: { orderBy: { minQuantity: "asc" } } },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "pricing.rule.created",
          resourceType: "PriceRule",
          resourceId: created.id,
          metadata: {
            priceBookId,
            itemId: item.id,
            pricingModel: created.pricingModel,
            tierCount: created.tiers.length,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return created;
    });
  }

  async updatePriceRule(
    tenant: AuthenticatedTenant,
    ruleId: string,
    input: UpdatePriceRuleInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.priceRule.findFirst({
        where: { id: ruleId, organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Price rule was not found.");
      }

      const nextModel = input.pricingModel ?? existing.pricingModel;
      if (input.tiers) {
        this.validateTiers(nextModel, input.tiers);
        await tx.priceTier.deleteMany({
          where: { organizationId, priceRuleId: ruleId },
        });
        if (input.tiers.length > 0) {
          await tx.priceTier.createMany({
            data: input.tiers.map((t, idx) => ({
              organizationId,
              priceRuleId: ruleId,
              minQuantity: t.minQuantity,
              maxQuantity: t.maxQuantity ?? null,
              unitPriceCents: t.unitPriceCents ?? null,
              flatFeeCents: t.flatFeeCents ?? null,
              packageSize: t.packageSize ?? null,
              packagePriceCents: t.packagePriceCents ?? null,
              discountBps: t.discountBps ?? null,
              sortOrder: t.sortOrder ?? idx,
            })),
          });
        }
      }

      const updated = await tx.priceRule.update({
        where: { id: ruleId },
        data: {
          ...(input.packId !== undefined ? { packId: input.packId } : {}),
          ...(input.servicePlanId !== undefined ? { servicePlanId: input.servicePlanId } : {}),
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.pricingModel !== undefined ? { pricingModel: input.pricingModel } : {}),
          ...(input.baseUnitPriceCents !== undefined ? { baseUnitPriceCents: input.baseUnitPriceCents } : {}),
          ...(input.minMarginBps !== undefined ? { minMarginBps: input.minMarginBps } : {}),
          ...(input.minQuantity !== undefined ? { minQuantity: input.minQuantity } : {}),
          ...(input.maxQuantity !== undefined ? { maxQuantity: input.maxQuantity } : {}),
          ...(input.conditions !== undefined ? { conditions: toNullableJson(input.conditions) } : {}),
          ...(input.customAdjustment !== undefined ? { customAdjustment: toNullableJson(input.customAdjustment) } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.startsAt !== undefined ? { startsAt: input.startsAt ? new Date(input.startsAt) : null } : {}),
          ...(input.endsAt !== undefined ? { endsAt: input.endsAt ? new Date(input.endsAt) : null } : {}),
        },
        include: { tiers: { orderBy: { minQuantity: "asc" } } },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "pricing.rule.updated",
          resourceType: "PriceRule",
          resourceId: ruleId,
          metadata: { pricingModel: updated.pricingModel } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async deletePriceRule(
    tenant: AuthenticatedTenant,
    ruleId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.priceRule.findFirst({
        where: { id: ruleId, organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Price rule was not found.");
      }
      await tx.priceRule.delete({ where: { id: ruleId } });
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "pricing.rule.deleted",
          resourceType: "PriceRule",
          resourceId: ruleId,
          ipAddress: ipAddress ?? null,
        },
      });
      return { deleted: true, ruleId };
    });
  }

  // ==========================================
  // Discount & Promotion Rules
  // ==========================================

  async createDiscountRule(
    tenant: AuthenticatedTenant,
    input: CreateDiscountRuleInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const code = input.code.trim().toUpperCase();
    this.validateDiscountFields(input);

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        if (input.targetItemId) {
          const item = await tx.item.findFirst({
            where: { id: input.targetItemId, organizationId },
            select: { id: true },
          });
          if (!item) throw new NotFoundException("Target item was not found.");
        }
        if (input.targetPackId) {
          const pack = await tx.itemPack.findFirst({
            where: { id: input.targetPackId, organizationId },
            select: { id: true },
          });
          if (!pack) throw new NotFoundException("Target pack was not found.");
        }

        const created = await tx.discountRule.create({
          data: {
            organizationId,
            code,
            name: input.name.trim(),
            description: input.description ?? null,
            promoCode: input.promoCode?.trim().toUpperCase() || null,
            discountType: input.discountType,
            scope: input.scope ?? DiscountScope.LINE_ITEM,
            valueBps: input.valueBps ?? null,
            amountCents: input.amountCents ?? null,
            fixedPriceCents: input.fixedPriceCents ?? null,
            buyQuantity: input.buyQuantity ?? null,
            getQuantity: input.getQuantity ?? null,
            getDiscountBps: input.getDiscountBps ?? null,
            targetItemId: input.targetItemId ?? null,
            targetPackId: input.targetPackId ?? null,
            targetTags: input.targetTags ?? [],
            customerSegments: input.customerSegments ?? [],
            externalAccountIds: input.externalAccountIds ?? [],
            minQuantity: input.minQuantity ?? null,
            minOrderSubtotalCents: input.minOrderSubtotalCents ?? null,
            maxDiscountCents: input.maxDiscountCents ?? null,
            isStackable: input.isStackable ?? false,
            priority: input.priority ?? 100,
            startsAt: input.startsAt ? new Date(input.startsAt) : null,
            endsAt: input.endsAt ? new Date(input.endsAt) : null,
            usageLimit: input.usageLimit ?? null,
            isActive: input.isActive ?? true,
            conditions: toNullableJson(input.conditions),
            createdByUserId: tenant.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "pricing.discount.created",
            resourceType: "DiscountRule",
            resourceId: created.id,
            metadata: {
              code: created.code,
              discountType: created.discountType,
              promoCode: created.promoCode,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return created;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`Discount code "${code}" already exists.`);
      }
      throw error;
    }
  }

  async listDiscountRules(
    tenant: AuthenticatedTenant,
    query: { isActive?: boolean; promoCode?: string; scope?: DiscountScope },
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const items = await this.prismaService.scoped.discountRule.findMany({
      where: {
        organizationId,
        ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
        ...(query.promoCode ? { promoCode: query.promoCode.trim().toUpperCase() } : {}),
        ...(query.scope ? { scope: query.scope } : {}),
      },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    });

    return { organizationId, items };
  }

  async updateDiscountRule(
    tenant: AuthenticatedTenant,
    discountId: string,
    input: UpdateDiscountRuleInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    try {
      return await this.prismaService.raw.$transaction(async (tx) => {
        const existing = await tx.discountRule.findFirst({
          where: { id: discountId, organizationId },
        });
        if (!existing) {
          throw new NotFoundException("Discount rule was not found.");
        }

        const merged = {
          discountType: input.discountType ?? existing.discountType,
          valueBps: input.valueBps !== undefined ? input.valueBps : existing.valueBps,
          amountCents: input.amountCents !== undefined ? input.amountCents : existing.amountCents,
          fixedPriceCents: input.fixedPriceCents !== undefined ? input.fixedPriceCents : existing.fixedPriceCents,
          buyQuantity: input.buyQuantity !== undefined ? input.buyQuantity : existing.buyQuantity,
          getQuantity: input.getQuantity !== undefined ? input.getQuantity : existing.getQuantity,
          startsAt: input.startsAt !== undefined ? input.startsAt : existing.startsAt?.toISOString() ?? null,
          endsAt: input.endsAt !== undefined ? input.endsAt : existing.endsAt?.toISOString() ?? null,
        };
        this.validateDiscountFields(merged);

        const updated = await tx.discountRule.update({
          where: { id: discountId },
          data: {
            ...(input.code !== undefined ? { code: input.code.trim().toUpperCase() } : {}),
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.promoCode !== undefined ? { promoCode: input.promoCode?.trim().toUpperCase() || null } : {}),
            ...(input.discountType !== undefined ? { discountType: input.discountType } : {}),
            ...(input.scope !== undefined ? { scope: input.scope } : {}),
            ...(input.valueBps !== undefined ? { valueBps: input.valueBps } : {}),
            ...(input.amountCents !== undefined ? { amountCents: input.amountCents } : {}),
            ...(input.fixedPriceCents !== undefined ? { fixedPriceCents: input.fixedPriceCents } : {}),
            ...(input.buyQuantity !== undefined ? { buyQuantity: input.buyQuantity } : {}),
            ...(input.getQuantity !== undefined ? { getQuantity: input.getQuantity } : {}),
            ...(input.getDiscountBps !== undefined ? { getDiscountBps: input.getDiscountBps } : {}),
            ...(input.targetItemId !== undefined ? { targetItemId: input.targetItemId } : {}),
            ...(input.targetPackId !== undefined ? { targetPackId: input.targetPackId } : {}),
            ...(input.targetTags !== undefined ? { targetTags: input.targetTags } : {}),
            ...(input.customerSegments !== undefined ? { customerSegments: input.customerSegments } : {}),
            ...(input.externalAccountIds !== undefined ? { externalAccountIds: input.externalAccountIds } : {}),
            ...(input.minQuantity !== undefined ? { minQuantity: input.minQuantity } : {}),
            ...(input.minOrderSubtotalCents !== undefined ? { minOrderSubtotalCents: input.minOrderSubtotalCents } : {}),
            ...(input.maxDiscountCents !== undefined ? { maxDiscountCents: input.maxDiscountCents } : {}),
            ...(input.isStackable !== undefined ? { isStackable: input.isStackable } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.startsAt !== undefined ? { startsAt: input.startsAt ? new Date(input.startsAt) : null } : {}),
            ...(input.endsAt !== undefined ? { endsAt: input.endsAt ? new Date(input.endsAt) : null } : {}),
            ...(input.usageLimit !== undefined ? { usageLimit: input.usageLimit } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            ...(input.conditions !== undefined ? { conditions: toNullableJson(input.conditions) } : {}),
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "pricing.discount.updated",
            resourceType: "DiscountRule",
            resourceId: discountId,
            metadata: { code: updated.code } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return updated;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException("Discount code already exists.");
      }
      throw error;
    }
  }
}

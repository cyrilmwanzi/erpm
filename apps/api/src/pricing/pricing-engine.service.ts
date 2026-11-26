import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  DiscountScope,
  ItemStatus,
  ItemVariantKind,
  PriceBookDirection,
  PricingModel,
  TenantContext,
} from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedTenant } from "../tenancy/tenant.decorators.js";
import {
  applyCustomRuleAdjustment,
  calculateDiscountAmount,
  calculateTieredSubtotal,
  enforceMinMarginFloor,
  evaluatePricingConditions,
  type AppliedTierBreakdown,
} from "./pricing-calculator.utils.js";

export interface QuoteLineRequest {
  itemId: string;
  quantity: number;
  packId?: string | null;
  servicePlanId?: string | null;
  overrideUnitPriceCents?: number | null;
}

export interface CalculateQuoteInput {
  direction?: PriceBookDirection;
  currency?: string;
  priceBookId?: string | null;
  customerSegment?: string | null;
  externalAccountId?: string | null;
  supplierId?: string | null;
  channel?: string | null;
  promoCodes?: string[];
  atDate?: string | null;
  customContext?: Record<string, unknown> | null;
  lines: QuoteLineRequest[];
}

export interface AppliedDiscountBreakdown {
  discountId: string;
  code: string;
  name: string;
  promoCode: string | null;
  discountType: string;
  scope: DiscountScope;
  discountCents: number;
  bonusUnits: number;
}

export interface CalculatedQuoteLine {
  itemId: string;
  sku: string;
  name: string;
  type: string;
  variantKind: string;
  parentItemId: string | null;
  pricingInheritedFromParent: boolean;
  variantAttributes: Array<{
    optionId: string;
    optionCode: string;
    optionName: string;
    optionValueId: string;
    valueCode: string;
    valueLabel: string;
    swatchHex: string | null;
  }>;
  packId: string | null;
  packCode: string | null;
  unitOfMeasure: string;
  unitsPerPack: number;
  quantity: number;
  totalBaseUnits: number;
  servicePlanId: string | null;
  servicePlanSummary: {
    code: string;
    name: string;
    planType: string;
    billingCycle: string;
    includedUnits: number;
    unitLabel: string;
    setupFeeCents: number;
    overageUnitPriceCents: number | null;
  } | null;
  bundleBreakdown: Array<{
    componentItemId: string;
    componentSku: string;
    componentName: string;
    quantityPerBundle: number;
    totalComponentQty: number;
    isOptional: boolean;
  }>;
  priceBookId: string | null;
  priceBookCode: string | null;
  priceRuleId: string | null;
  pricingModel: PricingModel;
  listUnitPriceCents: number;
  effectiveUnitPriceCents: number;
  baseSubtotalCents: number;
  tierSubtotalCents: number;
  setupFeeCents: number;
  customAdjustmentCents: number;
  marginFloorApplied: boolean;
  lineDiscountCents: number;
  finalLineTotalCents: number;
  bonusUnits: number;
  appliedTiers: AppliedTierBreakdown[];
  appliedDiscounts: AppliedDiscountBreakdown[];
}

export interface CalculatedQuoteResult {
  organizationId: string;
  direction: PriceBookDirection;
  currency: string;
  evaluatedAt: string;
  customerSegment: string | null;
  externalAccountId: string | null;
  supplierId: string | null;
  promoCodes: string[];
  lines: CalculatedQuoteLine[];
  orderDiscounts: AppliedDiscountBreakdown[];
  baseSubtotalCents: number;
  subtotalAfterTiersCents: number;
  lineDiscountTotalCents: number;
  orderDiscountTotalCents: number;
  totalDiscountCents: number;
  totalCents: number;
  totalBonusUnits: number;
  totalBaseUnits: number;
}

@Injectable()
export class PricingEngineService {
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

  async calculateQuote(
    tenant: AuthenticatedTenant,
    input: CalculateQuoteInput,
  ): Promise<CalculatedQuoteResult> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    if (!input.lines || input.lines.length === 0) {
      throw new BadRequestException("At least one line item is required for pricing.");
    }

    const direction = input.direction ?? PriceBookDirection.SALES;
    const atDate = input.atDate ? new Date(input.atDate) : new Date();
    const promoCodes = Array.from(
      new Set(
        (input.promoCodes ?? [])
          .map((c) => c.trim().toUpperCase())
          .filter((c) => c.length > 0),
      ),
    );

    const itemIds = Array.from(new Set(input.lines.map((l) => l.itemId)));
    const packIds = Array.from(
      new Set(input.lines.map((l) => l.packId).filter((id): id is string => Boolean(id))),
    );
    const servicePlanIds = Array.from(
      new Set(
        input.lines
          .map((l) => l.servicePlanId)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    const [settings, items, packs, servicePlans, discountRules] = await Promise.all([
      this.prismaService.raw.tenantSettings.findUnique({
        where: { organizationId },
        select: { defaultCurrency: true },
      }),
      this.prismaService.raw.item.findMany({
        where: { organizationId, id: { in: itemIds } },
        include: {
          variantAttributes: {
            include: {
              option: { select: { id: true, code: true, name: true } },
              optionValue: {
                select: { id: true, code: true, label: true, swatchHex: true },
              },
            },
          },
        },
      }),
      packIds.length > 0
        ? this.prismaService.raw.itemPack.findMany({
            where: { organizationId, id: { in: packIds } },
          })
        : Promise.resolve([]),
      servicePlanIds.length > 0
        ? this.prismaService.raw.servicePlan.findMany({
            where: { organizationId, id: { in: servicePlanIds } },
          })
        : Promise.resolve([]),
      this.prismaService.raw.discountRule.findMany({
        where: {
          organizationId,
          isActive: true,
          AND: [
            { OR: [{ startsAt: null }, { startsAt: { lte: atDate } }] },
            { OR: [{ endsAt: null }, { endsAt: { gte: atDate } }] },
            {
              OR: [
                { promoCode: null },
                ...(promoCodes.length > 0 ? [{ promoCode: { in: promoCodes } }] : []),
              ],
            },
          ],
        },
        orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
      }),
    ]);

    const parentIds = Array.from(
      new Set(
        items
          .map((i) => i.parentItemId)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const lookupItemIds = Array.from(new Set([...itemIds, ...parentIds]));

    const [parentItems, bundleRows, supplierItems, priceBooks] = await Promise.all([
      parentIds.length > 0
        ? this.prismaService.raw.item.findMany({
            where: { organizationId, id: { in: parentIds } },
          })
        : Promise.resolve([]),
      this.prismaService.raw.itemBundleComponent.findMany({
        where: { organizationId, bundleItemId: { in: itemIds } },
        orderBy: { sortOrder: "asc" },
        include: {
          componentItem: {
            select: {
              id: true,
              sku: true,
              name: true,
              salePriceCents: true,
              costPriceCents: true,
            },
          },
          componentPack: {
            select: {
              id: true,
              unitsPerPack: true,
              salePriceCents: true,
              costPriceCents: true,
            },
          },
        },
      }),
      direction === PriceBookDirection.PURCHASE && input.supplierId
        ? this.prismaService.raw.supplierItem.findMany({
            where: {
              organizationId,
              supplierId: input.supplierId,
              itemId: { in: lookupItemIds },
            },
          })
        : Promise.resolve([]),
      this.prismaService.raw.priceBook.findMany({
        where: {
          organizationId,
          direction,
          isActive: true,
          AND: [
            { OR: [{ startsAt: null }, { startsAt: { lte: atDate } }] },
            { OR: [{ endsAt: null }, { endsAt: { gte: atDate } }] },
          ],
        },
        include: {
          rules: {
            where: {
              itemId: { in: lookupItemIds },
              isActive: true,
              AND: [
                { OR: [{ startsAt: null }, { startsAt: { lte: atDate } }] },
                { OR: [{ endsAt: null }, { endsAt: { gte: atDate } }] },
              ],
            },
            include: {
              tiers: { orderBy: [{ minQuantity: "asc" }, { sortOrder: "asc" }] },
            },
            orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
          },
        },
      }),
    ]);

    const currency = (input.currency ?? settings?.defaultCurrency ?? "USD").toUpperCase();
    const itemMap = new Map(items.map((i) => [i.id, i]));
    const parentItemMap = new Map(parentItems.map((i) => [i.id, i]));
    const packMap = new Map(packs.map((p) => [p.id, p]));
    const planMap = new Map(servicePlans.map((s) => [s.id, s]));
    const supplierItemMap = new Map(supplierItems.map((si) => [si.itemId, si]));

    const bundlesByParent = new Map<string, typeof bundleRows>();
    for (const row of bundleRows) {
      const list = bundlesByParent.get(row.bundleItemId) ?? [];
      list.push(row);
      bundlesByParent.set(row.bundleItemId, list);
    }

    if (input.priceBookId) {
      const explicitExists = priceBooks.some((pb) => pb.id === input.priceBookId);
      if (!explicitExists) {
        throw new NotFoundException(
          `Active ${direction} price book (${input.priceBookId}) was not found.`,
        );
      }
    }

    // Score & rank matching price books (lowest rank index = highest precedence)
    const eligibleBooks = priceBooks
      .filter((pb) => {
        if (pb.currency !== currency) return false;
        if (input.priceBookId && pb.id === input.priceBookId) return true;
        if (pb.externalAccountId) {
          return pb.externalAccountId === input.externalAccountId;
        }
        if (pb.customerSegment) {
          return pb.customerSegment === input.customerSegment;
        }
        if (pb.supplierId) {
          return pb.supplierId === input.supplierId;
        }
        return pb.isDefault || (!pb.externalAccountId && !pb.customerSegment && !pb.supplierId);
      })
      .sort((a, b) => {
        const specificity = (pb: (typeof priceBooks)[number]) => {
          if (input.priceBookId && pb.id === input.priceBookId) return 0;
          if (pb.externalAccountId && pb.externalAccountId === input.externalAccountId) return 1;
          if (pb.customerSegment && pb.customerSegment === input.customerSegment) return 2;
          if (pb.supplierId && pb.supplierId === input.supplierId) return 3;
          if (pb.isDefault) return 4;
          return 5;
        };
        return specificity(a) - specificity(b) || a.priority - b.priority;
      });

    // Pass 1: resolve base, pack, bundle, service plan, and tiered pricing per line
    const calculatedLines: CalculatedQuoteLine[] = [];

    for (const lineReq of input.lines) {
      const item = itemMap.get(lineReq.itemId);
      if (!item) {
        throw new NotFoundException(`Catalog item "${lineReq.itemId}" was not found.`);
      }
      if (item.status === ItemStatus.ARCHIVED) {
        throw new BadRequestException(`Archived item "${item.sku}" cannot be quoted.`);
      }
      if (lineReq.quantity < 1) {
        throw new BadRequestException("Line quantity must be >= 1.");
      }

      const parentItem = item.parentItemId
        ? parentItemMap.get(item.parentItemId)
        : undefined;
      const isVariant = item.variantKind === ItemVariantKind.VARIANT;
      const canInheritSalePrice =
        isVariant &&
        item.inheritParentPricing &&
        (item.salePriceOverrideCents === null ||
          item.salePriceOverrideCents === undefined) &&
        Boolean(parentItem);
      const canInheritCostPrice =
        isVariant &&
        item.inheritParentPricing &&
        (item.costPriceOverrideCents === null ||
          item.costPriceOverrideCents === undefined) &&
        Boolean(parentItem);

      const resolvedSaleUnitPriceCents =
        isVariant &&
        item.salePriceOverrideCents !== null &&
        item.salePriceOverrideCents !== undefined
          ? item.salePriceOverrideCents
          : canInheritSalePrice && parentItem
            ? parentItem.salePriceCents
            : item.salePriceCents;

      const resolvedCostUnitPriceCents =
        isVariant &&
        item.costPriceOverrideCents !== null &&
        item.costPriceOverrideCents !== undefined
          ? item.costPriceOverrideCents
          : canInheritCostPrice && parentItem
            ? parentItem.costPriceCents
            : item.costPriceCents;

      const pack = lineReq.packId ? packMap.get(lineReq.packId) : undefined;
      const packBelongsToItemOrParent =
        Boolean(pack) &&
        (pack!.itemId === item.id ||
          (isVariant && Boolean(item.parentItemId) && pack!.itemId === item.parentItemId));
      if (lineReq.packId && (!pack || !packBelongsToItemOrParent || !pack.isActive)) {
        throw new BadRequestException(
          `Pack (${lineReq.packId}) is invalid, inactive, or does not belong to item "${item.sku}".`,
        );
      }
      if (pack) {
        if (direction === PriceBookDirection.SALES && !pack.isSellable) {
          throw new BadRequestException(`Pack "${pack.code}" is not sellable.`);
        }
        if (direction === PriceBookDirection.PURCHASE && !pack.isPurchasable) {
          throw new BadRequestException(`Pack "${pack.code}" is not purchasable.`);
        }
        if (lineReq.quantity < pack.minOrderPacks) {
          throw new BadRequestException(
            `Pack "${pack.code}" requires a minimum order of ${pack.minOrderPacks} packs.`,
          );
        }
        if (
          pack.packStep > 1 &&
          (lineReq.quantity - pack.minOrderPacks) % pack.packStep !== 0
        ) {
          throw new BadRequestException(
            `Pack "${pack.code}" must be ordered in increments of ${pack.packStep} starting from ${pack.minOrderPacks}.`,
          );
        }
      }

      const servicePlan = lineReq.servicePlanId
        ? planMap.get(lineReq.servicePlanId)
        : undefined;
      if (
        lineReq.servicePlanId &&
        (!servicePlan || servicePlan.itemId !== item.id || !servicePlan.isActive)
      ) {
        throw new BadRequestException(
          `Service plan (${lineReq.servicePlanId}) is invalid, inactive, or does not belong to item "${item.sku}".`,
        );
      }

      const unitsPerPack = pack ? pack.unitsPerPack : 1;
      const totalBaseUnits = servicePlan
        ? lineReq.quantity * servicePlan.includedUnits
        : lineReq.quantity * unitsPerPack;

      const compRows = bundlesByParent.get(item.id) ?? [];
      const bundleBreakdown = compRows.map((c) => ({
        componentItemId: c.componentItemId,
        componentSku: c.componentItem.sku,
        componentName: c.componentItem.name,
        quantityPerBundle: c.quantity,
        totalComponentQty: c.quantity * lineReq.quantity,
        isOptional: c.isOptional,
      }));

      // Fallback unit price before price book rules (variant override -> parent fallback)
      const isSharedParentPack = Boolean(pack && pack.itemId !== item.id);
      let fallbackUnitPriceCents: number;
      let pricingInheritedFromParent = false;

      if (
        lineReq.overrideUnitPriceCents !== null &&
        lineReq.overrideUnitPriceCents !== undefined
      ) {
        fallbackUnitPriceCents = lineReq.overrideUnitPriceCents;
      } else if (servicePlan) {
        fallbackUnitPriceCents = servicePlan.basePriceCents;
      } else if (direction === PriceBookDirection.PURCHASE) {
        const variantSupItem = supplierItemMap.get(item.id);
        const parentSupItem =
          !variantSupItem && item.inheritParentPricing && parentItem
            ? supplierItemMap.get(parentItem.id)
            : undefined;
        const supItem = variantSupItem ?? parentSupItem;
        if (
          pack?.costPriceCents !== null &&
          pack?.costPriceCents !== undefined &&
          (!isSharedParentPack || canInheritCostPrice)
        ) {
          fallbackUnitPriceCents = pack.costPriceCents;
          pricingInheritedFromParent = isSharedParentPack;
        } else if (supItem && (!supItem.packId || supItem.packId === pack?.id)) {
          fallbackUnitPriceCents =
            supItem.packId === pack?.id
              ? supItem.unitCostCents
              : supItem.unitCostCents * unitsPerPack;
          pricingInheritedFromParent = Boolean(!variantSupItem && parentSupItem);
        } else {
          fallbackUnitPriceCents = resolvedCostUnitPriceCents * unitsPerPack;
          pricingInheritedFromParent = canInheritCostPrice;
        }
      } else {
        if (
          pack?.salePriceCents !== null &&
          pack?.salePriceCents !== undefined &&
          (!isSharedParentPack || canInheritSalePrice)
        ) {
          fallbackUnitPriceCents = pack.salePriceCents;
          pricingInheritedFromParent = isSharedParentPack;
        } else if (compRows.length > 0 && resolvedSaleUnitPriceCents === 0) {
          fallbackUnitPriceCents = compRows
            .filter((c) => !c.isOptional)
            .reduce((sum, c) => {
              const compPrice =
                c.componentPack?.salePriceCents ??
                c.componentItem.salePriceCents * (c.componentPack?.unitsPerPack ?? 1);
              return sum + c.quantity * compPrice;
            }, 0);
        } else {
          fallbackUnitPriceCents = resolvedSaleUnitPriceCents * unitsPerPack;
          pricingInheritedFromParent = canInheritSalePrice;
        }
      }

      // Match best PriceBook + PriceRule unless explicit unit override was given
      let matchedBook: (typeof eligibleBooks)[number] | null = null;
      let matchedRule: (typeof eligibleBooks)[number]["rules"][number] | null = null;

      if (
        lineReq.overrideUnitPriceCents === null ||
        lineReq.overrideUnitPriceCents === undefined
      ) {
        const mergedTags = Array.from(
          new Set([...item.tags, ...(parentItem?.tags ?? [])]),
        );
        const condCtx = {
          channel: input.channel ?? undefined,
          customerSegment: input.customerSegment ?? undefined,
          externalAccountId: input.externalAccountId ?? undefined,
          lineQuantity: lineReq.quantity,
          itemTags: mergedTags,
          itemMetadata: (item.metadata as Record<string, unknown> | null) ?? null,
          atDate,
          customContext: input.customContext ?? undefined,
        };

        const canInheritParentPriceBookRule =
          isVariant &&
          item.inheritParentPricing &&
          Boolean(parentItem) &&
          (direction === PriceBookDirection.PURCHASE
            ? item.costPriceOverrideCents === null ||
              item.costPriceOverrideCents === undefined
            : item.salePriceOverrideCents === null ||
              item.salePriceOverrideCents === undefined);

        for (const pb of eligibleBooks) {
          const candidates = pb.rules
            .filter((r) => {
              const matchesSelf = r.itemId === item.id;
              const matchesParent =
                canInheritParentPriceBookRule &&
                parentItem !== undefined &&
                r.itemId === parentItem.id;
              if (!matchesSelf && !matchesParent) return false;
              if (r.packId && r.packId !== (pack?.id ?? null)) return false;
              if (r.servicePlanId && r.servicePlanId !== (servicePlan?.id ?? null)) {
                return false;
              }
              if (lineReq.quantity < r.minQuantity) return false;
              if (r.maxQuantity !== null && lineReq.quantity > r.maxQuantity) {
                return false;
              }
              return evaluatePricingConditions(r.conditions, condCtx);
            })
            .sort((a, b) => {
              const targetScore = (r: typeof a) =>
                (r.itemId === item.id ? 0 : 10) +
                (r.servicePlanId ? 0 : 1) +
                (r.packId ? 0 : 2);
              return targetScore(a) - targetScore(b) || a.priority - b.priority;
            });

          if (candidates[0]) {
            matchedBook = pb;
            matchedRule = candidates[0];
            pricingInheritedFromParent = matchedRule.itemId !== item.id;
            break;
          }
        }
      }

      const pricingModel = matchedRule?.pricingModel ?? PricingModel.FLAT;
      const listUnitPriceCents = matchedRule
        ? matchedRule.baseUnitPriceCents
        : fallbackUnitPriceCents;

      const baseSubtotalCents = lineReq.quantity * fallbackUnitPriceCents;
      const tierCalc = calculateTieredSubtotal(
        pricingModel,
        listUnitPriceCents,
        lineReq.quantity,
        matchedRule?.tiers ?? [],
      );

      const adjCalc = applyCustomRuleAdjustment(
        tierCalc.subtotalCents,
        lineReq.quantity,
        matchedRule?.customAdjustment ?? null,
      );

      const unitCostForFloor =
        direction === PriceBookDirection.SALES
          ? (pack?.costPriceCents ?? resolvedCostUnitPriceCents * unitsPerPack)
          : 0;

      const marginCheck = enforceMinMarginFloor(
        adjCalc.subtotalCents,
        lineReq.quantity,
        unitCostForFloor,
        matchedRule?.minMarginBps,
      );

      const setupFeeCents = servicePlan ? servicePlan.setupFeeCents : 0;
      const tierSubtotalWithSetup = marginCheck.subtotalCents + setupFeeCents;

      calculatedLines.push({
        itemId: item.id,
        sku: item.sku,
        name: item.name,
        type: item.type,
        variantKind: item.variantKind,
        parentItemId: item.parentItemId ?? null,
        pricingInheritedFromParent,
        variantAttributes: item.variantAttributes.map((attr) => ({
          optionId: attr.optionId,
          optionCode: attr.option.code,
          optionName: attr.option.name,
          optionValueId: attr.optionValueId,
          valueCode: attr.optionValue.code,
          valueLabel: attr.optionValue.label,
          swatchHex: attr.optionValue.swatchHex,
        })),
        packId: pack?.id ?? null,
        packCode: pack?.code ?? null,
        unitOfMeasure: pack ? pack.unitOfMeasure : item.unitOfMeasure,
        unitsPerPack,
        quantity: lineReq.quantity,
        totalBaseUnits,
        servicePlanId: servicePlan?.id ?? null,
        servicePlanSummary: servicePlan
          ? {
              code: servicePlan.code,
              name: servicePlan.name,
              planType: servicePlan.planType,
              billingCycle: servicePlan.billingCycle,
              includedUnits: servicePlan.includedUnits,
              unitLabel: servicePlan.unitLabel,
              setupFeeCents: servicePlan.setupFeeCents,
              overageUnitPriceCents: servicePlan.overageUnitPriceCents,
            }
          : null,
        bundleBreakdown,
        priceBookId: matchedBook?.id ?? null,
        priceBookCode: matchedBook?.code ?? null,
        priceRuleId: matchedRule?.id ?? null,
        pricingModel,
        listUnitPriceCents,
        effectiveUnitPriceCents: Math.round(
          tierSubtotalWithSetup / lineReq.quantity,
        ),
        baseSubtotalCents,
        tierSubtotalCents: tierSubtotalWithSetup,
        setupFeeCents,
        customAdjustmentCents: adjCalc.adjustmentCents,
        marginFloorApplied: marginCheck.marginFloorApplied,
        lineDiscountCents: 0,
        finalLineTotalCents: tierSubtotalWithSetup,
        bonusUnits: 0,
        appliedTiers: tierCalc.appliedTiers,
        appliedDiscounts: [],
      });
    }

    const subtotalAfterTiersCents = calculatedLines.reduce(
      (sum, l) => sum + l.tierSubtotalCents,
      0,
    );

    const activeDiscounts = discountRules.filter((d) => {
      if (d.usageLimit !== null && d.usageCount >= d.usageLimit) {
        return false;
      }
      if (
        d.customerSegments.length > 0 &&
        (!input.customerSegment || !d.customerSegments.includes(input.customerSegment))
      ) {
        return false;
      }
      if (
        d.externalAccountIds.length > 0 &&
        (!input.externalAccountId ||
          !d.externalAccountIds.includes(input.externalAccountId))
      ) {
        return false;
      }
      if (
        d.minOrderSubtotalCents !== null &&
        subtotalAfterTiersCents < d.minOrderSubtotalCents
      ) {
        return false;
      }
      return true;
    });

    // Pass 2: line-level discounts & BOGO (with parent template fallback)
    for (const line of calculatedLines) {
      const item = itemMap.get(line.itemId)!;
      const parentItem = line.parentItemId
        ? parentItemMap.get(line.parentItemId)
        : undefined;
      const mergedTags = Array.from(
        new Set([...item.tags, ...(parentItem?.tags ?? [])]),
      );
      const condCtx = {
        channel: input.channel ?? undefined,
        customerSegment: input.customerSegment ?? undefined,
        externalAccountId: input.externalAccountId ?? undefined,
        lineQuantity: line.quantity,
        orderSubtotalCents: subtotalAfterTiersCents,
        itemTags: mergedTags,
        itemMetadata: (item.metadata as Record<string, unknown> | null) ?? null,
        atDate,
        customContext: input.customContext ?? undefined,
      };

      const eligibleLineDiscounts = activeDiscounts.filter((d) => {
        if (d.scope !== DiscountScope.LINE_ITEM) return false;
        if (
          d.targetItemId &&
          d.targetItemId !== line.itemId &&
          !(line.parentItemId && d.targetItemId === line.parentItemId)
        ) {
          return false;
        }
        if (d.targetPackId && d.targetPackId !== line.packId) return false;
        if (
          d.targetTags.length > 0 &&
          !d.targetTags.some((tag) => mergedTags.includes(tag))
        ) {
          return false;
        }
        if (d.minQuantity !== null && line.quantity < d.minQuantity) {
          return false;
        }
        return evaluatePricingConditions(d.conditions, condCtx);
      });

      const stackable = eligibleLineDiscounts.filter((d) => d.isStackable);
      const nonStackable = eligibleLineDiscounts.filter((d) => !d.isStackable);

      let runningSubtotal = line.tierSubtotalCents;
      const chosenDiscounts: AppliedDiscountBreakdown[] = [];
      let totalBonusUnits = 0;

      // Pick best single non-stackable discount
      let bestNonStackable: {
        rule: (typeof nonStackable)[number];
        discountCents: number;
        bonusUnits: number;
      } | null = null;

      for (const rule of nonStackable) {
        const res = calculateDiscountAmount(
          rule,
          runningSubtotal,
          line.quantity,
          line.effectiveUnitPriceCents,
        );
        if (
          res.discountCents > 0 &&
          (!bestNonStackable || res.discountCents > bestNonStackable.discountCents)
        ) {
          bestNonStackable = { rule, ...res };
        }
      }

      if (bestNonStackable) {
        runningSubtotal = Math.max(0, runningSubtotal - bestNonStackable.discountCents);
        totalBonusUnits += bestNonStackable.bonusUnits;
        chosenDiscounts.push({
          discountId: bestNonStackable.rule.id,
          code: bestNonStackable.rule.code,
          name: bestNonStackable.rule.name,
          promoCode: bestNonStackable.rule.promoCode,
          discountType: bestNonStackable.rule.discountType,
          scope: DiscountScope.LINE_ITEM,
          discountCents: bestNonStackable.discountCents,
          bonusUnits: bestNonStackable.bonusUnits,
        });
      }

      // Apply stackable discounts sequentially
      for (const rule of stackable) {
        if (runningSubtotal <= 0) break;
        const res = calculateDiscountAmount(
          rule,
          runningSubtotal,
          line.quantity,
          line.effectiveUnitPriceCents,
        );
        if (res.discountCents > 0) {
          runningSubtotal = Math.max(0, runningSubtotal - res.discountCents);
          totalBonusUnits += res.bonusUnits;
          chosenDiscounts.push({
            discountId: rule.id,
            code: rule.code,
            name: rule.name,
            promoCode: rule.promoCode,
            discountType: rule.discountType,
            scope: DiscountScope.LINE_ITEM,
            discountCents: res.discountCents,
            bonusUnits: res.bonusUnits,
          });
        }
      }

      line.lineDiscountCents = line.tierSubtotalCents - runningSubtotal;
      line.finalLineTotalCents = runningSubtotal;
      line.effectiveUnitPriceCents = Math.round(runningSubtotal / line.quantity);
      line.bonusUnits = totalBonusUnits;
      line.appliedDiscounts = chosenDiscounts;
    }

    const subtotalAfterLineDiscounts = calculatedLines.reduce(
      (sum, l) => sum + l.finalLineTotalCents,
      0,
    );

    // Pass 3: order-level discounts
    const eligibleOrderDiscounts = activeDiscounts.filter((d) => {
      if (d.scope !== DiscountScope.ORDER) return false;
      return evaluatePricingConditions(d.conditions, {
        channel: input.channel ?? undefined,
        customerSegment: input.customerSegment ?? undefined,
        externalAccountId: input.externalAccountId ?? undefined,
        lineQuantity: calculatedLines.reduce((sum, l) => sum + l.quantity, 0),
        orderSubtotalCents: subtotalAfterLineDiscounts,
        itemTags: [],
        atDate,
        customContext: input.customContext ?? undefined,
      });
    });

    const orderDiscounts: AppliedDiscountBreakdown[] = [];
    let orderRunningSubtotal = subtotalAfterLineDiscounts;
    const totalOrderQty = calculatedLines.reduce((sum, l) => sum + l.quantity, 0);

    const orderNonStackable = eligibleOrderDiscounts.filter((d) => !d.isStackable);
    const orderStackable = eligibleOrderDiscounts.filter((d) => d.isStackable);

    let bestOrderRule: {
      rule: (typeof orderNonStackable)[number];
      discountCents: number;
      bonusUnits: number;
    } | null = null;

    for (const rule of orderNonStackable) {
      const res = calculateDiscountAmount(
        rule,
        orderRunningSubtotal,
        totalOrderQty,
        0,
      );
      if (
        res.discountCents > 0 &&
        (!bestOrderRule || res.discountCents > bestOrderRule.discountCents)
      ) {
        bestOrderRule = { rule, ...res };
      }
    }

    if (bestOrderRule) {
      orderRunningSubtotal = Math.max(
        0,
        orderRunningSubtotal - bestOrderRule.discountCents,
      );
      orderDiscounts.push({
        discountId: bestOrderRule.rule.id,
        code: bestOrderRule.rule.code,
        name: bestOrderRule.rule.name,
        promoCode: bestOrderRule.rule.promoCode,
        discountType: bestOrderRule.rule.discountType,
        scope: DiscountScope.ORDER,
        discountCents: bestOrderRule.discountCents,
        bonusUnits: bestOrderRule.bonusUnits,
      });
    }

    for (const rule of orderStackable) {
      if (orderRunningSubtotal <= 0) break;
      const res = calculateDiscountAmount(
        rule,
        orderRunningSubtotal,
        totalOrderQty,
        0,
      );
      if (res.discountCents > 0) {
        orderRunningSubtotal = Math.max(0, orderRunningSubtotal - res.discountCents);
        orderDiscounts.push({
          discountId: rule.id,
          code: rule.code,
          name: rule.name,
          promoCode: rule.promoCode,
          discountType: rule.discountType,
          scope: DiscountScope.ORDER,
          discountCents: res.discountCents,
          bonusUnits: res.bonusUnits,
        });
      }
    }

    const baseSubtotalCents = calculatedLines.reduce(
      (sum, l) => sum + l.baseSubtotalCents,
      0,
    );
    const lineDiscountTotalCents = calculatedLines.reduce(
      (sum, l) => sum + l.lineDiscountCents,
      0,
    );
    const orderDiscountTotalCents = subtotalAfterLineDiscounts - orderRunningSubtotal;
    const totalDiscountCents = lineDiscountTotalCents + orderDiscountTotalCents;
    const totalBonusUnits = calculatedLines.reduce(
      (sum, l) => sum + l.bonusUnits,
      0,
    );
    const totalBaseUnits = calculatedLines.reduce(
      (sum, l) => sum + l.totalBaseUnits + l.bonusUnits * l.unitsPerPack,
      0,
    );

    return {
      organizationId,
      direction,
      currency,
      evaluatedAt: atDate.toISOString(),
      customerSegment: input.customerSegment ?? null,
      externalAccountId: input.externalAccountId ?? null,
      supplierId: input.supplierId ?? null,
      promoCodes,
      lines: calculatedLines,
      orderDiscounts,
      baseSubtotalCents,
      subtotalAfterTiersCents,
      lineDiscountTotalCents,
      orderDiscountTotalCents,
      totalDiscountCents,
      totalCents: orderRunningSubtotal,
      totalBonusUnits,
      totalBaseUnits,
    };
  }
}

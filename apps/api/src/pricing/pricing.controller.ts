import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  BillingCycle,
  DiscountScope,
  DiscountType,
  PriceBookDirection,
  PricingModel,
  ServicePlanType,
} from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { PricingCatalogService } from "./pricing-catalog.service.js";
import { PricingEngineService } from "./pricing-engine.service.js";

const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);

const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((v) => v.toUpperCase());

const createPackSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(160),
  unitOfMeasure: z.string().trim().min(1).max(32),
  unitsPerPack: z.number().int().min(1).max(1_000_000),
  barcode: z.string().trim().max(64).nullable().optional(),
  packSku: z.string().trim().max(64).nullable().optional(),
  salePriceCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  costPriceCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  isSellable: z.boolean().optional(),
  isPurchasable: z.boolean().optional(),
  isDefaultSalesPack: z.boolean().optional(),
  isDefaultPurchasePack: z.boolean().optional(),
  minOrderPacks: z.number().int().min(1).max(100_000).optional(),
  packStep: z.number().int().min(1).max(100_000).optional(),
  weightGrams: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  dimensionsJson: z.record(z.string(), z.unknown()).nullable().optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const updatePackSchema = createPackSchema.partial();

const setBundleSchema = z.object({
  components: z
    .array(
      z.object({
        componentItemId: z.string().trim().min(1),
        componentPackId: z.string().trim().min(1).nullable().optional(),
        quantity: z.number().int().min(1).max(100_000),
        priceAllocationBps: z.number().int().min(0).max(10000).nullable().optional(),
        isOptional: z.boolean().optional(),
        sortOrder: z.number().int().min(0).max(1000).optional(),
      }),
    )
    .max(100),
});

const createServicePlanSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  planType: z
    .enum([
      ServicePlanType.RETAINER,
      ServicePlanType.HOUR_PACK,
      ServicePlanType.SUBSCRIPTION,
      ServicePlanType.MILESTONE,
    ])
    .optional(),
  billingCycle: z
    .enum([
      BillingCycle.ONE_TIME,
      BillingCycle.WEEKLY,
      BillingCycle.MONTHLY,
      BillingCycle.QUARTERLY,
      BillingCycle.ANNUAL,
    ])
    .optional(),
  includedUnits: z.number().int().min(1).max(1_000_000),
  unitLabel: z.string().trim().min(1).max(32).optional(),
  basePriceCents: z.number().int().min(0).max(2_000_000_000),
  overageUnitPriceCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  setupFeeCents: z.number().int().min(0).max(2_000_000_000).optional(),
  rolloverEnabled: z.boolean().optional(),
  maxRolloverUnits: z.number().int().min(0).max(1_000_000).nullable().optional(),
  validityDays: z.number().int().min(1).max(3650).nullable().optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const updateServicePlanSchema = createServicePlanSchema.partial();

const createPriceBookSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  direction: z.enum([PriceBookDirection.SALES, PriceBookDirection.PURCHASE]).optional(),
  currency: currencySchema.optional(),
  priority: z.number().int().min(1).max(10_000).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  customerSegment: z.string().trim().min(1).max(80).nullable().optional(),
  externalAccountId: z.string().trim().min(1).max(128).nullable().optional(),
  supplierId: z.string().trim().min(1).nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  customAttributes: z.record(z.string(), z.unknown()).nullable().optional(),
});

const updatePriceBookSchema = createPriceBookSchema.partial();

const priceTierSchema = z.object({
  minQuantity: z.number().int().min(1).max(10_000_000),
  maxQuantity: z.number().int().min(1).max(10_000_000).nullable().optional(),
  unitPriceCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  flatFeeCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  packageSize: z.number().int().min(1).max(1_000_000).nullable().optional(),
  packagePriceCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  discountBps: z.number().int().min(0).max(10000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

const createPriceRuleSchema = z.object({
  itemId: z.string().trim().min(1),
  packId: z.string().trim().min(1).nullable().optional(),
  servicePlanId: z.string().trim().min(1).nullable().optional(),
  name: z.string().trim().min(1).max(160),
  pricingModel: z
    .enum([
      PricingModel.FLAT,
      PricingModel.VOLUME,
      PricingModel.GRADUATED,
      PricingModel.PACKAGE,
    ])
    .optional(),
  baseUnitPriceCents: z.number().int().min(0).max(2_000_000_000),
  minMarginBps: z.number().int().min(0).max(9999).nullable().optional(),
  minQuantity: z.number().int().min(1).max(10_000_000).optional(),
  maxQuantity: z.number().int().min(1).max(10_000_000).nullable().optional(),
  conditions: z.record(z.string(), z.unknown()).nullable().optional(),
  customAdjustment: z.record(z.string(), z.unknown()).nullable().optional(),
  priority: z.number().int().min(1).max(10_000).optional(),
  isActive: z.boolean().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  tiers: z.array(priceTierSchema).max(50).optional(),
});

const updatePriceRuleSchema = createPriceRuleSchema.omit({ itemId: true }).partial();

const createDiscountSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  promoCode: z.string().trim().min(1).max(64).nullable().optional(),
  discountType: z.enum([
    DiscountType.PERCENTAGE,
    DiscountType.FIXED_AMOUNT,
    DiscountType.FIXED_PRICE,
    DiscountType.BUY_X_GET_Y,
  ]),
  scope: z.enum([DiscountScope.LINE_ITEM, DiscountScope.ORDER]).optional(),
  valueBps: z.number().int().min(1).max(10000).nullable().optional(),
  amountCents: z.number().int().min(1).max(2_000_000_000).nullable().optional(),
  fixedPriceCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  buyQuantity: z.number().int().min(1).max(100_000).nullable().optional(),
  getQuantity: z.number().int().min(1).max(100_000).nullable().optional(),
  getDiscountBps: z.number().int().min(1).max(10000).nullable().optional(),
  targetItemId: z.string().trim().min(1).nullable().optional(),
  targetPackId: z.string().trim().min(1).nullable().optional(),
  targetTags: z.array(z.string().trim().min(1).max(40)).max(25).optional(),
  customerSegments: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  externalAccountIds: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
  minQuantity: z.number().int().min(1).max(10_000_000).nullable().optional(),
  minOrderSubtotalCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  maxDiscountCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  isStackable: z.boolean().optional(),
  priority: z.number().int().min(1).max(10_000).optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  usageLimit: z.number().int().min(1).max(10_000_000).nullable().optional(),
  isActive: z.boolean().optional(),
  conditions: z.record(z.string(), z.unknown()).nullable().optional(),
});

const updateDiscountSchema = createDiscountSchema.partial();

const quoteSchema = z.object({
  direction: z.enum([PriceBookDirection.SALES, PriceBookDirection.PURCHASE]).optional(),
  currency: currencySchema.optional(),
  priceBookId: z.string().trim().min(1).nullable().optional(),
  customerSegment: z.string().trim().min(1).max(80).nullable().optional(),
  externalAccountId: z.string().trim().min(1).max(128).nullable().optional(),
  supplierId: z.string().trim().min(1).nullable().optional(),
  channel: z.string().trim().min(1).max(64).nullable().optional(),
  promoCodes: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  atDate: z.string().datetime().nullable().optional(),
  customContext: z.record(z.string(), z.unknown()).nullable().optional(),
  lines: z
    .array(
      z.object({
        itemId: z.string().trim().min(1),
        quantity: z.number().int().min(1).max(10_000_000),
        packId: z.string().trim().min(1).nullable().optional(),
        servicePlanId: z.string().trim().min(1).nullable().optional(),
        overrideUnitPriceCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
});

@Controller("api/v1/pricing")
@RequireActiveOrganization()
export class PricingController {
  constructor(
    @Inject(PricingCatalogService)
    private readonly catalogService: PricingCatalogService,
    @Inject(PricingEngineService)
    private readonly engineService: PricingEngineService,
  ) {}

  // ==========================================
  // Quote Calculator API
  // ==========================================

  @Post("quote")
  @RequiredOrgPermissions({ pricing: ["quote"] })
  async calculateQuote(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
  ) {
    const parsed = quoteSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid pricing quote payload.",
        issues: parsed.error.issues,
      });
    }
    return this.engineService.calculateQuote(tenant, parsed.data);
  }

  @Post("simulate")
  @RequiredOrgPermissions({ pricing: ["quote"] })
  async simulateQuote(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
  ) {
    return this.calculateQuote(tenant, body);
  }

  // ==========================================
  // Item Packaging, Bundles & Service Plans
  // ==========================================

  @Get("items/:itemId/options")
  @RequiredOrgPermissions({ pricing: ["read"] })
  async getItemPricingOptions(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("itemId") itemId: string,
  ) {
    return this.catalogService.getItemPricingOptions(tenant, itemId);
  }

  @Post("items/:itemId/packs")
  @RequiredOrgPermissions({ pricing: ["create"] })
  async createItemPack(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("itemId") itemId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createPackSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid item pack payload.",
        issues: parsed.error.issues,
      });
    }
    return this.catalogService.createItemPack(tenant, itemId, parsed.data, req.ip);
  }

  @Patch("packs/:packId")
  @RequiredOrgPermissions({ pricing: ["update"] })
  async updateItemPack(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("packId") packId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updatePackSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid item pack update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.catalogService.updateItemPack(tenant, packId, parsed.data, req.ip);
  }

  @Delete("packs/:packId")
  @RequiredOrgPermissions({ pricing: ["archive"] })
  async deleteItemPack(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("packId") packId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.catalogService.deleteItemPack(tenant, packId, req.ip);
  }

  @Get("items/:itemId/bundle")
  @RequiredOrgPermissions({ pricing: ["read"] })
  async getBundleComponents(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("itemId") itemId: string,
  ) {
    return this.catalogService.getBundleComponents(tenant, itemId);
  }

  @Put("items/:itemId/bundle")
  @RequiredOrgPermissions({ pricing: ["update"] })
  async setBundleComponents(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("itemId") itemId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = setBundleSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid bundle components payload.",
        issues: parsed.error.issues,
      });
    }
    return this.catalogService.setBundleComponents(
      tenant,
      itemId,
      parsed.data.components,
      req.ip,
    );
  }

  @Post("items/:itemId/service-plans")
  @RequiredOrgPermissions({ pricing: ["create"] })
  async createServicePlan(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("itemId") itemId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createServicePlanSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid service plan payload.",
        issues: parsed.error.issues,
      });
    }
    return this.catalogService.createServicePlan(tenant, itemId, parsed.data, req.ip);
  }

  @Patch("service-plans/:planId")
  @RequiredOrgPermissions({ pricing: ["update"] })
  async updateServicePlan(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("planId") planId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateServicePlanSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid service plan update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.catalogService.updateServicePlan(tenant, planId, parsed.data, req.ip);
  }

  // ==========================================
  // Price Books & Bulk Tiers
  // ==========================================

  @Post("price-books")
  @RequiredOrgPermissions({ pricing: ["create"] })
  async createPriceBook(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createPriceBookSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid price book payload.",
        issues: parsed.error.issues,
      });
    }
    return this.catalogService.createPriceBook(tenant, parsed.data, req.ip);
  }

  @Get("price-books")
  @RequiredOrgPermissions({ pricing: ["read"] })
  async listPriceBooks(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query("direction") direction?: PriceBookDirection,
    @Query("customerSegment") customerSegment?: string,
    @Query("externalAccountId") externalAccountId?: string,
    @Query("supplierId") supplierId?: string,
    @Query("isActive") isActive?: string,
  ) {
    return this.catalogService.listPriceBooks(tenant, {
      direction,
      customerSegment,
      externalAccountId,
      supplierId,
      isActive: isActive === undefined ? undefined : isActive === "true",
    });
  }

  @Get("price-books/:priceBookId")
  @RequiredOrgPermissions({ pricing: ["read"] })
  async getPriceBook(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("priceBookId") priceBookId: string,
  ) {
    return this.catalogService.getPriceBook(tenant, priceBookId);
  }

  @Patch("price-books/:priceBookId")
  @RequiredOrgPermissions({ pricing: ["update"] })
  async updatePriceBook(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("priceBookId") priceBookId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updatePriceBookSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid price book update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.catalogService.updatePriceBook(
      tenant,
      priceBookId,
      parsed.data,
      req.ip,
    );
  }

  @Post("price-books/:priceBookId/rules")
  @RequiredOrgPermissions({ pricing: ["create"] })
  async createPriceRule(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("priceBookId") priceBookId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createPriceRuleSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid price rule payload.",
        issues: parsed.error.issues,
      });
    }
    return this.catalogService.createPriceRule(
      tenant,
      priceBookId,
      parsed.data,
      req.ip,
    );
  }

  @Patch("rules/:ruleId")
  @RequiredOrgPermissions({ pricing: ["update"] })
  async updatePriceRule(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("ruleId") ruleId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updatePriceRuleSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid price rule update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.catalogService.updatePriceRule(tenant, ruleId, parsed.data, req.ip);
  }

  @Delete("rules/:ruleId")
  @RequiredOrgPermissions({ pricing: ["archive"] })
  async deletePriceRule(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("ruleId") ruleId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.catalogService.deletePriceRule(tenant, ruleId, req.ip);
  }

  // ==========================================
  // Discounts & Promotions
  // ==========================================

  @Post("discounts")
  @RequiredOrgPermissions({ pricing: ["create"] })
  async createDiscountRule(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createDiscountSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid discount rule payload.",
        issues: parsed.error.issues,
      });
    }
    return this.catalogService.createDiscountRule(tenant, parsed.data, req.ip);
  }

  @Get("discounts")
  @RequiredOrgPermissions({ pricing: ["read"] })
  async listDiscountRules(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query("isActive") isActive?: string,
    @Query("promoCode") promoCode?: string,
    @Query("scope") scope?: DiscountScope,
  ) {
    return this.catalogService.listDiscountRules(tenant, {
      isActive: isActive === undefined ? undefined : isActive === "true",
      promoCode,
      scope,
    });
  }

  @Patch("discounts/:discountId")
  @RequiredOrgPermissions({ pricing: ["update"] })
  async updateDiscountRule(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("discountId") discountId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateDiscountSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid discount rule update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.catalogService.updateDiscountRule(
      tenant,
      discountId,
      parsed.data,
      req.ip,
    );
  }
}

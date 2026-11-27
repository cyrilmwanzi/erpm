import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import { ItemStatus, ItemType, VariantOptionDisplayType } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { VariantsService } from "./variants.service.js";

const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    "Code may only contain letters, numbers, dots, underscores, and hyphens.",
  );

const skuSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    "SKU may only contain letters, numbers, dots, underscores, and hyphens.",
  );

const swatchHexSchema = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, "swatchHex must be a 6-digit hex color like #FF5500.");

const displayTypeEnum = z.enum([
  VariantOptionDisplayType.SELECT,
  VariantOptionDisplayType.COLOR,
  VariantOptionDisplayType.SIZE,
  VariantOptionDisplayType.TEXT,
]);

const itemTypeEnum = z.enum([
  ItemType.SELLABLE,
  ItemType.MERCH,
  ItemType.RAW_MATERIAL,
  ItemType.SERVICE,
  ItemType.CONSUMABLE,
]);

const itemStatusEnum = z.enum([
  ItemStatus.DRAFT,
  ItemStatus.ACTIVE,
  ItemStatus.ARCHIVED,
]);

const mutableStatusEnum = z.enum([ItemStatus.DRAFT, ItemStatus.ACTIVE]);

const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((val) => val.toUpperCase());

const metadataSchema = z.record(z.string(), z.unknown()).nullable();
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(25);

const optionValueInputSchema = z.object({
  code: codeSchema,
  label: z.string().trim().min(1).max(120),
  swatchHex: swatchHexSchema.nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
  metadata: metadataSchema.optional(),
});

const createOptionSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  displayType: displayTypeEnum.optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
  metadata: metadataSchema.optional(),
  values: z.array(optionValueInputSchema).max(200).optional(),
});

const updateOptionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  displayType: displayTypeEnum.optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
  metadata: metadataSchema.optional(),
});

const addOptionValuesSchema = z.object({
  values: z.array(optionValueInputSchema).min(1).max(200),
});

const updateOptionValueSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  swatchHex: swatchHexSchema.nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
  metadata: metadataSchema.optional(),
});

const listOptionsQuerySchema = z.object({
  displayType: displayTypeEnum.optional(),
  isActive: z
    .enum(["true", "false"])
    .transform((val) => val === "true")
    .optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

const templateOptionConfigSchema = z.object({
  optionId: z.string().trim().min(1),
  valueIds: z.array(z.string().trim().min(1)).max(200).optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

const createTemplateSchema = z.object({
  sku: skuSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  type: itemTypeEnum,
  status: mutableStatusEnum.optional(),
  unitOfMeasure: z.string().trim().min(1).max(32).optional(),
  currency: currencySchema.optional(),
  salePriceCents: z.number().int().min(0).max(2_000_000_000).optional(),
  costPriceCents: z.number().int().min(0).max(2_000_000_000).optional(),
  tags: tagsSchema.optional(),
  metadata: metadataSchema.optional(),
  options: z.array(templateOptionConfigSchema).max(10).optional(),
  autoGenerateMatrix: z.boolean().optional(),
  skuPattern: z.string().trim().min(1).max(120).optional(),
  namePattern: z.string().trim().min(1).max(160).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

const promoteToTemplateSchema = z.object({
  options: z.array(templateOptionConfigSchema).max(10).optional(),
  autoGenerateMatrix: z.boolean().optional(),
  skuPattern: z.string().trim().min(1).max(120).optional(),
  namePattern: z.string().trim().min(1).max(160).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

const configureTemplateOptionsSchema = z.object({
  options: z.array(templateOptionConfigSchema).min(1).max(10),
});

const listTemplatesQuerySchema = z.object({
  type: itemTypeEnum.optional(),
  status: itemStatusEnum.optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const matrixSelectionSchema = z.object({
  optionId: z.string().trim().min(1),
  valueIds: z.array(z.string().trim().min(1)).max(200).optional(),
});

const previewMatrixSchema = z.object({
  selections: z.array(matrixSelectionSchema).max(10).optional(),
  skuPattern: z.string().trim().min(1).max(120).optional(),
  namePattern: z.string().trim().min(1).max(160).optional(),
  maxCombinations: z.coerce.number().int().min(1).max(500).optional(),
});

const matrixOverrideSchema = z.object({
  sku: skuSchema.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  status: mutableStatusEnum.optional(),
  inheritParentPricing: z.boolean().optional(),
  salePriceOverrideCents: z
    .number()
    .int()
    .min(0)
    .max(2_000_000_000)
    .nullable()
    .optional(),
  costPriceOverrideCents: z
    .number()
    .int()
    .min(0)
    .max(2_000_000_000)
    .nullable()
    .optional(),
  trackInventory: z.boolean().optional(),
  allowNegativeStock: z.boolean().optional(),
  reorderPoint: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
});

const generateMatrixSchema = previewMatrixSchema.extend({
  skipConflicts: z.boolean().optional(),
  defaultStatus: mutableStatusEnum.optional(),
  defaultTrackInventory: z.boolean().optional(),
  defaultAllowNegativeStock: z.boolean().optional(),
  defaultReorderPoint: z
    .number()
    .int()
    .min(0)
    .max(1_000_000_000)
    .nullable()
    .optional(),
  overridesByVariantKey: z.record(z.string(), matrixOverrideSchema).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

const variantAttributeInputSchema = z.object({
  optionId: z.string().trim().min(1).optional(),
  optionCode: codeSchema.optional(),
  optionValueId: z.string().trim().min(1).optional(),
  valueCode: codeSchema.optional(),
});

const createVariantSchema = z.object({
  sku: skuSchema.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  status: mutableStatusEnum.optional(),
  inheritParentPricing: z.boolean().optional(),
  salePriceOverrideCents: z
    .number()
    .int()
    .min(0)
    .max(2_000_000_000)
    .nullable()
    .optional(),
  costPriceOverrideCents: z
    .number()
    .int()
    .min(0)
    .max(2_000_000_000)
    .nullable()
    .optional(),
  trackInventory: z.boolean().optional(),
  allowNegativeStock: z.boolean().optional(),
  reorderPoint: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  tags: tagsSchema.optional(),
  metadata: metadataSchema.optional(),
  attributes: z.array(variantAttributeInputSchema).min(1).max(10),
  reason: z.string().trim().min(1).max(500).optional(),
});

const updateVariantSchema = z.object({
  sku: skuSchema.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  status: mutableStatusEnum.optional(),
  inheritParentPricing: z.boolean().optional(),
  salePriceOverrideCents: z
    .number()
    .int()
    .min(0)
    .max(2_000_000_000)
    .nullable()
    .optional(),
  costPriceOverrideCents: z
    .number()
    .int()
    .min(0)
    .max(2_000_000_000)
    .nullable()
    .optional(),
  trackInventory: z.boolean().optional(),
  allowNegativeStock: z.boolean().optional(),
  reorderPoint: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  tags: tagsSchema.optional(),
  metadata: metadataSchema.optional(),
  expectedVersion: z.number().int().min(1).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

const bulkUpdateVariantsSchema = z.object({
  variantIds: z.array(z.string().trim().min(1)).min(1).max(250),
  status: mutableStatusEnum.optional(),
  inheritParentPricing: z.boolean().optional(),
  salePriceOverrideCents: z
    .number()
    .int()
    .min(0)
    .max(2_000_000_000)
    .nullable()
    .optional(),
  costPriceOverrideCents: z
    .number()
    .int()
    .min(0)
    .max(2_000_000_000)
    .nullable()
    .optional(),
  allowNegativeStock: z.boolean().optional(),
  reorderPoint: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

const resolveVariantSchema = z.object({
  attributes: z.array(variantAttributeInputSchema).min(1).max(10),
});

@Controller("api/v1/variants")
@RequireActiveOrganization()
export class VariantsController {
  constructor(
    @Inject(VariantsService) private readonly variantsService: VariantsService,
  ) {}

  // ==========================================
  // Organization Variant Options
  // ==========================================

  @Post("options")
  @RequiredOrgPermissions({ item: ["create"] })
  async createOption(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createOptionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid variant option payload.",
        issues: parsed.error.issues,
      });
    }

    return this.variantsService.createOption(tenant, parsed.data, req.ip);
  }

  @Get("options")
  @RequiredOrgPermissions({ item: ["read"] })
  async listOptions(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listOptionsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid variant option query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.variantsService.listOptions(tenant, parsed.data);
  }

  @Get("options/:optionId")
  @RequiredOrgPermissions({ item: ["read"] })
  async getOption(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("optionId") optionId: string,
  ) {
    return this.variantsService.getOption(tenant, optionId);
  }

  @Patch("options/:optionId")
  @RequiredOrgPermissions({ item: ["update"] })
  async updateOption(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("optionId") optionId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateOptionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid variant option update payload.",
        issues: parsed.error.issues,
      });
    }

    return this.variantsService.updateOption(
      tenant,
      optionId,
      parsed.data,
      req.ip,
    );
  }

  @Post("options/:optionId/values")
  @RequiredOrgPermissions({ item: ["update"] })
  async addOptionValues(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("optionId") optionId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = addOptionValuesSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid variant option values payload.",
        issues: parsed.error.issues,
      });
    }

    return this.variantsService.addOptionValues(
      tenant,
      optionId,
      parsed.data.values,
      req.ip,
    );
  }

  @Patch("options/:optionId/values/:valueId")
  @RequiredOrgPermissions({ item: ["update"] })
  async updateOptionValue(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("optionId") optionId: string,
    @Param("valueId") valueId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateOptionValueSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid variant option value update payload.",
        issues: parsed.error.issues,
      });
    }

    return this.variantsService.updateOptionValue(
      tenant,
      optionId,
      valueId,
      parsed.data,
      req.ip,
    );
  }

  // ==========================================
  // Product Templates & Matrix Generation
  // ==========================================

  @Post("templates")
  @RequiredOrgPermissions({ item: ["create"] })
  async createTemplate(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createTemplateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid product template payload.",
        issues: parsed.error.issues,
      });
    }

    return this.variantsService.createTemplate(tenant, parsed.data, req.ip);
  }

  @Post("templates/:itemId/promote")
  @RequiredOrgPermissions({ item: ["update"] })
  async promoteToTemplate(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("itemId") itemId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = promoteToTemplateSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid template promotion payload.",
        issues: parsed.error.issues,
      });
    }

    return this.variantsService.promoteToTemplate(
      tenant,
      itemId,
      parsed.data,
      req.ip,
    );
  }

  @Get("templates")
  @RequiredOrgPermissions({ item: ["read"] })
  async listTemplates(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listTemplatesQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid product templates query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.variantsService.listTemplates(tenant, parsed.data);
  }

  @Get("templates/:templateId")
  @RequiredOrgPermissions({ item: ["read"] })
  async getTemplate(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("templateId") templateId: string,
  ) {
    return this.variantsService.getTemplate(tenant, templateId);
  }

  @Put("templates/:templateId/options")
  @RequiredOrgPermissions({ item: ["update"] })
  async configureTemplateOptions(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("templateId") templateId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = configureTemplateOptionsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid template options payload.",
        issues: parsed.error.issues,
      });
    }

    return this.variantsService.configureTemplateOptions(
      tenant,
      templateId,
      parsed.data.options,
      req.ip,
    );
  }

  @Post("templates/:templateId/matrix/preview")
  @RequiredOrgPermissions({ item: ["read"] })
  async previewMatrix(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("templateId") templateId: string,
    @Body() body: unknown,
  ) {
    const parsed = previewMatrixSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid SKU matrix preview payload.",
        issues: parsed.error.issues,
      });
    }

    return this.variantsService.previewMatrix(tenant, templateId, parsed.data);
  }

  @Post("templates/:templateId/matrix/generate")
  @RequiredOrgPermissions({ item: ["create"] })
  async generateMatrix(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("templateId") templateId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = generateMatrixSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid SKU matrix generation payload.",
        issues: parsed.error.issues,
      });
    }

    return this.variantsService.generateMatrix(
      tenant,
      templateId,
      parsed.data,
      req.ip,
    );
  }

  @Post("templates/:templateId/variants")
  @RequiredOrgPermissions({ item: ["create"] })
  async createVariant(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("templateId") templateId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createVariantSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid product variant payload.",
        issues: parsed.error.issues,
      });
    }

    return this.variantsService.createVariant(
      tenant,
      templateId,
      parsed.data,
      req.ip,
    );
  }

  @Post("templates/:templateId/variants/bulk-update")
  @RequiredOrgPermissions({ item: ["update"] })
  async bulkUpdateVariants(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("templateId") templateId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = bulkUpdateVariantsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid bulk variant update payload.",
        issues: parsed.error.issues,
      });
    }

    return this.variantsService.bulkUpdateVariants(
      tenant,
      templateId,
      parsed.data,
      req.ip,
    );
  }

  @Post("templates/:templateId/resolve")
  @RequiredOrgPermissions({ item: ["read"] })
  async resolveByAttributes(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("templateId") templateId: string,
    @Body() body: unknown,
  ) {
    const parsed = resolveVariantSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid attribute resolution payload.",
        issues: parsed.error.issues,
      });
    }

    return this.variantsService.resolveByAttributes(
      tenant,
      templateId,
      parsed.data,
    );
  }

  // ==========================================
  // Concrete Variant Details & Updates
  // ==========================================

  @Get(":variantId")
  @RequiredOrgPermissions({ item: ["read"] })
  async getVariant(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("variantId") variantId: string,
  ) {
    return this.variantsService.getVariant(tenant, variantId);
  }

  @Patch(":variantId")
  @RequiredOrgPermissions({ item: ["update"] })
  async updateVariant(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("variantId") variantId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateVariantSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid variant update payload.",
        issues: parsed.error.issues,
      });
    }

    return this.variantsService.updateVariant(
      tenant,
      variantId,
      parsed.data,
      req.ip,
    );
  }
}

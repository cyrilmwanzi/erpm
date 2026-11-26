import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  ItemStatus,
  ItemType,
  ItemVariantKind,
  LotAllocationStrategy,
} from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentTenant,
  RequireActiveTenant,
  RequiredOrgPermissions,
  type AuthenticatedTenant,
} from "../tenancy/tenant.decorators.js";
import { ItemsService } from "./items.service.js";

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

const itemVariantKindEnum = z.enum([
  ItemVariantKind.STANDARD,
  ItemVariantKind.TEMPLATE,
  ItemVariantKind.VARIANT,
]);

const lotAllocationStrategyEnum = z.enum([
  LotAllocationStrategy.FEFO,
  LotAllocationStrategy.FIFO,
  LotAllocationStrategy.MANUAL,
]);

const mutableStatusEnum = z.enum([ItemStatus.DRAFT, ItemStatus.ACTIVE]);

const skuSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    "SKU may only contain letters, numbers, dots, underscores, and hyphens.",
  );

const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((val) => val.toUpperCase());

const metadataSchema = z.record(z.string(), z.unknown()).nullable();

const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(25);

const createItemSchema = z.object({
  sku: skuSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  type: itemTypeEnum,
  status: mutableStatusEnum.optional(),
  unitOfMeasure: z.string().trim().min(1).max(32).optional(),
  currency: currencySchema.optional(),
  salePriceCents: z.number().int().min(0).max(2_000_000_000).optional(),
  costPriceCents: z.number().int().min(0).max(2_000_000_000).optional(),
  trackInventory: z.boolean().optional(),
  allowNegativeStock: z.boolean().optional(),
  reorderPoint: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  trackExpiry: z.boolean().optional(),
  shelfLifeDays: z.number().int().min(1).max(36500).nullable().optional(),
  expiryWarningDays: z.number().int().min(0).max(3650).nullable().optional(),
  expiryCriticalDays: z.number().int().min(0).max(3650).nullable().optional(),
  lotAllocationStrategy: lotAllocationStrategyEnum.optional(),
  isBundle: z.boolean().optional(),
  variantKind: z
    .enum([ItemVariantKind.STANDARD, ItemVariantKind.TEMPLATE])
    .optional(),
  tags: tagsSchema.optional(),
  metadata: metadataSchema.optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

const updateItemSchema = z.object({
  sku: skuSchema.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  type: itemTypeEnum.optional(),
  status: mutableStatusEnum.optional(),
  unitOfMeasure: z.string().trim().min(1).max(32).optional(),
  currency: currencySchema.optional(),
  salePriceCents: z.number().int().min(0).max(2_000_000_000).optional(),
  costPriceCents: z.number().int().min(0).max(2_000_000_000).optional(),
  trackInventory: z.boolean().optional(),
  allowNegativeStock: z.boolean().optional(),
  reorderPoint: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  trackExpiry: z.boolean().optional(),
  shelfLifeDays: z.number().int().min(1).max(36500).nullable().optional(),
  expiryWarningDays: z.number().int().min(0).max(3650).nullable().optional(),
  expiryCriticalDays: z.number().int().min(0).max(3650).nullable().optional(),
  lotAllocationStrategy: lotAllocationStrategyEnum.optional(),
  isBundle: z.boolean().optional(),
  tags: tagsSchema.optional(),
  metadata: metadataSchema.optional(),
  expectedVersion: z.number().int().min(1).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

const listItemsQuerySchema = z.object({
  type: itemTypeEnum.optional(),
  status: itemStatusEnum.optional(),
  variantKind: itemVariantKindEnum.optional(),
  parentItemId: z.string().trim().min(1).optional(),
  includeTemplates: z
    .enum(["true", "false"])
    .transform((val) => val === "true")
    .optional(),
  trackInventory: z
    .enum(["true", "false"])
    .transform((val) => val === "true")
    .optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const archiveItemSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

const restoreItemSchema = z.object({
  status: mutableStatusEnum.default(ItemStatus.ACTIVE),
  reason: z.string().trim().min(1).max(500).optional(),
});

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

@Controller("api/v1/items")
@RequireActiveTenant()
export class ItemsController {
  constructor(
    @Inject(ItemsService) private readonly itemsService: ItemsService,
  ) {}

  @Post()
  @RequiredOrgPermissions({ item: ["create"] })
  async createItem(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createItemSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid catalog item payload.",
        issues: parsed.error.issues,
      });
    }

    return this.itemsService.createItem(tenant, parsed.data, req.ip);
  }

  @Get()
  @RequiredOrgPermissions({ item: ["read"] })
  async listItems(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listItemsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid catalog item query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.itemsService.listItems(tenant, parsed.data);
  }

  @Get(":itemId")
  @RequiredOrgPermissions({ item: ["read"] })
  async getItem(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("itemId") itemId: string,
  ) {
    return this.itemsService.getItem(tenant, itemId);
  }

  @Patch(":itemId")
  @RequiredOrgPermissions({ item: ["update"] })
  async updateItem(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("itemId") itemId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateItemSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid catalog item update payload.",
        issues: parsed.error.issues,
      });
    }

    return this.itemsService.updateItem(tenant, itemId, parsed.data, req.ip);
  }

  @Post(":itemId/archive")
  @RequiredOrgPermissions({ item: ["archive"] })
  async archiveItem(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("itemId") itemId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = archiveItemSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid archive payload.",
        issues: parsed.error.issues,
      });
    }

    return this.itemsService.archiveItem(
      tenant,
      itemId,
      parsed.data.reason,
      req.ip,
    );
  }

  @Post(":itemId/restore")
  @RequiredOrgPermissions({ item: ["archive"] })
  async restoreItem(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("itemId") itemId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = restoreItemSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid restore payload.",
        issues: parsed.error.issues,
      });
    }

    return this.itemsService.restoreItem(
      tenant,
      itemId,
      parsed.data.status,
      parsed.data.reason,
      req.ip,
    );
  }

  @Get(":itemId/history")
  @RequiredOrgPermissions({ item: ["read"] })
  async listItemHistory(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("itemId") itemId: string,
    @Query() query: unknown,
  ) {
    const parsed = historyQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid history query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.itemsService.listItemHistory(
      tenant,
      itemId,
      parsed.data.limit,
      parsed.data.cursor,
    );
  }
}

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
import { PurchaseOrderStatus } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { attachStoredObjectSchema } from "../storage/attachments.service.js";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { DeliveriesService } from "./deliveries.service.js";
import { PurchaseOrdersService } from "./purchase-orders.service.js";

const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((v) => v.toUpperCase());

const poLineSchema = z.object({
  itemId: z.string().trim().min(1),
  packId: z.string().trim().min(1).nullable().optional(),
  orderedQty: z.number().int().min(1).max(1_000_000),
  unitCostCents: z.number().int().min(0).max(2_000_000_000).optional(),
  supplierSku: z.string().trim().max(64).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

const createPurchaseOrderSchema = z.object({
  poNumber: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
  supplierId: z.string().trim().min(1),
  locationId: z.string().trim().min(1),
  currency: currencySchema.optional(),
  priceBookId: z.string().trim().min(1).nullable().optional(),
  promoCodes: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  taxCents: z.number().int().min(0).max(2_000_000_000).optional(),
  expectedAt: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: z.array(poLineSchema).min(1).max(200),
});

const updateDraftPoSchema = z.object({
  locationId: z.string().trim().min(1).optional(),
  currency: currencySchema.optional(),
  priceBookId: z.string().trim().min(1).nullable().optional(),
  promoCodes: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  taxCents: z.number().int().min(0).max(2_000_000_000).optional(),
  expectedAt: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: z.array(poLineSchema).min(1).max(200).optional(),
});

const listPoQuerySchema = z.object({
  status: z
    .enum([
      PurchaseOrderStatus.DRAFT,
      PurchaseOrderStatus.SUBMITTED,
      PurchaseOrderStatus.PARTIALLY_RECEIVED,
      PurchaseOrderStatus.RECEIVED,
      PurchaseOrderStatus.CANCELLED,
    ])
    .optional(),
  supplierId: z.string().trim().min(1).optional(),
  locationId: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const cancelPoSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

const deliveryLineSchema = z.object({
  purchaseOrderLineId: z.string().trim().min(1),
  packId: z.string().trim().min(1).nullable().optional(),
  packQty: z.number().int().min(0).max(1_000_000).optional(),
  looseBaseQty: z.number().int().min(0).max(10_000_000).optional(),
  baseQty: z.number().int().min(1).max(10_000_000).optional(),
  lotNumber: z.string().trim().max(80).nullable().optional(),
  batchCode: z.string().trim().max(80).nullable().optional(),
  supplierBatchNumber: z.string().trim().max(100).nullable().optional(),
  manufacturedAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  serialNumbers: z
    .array(z.string().trim().min(1).max(100))
    .max(1000)
    .nullable()
    .optional(),
  attachments: z.array(attachStoredObjectSchema).max(20).optional(),
});

const createDeliverySchema = z.object({
  receiptNumber: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
  locationId: z.string().trim().min(1).optional(),
  carrier: z.string().trim().max(120).nullable().optional(),
  trackingNumber: z.string().trim().max(120).nullable().optional(),
  packingSlipNumber: z.string().trim().max(120).nullable().optional(),
  deliveredAt: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  attachments: z.array(attachStoredObjectSchema).max(20).optional(),
  lines: z.array(deliveryLineSchema).min(1).max(200),
});

const receiveGoodsSchema = z.object({
  receiptNumber: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
  locationId: z.string().trim().min(1).optional(),
  carrier: z.string().trim().max(120).nullable().optional(),
  trackingNumber: z.string().trim().max(120).nullable().optional(),
  packingSlipNumber: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
  lines: z
    .array(
      z.object({
        purchaseOrderLineId: z.string().trim().min(1),
        receivedQty: z.number().int().min(1).max(1_000_000).optional(),
        packId: z.string().trim().min(1).nullable().optional(),
        packQty: z.number().int().min(0).max(1_000_000).optional(),
        looseBaseQty: z.number().int().min(0).max(10_000_000).optional(),
        baseQty: z.number().int().min(1).max(10_000_000).optional(),
        lotNumber: z.string().trim().max(80).nullable().optional(),
        batchCode: z.string().trim().max(80).nullable().optional(),
        manufacturedAt: z.string().datetime().nullable().optional(),
        expiresAt: z.string().datetime().nullable().optional(),
        serialNumbers: z.array(z.string().trim().min(1).max(100)).max(1000).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
});

@Controller("api/v1/purchase-orders")
@RequireActiveOrganization()
export class PurchaseOrdersController {
  constructor(
    @Inject(PurchaseOrdersService)
    private readonly purchaseOrdersService: PurchaseOrdersService,
    @Inject(DeliveriesService)
    private readonly deliveriesService: DeliveriesService,
  ) {}

  @Post()
  @RequiredOrgPermissions({ purchaseOrder: ["create"] })
  async createPurchaseOrder(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createPurchaseOrderSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid purchase order payload.",
        issues: parsed.error.issues,
      });
    }

    return this.purchaseOrdersService.createPurchaseOrder(
      tenant,
      parsed.data,
      req.ip,
    );
  }

  @Get()
  @RequiredOrgPermissions({ purchaseOrder: ["read"] })
  async listPurchaseOrders(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listPoQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid purchase order query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.purchaseOrdersService.listPurchaseOrders(tenant, parsed.data);
  }

  @Get(":poId")
  @RequiredOrgPermissions({ purchaseOrder: ["read"] })
  async getPurchaseOrder(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("poId") poId: string,
  ) {
    return this.purchaseOrdersService.getPurchaseOrder(tenant, poId);
  }

  @Patch(":poId")
  @RequiredOrgPermissions({ purchaseOrder: ["update"] })
  async updateDraftPurchaseOrder(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("poId") poId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateDraftPoSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid purchase order update payload.",
        issues: parsed.error.issues,
      });
    }

    return this.purchaseOrdersService.updateDraftPurchaseOrder(
      tenant,
      poId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":poId/submit")
  @RequiredOrgPermissions({ purchaseOrder: ["submit"] })
  async submitPurchaseOrder(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("poId") poId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.purchaseOrdersService.submitPurchaseOrder(tenant, poId, req.ip);
  }

  @Post(":poId/cancel")
  @RequiredOrgPermissions({ purchaseOrder: ["cancel"] })
  async cancelPurchaseOrder(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("poId") poId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = cancelPoSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid cancellation payload.",
        issues: parsed.error.issues,
      });
    }

    return this.purchaseOrdersService.cancelPurchaseOrder(
      tenant,
      poId,
      parsed.data.reason,
      req.ip,
    );
  }

  @Get(":poId/delivery-preview")
  @RequiredOrgPermissions({ purchaseOrder: ["read"] })
  async getDeliveryPreview(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("poId") poId: string,
  ) {
    return this.deliveriesService.getDeliveryPreview(tenant, poId);
  }

  @Get(":poId/deliveries")
  @RequiredOrgPermissions({ purchaseOrder: ["read"] })
  async listPoDeliveries(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("poId") poId: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.deliveriesService.listDeliveries(tenant, {
      purchaseOrderId: poId,
      limit: limit ? Math.min(Math.max(Number(limit) || 25, 1), 100) : 25,
      cursor,
    });
  }

  @Post(":poId/deliveries")
  @RequiredOrgPermissions({ purchaseOrder: ["receive"] })
  async createDelivery(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("poId") poId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createDeliverySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid delivery payload.",
        issues: parsed.error.issues,
      });
    }

    return this.deliveriesService.createDelivery(
      tenant,
      poId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":poId/receive")
  @RequiredOrgPermissions({ purchaseOrder: ["receive"] })
  async receiveGoods(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("poId") poId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = receiveGoodsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid goods receipt payload.",
        issues: parsed.error.issues,
      });
    }

    return this.purchaseOrdersService.receiveGoods(
      tenant,
      poId,
      parsed.data,
      req.ip,
    );
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { VendorBillStatus } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { VendorBillsService } from "./vendor-bills.service.js";

const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((v) => v.toUpperCase());

const createVendorBillSchema = z.object({
  billNumber: z.string().trim().min(1).max(64),
  supplierId: z.string().trim().min(1),
  purchaseOrderId: z.string().trim().min(1).nullable().optional(),
  goodsReceiptId: z.string().trim().min(1).nullable().optional(),
  status: z.enum([VendorBillStatus.DRAFT, VendorBillStatus.OPEN]).optional(),
  currency: currencySchema.optional(),
  taxCents: z.number().int().min(0).max(2_000_000_000).optional(),
  issuedAt: z.string().datetime().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: z
    .array(
      z.object({
        itemId: z.string().trim().min(1).nullable().optional(),
        goodsReceiptLineId: z.string().trim().min(1).nullable().optional(),
        description: z.string().trim().min(1).max(500),
        quantity: z.number().int().min(1).max(1_000_000),
        baseQty: z.number().int().min(1).max(10_000_000).optional(),
        unitCostCents: z.number().int().min(0).max(2_000_000_000),
      }),
    )
    .min(1)
    .max(200),
});

const createBillFromDeliverySchema = z.object({
  billNumber: z.string().trim().min(1).max(64),
  status: z.enum([VendorBillStatus.DRAFT, VendorBillStatus.OPEN]).optional(),
  taxCents: z.number().int().min(0).max(2_000_000_000).optional(),
  issuedAt: z.string().datetime().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const listVendorBillsQuerySchema = z.object({
  status: z
    .enum([
      VendorBillStatus.DRAFT,
      VendorBillStatus.OPEN,
      VendorBillStatus.PARTIALLY_PAID,
      VendorBillStatus.PAID,
      VendorBillStatus.VOID,
    ])
    .optional(),
  supplierId: z.string().trim().min(1).optional(),
  purchaseOrderId: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const recordPaymentSchema = z.object({
  amountCents: z.number().int().min(1).max(2_000_000_000),
  reference: z.string().trim().min(1).max(100).optional(),
});

const voidBillSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

@Controller("api/v1/vendor-bills")
@RequireActiveOrganization()
export class VendorBillsController {
  constructor(
    @Inject(VendorBillsService)
    private readonly vendorBillsService: VendorBillsService,
  ) {}

  @Post()
  @RequiredOrgPermissions({ vendorBill: ["create"] })
  async createVendorBill(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createVendorBillSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid vendor bill payload.",
        issues: parsed.error.issues,
      });
    }

    return this.vendorBillsService.createVendorBill(
      tenant,
      parsed.data,
      req.ip,
    );
  }

  @Post("from-delivery/:deliveryId")
  @RequiredOrgPermissions({ vendorBill: ["create"] })
  async createVendorBillFromDelivery(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("deliveryId") deliveryId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createBillFromDeliverySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid vendor bill payload.",
        issues: parsed.error.issues,
      });
    }

    return this.vendorBillsService.createVendorBillFromDelivery(
      tenant,
      deliveryId,
      parsed.data,
      req.ip,
    );
  }

  @Get()
  @RequiredOrgPermissions({ vendorBill: ["read"] })
  async listVendorBills(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listVendorBillsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid vendor bill query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.vendorBillsService.listVendorBills(tenant, parsed.data);
  }

  @Get(":billId")
  @RequiredOrgPermissions({ vendorBill: ["read"] })
  async getVendorBill(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("billId") billId: string,
  ) {
    return this.vendorBillsService.getVendorBill(tenant, billId);
  }

  @Post(":billId/post")
  @RequiredOrgPermissions({ vendorBill: ["update"] })
  async postVendorBill(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("billId") billId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.vendorBillsService.postVendorBill(tenant, billId, req.ip);
  }

  @Post(":billId/payments")
  @RequiredOrgPermissions({ vendorBill: ["pay"] })
  async recordPayment(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("billId") billId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = recordPaymentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid payment payload.",
        issues: parsed.error.issues,
      });
    }

    return this.vendorBillsService.recordPayment(
      tenant,
      billId,
      parsed.data.amountCents,
      parsed.data.reference,
      req.ip,
    );
  }

  @Post(":billId/void")
  @RequiredOrgPermissions({ vendorBill: ["void"] })
  async voidVendorBill(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("billId") billId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = voidBillSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid void payload.",
        issues: parsed.error.issues,
      });
    }

    return this.vendorBillsService.voidVendorBill(
      tenant,
      billId,
      parsed.data.reason,
      req.ip,
    );
  }
}

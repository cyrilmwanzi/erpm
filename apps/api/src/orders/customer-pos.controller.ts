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
import { CustomerPoStatus } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { CustomerPoService } from "./customer-pos.service.js";

const dateStringSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), {
    message: "Must be a valid ISO date or datetime string.",
  });

const poLineSchema = z.object({
  itemId: z.string().trim().min(1),
  quantity: z.number().int().min(1).max(1_000_000),
  unitPriceCents: z.number().int().min(0).max(1_000_000_000).optional(),
  discountCents: z.number().int().min(0).max(1_000_000_000).optional(),
  description: z.string().trim().max(500).optional(),
  unitOfMeasure: z.string().trim().max(40).optional(),
});

const createCustomerPoSchema = z.object({
  poNumber: z.string().trim().min(1).max(120),
  customerId: z.string().trim().min(1),
  internalRef: z.string().trim().min(1).max(64).optional(),
  currency: z.string().trim().length(3).transform((v) => v.toUpperCase()).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  issueDate: dateStringSchema.nullable().optional(),
  expiryDate: dateStringSchema.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  taxCents: z.number().int().min(0).max(1_000_000_000).optional(),
  lines: z.array(poLineSchema).min(1).max(500),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const listCustomerPosQuerySchema = z.object({
  status: z
    .enum([
      CustomerPoStatus.RECEIVED,
      CustomerPoStatus.CONFIRMED,
      CustomerPoStatus.PARTIALLY_INVOICED,
      CustomerPoStatus.INVOICED,
      CustomerPoStatus.COMPLETED,
      CustomerPoStatus.CANCELLED,
      CustomerPoStatus.REJECTED,
    ])
    .optional(),
  customerId: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const confirmCustomerPoSchema = z.object({
  allowOverrideCredit: z.boolean().optional(),
});

const cancelCustomerPoSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

const convertToOrderSchema = z.object({
  locationId: z.string().trim().min(1),
  orderNumber: z.string().trim().max(64).optional(),
  notes: z.string().trim().max(2000).optional(),
});

const convertToInvoiceSchema = z.object({
  invoiceNumber: z.string().trim().max(64).optional(),
  dueAt: dateStringSchema.nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
  status: z.enum(["DRAFT", "ISSUED"]).optional(),
});

@Controller("api/v1/customer-pos")
@RequireActiveOrganization()
export class CustomerPoController {
  constructor(
    @Inject(CustomerPoService)
    private readonly customerPoService: CustomerPoService,
  ) {}

  @Post()
  @RequiredOrgPermissions({ customerPo: ["create"] })
  async createCustomerPo(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createCustomerPoSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid Customer PO payload.",
        issues: parsed.error.issues,
      });
    }

    return this.customerPoService.createCustomerPo(
      tenant,
      parsed.data,
      req.ip,
    );
  }

  @Get()
  @RequiredOrgPermissions({ customerPo: ["read"] })
  async listCustomerPos(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listCustomerPosQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid Customer PO query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.customerPoService.listCustomerPos(tenant, parsed.data);
  }

  @Get(":poId")
  @RequiredOrgPermissions({ customerPo: ["read"] })
  async getCustomerPo(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("poId") poId: string,
  ) {
    return this.customerPoService.getCustomerPo(tenant, poId);
  }

  @Post(":poId/confirm")
  @RequiredOrgPermissions({ customerPo: ["confirm"] })
  async confirmCustomerPo(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("poId") poId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = confirmCustomerPoSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid Customer PO confirm payload.",
        issues: parsed.error.issues,
      });
    }

    return this.customerPoService.confirmCustomerPo(
      tenant,
      poId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":poId/cancel")
  @RequiredOrgPermissions({ customerPo: ["cancel"] })
  async cancelCustomerPo(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("poId") poId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = cancelCustomerPoSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid Customer PO cancel payload.",
        issues: parsed.error.issues,
      });
    }

    return this.customerPoService.cancelCustomerPo(
      tenant,
      poId,
      parsed.data.reason,
      req.ip,
    );
  }

  @Post(":poId/convert-to-order")
  @RequiredOrgPermissions({ customerPo: ["confirm"], order: ["create"] })
  async convertToOrder(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("poId") poId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = convertToOrderSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid convert to order payload.",
        issues: parsed.error.issues,
      });
    }

    return this.customerPoService.convertToOrder(
      tenant,
      poId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":poId/convert-to-invoice")
  @RequiredOrgPermissions({ customerPo: ["confirm"], invoice: ["create"] })
  async convertToInvoice(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("poId") poId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = convertToInvoiceSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid convert to invoice payload.",
        issues: parsed.error.issues,
      });
    }

    return this.customerPoService.convertToInvoice(
      tenant,
      poId,
      parsed.data,
      req.ip,
    );
  }
}

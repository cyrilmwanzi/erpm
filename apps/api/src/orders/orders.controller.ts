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
import { OrderChannel, OrderStatus } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { MpesaPaymentService } from "../payments/mpesa-payment.service.js";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { InvoicesPaymentsService } from "./invoices-payments.service.js";
import { OrdersService } from "./orders.service.js";

const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((v) => v.toUpperCase());

const dateStringSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), {
    message: "Must be a valid ISO date or datetime string.",
  });

const docNumberSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);

const orderLineSchema = z.object({
  itemId: z.string().trim().min(1),
  quantity: z.number().int().min(1).max(1_000_000),
  packId: z.string().trim().min(1).nullable().optional(),
  servicePlanId: z.string().trim().min(1).nullable().optional(),
  overrideUnitPriceCents: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  description: z.string().trim().max(300).nullable().optional(),
});

const posCheckoutSchema = z.object({
  orderNumber: docNumberSchema.optional(),
  locationId: z.string().trim().min(1),
  customerId: z.string().trim().min(1).nullable().optional(),
  priceBookId: z.string().trim().min(1).nullable().optional(),
  promoCodes: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  currency: currencySchema.optional(),
  taxCents: z.number().int().min(0).max(1_000_000_000).optional(),
  cashTenderedCents: z.number().int().min(0).max(1_000_000_000).optional(),
  paymentMethod: z.enum(["CASH", "MPESA"]).optional(),
  mpesaPhoneNumber: z.string().trim().min(9).max(20).nullable().optional(),
  mpesaAccountReference: z.string().trim().max(32).nullable().optional(),
  mpesaTransactionDesc: z.string().trim().max(64).nullable().optional(),
  reference: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: z.array(orderLineSchema).min(1).max(200),
});

const orderMpesaStkSchema = z.object({
  phoneNumber: z.string().trim().min(9).max(20),
  amountCents: z.number().int().min(100).max(1_000_000_000).optional(),
  accountReference: z.string().trim().max(32).nullable().optional(),
  transactionDesc: z.string().trim().max(64).nullable().optional(),
});

const createB2bOrderSchema = z.object({
  orderNumber: docNumberSchema.optional(),
  locationId: z.string().trim().min(1),
  customerId: z.string().trim().min(1),
  priceBookId: z.string().trim().min(1).nullable().optional(),
  externalDealId: z.string().trim().min(1).max(120).nullable().optional(),
  promoCodes: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  currency: currencySchema.optional(),
  taxCents: z.number().int().min(0).max(1_000_000_000).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: z.array(orderLineSchema).min(1).max(200),
});

const updateDraftB2bOrderSchema = z.object({
  locationId: z.string().trim().min(1).optional(),
  customerId: z.string().trim().min(1).optional(),
  priceBookId: z.string().trim().min(1).nullable().optional(),
  externalDealId: z.string().trim().min(1).max(120).nullable().optional(),
  promoCodes: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  currency: currencySchema.optional(),
  taxCents: z.number().int().min(0).max(1_000_000_000).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: z.array(orderLineSchema).min(1).max(200).optional(),
});

const confirmB2bOrderSchema = z.object({
  issueInvoice: z.boolean().optional(),
  invoiceDueAt: dateStringSchema.nullable().optional(),
  invoiceNotes: z.string().trim().max(2000).nullable().optional(),
});

const fulfillB2bOrderSchema = z.object({
  lines: z
    .array(
      z.object({
        orderLineId: z.string().trim().min(1),
        quantity: z.number().int().min(1).max(1_000_000),
      }),
    )
    .min(1)
    .max(200)
    .optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const cancelOrderSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

const createInvoiceFromOrderSchema = z.object({
  invoiceNumber: docNumberSchema.optional(),
  status: z.enum(["DRAFT", "ISSUED"]).optional(),
  taxCents: z.number().int().min(0).max(1_000_000_000).optional(),
  dueAt: dateStringSchema.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const listOrdersQuerySchema = z.object({
  channel: z.enum([OrderChannel.POS, OrderChannel.B2B]).optional(),
  status: z
    .enum([
      OrderStatus.DRAFT,
      OrderStatus.CONFIRMED,
      OrderStatus.PARTIALLY_FULFILLED,
      OrderStatus.FULFILLED,
      OrderStatus.COMPLETED,
      OrderStatus.CANCELLED,
    ])
    .optional(),
  customerId: z.string().trim().min(1).optional(),
  locationId: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

@Controller("api/v1/orders")
@RequireActiveOrganization()
export class OrdersController {
  constructor(
    @Inject(OrdersService) private readonly ordersService: OrdersService,
    @Inject(InvoicesPaymentsService)
    private readonly invoicesPaymentsService: InvoicesPaymentsService,
    @Inject(MpesaPaymentService)
    private readonly mpesaPaymentService: MpesaPaymentService,
  ) {}

  @Post("pos/checkout")
  @RequiredOrgPermissions({ order: ["posCheckout"] })
  async posCheckout(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = posCheckoutSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid POS checkout payload.",
        issues: parsed.error.issues,
      });
    }

    return this.ordersService.posCheckout(tenant, parsed.data, req.ip);
  }

  @Post("b2b")
  @RequiredOrgPermissions({ order: ["create"] })
  async createB2bOrder(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createB2bOrderSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid B2B order payload.",
        issues: parsed.error.issues,
      });
    }

    return this.ordersService.createB2bOrder(tenant, parsed.data, req.ip);
  }

  @Get()
  @RequiredOrgPermissions({ order: ["read"] })
  async listOrders(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listOrdersQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid order query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.ordersService.listOrders(tenant, parsed.data);
  }

  @Get(":orderId")
  @RequiredOrgPermissions({ order: ["read"] })
  async getOrder(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("orderId") orderId: string,
  ) {
    return this.ordersService.getOrder(tenant, orderId);
  }

  @Patch(":orderId")
  @RequiredOrgPermissions({ order: ["update"] })
  async updateDraftB2bOrder(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("orderId") orderId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateDraftB2bOrderSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid B2B order update payload.",
        issues: parsed.error.issues,
      });
    }

    return this.ordersService.updateDraftB2bOrder(
      tenant,
      orderId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":orderId/confirm")
  @RequiredOrgPermissions({ order: ["confirm"] })
  async confirmB2bOrder(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("orderId") orderId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = confirmB2bOrderSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid order confirmation payload.",
        issues: parsed.error.issues,
      });
    }

    return this.ordersService.confirmB2bOrder(
      tenant,
      orderId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":orderId/fulfill")
  @RequiredOrgPermissions({ order: ["fulfill"] })
  async fulfillB2bOrder(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("orderId") orderId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = fulfillB2bOrderSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid order fulfillment payload.",
        issues: parsed.error.issues,
      });
    }

    return this.ordersService.fulfillB2bOrder(
      tenant,
      orderId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":orderId/cancel")
  @RequiredOrgPermissions({ order: ["cancel"] })
  async cancelB2bOrder(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("orderId") orderId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = cancelOrderSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid order cancellation payload.",
        issues: parsed.error.issues,
      });
    }

    return this.ordersService.cancelB2bOrder(
      tenant,
      orderId,
      parsed.data.reason,
      req.ip,
    );
  }

  @Post(":orderId/invoices")
  @RequiredOrgPermissions({ invoice: ["create"] })
  async createInvoiceFromOrder(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("orderId") orderId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createInvoiceFromOrderSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid invoice creation payload.",
        issues: parsed.error.issues,
      });
    }

    return this.invoicesPaymentsService.createInvoiceFromOrder(
      tenant,
      orderId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":orderId/payments/mpesa/stk-push")
  @RequiredOrgPermissions({ payment: ["record"] })
  async initiateOrderMpesaStkPush(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("orderId") orderId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = orderMpesaStkSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid M-Pesa STK Push payload.",
        issues: parsed.error.issues,
      });
    }

    return this.mpesaPaymentService.initiateStkPushForOrder(
      tenant,
      orderId,
      parsed.data,
      req.ip,
    );
  }
}

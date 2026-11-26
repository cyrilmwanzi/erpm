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
import { SubscriptionBillingCycle } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AllowWhenBillingLocked,
  CurrentTenant,
  RequireActiveTenant,
  RequiredOrgPermissions,
  type AuthenticatedTenant,
} from "../tenancy/tenant.decorators.js";
import { OrgBillingService } from "./org-billing.service.js";

const listLimitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const checkoutSchema = z.object({
  planId: z.string().trim().min(1),
  billingCycle: z.enum([
    SubscriptionBillingCycle.MONTHLY,
    SubscriptionBillingCycle.ANNUAL,
  ]),
});

const initiateMpesaSchema = z.object({
  invoiceId: z.string().trim().min(1).optional(),
  planId: z.string().trim().min(1).optional(),
  billingCycle: z
    .enum([SubscriptionBillingCycle.MONTHLY, SubscriptionBillingCycle.ANNUAL])
    .optional(),
  phoneNumber: z.string().trim().min(9).max(20),
});

const simulateStkSchema = z.object({
  transactionId: z.string().trim().min(1),
  outcome: z.enum(["SUCCESS", "CANCELLED", "FAILED", "TIMEOUT"]).optional(),
  mpesaReceiptNumber: z.string().trim().min(4).max(32).optional(),
  resultDesc: z.string().trim().max(240).optional(),
});

@Controller("api/v1/billing")
@RequireActiveTenant()
@AllowWhenBillingLocked()
export class OrgBillingController {
  constructor(
    @Inject(OrgBillingService)
    private readonly orgBillingService: OrgBillingService,
  ) {}

  @Get("subscription")
  @RequiredOrgPermissions({ billing: ["read"] })
  async getSubscription(@CurrentTenant() tenant: AuthenticatedTenant) {
    return this.orgBillingService.getSubscriptionOverview(tenant);
  }

  @Get("options")
  @RequiredOrgPermissions({ billing: ["read"] })
  async getBillingOptions(@CurrentTenant() tenant: AuthenticatedTenant) {
    return this.orgBillingService.getBillingOptions(tenant);
  }

  @Get("invoices")
  @RequiredOrgPermissions({ billing: ["read"] })
  async listInvoices(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listLimitQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid invoice query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.orgBillingService.listInvoices(tenant, parsed.data.limit);
  }

  @Get("payments")
  @RequiredOrgPermissions({ billing: ["read"] })
  async listPayments(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listLimitQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid billing payments query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.orgBillingService.listPayments(tenant, parsed.data.limit);
  }

  @Post("checkout")
  @RequiredOrgPermissions({ billing: ["manage"] })
  async createCheckout(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = checkoutSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid billing checkout payload.",
        issues: parsed.error.issues,
      });
    }
    return this.orgBillingService.createCheckoutInvoice(
      tenant,
      parsed.data,
      req.ip,
    );
  }

  @Post("payments/mpesa/stk-push")
  @RequiredOrgPermissions({ billing: ["manage"] })
  async initiateMpesaPayment(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = initiateMpesaSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid M-Pesa subscription payment payload.",
        issues: parsed.error.issues,
      });
    }
    return this.orgBillingService.initiateMpesaPayment(
      tenant,
      parsed.data,
      req.ip,
    );
  }

  @Post("payments/mpesa/:transactionId/query-status")
  @RequiredOrgPermissions({ billing: ["manage"] })
  async queryMpesaStatus(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("transactionId") transactionId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.orgBillingService.queryMpesaPaymentStatus(
      tenant,
      transactionId,
      req.ip,
    );
  }

  @Post("payments/mpesa/simulator/callback")
  @RequiredOrgPermissions({ billing: ["manage"] })
  async simulateMpesaCallback(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = simulateStkSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid M-Pesa billing simulator payload.",
        issues: parsed.error.issues,
      });
    }
    return this.orgBillingService.simulateMpesaCallback(
      tenant,
      parsed.data,
      req.ip,
    );
  }
}

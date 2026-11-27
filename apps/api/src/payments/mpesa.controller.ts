import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  MpesaC2bResponseType,
  MpesaEnvironment,
  MpesaShortcodeType,
  PaymentTargetType,
  PaymentTransactionFlow,
  PaymentTransactionStatus,
} from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredBillingFeature,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { MpesaConfigService } from "./mpesa-config.service.js";
import { MpesaPaymentService } from "./mpesa-payment.service.js";

const upsertMpesaConfigSchema = z.object({
  isEnabled: z.boolean().optional(),
  environment: z
    .enum([
      MpesaEnvironment.SANDBOX,
      MpesaEnvironment.PRODUCTION,
      MpesaEnvironment.LOCAL_SIMULATOR,
    ])
    .optional(),
  shortcodeType: z
    .enum([MpesaShortcodeType.PAYBILL, MpesaShortcodeType.TILL])
    .optional(),
  businessShortCode: z
    .string()
    .trim()
    .regex(/^\d{4,12}$/, "businessShortCode must be 4-12 digits."),
  partyB: z
    .string()
    .trim()
    .regex(/^\d{4,12}$/, "partyB must be 4-12 digits.")
    .nullable()
    .optional(),
  consumerKey: z.string().trim().min(4).max(512).nullable().optional(),
  consumerSecret: z.string().trim().min(4).max(512).nullable().optional(),
  passkey: z.string().trim().min(8).max(512).nullable().optional(),
  callbackIpAllowlist: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  c2bResponseType: z
    .enum([MpesaC2bResponseType.COMPLETED, MpesaC2bResponseType.CANCELLED])
    .optional(),
  c2bValidateReference: z.boolean().optional(),
  accountReferencePrefix: z
    .string()
    .trim()
    .max(12)
    .regex(/^[A-Za-z0-9_-]*$/)
    .nullable()
    .optional(),
  transactionDescTemplate: z.string().trim().max(64).nullable().optional(),
});

const listTransactionsQuerySchema = z.object({
  status: z
    .enum([
      PaymentTransactionStatus.PENDING,
      PaymentTransactionStatus.SUCCEEDED,
      PaymentTransactionStatus.FAILED,
      PaymentTransactionStatus.CANCELLED,
      PaymentTransactionStatus.EXPIRED,
      PaymentTransactionStatus.UNMATCHED_C2B,
    ])
    .optional(),
  flow: z
    .enum([
      PaymentTransactionFlow.STK_PUSH,
      PaymentTransactionFlow.C2B_PAYBILL,
      PaymentTransactionFlow.C2B_TILL,
    ])
    .optional(),
  targetType: z
    .enum([
      PaymentTargetType.POS_ORDER,
      PaymentTargetType.ORDER,
      PaymentTargetType.SALES_INVOICE,
      PaymentTargetType.FULFILLMENT,
      PaymentTargetType.UNMATCHED,
    ])
    .optional(),
  orderId: z.string().trim().min(1).optional(),
  salesInvoiceId: z.string().trim().min(1).optional(),
  fulfillmentId: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const reconcileC2bSchema = z.object({
  targetType: z.enum(["ORDER", "SALES_INVOICE", "FULFILLMENT"]),
  targetId: z.string().trim().min(1),
});

const simulateStkSchema = z.object({
  transactionId: z.string().trim().min(1),
  outcome: z.enum(["SUCCESS", "CANCELLED", "FAILED", "TIMEOUT"]).optional(),
  mpesaReceiptNumber: z.string().trim().min(4).max(32).optional(),
  resultDesc: z.string().trim().max(240).optional(),
});

const simulateC2bSchema = z.object({
  action: z.enum(["VALIDATE", "CONFIRM", "VALIDATE_AND_CONFIRM"]).optional(),
  transId: z.string().trim().min(4).max(32).optional(),
  amountCents: z.number().int().min(100).max(1_000_000_000),
  billRefNumber: z.string().trim().min(1).max(64),
  phoneNumber: z.string().trim().min(9).max(20),
  firstName: z.string().trim().max(64).optional(),
  lastName: z.string().trim().max(64).optional(),
});

@Controller("api/v1/payments/mpesa")
@RequireActiveOrganization()
@RequiredBillingFeature("mpesa")
export class MpesaController {
  constructor(
    @Inject(MpesaConfigService)
    private readonly configService: MpesaConfigService,
    @Inject(MpesaPaymentService)
    private readonly paymentService: MpesaPaymentService,
  ) {}

  @Get("config")
  @RequiredOrgPermissions({ payment: ["configure"] })
  async getConfig(@CurrentOrganization() tenant: AuthenticatedOrganization) {
    return this.configService.getConfig(tenant);
  }

  @Put("config")
  @RequiredOrgPermissions({ payment: ["configure"] })
  async upsertConfig(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = upsertMpesaConfigSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid M-Pesa configuration payload.",
        issues: parsed.error.issues,
      });
    }

    return this.configService.upsertConfig(tenant, parsed.data, req.ip);
  }

  @Post("config/rotate-token")
  @RequiredOrgPermissions({ payment: ["configure"] })
  async rotateCallbackToken(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Req() req: FastifyRequest,
  ) {
    return this.configService.rotateCallbackToken(tenant, req.ip);
  }

  @Post("config/test")
  @RequiredOrgPermissions({ payment: ["configure"] })
  async testConnection(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Req() req: FastifyRequest,
  ) {
    return this.configService.testConnection(tenant, req.ip);
  }

  @Post("config/register-c2b")
  @RequiredOrgPermissions({ payment: ["configure"] })
  async registerC2bUrls(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Req() req: FastifyRequest,
  ) {
    return this.configService.registerC2bUrls(tenant, req.ip);
  }

  @Get("transactions")
  @RequiredOrgPermissions({ payment: ["read"] })
  async listTransactions(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listTransactionsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid M-Pesa transaction query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.paymentService.listTransactions(tenant, parsed.data);
  }

  @Get("transactions/:transactionId")
  @RequiredOrgPermissions({ payment: ["read"] })
  async getTransaction(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("transactionId") transactionId: string,
  ) {
    return this.paymentService.getTransaction(tenant, transactionId);
  }

  @Post("transactions/:transactionId/query-status")
  @RequiredOrgPermissions({ payment: ["reconcile"] })
  async queryStatus(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("transactionId") transactionId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.paymentService.queryStkStatusAndReconcile(
      tenant,
      transactionId,
      req.ip,
    );
  }

  @Post("transactions/:transactionId/reconcile")
  @RequiredOrgPermissions({ payment: ["reconcile"] })
  async reconcileUnmatchedC2b(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("transactionId") transactionId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = reconcileC2bSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid C2B reconciliation payload.",
        issues: parsed.error.issues,
      });
    }

    return this.paymentService.reconcileUnmatchedC2b(
      tenant,
      transactionId,
      parsed.data,
      req.ip,
    );
  }

  @Post("simulator/stk-callback")
  @RequiredOrgPermissions({ payment: ["record"] })
  async simulateStkCallback(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = simulateStkSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid STK simulator payload.",
        issues: parsed.error.issues,
      });
    }

    return this.paymentService.simulateStkCallback(tenant, parsed.data, req.ip);
  }

  @Post("simulator/c2b")
  @RequiredOrgPermissions({ payment: ["record"] })
  async simulateC2b(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = simulateC2bSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid C2B simulator payload.",
        issues: parsed.error.issues,
      });
    }

    return this.paymentService.simulateC2bWebhook(tenant, parsed.data, req.ip);
  }
}

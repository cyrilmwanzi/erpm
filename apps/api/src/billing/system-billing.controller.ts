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
  BillingSubscriptionStatus,
  MpesaEnvironment,
  MpesaShortcodeType,
  PlatformRole,
  SubscriptionBillingCycle,
} from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentSystemAdmin,
  RequireSystemAdmin,
  type AuthenticatedSystemAdmin,
} from "./billing.decorators.js";
import { PlatformMpesaService } from "./platform-mpesa.service.js";
import { SystemBillingService } from "./system-billing.service.js";

const updatePlatformConfigSchema = z.object({
  autoTrialEnabled: z.boolean().optional(),
  defaultTrialDays: z.number().int().min(0).max(365).optional(),
  defaultGracePeriodDays: z.number().int().min(0).max(90).optional(),
  defaultCurrency: z
    .string()
    .trim()
    .length(3)
    .transform((v) => v.toUpperCase())
    .optional(),
  taxRateBps: z.number().int().min(0).max(5000).optional(),
  mpesaEnabled: z.boolean().optional(),
  allowMonthlyBilling: z.boolean().optional(),
  allowAnnualBilling: z.boolean().optional(),
  lockoutAfterGrace: z.boolean().optional(),
  enforceQuotas: z.boolean().optional(),
  enforceFeatureFlags: z.boolean().optional(),
  billingSupportEmail: z.string().trim().email().max(320).nullable().optional(),
});

const upsertPlatformMpesaSchema = z.object({
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
  accountReferencePrefix: z
    .string()
    .trim()
    .max(12)
    .regex(/^[A-Za-z0-9_-]*$/)
    .nullable()
    .optional(),
  transactionDescTemplate: z.string().trim().max(64).nullable().optional(),
});

const createPlanSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  isDefaultTrial: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((v) => v.toUpperCase())
    .optional(),
  monthlyPriceCents: z.number().int().min(0).max(1_000_000_000),
  annualPriceCents: z.number().int().min(0).max(10_000_000_000),
  trialDays: z.number().int().min(0).max(365).optional(),
  gracePeriodDays: z.number().int().min(0).max(90).optional(),
  maxMembers: z.number().int().min(1).max(100_000).nullable().optional(),
  maxLocations: z.number().int().min(1).max(10_000).nullable().optional(),
  maxItems: z.number().int().min(1).max(10_000_000).nullable().optional(),
  maxMonthlyOrders: z.number().int().min(1).max(100_000_000).nullable().optional(),
  maxStorageBytes: z.number().int().min(1024).nullable().optional(),
  features: z.record(z.string(), z.boolean()).optional(),
});

const updatePlanSchema = createPlanSchema.omit({ code: true }).partial();

const listOrgsQuerySchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  status: z
    .enum([
      BillingSubscriptionStatus.TRIALING,
      BillingSubscriptionStatus.ACTIVE,
      BillingSubscriptionStatus.GRACE_PERIOD,
      BillingSubscriptionStatus.PAST_DUE,
      BillingSubscriptionStatus.EXPIRED,
      BillingSubscriptionStatus.SUSPENDED,
      BillingSubscriptionStatus.CANCELED,
    ])
    .optional(),
  hasOverride: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const updateSubscriptionSchema = z.object({
  planId: z.string().trim().min(1).optional(),
  billingCycle: z
    .enum([SubscriptionBillingCycle.MONTHLY, SubscriptionBillingCycle.ANNUAL])
    .optional(),
  status: z
    .enum([
      BillingSubscriptionStatus.TRIALING,
      BillingSubscriptionStatus.ACTIVE,
      BillingSubscriptionStatus.GRACE_PERIOD,
      BillingSubscriptionStatus.PAST_DUE,
      BillingSubscriptionStatus.EXPIRED,
      BillingSubscriptionStatus.SUSPENDED,
      BillingSubscriptionStatus.CANCELED,
    ])
    .optional(),
  trialEndsAt: z.string().trim().nullable().optional(),
  currentPeriodStart: z.string().trim().nullable().optional(),
  currentPeriodEnd: z.string().trim().nullable().optional(),
  gracePeriodEndsAt: z.string().trim().nullable().optional(),
  cancelAtPeriodEnd: z.boolean().optional(),
  suspensionReason: z.string().trim().max(500).nullable().optional(),
});

const upsertOverrideSchema = z.object({
  isActive: z.boolean().optional(),
  exemptFromBilling: z.boolean().optional(),
  exemptUntil: z.string().trim().nullable().optional(),
  forceStatus: z
    .enum([
      BillingSubscriptionStatus.TRIALING,
      BillingSubscriptionStatus.ACTIVE,
      BillingSubscriptionStatus.GRACE_PERIOD,
      BillingSubscriptionStatus.PAST_DUE,
      BillingSubscriptionStatus.EXPIRED,
      BillingSubscriptionStatus.SUSPENDED,
      BillingSubscriptionStatus.CANCELED,
    ])
    .nullable()
    .optional(),
  forcePlanId: z.string().trim().min(1).nullable().optional(),
  customTrialEndsAt: z.string().trim().nullable().optional(),
  customGracePeriodEndsAt: z.string().trim().nullable().optional(),
  customMaxMembers: z.number().int().min(1).max(100_000).nullable().optional(),
  customMaxLocations: z.number().int().min(1).max(10_000).nullable().optional(),
  customMaxItems: z.number().int().min(1).max(10_000_000).nullable().optional(),
  customMaxMonthlyOrders: z
    .number()
    .int()
    .min(1)
    .max(100_000_000)
    .nullable()
    .optional(),
  customMaxStorageBytes: z.number().int().min(1024).nullable().optional(),
  discountPercent: z.number().int().min(0).max(100).nullable().optional(),
  allowMpesaOverride: z.boolean().nullable().optional(),
  featureOverrides: z.record(z.string(), z.boolean()).nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const extendTrialSchema = z.object({
  additionalDays: z.number().int().min(1).max(365).optional(),
  trialEndsAt: z.string().trim().optional(),
  reason: z.string().trim().max(500).optional(),
});

const suspendOrgSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

const reactivateOrgSchema = z.object({
  durationDays: z.number().int().min(1).max(3650).optional(),
  planId: z.string().trim().min(1).optional(),
  reason: z.string().trim().max(500).optional(),
});

const adminCreateInvoiceSchema = z.object({
  planId: z.string().trim().min(1).optional(),
  billingCycle: z
    .enum([SubscriptionBillingCycle.MONTHLY, SubscriptionBillingCycle.ANNUAL])
    .optional(),
  dueInDays: z.number().int().min(0).max(365).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  markPaidImmediately: z.boolean().optional(),
  externalReference: z.string().trim().max(120).nullable().optional(),
});

const markPaidSchema = z.object({
  externalReference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
});

const waiveInvoiceSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

const voidInvoiceSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

const auditQuerySchema = z.object({
  organizationId: z.string().trim().min(1).optional(),
  action: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const setAdminRoleSchema = z.object({
  platformRole: z.enum([PlatformRole.USER, PlatformRole.SYSTEM_ADMIN]),
});

@Controller("api/v1/system/billing")
@RequireSystemAdmin()
export class SystemBillingController {
  constructor(
    @Inject(SystemBillingService)
    private readonly systemBillingService: SystemBillingService,
    @Inject(PlatformMpesaService)
    private readonly platformMpesaService: PlatformMpesaService,
  ) {}

  @Get("config")
  async getPlatformConfig() {
    return this.systemBillingService.getPlatformBillingOverview();
  }

  @Put("config")
  async updatePlatformConfig(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updatePlatformConfigSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid platform billing configuration payload.",
        issues: parsed.error.issues,
      });
    }
    return this.systemBillingService.updatePlatformBillingConfig(
      admin.userId,
      parsed.data,
      req.ip,
    );
  }

  @Put("mpesa-config")
  async upsertPlatformMpesaConfig(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = upsertPlatformMpesaSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid platform M-Pesa configuration payload.",
        issues: parsed.error.issues,
      });
    }
    return this.platformMpesaService.upsertConfig(
      admin.userId,
      parsed.data,
      req.ip,
    );
  }

  @Post("mpesa-config/rotate-token")
  async rotatePlatformMpesaToken(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Req() req: FastifyRequest,
  ) {
    return this.platformMpesaService.rotateCallbackToken(admin.userId, req.ip);
  }

  @Post("mpesa-config/test")
  async testPlatformMpesaConnection(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Req() req: FastifyRequest,
  ) {
    return this.platformMpesaService.testConnection(admin.userId, req.ip);
  }

  @Get("plans")
  async listPlans() {
    return this.systemBillingService.listPlans();
  }

  @Post("plans")
  async createPlan(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createPlanSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid billing plan payload.",
        issues: parsed.error.issues,
      });
    }
    return this.systemBillingService.createPlan(
      admin.userId,
      parsed.data,
      req.ip,
    );
  }

  @Patch("plans/:planId")
  async updatePlan(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Param("planId") planId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updatePlanSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid billing plan update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.systemBillingService.updatePlan(
      admin.userId,
      planId,
      parsed.data,
      req.ip,
    );
  }

  @Get("organizations")
  async listOrganizations(@Query() query: unknown) {
    const parsed = listOrgsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid organization billing query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.systemBillingService.listOrganizations(parsed.data);
  }

  @Get("organizations/:organizationId")
  async getOrganizationBilling(@Param("organizationId") organizationId: string) {
    return this.systemBillingService.getOrganizationBillingDetail(organizationId);
  }

  @Put("organizations/:organizationId/subscription")
  async updateOrganizationSubscription(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Param("organizationId") organizationId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateSubscriptionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid subscription update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.systemBillingService.updateOrganizationSubscription(
      admin.userId,
      organizationId,
      parsed.data,
      req.ip,
    );
  }

  @Put("organizations/:organizationId/override")
  async upsertOrganizationOverride(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Param("organizationId") organizationId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = upsertOverrideSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid organization billing override payload.",
        issues: parsed.error.issues,
      });
    }
    return this.systemBillingService.upsertOrganizationOverride(
      admin.userId,
      organizationId,
      parsed.data,
      req.ip,
    );
  }

  @Delete("organizations/:organizationId/override")
  async clearOrganizationOverride(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Param("organizationId") organizationId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.systemBillingService.clearOrganizationOverride(
      admin.userId,
      organizationId,
      req.ip,
    );
  }

  @Post("organizations/:organizationId/extend-trial")
  async extendOrganizationTrial(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Param("organizationId") organizationId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = extendTrialSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid trial extension payload.",
        issues: parsed.error.issues,
      });
    }
    return this.systemBillingService.extendOrganizationTrial(
      admin.userId,
      organizationId,
      parsed.data,
      req.ip,
    );
  }

  @Post("organizations/:organizationId/suspend")
  async suspendOrganization(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Param("organizationId") organizationId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = suspendOrgSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid organization suspension payload.",
        issues: parsed.error.issues,
      });
    }
    return this.systemBillingService.suspendOrganization(
      admin.userId,
      organizationId,
      parsed.data.reason,
      req.ip,
    );
  }

  @Post("organizations/:organizationId/reactivate")
  async reactivateOrganization(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Param("organizationId") organizationId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = reactivateOrgSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid organization reactivation payload.",
        issues: parsed.error.issues,
      });
    }
    return this.systemBillingService.reactivateOrganization(
      admin.userId,
      organizationId,
      parsed.data,
      req.ip,
    );
  }

  @Post("organizations/:organizationId/invoices")
  async createAdminInvoice(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Param("organizationId") organizationId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = adminCreateInvoiceSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid billing invoice payload.",
        issues: parsed.error.issues,
      });
    }
    return this.systemBillingService.createAdminInvoice(
      admin.userId,
      organizationId,
      parsed.data,
      req.ip,
    );
  }

  @Post("invoices/:invoiceId/mark-paid")
  async markInvoicePaid(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Param("invoiceId") invoiceId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = markPaidSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid mark-paid payload.",
        issues: parsed.error.issues,
      });
    }
    return this.systemBillingService.markInvoicePaid(
      admin.userId,
      invoiceId,
      parsed.data,
      req.ip,
    );
  }

  @Post("invoices/:invoiceId/waive")
  async waiveInvoice(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Param("invoiceId") invoiceId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = waiveInvoiceSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid invoice waiver payload.",
        issues: parsed.error.issues,
      });
    }
    return this.systemBillingService.waiveInvoice(
      admin.userId,
      invoiceId,
      parsed.data.reason,
      req.ip,
    );
  }

  @Post("invoices/:invoiceId/void")
  async voidInvoice(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Param("invoiceId") invoiceId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = voidInvoiceSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid invoice void payload.",
        issues: parsed.error.issues,
      });
    }
    return this.systemBillingService.voidInvoice(
      admin.userId,
      invoiceId,
      parsed.data.reason,
      req.ip,
    );
  }

  @Get("audit-logs")
  async listAuditLogs(@Query() query: unknown) {
    const parsed = auditQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid billing audit query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.systemBillingService.listAuditLogs(parsed.data);
  }

  @Get("admins")
  async listSystemAdmins() {
    return this.systemBillingService.listSystemAdmins();
  }

  @Post("admins/:userId/role")
  async setUserPlatformRole(
    @CurrentSystemAdmin() admin: AuthenticatedSystemAdmin,
    @Param("userId") userId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = setAdminRoleSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid platform role payload.",
        issues: parsed.error.issues,
      });
    }
    return this.systemBillingService.setUserPlatformRole(
      admin.userId,
      userId,
      parsed.data.platformRole,
      req.ip,
    );
  }
}

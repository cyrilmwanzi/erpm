import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  BillingInvoiceStatus,
  Prisma,
  SubscriptionBillingCycle,
  OrganizationContext,
} from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { provisionPlatformBillingDefaults } from "./billing-bootstrap.service.js";
import { BillingEnforcementService } from "./billing-enforcement.service.js";
import {
  addBillingCycleDuration,
  addDays,
  computeBillingInvoiceAmounts,
} from "./billing-security.utils.js";
import { PlatformMpesaService } from "./platform-mpesa.service.js";

export interface OrgCheckoutInput {
  planId: string;
  billingCycle: SubscriptionBillingCycle;
}

export interface OrgMpesaStkPushInput {
  invoiceId?: string;
  planId?: string;
  billingCycle?: SubscriptionBillingCycle;
  phoneNumber: string;
}

function generateOrgInvoiceNumber(): string {
  return `SINV-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
}

@Injectable()
export class OrgBillingService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(BillingEnforcementService)
    private readonly billingEnforcement: BillingEnforcementService,
    @Inject(PlatformMpesaService)
    private readonly platformMpesaService: PlatformMpesaService,
  ) {}

  async getSubscriptionOverview(tenant: AuthenticatedOrganization) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const entitlement =
      await this.billingEnforcement.evaluateOrganizationEntitlement(organizationId, {
        skipCache: true,
      });
    const usage =
      await this.billingEnforcement.getOrganizationUsage(organizationId);
    const { config } = await provisionPlatformBillingDefaults(
      this.prismaService.raw,
    );

    return {
      organizationId,
      entitlement,
      usage,
      billingSupportEmail: config.billingSupportEmail,
    };
  }

  async getBillingOptions(tenant: AuthenticatedOrganization) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const [{ config }, entitlement, plans, mpesaConfig] = await Promise.all([
      provisionPlatformBillingDefaults(this.prismaService.raw),
      this.billingEnforcement.evaluateOrganizationEntitlement(organizationId),
      this.prismaService.raw.billingPlan.findMany({
        where: { isActive: true, isPublic: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
      this.prismaService.raw.platformMpesaConfig.findUnique({
        where: { id: "default" },
        select: {
          isEnabled: true,
          environment: true,
          shortcodeType: true,
          businessShortCode: true,
          accountReferencePrefix: true,
        },
      }),
    ]);

    const availableBillingCycles: SubscriptionBillingCycle[] = [];
    if (config.allowMonthlyBilling) {
      availableBillingCycles.push(SubscriptionBillingCycle.MONTHLY);
    }
    if (config.allowAnnualBilling) {
      availableBillingCycles.push(SubscriptionBillingCycle.ANNUAL);
    }

    return {
      organizationId,
      currency: config.defaultCurrency,
      taxRateBps: config.taxRateBps,
      discountPercent: entitlement.discountPercent,
      availableBillingCycles,
      paymentMethods: {
        mpesa: {
          available: entitlement.mpesaPaymentAvailable,
          environment: mpesaConfig?.environment ?? null,
          shortcodeType: mpesaConfig?.shortcodeType ?? null,
          businessShortCode: entitlement.mpesaPaymentAvailable
            ? (mpesaConfig?.businessShortCode ?? null)
            : null,
          accountReferencePrefix: mpesaConfig?.accountReferencePrefix ?? null,
        },
      },
      plans: plans.map((plan) => ({
        ...plan,
        maxStorageBytes:
          plan.maxStorageBytes !== null && plan.maxStorageBytes !== undefined
            ? Number(plan.maxStorageBytes)
            : null,
      })),
    };
  }

  async listInvoices(tenant: AuthenticatedOrganization, limit = 25) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const invoices = await this.prismaService.raw.billingInvoice.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
      include: {
        plan: { select: { id: true, code: true, name: true } },
      },
    });
    return {
      organizationId,
      items: invoices,
    };
  }

  async listPayments(tenant: AuthenticatedOrganization, limit = 25) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const payments =
      await this.prismaService.raw.billingPaymentTransaction.findMany({
        where: { organizationId },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(limit, 1), 100),
        include: {
          invoice: {
            select: {
              id: true,
              invoiceNumber: true,
              status: true,
              totalCents: true,
            },
          },
        },
      });
    return {
      organizationId,
      items: payments.map((p) =>
        this.platformMpesaService.sanitizeTransaction(p),
      ),
    };
  }

  async createCheckoutInvoice(
    tenant: AuthenticatedOrganization,
    input: OrgCheckoutInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const [{ config }, entitlement] = await Promise.all([
      provisionPlatformBillingDefaults(this.prismaService.raw),
      this.billingEnforcement.evaluateOrganizationEntitlement(organizationId),
    ]);

    if (
      input.billingCycle === SubscriptionBillingCycle.MONTHLY &&
      !config.allowMonthlyBilling
    ) {
      throw new BadRequestException(
        "Monthly billing cycle is currently disabled by system administrators.",
      );
    }
    if (
      input.billingCycle === SubscriptionBillingCycle.ANNUAL &&
      !config.allowAnnualBilling
    ) {
      throw new BadRequestException(
        "Annual billing cycle is currently disabled by system administrators.",
      );
    }

    const plan = await this.prismaService.raw.billingPlan.findFirst({
      where: {
        id: input.planId,
        isActive: true,
      },
    });
    if (!plan) {
      throw new NotFoundException("Selected billing plan was not found or is inactive.");
    }
    if (!plan.isPublic && entitlement.planId !== plan.id) {
      throw new BadRequestException(
        "Selected billing plan is private and must be assigned by a system administrator.",
      );
    }

    const baseAmountCents =
      input.billingCycle === SubscriptionBillingCycle.ANNUAL
        ? plan.annualPriceCents
        : plan.monthlyPriceCents;
    const amounts = computeBillingInvoiceAmounts({
      baseAmountCents,
      discountPercent: entitlement.discountPercent,
      taxRateBps: config.taxRateBps,
    });

    const now = new Date();
    const periodEnd = addBillingCycleDuration(now, input.billingCycle);
    const dueAt = addDays(now, 3);

    const isZeroTotal = amounts.totalCents === 0;
    const invoice = await this.prismaService.raw.$transaction(async (tx) => {
      const created = await tx.billingInvoice.create({
        data: {
          invoiceNumber: generateOrgInvoiceNumber(),
          organizationId,
          planId: plan.id,
          billingCycle: input.billingCycle,
          currency: plan.currency,
          ...amounts,
          amountPaidCents: 0,
          status: isZeroTotal
            ? BillingInvoiceStatus.PAID
            : BillingInvoiceStatus.OPEN,
          periodStart: now,
          periodEnd,
          dueAt,
          paidAt: isZeroTotal ? now : null,
          createdByUserId: tenant.userId,
        },
        include: { plan: true },
      });

      if (isZeroTotal) {
        await this.platformMpesaService.activateSubscriptionFromInvoiceTx(
          tx,
          created,
          now,
        );
      }

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId: tenant.userId,
          organizationId,
          action: "billing.checkout.created",
          resourceType: "BillingInvoice",
          resourceId: created.id,
          metadata: {
            invoiceNumber: created.invoiceNumber,
            planCode: plan.code,
            billingCycle: input.billingCycle,
            totalCents: created.totalCents,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return created;
    });

    if (isZeroTotal) {
      await this.billingEnforcement.invalidateOrganizationCache(organizationId);
    }

    return {
      invoice: {
        ...invoice,
        plan: {
          ...invoice.plan,
          maxStorageBytes:
            invoice.plan.maxStorageBytes !== null &&
            invoice.plan.maxStorageBytes !== undefined
              ? Number(invoice.plan.maxStorageBytes)
              : null,
        },
      },
      requiresPayment: !isZeroTotal,
      mpesaAvailable: entitlement.mpesaPaymentAvailable,
    };
  }

  async initiateMpesaPayment(
    tenant: AuthenticatedOrganization,
    input: OrgMpesaStkPushInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const entitlement =
      await this.billingEnforcement.evaluateOrganizationEntitlement(organizationId);

    if (!entitlement.mpesaPaymentAvailable) {
      throw new BadRequestException(
        "M-Pesa subscription payments are currently unavailable for this organization.",
      );
    }

    let invoiceId = input.invoiceId;
    if (!invoiceId) {
      const targetPlanId = input.planId ?? entitlement.planId;
      const targetCycle =
        input.billingCycle ??
        (entitlement.billingCycle === "ANNUAL"
          ? SubscriptionBillingCycle.ANNUAL
          : SubscriptionBillingCycle.MONTHLY);

      const checkout = await this.createCheckoutInvoice(
        tenant,
        {
          planId: targetPlanId,
          billingCycle: targetCycle,
        },
        ipAddress,
      );
      if (!checkout.requiresPayment) {
        return {
          settledWithoutPayment: true,
          invoice: checkout.invoice,
          transaction: null,
          daraja: null,
        };
      }
      invoiceId = checkout.invoice.id;
    }

    const result = await this.platformMpesaService.initiateStkPushForInvoice({
      organizationId,
      invoiceId,
      phoneNumber: input.phoneNumber,
      actorUserId: tenant.userId,
      ipAddress,
    });

    return {
      settledWithoutPayment: false,
      ...result,
    };
  }

  async queryMpesaPaymentStatus(
    tenant: AuthenticatedOrganization,
    transactionId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    return this.platformMpesaService.queryStkStatusAndReconcile({
      organizationId,
      transactionId,
      actorUserId: tenant.userId,
      ipAddress,
    });
  }

  async simulateMpesaCallback(
    tenant: AuthenticatedOrganization,
    input: {
      transactionId: string;
      outcome?: "SUCCESS" | "CANCELLED" | "FAILED" | "TIMEOUT";
      mpesaReceiptNumber?: string;
      resultDesc?: string;
    },
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    return this.platformMpesaService.simulateStkCallback({
      organizationId,
      transactionId: input.transactionId,
      outcome: input.outcome ?? "SUCCESS",
      mpesaReceiptNumber: input.mpesaReceiptNumber,
      resultDesc: input.resultDesc,
      actorUserId: tenant.userId,
      ipAddress,
    });
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedOrganization): string {
    const contextOrgId = OrganizationContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active organization context mismatch.");
    }
    return tenant.organizationId;
  }
}

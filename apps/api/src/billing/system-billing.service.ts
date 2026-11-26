import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  BillingInvoiceStatus,
  BillingPaymentMethod,
  BillingPaymentStatus,
  BillingSubscriptionStatus,
  PlatformRole,
  Prisma,
  SubscriptionBillingCycle,
} from "@scace/db";
import { getEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import {
  DEFAULT_PLAN_FEATURES,
  provisionInitialTrialForOrganization,
  provisionPlatformBillingDefaults,
} from "./billing-bootstrap.service.js";
import { BillingEnforcementService } from "./billing-enforcement.service.js";
import {
  addBillingCycleDuration,
  addDays,
  computeBillingInvoiceAmounts,
} from "./billing-security.utils.js";
import { PlatformMpesaService } from "./platform-mpesa.service.js";

export interface UpdatePlatformBillingConfigInput {
  autoTrialEnabled?: boolean;
  defaultTrialDays?: number;
  defaultGracePeriodDays?: number;
  defaultCurrency?: string;
  taxRateBps?: number;
  mpesaEnabled?: boolean;
  allowMonthlyBilling?: boolean;
  allowAnnualBilling?: boolean;
  lockoutAfterGrace?: boolean;
  enforceQuotas?: boolean;
  enforceFeatureFlags?: boolean;
  billingSupportEmail?: string | null;
}

export interface CreateBillingPlanInput {
  code: string;
  name: string;
  description?: string | null;
  isActive?: boolean;
  isPublic?: boolean;
  isDefaultTrial?: boolean;
  sortOrder?: number;
  currency?: string;
  monthlyPriceCents: number;
  annualPriceCents: number;
  trialDays?: number;
  gracePeriodDays?: number;
  maxMembers?: number | null;
  maxLocations?: number | null;
  maxItems?: number | null;
  maxMonthlyOrders?: number | null;
  maxStorageBytes?: number | null;
  features?: Record<string, boolean>;
}

export interface UpdateBillingPlanInput {
  name?: string;
  description?: string | null;
  isActive?: boolean;
  isPublic?: boolean;
  isDefaultTrial?: boolean;
  sortOrder?: number;
  currency?: string;
  monthlyPriceCents?: number;
  annualPriceCents?: number;
  trialDays?: number;
  gracePeriodDays?: number;
  maxMembers?: number | null;
  maxLocations?: number | null;
  maxItems?: number | null;
  maxMonthlyOrders?: number | null;
  maxStorageBytes?: number | null;
  features?: Record<string, boolean>;
}

export interface UpdateOrganizationSubscriptionAdminInput {
  planId?: string;
  billingCycle?: SubscriptionBillingCycle;
  status?: BillingSubscriptionStatus;
  trialEndsAt?: string | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  gracePeriodEndsAt?: string | null;
  cancelAtPeriodEnd?: boolean;
  suspensionReason?: string | null;
}

export interface UpsertOrganizationOverrideInput {
  isActive?: boolean;
  exemptFromBilling?: boolean;
  exemptUntil?: string | null;
  forceStatus?: BillingSubscriptionStatus | null;
  forcePlanId?: string | null;
  customTrialEndsAt?: string | null;
  customGracePeriodEndsAt?: string | null;
  customMaxMembers?: number | null;
  customMaxLocations?: number | null;
  customMaxItems?: number | null;
  customMaxMonthlyOrders?: number | null;
  customMaxStorageBytes?: number | null;
  discountPercent?: number | null;
  allowMpesaOverride?: boolean | null;
  featureOverrides?: Record<string, boolean> | null;
  reason?: string | null;
  notes?: string | null;
}

export interface ListOrganizationsBillingQuery {
  search?: string;
  status?: BillingSubscriptionStatus;
  hasOverride?: boolean;
  limit: number;
  cursor?: string;
}

export interface AdminCreateBillingInvoiceInput {
  planId?: string;
  billingCycle?: SubscriptionBillingCycle;
  dueInDays?: number;
  notes?: string | null;
  markPaidImmediately?: boolean;
  externalReference?: string | null;
}

function serializePlan<
  T extends {
    maxStorageBytes?: bigint | number | null;
  },
>(plan: T) {
  return {
    ...plan,
    maxStorageBytes:
      plan.maxStorageBytes !== null && plan.maxStorageBytes !== undefined
        ? Number(plan.maxStorageBytes)
        : null,
  };
}

function serializeOverride<
  T extends {
    customMaxStorageBytes?: bigint | number | null;
  },
>(override: T) {
  return {
    ...override,
    customMaxStorageBytes:
      override.customMaxStorageBytes !== null &&
      override.customMaxStorageBytes !== undefined
        ? Number(override.customMaxStorageBytes)
        : null,
  };
}

function generateInvoiceNumber(): string {
  return `SINV-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
}

@Injectable()
export class SystemBillingService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(PlatformMpesaService)
    private readonly platformMpesaService: PlatformMpesaService,
    @Inject(BillingEnforcementService)
    private readonly billingEnforcement: BillingEnforcementService,
  ) {}

  async getPlatformBillingOverview() {
    const { config } = await provisionPlatformBillingDefaults(
      this.prismaService.raw,
    );
    const mpesaConfig = await this.platformMpesaService.getConfig();
    return {
      billingConfig: config,
      mpesaConfig,
    };
  }

  async updatePlatformBillingConfig(
    actorUserId: string,
    input: UpdatePlatformBillingConfigInput,
    ipAddress?: string,
  ) {
    await provisionPlatformBillingDefaults(this.prismaService.raw);

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const saved = await tx.platformBillingConfig.update({
        where: { id: "default" },
        data: {
          ...(input.autoTrialEnabled !== undefined
            ? { autoTrialEnabled: input.autoTrialEnabled }
            : {}),
          ...(input.defaultTrialDays !== undefined
            ? { defaultTrialDays: input.defaultTrialDays }
            : {}),
          ...(input.defaultGracePeriodDays !== undefined
            ? { defaultGracePeriodDays: input.defaultGracePeriodDays }
            : {}),
          ...(input.defaultCurrency !== undefined
            ? { defaultCurrency: input.defaultCurrency }
            : {}),
          ...(input.taxRateBps !== undefined
            ? { taxRateBps: input.taxRateBps }
            : {}),
          ...(input.mpesaEnabled !== undefined
            ? { mpesaEnabled: input.mpesaEnabled }
            : {}),
          ...(input.allowMonthlyBilling !== undefined
            ? { allowMonthlyBilling: input.allowMonthlyBilling }
            : {}),
          ...(input.allowAnnualBilling !== undefined
            ? { allowAnnualBilling: input.allowAnnualBilling }
            : {}),
          ...(input.lockoutAfterGrace !== undefined
            ? { lockoutAfterGrace: input.lockoutAfterGrace }
            : {}),
          ...(input.enforceQuotas !== undefined
            ? { enforceQuotas: input.enforceQuotas }
            : {}),
          ...(input.enforceFeatureFlags !== undefined
            ? { enforceFeatureFlags: input.enforceFeatureFlags }
            : {}),
          ...(input.billingSupportEmail !== undefined
            ? { billingSupportEmail: input.billingSupportEmail }
            : {}),
          updatedByUserId: actorUserId,
        },
      });

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId,
          action: "platform.billing_config.updated",
          resourceType: "PlatformBillingConfig",
          resourceId: saved.id,
          metadata: input as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });

    await this.billingEnforcement.invalidateAllOrganizationCaches();
    return updated;
  }

  async listPlans() {
    await provisionPlatformBillingDefaults(this.prismaService.raw);
    const plans = await this.prismaService.raw.billingPlan.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return {
      items: plans.map(serializePlan),
    };
  }

  async createPlan(
    actorUserId: string,
    input: CreateBillingPlanInput,
    ipAddress?: string,
  ) {
    await provisionPlatformBillingDefaults(this.prismaService.raw);
    const code = input.code.trim().toUpperCase();

    const existing = await this.prismaService.raw.billingPlan.findUnique({
      where: { code },
    });
    if (existing) {
      throw new ConflictException(`Billing plan with code "${code}" already exists.`);
    }

    const created = await this.prismaService.raw.$transaction(async (tx) => {
      if (input.isDefaultTrial) {
        await tx.billingPlan.updateMany({
          where: { isDefaultTrial: true },
          data: { isDefaultTrial: false },
        });
      }

      const plan = await tx.billingPlan.create({
        data: {
          code,
          name: input.name.trim(),
          description: input.description?.trim() ?? null,
          isActive: input.isActive ?? true,
          isPublic: input.isPublic ?? true,
          isDefaultTrial: input.isDefaultTrial ?? false,
          sortOrder: input.sortOrder ?? 10,
          currency: (input.currency ?? "KES").toUpperCase(),
          monthlyPriceCents: input.monthlyPriceCents,
          annualPriceCents: input.annualPriceCents,
          trialDays: input.trialDays ?? 14,
          gracePeriodDays: input.gracePeriodDays ?? 7,
          maxMembers: input.maxMembers ?? null,
          maxLocations: input.maxLocations ?? null,
          maxItems: input.maxItems ?? null,
          maxMonthlyOrders: input.maxMonthlyOrders ?? null,
          maxStorageBytes:
            input.maxStorageBytes !== undefined && input.maxStorageBytes !== null
              ? BigInt(input.maxStorageBytes)
              : null,
          features: {
            ...DEFAULT_PLAN_FEATURES,
            ...(input.features ?? {}),
          } as Prisma.InputJsonValue,
          createdByUserId: actorUserId,
          updatedByUserId: actorUserId,
        },
      });

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId,
          action: "platform.plan.created",
          resourceType: "BillingPlan",
          resourceId: plan.id,
          metadata: {
            code: plan.code,
            name: plan.name,
            isDefaultTrial: plan.isDefaultTrial,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return plan;
    });

    await this.billingEnforcement.invalidateAllOrganizationCaches();
    return serializePlan(created);
  }

  async updatePlan(
    actorUserId: string,
    planId: string,
    input: UpdateBillingPlanInput,
    ipAddress?: string,
  ) {
    const existing = await this.prismaService.raw.billingPlan.findUnique({
      where: { id: planId },
    });
    if (!existing) {
      throw new NotFoundException("Billing plan was not found.");
    }

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      if (input.isDefaultTrial === true) {
        await tx.billingPlan.updateMany({
          where: { id: { not: planId }, isDefaultTrial: true },
          data: { isDefaultTrial: false },
        });
      }

      const plan = await tx.billingPlan.update({
        where: { id: planId },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined
            ? { description: input.description?.trim() ?? null }
            : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.isPublic !== undefined ? { isPublic: input.isPublic } : {}),
          ...(input.isDefaultTrial !== undefined
            ? { isDefaultTrial: input.isDefaultTrial }
            : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          ...(input.currency !== undefined
            ? { currency: input.currency.toUpperCase() }
            : {}),
          ...(input.monthlyPriceCents !== undefined
            ? { monthlyPriceCents: input.monthlyPriceCents }
            : {}),
          ...(input.annualPriceCents !== undefined
            ? { annualPriceCents: input.annualPriceCents }
            : {}),
          ...(input.trialDays !== undefined ? { trialDays: input.trialDays } : {}),
          ...(input.gracePeriodDays !== undefined
            ? { gracePeriodDays: input.gracePeriodDays }
            : {}),
          ...(input.maxMembers !== undefined
            ? { maxMembers: input.maxMembers }
            : {}),
          ...(input.maxLocations !== undefined
            ? { maxLocations: input.maxLocations }
            : {}),
          ...(input.maxItems !== undefined ? { maxItems: input.maxItems } : {}),
          ...(input.maxMonthlyOrders !== undefined
            ? { maxMonthlyOrders: input.maxMonthlyOrders }
            : {}),
          ...(input.maxStorageBytes !== undefined
            ? {
                maxStorageBytes:
                  input.maxStorageBytes !== null
                    ? BigInt(input.maxStorageBytes)
                    : null,
              }
            : {}),
          ...(input.features !== undefined
            ? { features: input.features as Prisma.InputJsonValue }
            : {}),
          updatedByUserId: actorUserId,
        },
      });

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId,
          action: "platform.plan.updated",
          resourceType: "BillingPlan",
          resourceId: plan.id,
          metadata: {
            code: plan.code,
            changes: input,
          } as unknown as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return plan;
    });

    await this.billingEnforcement.invalidateAllOrganizationCaches();
    return serializePlan(updated);
  }

  async listOrganizations(query: ListOrganizationsBillingQuery) {
    const take = Math.min(Math.max(query.limit, 1), 100);
    const orgs = await this.prismaService.raw.organization.findMany({
      where: {
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: "insensitive" } },
                { slug: { contains: query.search, mode: "insensitive" } },
              ],
            }
          : {}),
        ...(query.status
          ? { subscription: { status: query.status } }
          : {}),
        ...(query.hasOverride === true
          ? { billingOverride: { is: { isActive: true } } }
          : query.hasOverride === false
            ? {
                OR: [
                  { billingOverride: { is: null } },
                  { billingOverride: { is: { isActive: false } } },
                ],
              }
            : {}),
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        subscription: {
          include: {
            plan: {
              select: { id: true, code: true, name: true },
            },
          },
        },
        billingOverride: true,
        _count: {
          select: {
            members: true,
            locations: true,
            items: true,
          },
        },
      },
    });

    const hasMore = orgs.length > take;
    const sliced = hasMore ? orgs.slice(0, take) : orgs;
    const nextCursor = hasMore ? (sliced[sliced.length - 1]?.id ?? null) : null;

    const items = await Promise.all(
      sliced.map(async (org) => {
        const entitlement =
          await this.billingEnforcement.evaluateOrganizationEntitlement(org.id, {
            persistTransition: false,
          });
        return {
          organization: {
            id: org.id,
            name: org.name,
            slug: org.slug,
            createdAt: org.createdAt,
            counts: org._count,
          },
          entitlement,
          override: org.billingOverride
            ? serializeOverride(org.billingOverride)
            : null,
        };
      }),
    );

    return { items, nextCursor };
  }

  async getOrganizationBillingDetail(organizationId: string) {
    const org = await this.prismaService.raw.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
      },
    });
    if (!org) {
      throw new NotFoundException("Organization was not found.");
    }

    const entitlement =
      await this.billingEnforcement.evaluateOrganizationEntitlement(organizationId, {
        skipCache: true,
      });

    const [subscription, override, usage, invoices, payments, auditLogs] =
      await Promise.all([
        this.prismaService.raw.organizationSubscription.findUnique({
          where: { organizationId },
          include: { plan: true },
        }),
        this.prismaService.raw.organizationBillingOverride.findUnique({
          where: { organizationId },
        }),
        this.billingEnforcement.getOrganizationUsage(organizationId),
        this.prismaService.raw.billingInvoice.findMany({
          where: { organizationId },
          orderBy: { createdAt: "desc" },
          take: 25,
          include: { plan: { select: { id: true, code: true, name: true } } },
        }),
        this.prismaService.raw.billingPaymentTransaction.findMany({
          where: { organizationId },
          orderBy: { createdAt: "desc" },
          take: 25,
        }),
        this.prismaService.raw.platformBillingAuditLog.findMany({
          where: { organizationId },
          orderBy: { createdAt: "desc" },
          take: 30,
        }),
      ]);

    return {
      organization: org,
      subscription: subscription
        ? {
            ...subscription,
            plan: serializePlan(subscription.plan),
          }
        : null,
      override: override ? serializeOverride(override) : null,
      entitlement,
      usage,
      invoices,
      payments: payments.map((p) =>
        this.platformMpesaService.sanitizeTransaction(p),
      ),
      auditLogs,
    };
  }

  async updateOrganizationSubscription(
    actorUserId: string,
    organizationId: string,
    input: UpdateOrganizationSubscriptionAdminInput,
    ipAddress?: string,
  ) {
    await this.assertOrganizationExists(organizationId);
    const existing = await provisionInitialTrialForOrganization(
      organizationId,
      actorUserId,
      this.prismaService.raw,
    );

    if (input.planId) {
      const plan = await this.prismaService.raw.billingPlan.findUnique({
        where: { id: input.planId },
      });
      if (!plan) {
        throw new NotFoundException("Target billing plan was not found.");
      }
    }

    const now = new Date();
    const parseOptDate = (val: string | null | undefined) => {
      if (val === undefined) return undefined;
      if (val === null) return null;
      const d = new Date(val);
      if (Number.isNaN(d.getTime())) {
        throw new BadRequestException(`Invalid ISO date value "${val}".`);
      }
      return d;
    };

    const nextStatus = input.status ?? existing.status;
    const isSuspended = nextStatus === BillingSubscriptionStatus.SUSPENDED;
    const isLockedStatus =
      nextStatus === BillingSubscriptionStatus.EXPIRED ||
      nextStatus === BillingSubscriptionStatus.SUSPENDED ||
      nextStatus === BillingSubscriptionStatus.CANCELED;

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const saved = await tx.organizationSubscription.update({
        where: { organizationId },
        data: {
          ...(input.planId !== undefined ? { planId: input.planId } : {}),
          ...(input.billingCycle !== undefined
            ? { billingCycle: input.billingCycle }
            : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(parseOptDate(input.trialEndsAt) !== undefined
            ? { trialEndsAt: parseOptDate(input.trialEndsAt) }
            : {}),
          ...(parseOptDate(input.currentPeriodStart) !== undefined
            ? { currentPeriodStart: parseOptDate(input.currentPeriodStart) }
            : {}),
          ...(parseOptDate(input.currentPeriodEnd) !== undefined
            ? { currentPeriodEnd: parseOptDate(input.currentPeriodEnd) }
            : {}),
          ...(parseOptDate(input.gracePeriodEndsAt) !== undefined
            ? { gracePeriodEndsAt: parseOptDate(input.gracePeriodEndsAt) }
            : {}),
          ...(input.cancelAtPeriodEnd !== undefined
            ? {
                cancelAtPeriodEnd: input.cancelAtPeriodEnd,
                canceledAt: input.cancelAtPeriodEnd ? now : null,
              }
            : {}),
          ...(isSuspended
            ? {
                suspendedAt: now,
                suspensionReason:
                  input.suspensionReason ??
                  existing.suspensionReason ??
                  "Suspended by system administrator.",
              }
            : input.status !== undefined
              ? {
                  suspendedAt: null,
                  ...(input.suspensionReason !== undefined
                    ? { suspensionReason: input.suspensionReason }
                    : { suspensionReason: null }),
                }
              : input.suspensionReason !== undefined
                ? { suspensionReason: input.suspensionReason }
                : {}),
          lockedAt: isLockedStatus ? now : null,
          lastEnforcedStatus: nextStatus,
          lastStatusEvaluatedAt: now,
        },
        include: { plan: true },
      });

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId,
          organizationId,
          action: "admin.subscription.updated",
          resourceType: "OrganizationSubscription",
          resourceId: saved.id,
          metadata: input as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });

    await this.billingEnforcement.invalidateOrganizationCache(organizationId);
    return {
      subscription: {
        ...updated,
        plan: serializePlan(updated.plan),
      },
      entitlement: await this.billingEnforcement.evaluateOrganizationEntitlement(
        organizationId,
        { skipCache: true },
      ),
    };
  }

  async upsertOrganizationOverride(
    actorUserId: string,
    organizationId: string,
    input: UpsertOrganizationOverrideInput,
    ipAddress?: string,
  ) {
    await this.assertOrganizationExists(organizationId);
    await provisionInitialTrialForOrganization(
      organizationId,
      actorUserId,
      this.prismaService.raw,
    );

    if (input.forcePlanId) {
      const plan = await this.prismaService.raw.billingPlan.findUnique({
        where: { id: input.forcePlanId },
      });
      if (!plan) {
        throw new NotFoundException("Forced billing plan was not found.");
      }
    }

    const parseOptDate = (val: string | null | undefined) => {
      if (val === undefined) return undefined;
      if (val === null) return null;
      const d = new Date(val);
      if (Number.isNaN(d.getTime())) {
        throw new BadRequestException(`Invalid ISO date value "${val}".`);
      }
      return d;
    };

    const existing =
      await this.prismaService.raw.organizationBillingOverride.findUnique({
        where: { organizationId },
      });

    const saved = await this.prismaService.raw.$transaction(async (tx) => {
      const record = existing
        ? await tx.organizationBillingOverride.update({
            where: { organizationId },
            data: {
              ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
              ...(input.exemptFromBilling !== undefined
                ? { exemptFromBilling: input.exemptFromBilling }
                : {}),
              ...(parseOptDate(input.exemptUntil) !== undefined
                ? { exemptUntil: parseOptDate(input.exemptUntil) }
                : {}),
              ...(input.forceStatus !== undefined
                ? { forceStatus: input.forceStatus }
                : {}),
              ...(input.forcePlanId !== undefined
                ? { forcePlanId: input.forcePlanId }
                : {}),
              ...(parseOptDate(input.customTrialEndsAt) !== undefined
                ? { customTrialEndsAt: parseOptDate(input.customTrialEndsAt) }
                : {}),
              ...(parseOptDate(input.customGracePeriodEndsAt) !== undefined
                ? {
                    customGracePeriodEndsAt: parseOptDate(
                      input.customGracePeriodEndsAt,
                    ),
                  }
                : {}),
              ...(input.customMaxMembers !== undefined
                ? { customMaxMembers: input.customMaxMembers }
                : {}),
              ...(input.customMaxLocations !== undefined
                ? { customMaxLocations: input.customMaxLocations }
                : {}),
              ...(input.customMaxItems !== undefined
                ? { customMaxItems: input.customMaxItems }
                : {}),
              ...(input.customMaxMonthlyOrders !== undefined
                ? { customMaxMonthlyOrders: input.customMaxMonthlyOrders }
                : {}),
              ...(input.customMaxStorageBytes !== undefined
                ? {
                    customMaxStorageBytes:
                      input.customMaxStorageBytes !== null
                        ? BigInt(input.customMaxStorageBytes)
                        : null,
                  }
                : {}),
              ...(input.discountPercent !== undefined
                ? { discountPercent: input.discountPercent }
                : {}),
              ...(input.allowMpesaOverride !== undefined
                ? { allowMpesaOverride: input.allowMpesaOverride }
                : {}),
              ...(input.featureOverrides !== undefined
                ? {
                    featureOverrides:
                      input.featureOverrides === null
                        ? Prisma.JsonNull
                        : (input.featureOverrides as Prisma.InputJsonValue),
                  }
                : {}),
              ...(input.reason !== undefined ? { reason: input.reason } : {}),
              ...(input.notes !== undefined ? { notes: input.notes } : {}),
              updatedByUserId: actorUserId,
            },
          })
        : await tx.organizationBillingOverride.create({
            data: {
              organizationId,
              isActive: input.isActive ?? true,
              exemptFromBilling: input.exemptFromBilling ?? false,
              exemptUntil: parseOptDate(input.exemptUntil) ?? null,
              forceStatus: input.forceStatus ?? null,
              forcePlanId: input.forcePlanId ?? null,
              customTrialEndsAt: parseOptDate(input.customTrialEndsAt) ?? null,
              customGracePeriodEndsAt:
                parseOptDate(input.customGracePeriodEndsAt) ?? null,
              customMaxMembers: input.customMaxMembers ?? null,
              customMaxLocations: input.customMaxLocations ?? null,
              customMaxItems: input.customMaxItems ?? null,
              customMaxMonthlyOrders: input.customMaxMonthlyOrders ?? null,
              customMaxStorageBytes:
                input.customMaxStorageBytes !== undefined &&
                input.customMaxStorageBytes !== null
                  ? BigInt(input.customMaxStorageBytes)
                  : null,
              discountPercent: input.discountPercent ?? null,
              allowMpesaOverride: input.allowMpesaOverride ?? null,
              featureOverrides: input.featureOverrides
                ? (input.featureOverrides as Prisma.InputJsonValue)
                : Prisma.JsonNull,
              reason: input.reason ?? null,
              notes: input.notes ?? null,
              createdByUserId: actorUserId,
              updatedByUserId: actorUserId,
            },
          });

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId,
          organizationId,
          action: "admin.override.upserted",
          resourceType: "OrganizationBillingOverride",
          resourceId: record.id,
          metadata: input as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return record;
    });

    await this.billingEnforcement.invalidateOrganizationCache(organizationId);
    return {
      override: serializeOverride(saved),
      entitlement: await this.billingEnforcement.evaluateOrganizationEntitlement(
        organizationId,
        { skipCache: true },
      ),
    };
  }

  async clearOrganizationOverride(
    actorUserId: string,
    organizationId: string,
    ipAddress?: string,
  ) {
    await this.assertOrganizationExists(organizationId);
    const existing =
      await this.prismaService.raw.organizationBillingOverride.findUnique({
        where: { organizationId },
      });

    if (existing) {
      await this.prismaService.raw.$transaction(async (tx) => {
        await tx.organizationBillingOverride.delete({
          where: { organizationId },
        });
        await tx.platformBillingAuditLog.create({
          data: {
            actorUserId,
            organizationId,
            action: "admin.override.cleared",
            resourceType: "OrganizationBillingOverride",
            resourceId: existing.id,
            ipAddress: ipAddress ?? null,
          },
        });
      });
    }

    await this.billingEnforcement.invalidateOrganizationCache(organizationId);
    return {
      cleared: Boolean(existing),
      entitlement: await this.billingEnforcement.evaluateOrganizationEntitlement(
        organizationId,
        { skipCache: true },
      ),
    };
  }

  async extendOrganizationTrial(
    actorUserId: string,
    organizationId: string,
    input: { additionalDays?: number; trialEndsAt?: string; reason?: string },
    ipAddress?: string,
  ) {
    await this.assertOrganizationExists(organizationId);
    const sub = await provisionInitialTrialForOrganization(
      organizationId,
      actorUserId,
      this.prismaService.raw,
    );
    const { config } = await provisionPlatformBillingDefaults(
      this.prismaService.raw,
    );
    const now = new Date();

    let nextTrialEndsAt: Date;
    if (input.trialEndsAt) {
      const parsed = new Date(input.trialEndsAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException("Invalid trialEndsAt timestamp.");
      }
      nextTrialEndsAt = parsed;
    } else {
      const days = input.additionalDays ?? 14;
      const base =
        sub.trialEndsAt && sub.trialEndsAt > now ? sub.trialEndsAt : now;
      nextTrialEndsAt = addDays(base, days);
    }

    const graceDays = sub.plan?.gracePeriodDays ?? config.defaultGracePeriodDays;
    const nextGraceEndsAt = addDays(nextTrialEndsAt, graceDays);

    await this.prismaService.raw.$transaction(async (tx) => {
      await tx.organizationSubscription.update({
        where: { organizationId },
        data: {
          status: BillingSubscriptionStatus.TRIALING,
          trialStartsAt: sub.trialStartsAt ?? now,
          trialEndsAt: nextTrialEndsAt,
          gracePeriodEndsAt: nextGraceEndsAt,
          lockedAt: null,
          suspendedAt: null,
          suspensionReason: null,
          lastEnforcedStatus: BillingSubscriptionStatus.TRIALING,
          lastStatusEvaluatedAt: now,
        },
      });

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId,
          organizationId,
          action: "admin.trial.extended",
          resourceType: "OrganizationSubscription",
          resourceId: sub.id,
          metadata: {
            nextTrialEndsAt: nextTrialEndsAt.toISOString(),
            nextGraceEndsAt: nextGraceEndsAt.toISOString(),
            reason: input.reason ?? null,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });
    });

    await this.billingEnforcement.invalidateOrganizationCache(organizationId);
    return this.billingEnforcement.evaluateOrganizationEntitlement(
      organizationId,
      { skipCache: true },
    );
  }

  async suspendOrganization(
    actorUserId: string,
    organizationId: string,
    reason: string,
    ipAddress?: string,
  ) {
    return this.updateOrganizationSubscription(
      actorUserId,
      organizationId,
      {
        status: BillingSubscriptionStatus.SUSPENDED,
        suspensionReason: reason,
      },
      ipAddress,
    );
  }

  async reactivateOrganization(
    actorUserId: string,
    organizationId: string,
    input: { durationDays?: number; planId?: string; reason?: string },
    ipAddress?: string,
  ) {
    await this.assertOrganizationExists(organizationId);
    const sub = await provisionInitialTrialForOrganization(
      organizationId,
      actorUserId,
      this.prismaService.raw,
    );
    const { config } = await provisionPlatformBillingDefaults(
      this.prismaService.raw,
    );

    const now = new Date();
    const durationDays = input.durationDays ?? 30;
    const nextPeriodEnd = addDays(now, durationDays);
    const nextGraceEnd = addDays(
      nextPeriodEnd,
      sub.plan?.gracePeriodDays ?? config.defaultGracePeriodDays,
    );

    await this.prismaService.raw.$transaction(async (tx) => {
      if (input.planId) {
        const plan = await tx.billingPlan.findUnique({
          where: { id: input.planId },
        });
        if (!plan) {
          throw new NotFoundException("Target plan was not found.");
        }
      }

      await tx.organizationSubscription.update({
        where: { organizationId },
        data: {
          ...(input.planId ? { planId: input.planId } : {}),
          status: BillingSubscriptionStatus.ACTIVE,
          currentPeriodStart: now,
          currentPeriodEnd: nextPeriodEnd,
          gracePeriodEndsAt: nextGraceEnd,
          suspendedAt: null,
          suspensionReason: null,
          lockedAt: null,
          canceledAt: null,
          cancelAtPeriodEnd: false,
          lastEnforcedStatus: BillingSubscriptionStatus.ACTIVE,
          lastStatusEvaluatedAt: now,
        },
      });

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId,
          organizationId,
          action: "admin.organization.reactivated",
          resourceType: "OrganizationSubscription",
          resourceId: sub.id,
          metadata: {
            durationDays,
            planId: input.planId ?? sub.planId,
            reason: input.reason ?? null,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });
    });

    await this.billingEnforcement.invalidateOrganizationCache(organizationId);
    return this.billingEnforcement.evaluateOrganizationEntitlement(
      organizationId,
      { skipCache: true },
    );
  }

  async createAdminInvoice(
    actorUserId: string,
    organizationId: string,
    input: AdminCreateBillingInvoiceInput,
    ipAddress?: string,
  ) {
    await this.assertOrganizationExists(organizationId);
    const sub = await provisionInitialTrialForOrganization(
      organizationId,
      actorUserId,
      this.prismaService.raw,
    );
    const { config } = await provisionPlatformBillingDefaults(
      this.prismaService.raw,
    );
    const override =
      await this.prismaService.raw.organizationBillingOverride.findUnique({
        where: { organizationId },
      });

    const planId = input.planId ?? sub.planId;
    const plan = await this.prismaService.raw.billingPlan.findUnique({
      where: { id: planId },
    });
    if (!plan) {
      throw new NotFoundException("Billing plan was not found.");
    }

    const billingCycle = input.billingCycle ?? sub.billingCycle;
    const baseAmountCents =
      billingCycle === SubscriptionBillingCycle.ANNUAL
        ? plan.annualPriceCents
        : plan.monthlyPriceCents;
    const amounts = computeBillingInvoiceAmounts({
      baseAmountCents,
      discountPercent: override?.isActive ? override.discountPercent : 0,
      taxRateBps: config.taxRateBps,
    });

    const now = new Date();
    const periodEnd = addBillingCycleDuration(now, billingCycle);
    const dueAt = addDays(now, input.dueInDays ?? 7);

    const created = await this.prismaService.raw.$transaction(async (tx) => {
      const invoice = await tx.billingInvoice.create({
        data: {
          invoiceNumber: generateInvoiceNumber(),
          organizationId,
          planId: plan.id,
          billingCycle,
          currency: plan.currency,
          ...amounts,
          amountPaidCents: input.markPaidImmediately ? amounts.totalCents : 0,
          status: input.markPaidImmediately
            ? BillingInvoiceStatus.PAID
            : BillingInvoiceStatus.OPEN,
          periodStart: now,
          periodEnd,
          dueAt,
          paidAt: input.markPaidImmediately ? now : null,
          notes: input.notes ?? null,
          createdByUserId: actorUserId,
        },
        include: { plan: true },
      });

      if (input.markPaidImmediately) {
        await tx.billingPaymentTransaction.create({
          data: {
            referenceNumber: `ADMIN-${Date.now().toString(36).toUpperCase()}`,
            organizationId,
            invoiceId: invoice.id,
            method: BillingPaymentMethod.ADMIN_MANUAL,
            status: BillingPaymentStatus.SUCCEEDED,
            currency: invoice.currency,
            amountCents: invoice.totalCents,
            accountReference: input.externalReference ?? invoice.invoiceNumber,
            initiatedByUserId: actorUserId,
            processedAt: now,
            notes: input.notes ?? "Settled directly by system administrator.",
          },
        });
        await this.platformMpesaService.activateSubscriptionFromInvoiceTx(
          tx,
          invoice,
          now,
        );
      }

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId,
          organizationId,
          action: "admin.invoice.created",
          resourceType: "BillingInvoice",
          resourceId: invoice.id,
          metadata: {
            invoiceNumber: invoice.invoiceNumber,
            totalCents: invoice.totalCents,
            markPaidImmediately: Boolean(input.markPaidImmediately),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return invoice;
    });

    await this.billingEnforcement.invalidateOrganizationCache(organizationId);
    return created;
  }

  async markInvoicePaid(
    actorUserId: string,
    invoiceId: string,
    input: { externalReference?: string; notes?: string },
    ipAddress?: string,
  ) {
    const invoice = await this.prismaService.raw.billingInvoice.findUnique({
      where: { id: invoiceId },
      include: { plan: true },
    });
    if (!invoice) {
      throw new NotFoundException("Billing invoice was not found.");
    }
    if (
      invoice.status === BillingInvoiceStatus.PAID ||
      invoice.status === BillingInvoiceStatus.WAIVED ||
      invoice.status === BillingInvoiceStatus.VOID
    ) {
      throw new BadRequestException(
        `Invoice "${invoice.invoiceNumber}" cannot be settled in status ${invoice.status}.`,
      );
    }

    const remainingCents = Math.max(0, invoice.totalCents - invoice.amountPaidCents);
    const now = new Date();

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const paidInvoice = await tx.billingInvoice.update({
        where: { id: invoice.id },
        data: {
          amountPaidCents: invoice.totalCents,
          status: BillingInvoiceStatus.PAID,
          paidAt: now,
          notes: input.notes ?? invoice.notes,
        },
        include: { plan: true },
      });

      await tx.billingPaymentTransaction.create({
        data: {
          referenceNumber: `ADMIN-${Date.now().toString(36).toUpperCase()}`,
          organizationId: invoice.organizationId,
          invoiceId: invoice.id,
          method: BillingPaymentMethod.ADMIN_MANUAL,
          status: BillingPaymentStatus.SUCCEEDED,
          currency: invoice.currency,
          amountCents: remainingCents,
          accountReference: input.externalReference ?? invoice.invoiceNumber,
          initiatedByUserId: actorUserId,
          processedAt: now,
          notes: input.notes ?? "Manual payment recorded by system administrator.",
        },
      });

      await this.platformMpesaService.activateSubscriptionFromInvoiceTx(
        tx,
        paidInvoice,
        now,
      );

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId,
          organizationId: invoice.organizationId,
          action: "admin.invoice.marked_paid",
          resourceType: "BillingInvoice",
          resourceId: invoice.id,
          metadata: {
            invoiceNumber: invoice.invoiceNumber,
            amountCents: remainingCents,
            externalReference: input.externalReference ?? null,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return paidInvoice;
    });

    await this.billingEnforcement.invalidateOrganizationCache(
      invoice.organizationId,
    );
    return updated;
  }

  async waiveInvoice(
    actorUserId: string,
    invoiceId: string,
    reason: string,
    ipAddress?: string,
  ) {
    const invoice = await this.prismaService.raw.billingInvoice.findUnique({
      where: { id: invoiceId },
      include: { plan: true },
    });
    if (!invoice) {
      throw new NotFoundException("Billing invoice was not found.");
    }
    if (
      invoice.status === BillingInvoiceStatus.PAID ||
      invoice.status === BillingInvoiceStatus.VOID
    ) {
      throw new BadRequestException(
        `Invoice "${invoice.invoiceNumber}" cannot be waived in status ${invoice.status}.`,
      );
    }

    const now = new Date();
    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const waived = await tx.billingInvoice.update({
        where: { id: invoice.id },
        data: {
          status: BillingInvoiceStatus.WAIVED,
          waivedAt: now,
          waivedByUserId: actorUserId,
          waivedReason: reason,
        },
        include: { plan: true },
      });

      await this.platformMpesaService.activateSubscriptionFromInvoiceTx(
        tx,
        waived,
        now,
      );

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId,
          organizationId: invoice.organizationId,
          action: "admin.invoice.waived",
          resourceType: "BillingInvoice",
          resourceId: invoice.id,
          metadata: {
            invoiceNumber: invoice.invoiceNumber,
            reason,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return waived;
    });

    await this.billingEnforcement.invalidateOrganizationCache(
      invoice.organizationId,
    );
    return updated;
  }

  async voidInvoice(
    actorUserId: string,
    invoiceId: string,
    reason?: string,
    ipAddress?: string,
  ) {
    const invoice = await this.prismaService.raw.billingInvoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice) {
      throw new NotFoundException("Billing invoice was not found.");
    }
    if (invoice.status === BillingInvoiceStatus.PAID) {
      throw new BadRequestException("Paid invoices cannot be voided.");
    }

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const voided = await tx.billingInvoice.update({
        where: { id: invoice.id },
        data: {
          status: BillingInvoiceStatus.VOID,
          notes: reason ?? invoice.notes,
        },
      });

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId,
          organizationId: invoice.organizationId,
          action: "admin.invoice.voided",
          resourceType: "BillingInvoice",
          resourceId: invoice.id,
          metadata: {
            invoiceNumber: invoice.invoiceNumber,
            reason: reason ?? null,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return voided;
    });

    return updated;
  }

  async listAuditLogs(query: {
    organizationId?: string;
    action?: string;
    limit: number;
    cursor?: string;
  }) {
    const take = Math.min(Math.max(query.limit, 1), 100);
    const logs = await this.prismaService.raw.platformBillingAuditLog.findMany({
      where: {
        ...(query.organizationId ? { organizationId: query.organizationId } : {}),
        ...(query.action ? { action: query.action } : {}),
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: { createdAt: "desc" },
      include: {
        actorUser: { select: { id: true, name: true, email: true } },
        organization: { select: { id: true, name: true, slug: true } },
      },
    });

    const hasMore = logs.length > take;
    const items = hasMore ? logs.slice(0, take) : logs;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;
    return { items, nextCursor };
  }

  async listSystemAdmins() {
    const env = getEnv();
    const allowlist = new Set(env.SYSTEM_ADMIN_EMAILS);
    const users = await this.prismaService.raw.user.findMany({
      where: {
        OR: [
          { platformRole: PlatformRole.SYSTEM_ADMIN },
          ...(env.SYSTEM_ADMIN_EMAILS.length > 0
            ? [{ email: { in: env.SYSTEM_ADMIN_EMAILS } }]
            : []),
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        platformRole: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    return {
      allowlistedEmails: env.SYSTEM_ADMIN_EMAILS,
      items: users.map((u) => ({
        ...u,
        inEnvAllowlist: allowlist.has(u.email.trim().toLowerCase()),
      })),
    };
  }

  async setUserPlatformRole(
    actorUserId: string,
    targetUserId: string,
    platformRole: PlatformRole,
    ipAddress?: string,
  ) {
    if (actorUserId === targetUserId && platformRole !== PlatformRole.SYSTEM_ADMIN) {
      throw new BadRequestException(
        "System administrators cannot demote their own platform role.",
      );
    }

    const user = await this.prismaService.raw.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, platformRole: true },
    });
    if (!user) {
      throw new NotFoundException("Target user was not found.");
    }

    const env = getEnv();
    if (
      platformRole === PlatformRole.USER &&
      env.SYSTEM_ADMIN_EMAILS.includes(user.email.trim().toLowerCase())
    ) {
      throw new BadRequestException(
        "This user's email is allowlisted in SYSTEM_ADMIN_EMAILS; remove them from the environment allowlist to demote.",
      );
    }

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const nextUser = await tx.user.update({
        where: { id: targetUserId },
        data: { platformRole },
        select: {
          id: true,
          name: true,
          email: true,
          emailVerified: true,
          platformRole: true,
        },
      });

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId,
          action: "admin.platform_role.updated",
          resourceType: "User",
          resourceId: targetUserId,
          metadata: {
            previousRole: user.platformRole,
            newRole: platformRole,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return nextUser;
    });

    return updated;
  }

  private async assertOrganizationExists(organizationId: string) {
    const org = await this.prismaService.raw.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!org) {
      throw new NotFoundException("Organization was not found.");
    }
  }
}

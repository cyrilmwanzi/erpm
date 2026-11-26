import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from "@nestjs/common";
import {
  BillingSubscriptionStatus,
  MpesaEnvironment,
  Prisma,
  StoredObjectStatus,
} from "@scace/db";
import { getEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { RedisService } from "../redis/redis.service.js";
import {
  DEFAULT_PLAN_FEATURES,
  provisionInitialTrialForOrganization,
  provisionPlatformBillingDefaults,
} from "./billing-bootstrap.service.js";
import { addDays, normalizeFeaturesMap } from "./billing-security.utils.js";

export type BillingQuotaKey =
  | "maxMembers"
  | "maxLocations"
  | "maxItems"
  | "maxMonthlyOrders"
  | "maxStorageBytes";

export interface BillingUsageSnapshot {
  membersAndInvitations: number;
  locations: number;
  items: number;
  monthlyOrders: number;
  storageBytes: number;
}

export interface BillingEffectiveLimits {
  maxMembers: number | null;
  maxLocations: number | null;
  maxItems: number | null;
  maxMonthlyOrders: number | null;
  maxStorageBytes: number | null;
}

export interface ResolvedBillingEntitlement {
  organizationId: string;
  subscriptionId: string;
  status: BillingSubscriptionStatus;
  persistedStatus: BillingSubscriptionStatus;
  isLockedOut: boolean;
  inGracePeriod: boolean;
  isExempt: boolean;
  exemptUntil: string | null;
  hasActiveOverride: boolean;
  overrideReason: string | null;
  planId: string;
  planCode: string;
  planName: string;
  billingCycle: string;
  trialStartsAt: string | null;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  gracePeriodEndsAt: string | null;
  daysRemainingInTrial: number | null;
  daysRemainingInGrace: number | null;
  limits: BillingEffectiveLimits;
  features: Record<string, boolean>;
  discountPercent: number;
  mpesaPaymentAvailable: boolean;
  mpesaEnvironment: MpesaEnvironment | null;
  enforceQuotas: boolean;
  enforceFeatureFlags: boolean;
  lockoutReason: string | null;
}

export interface BillingStateSnapshotInput {
  organizationId: string;
  subscriptionId: string;
  persistedStatus: BillingSubscriptionStatus;
  billingCycle: string;
  trialStartsAt: Date | null;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  gracePeriodEndsAt: Date | null;
  suspendedAt: Date | null;
  suspensionReason: string | null;
  plan: {
    id: string;
    code: string;
    name: string;
    gracePeriodDays: number;
    maxMembers: number | null;
    maxLocations: number | null;
    maxItems: number | null;
    maxMonthlyOrders: number | null;
    maxStorageBytes: bigint | number | null;
    features: unknown;
  };
  override: {
    isActive: boolean;
    exemptFromBilling: boolean;
    exemptUntil: Date | null;
    forceStatus: BillingSubscriptionStatus | null;
    customTrialEndsAt: Date | null;
    customGracePeriodEndsAt: Date | null;
    customMaxMembers: number | null;
    customMaxLocations: number | null;
    customMaxItems: number | null;
    customMaxMonthlyOrders: number | null;
    customMaxStorageBytes: bigint | number | null;
    discountPercent: number | null;
    allowMpesaOverride: boolean | null;
    featureOverrides: unknown;
    reason: string | null;
  } | null;
  platformConfig: {
    defaultGracePeriodDays: number;
    mpesaEnabled: boolean;
    lockoutAfterGrace: boolean;
    enforceQuotas: boolean;
    enforceFeatureFlags: boolean;
  };
  platformMpesa: {
    isEnabled: boolean;
    environment: MpesaEnvironment;
  } | null;
  enforcementEnabled?: boolean;
  now?: Date;
}

function diffDaysCeil(from: Date, to: Date): number {
  const diff = to.getTime() - from.getTime();
  if (diff <= 0) {
    return 0;
  }
  return Math.ceil(diff / 86_400_000);
}

export function evaluateBillingStateSnapshot(
  input: BillingStateSnapshotInput,
): ResolvedBillingEntitlement {
  const now = input.now ?? new Date();
  const enforcementEnabled = input.enforcementEnabled ?? true;
  const activeOverride =
    input.override && input.override.isActive ? input.override : null;

  const isExempt = Boolean(
    activeOverride?.exemptFromBilling &&
      (!activeOverride.exemptUntil || activeOverride.exemptUntil > now),
  );

  const graceDays = Math.max(
    0,
    input.plan.gracePeriodDays ?? input.platformConfig.defaultGracePeriodDays,
  );

  const effectiveTrialEndsAt =
    activeOverride?.customTrialEndsAt ?? input.trialEndsAt;

  let effectiveGraceEndsAt =
    activeOverride?.customGracePeriodEndsAt ?? input.gracePeriodEndsAt;
  if (!effectiveGraceEndsAt) {
    const anchor =
      input.persistedStatus === BillingSubscriptionStatus.ACTIVE
        ? input.currentPeriodEnd
        : effectiveTrialEndsAt;
    if (anchor) {
      effectiveGraceEndsAt = addDays(anchor, graceDays);
    }
  }

  let effectiveStatus: BillingSubscriptionStatus = input.persistedStatus;
  let inGracePeriod = false;
  let isLockedOut = false;
  let lockoutReason: string | null = null;

  if (isExempt) {
    effectiveStatus = BillingSubscriptionStatus.ACTIVE;
    isLockedOut = false;
  } else if (activeOverride?.forceStatus) {
    effectiveStatus = activeOverride.forceStatus;
    inGracePeriod =
      effectiveStatus === BillingSubscriptionStatus.GRACE_PERIOD;
    isLockedOut =
      enforcementEnabled &&
      (effectiveStatus === BillingSubscriptionStatus.EXPIRED ||
        effectiveStatus === BillingSubscriptionStatus.SUSPENDED ||
        effectiveStatus === BillingSubscriptionStatus.CANCELED);
    if (isLockedOut) {
      lockoutReason =
        activeOverride.reason ||
        `Organization billing status was set to ${effectiveStatus} by a system administrator.`;
    }
  } else if (input.persistedStatus === BillingSubscriptionStatus.SUSPENDED) {
    effectiveStatus = BillingSubscriptionStatus.SUSPENDED;
    isLockedOut = enforcementEnabled;
    lockoutReason =
      input.suspensionReason ||
      "Organization subscription has been suspended by a system administrator.";
  } else if (input.persistedStatus === BillingSubscriptionStatus.CANCELED) {
    effectiveStatus = BillingSubscriptionStatus.CANCELED;
    isLockedOut = enforcementEnabled;
    lockoutReason = "Organization subscription has been canceled.";
  } else if (input.persistedStatus === BillingSubscriptionStatus.ACTIVE) {
    if (input.currentPeriodEnd && now > input.currentPeriodEnd) {
      const periodGraceEnd =
        activeOverride?.customGracePeriodEndsAt ??
        input.gracePeriodEndsAt ??
        addDays(input.currentPeriodEnd, graceDays);
      effectiveGraceEndsAt = periodGraceEnd;
      if (now <= periodGraceEnd) {
        effectiveStatus = BillingSubscriptionStatus.GRACE_PERIOD;
        inGracePeriod = true;
        isLockedOut = false;
      } else {
        effectiveStatus = input.platformConfig.lockoutAfterGrace
          ? BillingSubscriptionStatus.EXPIRED
          : BillingSubscriptionStatus.PAST_DUE;
        isLockedOut =
          enforcementEnabled && input.platformConfig.lockoutAfterGrace;
        if (isLockedOut) {
          lockoutReason =
            "Subscription billing period and grace period have expired.";
        }
      }
    } else {
      effectiveStatus = BillingSubscriptionStatus.ACTIVE;
      isLockedOut = false;
    }
  } else {
    // TRIALING, GRACE_PERIOD, PAST_DUE, EXPIRED
    if (effectiveTrialEndsAt && now <= effectiveTrialEndsAt) {
      effectiveStatus = BillingSubscriptionStatus.TRIALING;
      isLockedOut = false;
    } else if (effectiveGraceEndsAt && now <= effectiveGraceEndsAt) {
      effectiveStatus = BillingSubscriptionStatus.GRACE_PERIOD;
      inGracePeriod = true;
      isLockedOut = false;
    } else {
      effectiveStatus = input.platformConfig.lockoutAfterGrace
        ? BillingSubscriptionStatus.EXPIRED
        : BillingSubscriptionStatus.PAST_DUE;
      isLockedOut =
        enforcementEnabled && input.platformConfig.lockoutAfterGrace;
      if (isLockedOut) {
        lockoutReason =
          "Free trial and grace period have expired. Complete M-Pesa payment or request a system administrator override to restore access.";
      }
    }
  }

  const baseFeatures = {
    ...DEFAULT_PLAN_FEATURES,
    ...normalizeFeaturesMap(input.plan.features),
  };
  const overrideFeatures = activeOverride
    ? normalizeFeaturesMap(activeOverride.featureOverrides)
    : {};
  const features = {
    ...baseFeatures,
    ...overrideFeatures,
  };

  const toNumberOrNull = (val: bigint | number | null | undefined): number | null => {
    if (val === null || val === undefined) {
      return null;
    }
    return Number(val);
  };

  const limits: BillingEffectiveLimits = {
    maxMembers:
      activeOverride?.customMaxMembers !== null &&
      activeOverride?.customMaxMembers !== undefined
        ? activeOverride.customMaxMembers
        : input.plan.maxMembers,
    maxLocations:
      activeOverride?.customMaxLocations !== null &&
      activeOverride?.customMaxLocations !== undefined
        ? activeOverride.customMaxLocations
        : input.plan.maxLocations,
    maxItems:
      activeOverride?.customMaxItems !== null &&
      activeOverride?.customMaxItems !== undefined
        ? activeOverride.customMaxItems
        : input.plan.maxItems,
    maxMonthlyOrders:
      activeOverride?.customMaxMonthlyOrders !== null &&
      activeOverride?.customMaxMonthlyOrders !== undefined
        ? activeOverride.customMaxMonthlyOrders
        : input.plan.maxMonthlyOrders,
    maxStorageBytes:
      activeOverride?.customMaxStorageBytes !== null &&
      activeOverride?.customMaxStorageBytes !== undefined
        ? toNumberOrNull(activeOverride.customMaxStorageBytes)
        : toNumberOrNull(input.plan.maxStorageBytes),
  };

  const orgMpesaAllowed =
    activeOverride?.allowMpesaOverride ?? input.platformConfig.mpesaEnabled;
  const mpesaPaymentAvailable = Boolean(
    orgMpesaAllowed && input.platformMpesa?.isEnabled,
  );

  return {
    organizationId: input.organizationId,
    subscriptionId: input.subscriptionId,
    status: effectiveStatus,
    persistedStatus: input.persistedStatus,
    isLockedOut,
    inGracePeriod,
    isExempt,
    exemptUntil: activeOverride?.exemptUntil
      ? activeOverride.exemptUntil.toISOString()
      : null,
    hasActiveOverride: Boolean(activeOverride),
    overrideReason: activeOverride?.reason ?? null,
    planId: input.plan.id,
    planCode: input.plan.code,
    planName: input.plan.name,
    billingCycle: input.billingCycle,
    trialStartsAt: input.trialStartsAt ? input.trialStartsAt.toISOString() : null,
    trialEndsAt: effectiveTrialEndsAt ? effectiveTrialEndsAt.toISOString() : null,
    currentPeriodStart: input.currentPeriodStart
      ? input.currentPeriodStart.toISOString()
      : null,
    currentPeriodEnd: input.currentPeriodEnd
      ? input.currentPeriodEnd.toISOString()
      : null,
    gracePeriodEndsAt: effectiveGraceEndsAt
      ? effectiveGraceEndsAt.toISOString()
      : null,
    daysRemainingInTrial:
      effectiveStatus === BillingSubscriptionStatus.TRIALING &&
      effectiveTrialEndsAt
        ? diffDaysCeil(now, effectiveTrialEndsAt)
        : null,
    daysRemainingInGrace:
      inGracePeriod && effectiveGraceEndsAt
        ? diffDaysCeil(now, effectiveGraceEndsAt)
        : null,
    limits,
    features,
    discountPercent: activeOverride?.discountPercent ?? 0,
    mpesaPaymentAvailable,
    mpesaEnvironment: input.platformMpesa?.environment ?? null,
    enforceQuotas: input.platformConfig.enforceQuotas && !isExempt,
    enforceFeatureFlags: input.platformConfig.enforceFeatureFlags && !isExempt,
    lockoutReason,
  };
}

interface CachedRawBillingSnapshot {
  organizationId: string;
  subscriptionId: string;
  persistedStatus: BillingSubscriptionStatus;
  billingCycle: string;
  trialStartsAt: string | null;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  gracePeriodEndsAt: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  plan: {
    id: string;
    code: string;
    name: string;
    gracePeriodDays: number;
    maxMembers: number | null;
    maxLocations: number | null;
    maxItems: number | null;
    maxMonthlyOrders: number | null;
    maxStorageBytes: number | null;
    features: unknown;
  };
  override: {
    isActive: boolean;
    exemptFromBilling: boolean;
    exemptUntil: string | null;
    forceStatus: BillingSubscriptionStatus | null;
    customTrialEndsAt: string | null;
    customGracePeriodEndsAt: string | null;
    customMaxMembers: number | null;
    customMaxLocations: number | null;
    customMaxItems: number | null;
    customMaxMonthlyOrders: number | null;
    customMaxStorageBytes: number | null;
    discountPercent: number | null;
    allowMpesaOverride: boolean | null;
    featureOverrides: unknown;
    reason: string | null;
  } | null;
  platformConfig: {
    defaultGracePeriodDays: number;
    mpesaEnabled: boolean;
    lockoutAfterGrace: boolean;
    enforceQuotas: boolean;
    enforceFeatureFlags: boolean;
  };
  platformMpesa: {
    isEnabled: boolean;
    environment: MpesaEnvironment;
  } | null;
}

@Injectable()
export class BillingEnforcementService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redisService: RedisService,
  ) {}

  private cacheKey(organizationId: string): string {
    return `billing:snapshot:${organizationId}`;
  }

  async invalidateOrganizationCache(organizationId: string): Promise<void> {
    try {
      await this.redisService.del(this.cacheKey(organizationId));
    } catch {
      // Non-fatal if Redis is unavailable
    }
  }

  async invalidateAllOrganizationCaches(): Promise<void> {
    try {
      await this.redisService.ensureConnected();
      const pattern = `${getEnv().REDIS_KEY_PREFIX}billing:snapshot:*`;
      const keys = await this.redisService.client.keys(pattern);
      if (keys.length > 0) {
        await this.redisService.client.del(...keys);
      }
    } catch {
      // Non-fatal if Redis is unavailable
    }
  }

  async evaluateOrganizationEntitlement(
    organizationId: string,
    options?: { skipCache?: boolean; persistTransition?: boolean },
  ): Promise<ResolvedBillingEntitlement> {
    const env = getEnv();
    let cached: CachedRawBillingSnapshot | null = null;

    if (!options?.skipCache) {
      try {
        cached = await this.redisService.getJson<CachedRawBillingSnapshot>(
          this.cacheKey(organizationId),
        );
      } catch {
        cached = null;
      }
    }

    if (!cached) {
      cached = await this.loadSnapshotFromDatabase(organizationId);
      try {
        await this.redisService.setJson(this.cacheKey(organizationId), cached, 30);
      } catch {
        // Non-fatal cache write failure
      }
    }

    const resolved = evaluateBillingStateSnapshot({
      organizationId: cached.organizationId,
      subscriptionId: cached.subscriptionId,
      persistedStatus: cached.persistedStatus,
      billingCycle: cached.billingCycle,
      trialStartsAt: cached.trialStartsAt ? new Date(cached.trialStartsAt) : null,
      trialEndsAt: cached.trialEndsAt ? new Date(cached.trialEndsAt) : null,
      currentPeriodStart: cached.currentPeriodStart
        ? new Date(cached.currentPeriodStart)
        : null,
      currentPeriodEnd: cached.currentPeriodEnd
        ? new Date(cached.currentPeriodEnd)
        : null,
      gracePeriodEndsAt: cached.gracePeriodEndsAt
        ? new Date(cached.gracePeriodEndsAt)
        : null,
      suspendedAt: cached.suspendedAt ? new Date(cached.suspendedAt) : null,
      suspensionReason: cached.suspensionReason,
      plan: cached.plan,
      override: cached.override
        ? {
            ...cached.override,
            exemptUntil: cached.override.exemptUntil
              ? new Date(cached.override.exemptUntil)
              : null,
            customTrialEndsAt: cached.override.customTrialEndsAt
              ? new Date(cached.override.customTrialEndsAt)
              : null,
            customGracePeriodEndsAt: cached.override.customGracePeriodEndsAt
              ? new Date(cached.override.customGracePeriodEndsAt)
              : null,
          }
        : null,
      platformConfig: cached.platformConfig,
      platformMpesa: cached.platformMpesa,
      enforcementEnabled: env.BILLING_ENFORCEMENT_ENABLED,
    });

    if (
      options?.persistTransition !== false &&
      resolved.status !== cached.persistedStatus &&
      !resolved.hasActiveOverride
    ) {
      await this.persistStatusTransition(
        organizationId,
        cached.subscriptionId,
        cached.persistedStatus,
        resolved.status,
        resolved.isLockedOut,
      );
    }

    return resolved;
  }

  private async persistStatusTransition(
    organizationId: string,
    subscriptionId: string,
    previousStatus: BillingSubscriptionStatus,
    nextStatus: BillingSubscriptionStatus,
    isLockedOut: boolean,
  ): Promise<void> {
    const now = new Date();
    try {
      await this.prismaService.raw.$transaction(async (tx) => {
        await tx.organizationSubscription.update({
          where: { id: subscriptionId },
          data: {
            status: nextStatus,
            lockedAt: isLockedOut ? now : null,
            lastEnforcedStatus: nextStatus,
            lastStatusEvaluatedAt: now,
          },
        });
        await tx.platformBillingAuditLog.create({
          data: {
            organizationId,
            action: "subscription.status_transition",
            resourceType: "OrganizationSubscription",
            resourceId: subscriptionId,
            metadata: {
              previousStatus,
              nextStatus,
              isLockedOut,
            } as Prisma.InputJsonValue,
          },
        });
      });
      await this.invalidateOrganizationCache(organizationId);
    } catch {
      // Non-fatal if DB is offline mock or concurrent update already transitioned
    }
  }

  private async loadSnapshotFromDatabase(
    organizationId: string,
  ): Promise<CachedRawBillingSnapshot> {
    const [{ config, defaultTrialPlan }, mpesaConfig, existingSub, override] =
      await Promise.all([
        provisionPlatformBillingDefaults(this.prismaService.raw),
        this.prismaService.raw.platformMpesaConfig.findUnique({
          where: { id: "default" },
          select: { isEnabled: true, environment: true },
        }),
        this.prismaService.raw.organizationSubscription.findUnique({
          where: { organizationId },
          include: { plan: true },
        }),
        this.prismaService.raw.organizationBillingOverride.findUnique({
          where: { organizationId },
        }),
      ]);

    const subscription =
      existingSub ??
      (await provisionInitialTrialForOrganization(
        organizationId,
        null,
        this.prismaService.raw,
      ));

    let effectivePlan = subscription.plan ?? defaultTrialPlan;
    if (
      override?.isActive &&
      override.forcePlanId &&
      override.forcePlanId !== effectivePlan.id
    ) {
      const forcedPlan = await this.prismaService.raw.billingPlan.findUnique({
        where: { id: override.forcePlanId },
      });
      if (forcedPlan) {
        effectivePlan = forcedPlan;
      }
    }

    return {
      organizationId,
      subscriptionId: subscription.id,
      persistedStatus: subscription.status,
      billingCycle: subscription.billingCycle,
      trialStartsAt: subscription.trialStartsAt
        ? subscription.trialStartsAt.toISOString()
        : null,
      trialEndsAt: subscription.trialEndsAt
        ? subscription.trialEndsAt.toISOString()
        : null,
      currentPeriodStart: subscription.currentPeriodStart
        ? subscription.currentPeriodStart.toISOString()
        : null,
      currentPeriodEnd: subscription.currentPeriodEnd
        ? subscription.currentPeriodEnd.toISOString()
        : null,
      gracePeriodEndsAt: subscription.gracePeriodEndsAt
        ? subscription.gracePeriodEndsAt.toISOString()
        : null,
      suspendedAt: subscription.suspendedAt
        ? subscription.suspendedAt.toISOString()
        : null,
      suspensionReason: subscription.suspensionReason,
      plan: {
        id: effectivePlan.id,
        code: effectivePlan.code,
        name: effectivePlan.name,
        gracePeriodDays: effectivePlan.gracePeriodDays,
        maxMembers: effectivePlan.maxMembers,
        maxLocations: effectivePlan.maxLocations,
        maxItems: effectivePlan.maxItems,
        maxMonthlyOrders: effectivePlan.maxMonthlyOrders,
        maxStorageBytes:
          effectivePlan.maxStorageBytes !== null &&
          effectivePlan.maxStorageBytes !== undefined
            ? Number(effectivePlan.maxStorageBytes)
            : null,
        features: effectivePlan.features,
      },
      override: override
        ? {
            isActive: override.isActive,
            exemptFromBilling: override.exemptFromBilling,
            exemptUntil: override.exemptUntil
              ? override.exemptUntil.toISOString()
              : null,
            forceStatus: override.forceStatus,
            customTrialEndsAt: override.customTrialEndsAt
              ? override.customTrialEndsAt.toISOString()
              : null,
            customGracePeriodEndsAt: override.customGracePeriodEndsAt
              ? override.customGracePeriodEndsAt.toISOString()
              : null,
            customMaxMembers: override.customMaxMembers,
            customMaxLocations: override.customMaxLocations,
            customMaxItems: override.customMaxItems,
            customMaxMonthlyOrders: override.customMaxMonthlyOrders,
            customMaxStorageBytes:
              override.customMaxStorageBytes !== null &&
              override.customMaxStorageBytes !== undefined
                ? Number(override.customMaxStorageBytes)
                : null,
            discountPercent: override.discountPercent,
            allowMpesaOverride: override.allowMpesaOverride,
            featureOverrides: override.featureOverrides,
            reason: override.reason,
          }
        : null,
      platformConfig: {
        defaultGracePeriodDays: config.defaultGracePeriodDays,
        mpesaEnabled: config.mpesaEnabled,
        lockoutAfterGrace: config.lockoutAfterGrace,
        enforceQuotas: config.enforceQuotas,
        enforceFeatureFlags: config.enforceFeatureFlags,
      },
      platformMpesa: mpesaConfig
        ? {
            isEnabled: mpesaConfig.isEnabled,
            environment: mpesaConfig.environment,
          }
        : null,
    };
  }

  assertNotLocked(entitlement: ResolvedBillingEntitlement): void {
    if (!entitlement.isLockedOut) {
      return;
    }

    throw new HttpException(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        code: "SUBSCRIPTION_LOCKED",
        message:
          entitlement.lockoutReason ??
          "Organization subscription or trial has expired beyond the grace period. Complete payment to restore access.",
        billingStatus: entitlement.status,
        planCode: entitlement.planCode,
        trialEndsAt: entitlement.trialEndsAt,
        gracePeriodEndsAt: entitlement.gracePeriodEndsAt,
        currentPeriodEnd: entitlement.currentPeriodEnd,
        billingRecoveryPath: "/api/v1/billing/subscription",
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }

  assertFeatureEnabled(
    entitlement: ResolvedBillingEntitlement,
    featureKey: string,
  ): void {
    if (!entitlement.enforceFeatureFlags || entitlement.isExempt) {
      return;
    }
    if (entitlement.features[featureKey] === false) {
      throw new ForbiddenException({
        code: "FEATURE_NOT_IN_PLAN",
        featureKey,
        planCode: entitlement.planCode,
        message: `Feature "${featureKey}" is disabled for plan "${entitlement.planCode}". Upgrade your subscription or contact a system administrator.`,
      });
    }
  }

  async getOrganizationUsage(organizationId: string): Promise<BillingUsageSnapshot> {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const [
      memberCount,
      pendingInviteCount,
      locationCount,
      itemCount,
      monthlyOrders,
      storageAgg,
    ] = await Promise.all([
      this.prismaService.raw.member.count({
        where: { organizationId },
      }),
      this.prismaService.raw.invitation.count({
        where: { organizationId, status: "pending" },
      }),
      this.prismaService.raw.location.count({
        where: { organizationId, status: "ACTIVE" },
      }),
      this.prismaService.raw.item.count({
        where: { organizationId, status: "ACTIVE" },
      }),
      this.prismaService.raw.order.count({
        where: {
          organizationId,
          createdAt: { gte: monthStart },
        },
      }),
      this.prismaService.raw.storedObject.aggregate({
        where: {
          organizationId,
          status: { in: [StoredObjectStatus.PENDING, StoredObjectStatus.READY] },
        },
        _sum: { sizeBytes: true },
      }),
    ]);

    return {
      membersAndInvitations: memberCount + pendingInviteCount,
      locations: locationCount,
      items: itemCount,
      monthlyOrders,
      storageBytes: Number(storageAgg?._sum?.sizeBytes ?? 0),
    };
  }

  async assertQuotaAvailable(
    organizationId: string,
    quotaKey: BillingQuotaKey,
    additionalUnits = 1,
  ): Promise<void> {
    const entitlement = await this.evaluateOrganizationEntitlement(organizationId);
    if (!entitlement.enforceQuotas || entitlement.isExempt) {
      return;
    }

    const limit = entitlement.limits[quotaKey];
    if (limit === null || limit === undefined) {
      return;
    }

    const usage = await this.getOrganizationUsage(organizationId);
    let current = 0;
    let label: string = quotaKey;
    switch (quotaKey) {
      case "maxMembers":
        current = usage.membersAndInvitations;
        label = "members & pending invitations";
        break;
      case "maxLocations":
        current = usage.locations;
        label = "active locations";
        break;
      case "maxItems":
        current = usage.items;
        label = "active items";
        break;
      case "maxMonthlyOrders":
        current = usage.monthlyOrders;
        label = "monthly orders";
        break;
      case "maxStorageBytes":
        current = usage.storageBytes;
        label = "storage bytes";
        break;
    }

    if (current + additionalUnits > limit) {
      throw new ForbiddenException({
        code: "QUOTA_EXCEEDED",
        quotaKey,
        limit,
        currentUsage: current,
        planCode: entitlement.planCode,
        message: `Organization ${label} limit (${limit}) reached on plan "${entitlement.planCode}". Upgrade your plan or contact a system administrator.`,
      });
    }
  }
}

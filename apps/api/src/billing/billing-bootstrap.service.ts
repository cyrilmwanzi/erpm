import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import {
  BillingSubscriptionStatus,
  MpesaEnvironment,
  MpesaShortcodeType,
  PlatformRole,
  Prisma,
  SubscriptionBillingCycle,
  prisma,
} from "@scace/db";
import { generateRandomToken, sha256Hex } from "../auth/crypto.utils.js";
import { getEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { addDays, encryptBillingSecret } from "./billing-security.utils.js";

export const DEFAULT_PLAN_FEATURES: Record<string, boolean> = {
  mpesa: true,
  production: true,
  reports: true,
  expiry: true,
  crm: true,
  communications: true,
  apiTokens: true,
};

export async function provisionPlatformBillingDefaults(
  db = prisma,
): Promise<{
  config: NonNullable<
    Awaited<ReturnType<typeof prisma.platformBillingConfig.findUnique>>
  >;
  defaultTrialPlan: NonNullable<
    Awaited<ReturnType<typeof prisma.billingPlan.findFirst>>
  >;
}> {
  const env = getEnv();

  let config = await db.platformBillingConfig.findUnique({
    where: { id: "default" },
  });
  if (!config) {
    config = await db.platformBillingConfig.upsert({
      where: { id: "default" },
      update: {},
      create: {
        id: "default",
        autoTrialEnabled: env.BILLING_AUTO_PROVISION_TRIAL,
        defaultTrialDays: env.BILLING_DEFAULT_TRIAL_DAYS,
        defaultGracePeriodDays: env.BILLING_DEFAULT_GRACE_DAYS,
        defaultCurrency: "KES",
        taxRateBps: 0,
        mpesaEnabled: true,
        allowMonthlyBilling: true,
        allowAnnualBilling: true,
        lockoutAfterGrace: true,
        enforceQuotas: true,
        enforceFeatureFlags: true,
      },
    });
  }

  const existingMpesa = await db.platformMpesaConfig.findUnique({
    where: { id: "default" },
  });
  if (!existingMpesa) {
    const freshToken = generateRandomToken(32);
    await db.platformMpesaConfig.upsert({
      where: { id: "default" },
      update: {},
      create: {
        id: "default",
        isEnabled: false,
        environment: MpesaEnvironment.LOCAL_SIMULATOR,
        shortcodeType: MpesaShortcodeType.PAYBILL,
        businessShortCode: "174379",
        callbackRouteTokenHash: sha256Hex(freshToken),
        callbackRouteTokenEncrypted: encryptBillingSecret(freshToken),
        callbackIpAllowlist: [],
        accountReferencePrefix: "SCACE",
        transactionDescTemplate: "Scace Subscription",
      },
    });
  }

  let defaultTrialPlan = await db.billingPlan.findFirst({
    where: { isDefaultTrial: true, isActive: true },
    orderBy: { sortOrder: "asc" },
  });

  if (!defaultTrialPlan) {
    const planCount = await db.billingPlan.count();
    if (planCount === 0) {
      defaultTrialPlan = await db.billingPlan.create({
        data: {
          code: "STARTER",
          name: "Starter",
          description: "Core ERP, inventory, POS, and M-Pesa billing for growing teams.",
          isActive: true,
          isPublic: true,
          isDefaultTrial: true,
          sortOrder: 1,
          currency: config.defaultCurrency,
          monthlyPriceCents: 290_000,
          annualPriceCents: 2_900_000,
          trialDays: config.defaultTrialDays,
          gracePeriodDays: config.defaultGracePeriodDays,
          maxMembers: 10,
          maxLocations: 3,
          maxItems: 500,
          maxMonthlyOrders: 1000,
          maxStorageBytes: BigInt(1_073_741_824),
          features: DEFAULT_PLAN_FEATURES as Prisma.InputJsonValue,
        },
      });

      await db.billingPlan.createMany({
        data: [
          {
            code: "GROWTH",
            name: "Growth",
            description: "Multi-location operations, production, expiry alerts, and scheduled reports.",
            isActive: true,
            isPublic: true,
            isDefaultTrial: false,
            sortOrder: 2,
            currency: config.defaultCurrency,
            monthlyPriceCents: 790_000,
            annualPriceCents: 7_900_000,
            trialDays: config.defaultTrialDays,
            gracePeriodDays: config.defaultGracePeriodDays,
            maxMembers: 50,
            maxLocations: 15,
            maxItems: 5000,
            maxMonthlyOrders: 10000,
            maxStorageBytes: BigInt(10_737_418_240),
            features: DEFAULT_PLAN_FEATURES as Prisma.InputJsonValue,
          },
          {
            code: "ENTERPRISE",
            name: "Enterprise",
            description: "Unlimited scale, custom quotas, and dedicated governance.",
            isActive: true,
            isPublic: true,
            isDefaultTrial: false,
            sortOrder: 3,
            currency: config.defaultCurrency,
            monthlyPriceCents: 1_990_000,
            annualPriceCents: 19_900_000,
            trialDays: config.defaultTrialDays,
            gracePeriodDays: config.defaultGracePeriodDays,
            maxMembers: null,
            maxLocations: null,
            maxItems: null,
            maxMonthlyOrders: null,
            maxStorageBytes: null,
            features: DEFAULT_PLAN_FEATURES as Prisma.InputJsonValue,
          },
        ],
        skipDuplicates: true,
      });
    } else {
      defaultTrialPlan =
        (await db.billingPlan.findFirst({
          where: { isActive: true },
          orderBy: { sortOrder: "asc" },
        })) ??
        (await db.billingPlan.findFirst({
          orderBy: { sortOrder: "asc" },
        }));
    }
  }

  if (!defaultTrialPlan) {
    defaultTrialPlan = await db.billingPlan.create({
      data: {
        code: "STARTER",
        name: "Starter",
        isActive: true,
        isPublic: true,
        isDefaultTrial: true,
        sortOrder: 1,
        currency: config.defaultCurrency,
        monthlyPriceCents: 290_000,
        annualPriceCents: 2_900_000,
        trialDays: config.defaultTrialDays,
        gracePeriodDays: config.defaultGracePeriodDays,
        features: DEFAULT_PLAN_FEATURES as Prisma.InputJsonValue,
      },
    });
  }

  return { config, defaultTrialPlan };
}

export async function provisionInitialTrialForOrganization(
  organizationId: string,
  actorUserId?: string | null,
  db = prisma,
) {
  const existing = await db.organizationSubscription.findUnique({
    where: { organizationId },
    include: { plan: true },
  });
  if (existing) {
    return existing;
  }

  const { config, defaultTrialPlan } = await provisionPlatformBillingDefaults(db);
  const now = new Date();
  const env = getEnv();
  const trialEnabled = config.autoTrialEnabled && env.BILLING_AUTO_PROVISION_TRIAL;
  const trialDays = Math.max(
    0,
    defaultTrialPlan.trialDays ?? config.defaultTrialDays,
  );
  const graceDays = Math.max(
    0,
    defaultTrialPlan.gracePeriodDays ?? config.defaultGracePeriodDays,
  );

  const trialStartsAt = trialEnabled ? now : null;
  const trialEndsAt = trialEnabled ? addDays(now, trialDays) : now;
  const gracePeriodEndsAt = addDays(trialEndsAt, graceDays);
  const initialStatus = trialEnabled
    ? trialDays > 0
      ? BillingSubscriptionStatus.TRIALING
      : BillingSubscriptionStatus.GRACE_PERIOD
    : graceDays > 0
      ? BillingSubscriptionStatus.GRACE_PERIOD
      : BillingSubscriptionStatus.EXPIRED;

  const subscription = await db.organizationSubscription.create({
    data: {
      organizationId,
      planId: defaultTrialPlan.id,
      billingCycle: SubscriptionBillingCycle.MONTHLY,
      status: initialStatus,
      trialStartsAt,
      trialEndsAt,
      gracePeriodEndsAt,
      lockedAt:
        initialStatus === BillingSubscriptionStatus.EXPIRED ? now : null,
      lastEnforcedStatus: initialStatus,
      lastStatusEvaluatedAt: now,
    },
    include: { plan: true },
  });

  await db.platformBillingAuditLog.create({
    data: {
      actorUserId: actorUserId ?? null,
      organizationId,
      action: "subscription.auto_provisioned",
      resourceType: "OrganizationSubscription",
      resourceId: subscription.id,
      metadata: {
        planCode: defaultTrialPlan.code,
        status: initialStatus,
        trialEnabled,
        trialEndsAt: trialEndsAt.toISOString(),
        gracePeriodEndsAt: gracePeriodEndsAt.toISOString(),
      } as Prisma.InputJsonValue,
    },
  });

  return subscription;
}

@Injectable()
export class BillingBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BillingBootstrapService.name);

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await provisionPlatformBillingDefaults(this.prismaService.raw);
      await this.syncAllowlistedSystemAdmins();
    } catch (error) {
      this.logger.warn(
        `Billing defaults bootstrap deferred: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async syncAllowlistedSystemAdmins(): Promise<void> {
    const env = getEnv();
    if (env.SYSTEM_ADMIN_EMAILS.length === 0) {
      return;
    }

    const users = await this.prismaService.raw.user.findMany({
      where: {
        platformRole: { not: PlatformRole.SYSTEM_ADMIN },
      },
      select: { id: true, email: true },
    });

    const allowlist = new Set(env.SYSTEM_ADMIN_EMAILS);
    const toPromote = users.filter((u) =>
      allowlist.has(u.email.trim().toLowerCase()),
    );
    if (toPromote.length === 0) {
      return;
    }

    await this.prismaService.raw.user.updateMany({
      where: { id: { in: toPromote.map((u) => u.id) } },
      data: { platformRole: PlatformRole.SYSTEM_ADMIN },
    });
  }
}

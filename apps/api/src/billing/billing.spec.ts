import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  BillingInvoiceStatus,
  BillingPaymentMethod,
  BillingPaymentStatus,
  BillingSubscriptionStatus,
  MpesaEnvironment,
  MpesaShortcodeType,
  PlatformRole,
  SubscriptionBillingCycle,
} from "@scace/db";
import { generateRandomToken, sha256Hex } from "../auth/crypto.utils.js";
import { hasOrganizationPermission } from "../auth/permissions.js";
import { OrganizationGuard } from "../organizations/organization.guard.js";
import {
  BILLING_FEATURE_KEY,
  BILLING_LOCK_EXEMPT_KEY,
} from "../organizations/organization.decorators.js";
import {
  BillingEnforcementService,
  evaluateBillingStateSnapshot,
  type BillingStateSnapshotInput,
} from "./billing-enforcement.service.js";
import {
  addBillingCycleDuration,
  addDays,
  computeBillingInvoiceAmounts,
  decryptBillingSecret,
  encryptBillingSecret,
  maskBillingSecretTail,
} from "./billing-security.utils.js";
import { OrgBillingController } from "./org-billing.controller.js";
import { PlatformMpesaService } from "./platform-mpesa.service.js";
import { SystemAdminGuard } from "./system-admin.guard.js";

function makeSnapshot(
  overrides: Partial<BillingStateSnapshotInput> = {},
): BillingStateSnapshotInput {
  const now = overrides.now ?? new Date("2026-11-26T10:00:00.000Z");
  return {
    organizationId: "org_1",
    subscriptionId: "sub_1",
    persistedStatus: BillingSubscriptionStatus.TRIALING,
    billingCycle: SubscriptionBillingCycle.MONTHLY,
    trialStartsAt: new Date("2026-11-12T10:00:00.000Z"),
    trialEndsAt: new Date("2026-11-26T10:00:00.000Z"),
    currentPeriodStart: null,
    currentPeriodEnd: null,
    gracePeriodEndsAt: new Date("2026-12-03T10:00:00.000Z"),
    suspendedAt: null,
    suspensionReason: null,
    plan: {
      id: "plan_starter",
      code: "STARTER",
      name: "Starter",
      gracePeriodDays: 7,
      maxMembers: 10,
      maxLocations: 3,
      maxItems: 500,
      maxMonthlyOrders: 1000,
      maxStorageBytes: 1_073_741_824,
      features: {
        mpesa: true,
        production: true,
        reports: true,
        expiry: true,
        crm: true,
        communications: true,
      },
    },
    override: null,
    platformConfig: {
      defaultGracePeriodDays: 7,
      mpesaEnabled: true,
      lockoutAfterGrace: true,
      enforceQuotas: true,
      enforceFeatureFlags: true,
    },
    platformMpesa: {
      isEnabled: true,
      environment: MpesaEnvironment.LOCAL_SIMULATOR,
    },
    enforcementEnabled: true,
    now,
    ...overrides,
  };
}

describe("Organization Billing, Free Trials & System Admin Governance", () => {
  const prevAllowlist = process.env.SYSTEM_ADMIN_EMAILS;

  afterEach(() => {
    process.env.SYSTEM_ADMIN_EMAILS = prevAllowlist;
  });

  it("encrypts platform billing secrets with AES-256-GCM and computes invoice totals", () => {
    const raw = "platform_daraja_passkey_secret_4321";
    const enc = encryptBillingSecret(raw);
    assert.ok(enc.startsWith("v1:"));
    assert.notEqual(enc, raw);
    assert.equal(decryptBillingSecret(enc), raw);
    assert.equal(maskBillingSecretTail(raw), "****4321");

    const amounts = computeBillingInvoiceAmounts({
      baseAmountCents: 100_000,
      discountPercent: 20,
      taxRateBps: 1600,
    });
    assert.deepEqual(amounts, {
      subtotalCents: 100_000,
      discountCents: 20_000,
      taxCents: 12_800,
      totalCents: 92_800,
    });

    const monthlyNext = addBillingCycleDuration(
      new Date("2026-01-15T00:00:00.000Z"),
      "MONTHLY",
    );
    assert.equal(monthlyNext.toISOString(), "2026-02-15T00:00:00.000Z");
  });

  it("grants billing RBAC permissions strictly to authorized organization roles", () => {
    assert.equal(
      hasOrganizationPermission("owner", { billing: ["read", "manage"] }),
      true,
    );
    assert.equal(
      hasOrganizationPermission("admin", { billing: ["read", "manage"] }),
      true,
    );
    assert.equal(hasOrganizationPermission("member", { billing: ["read"] }), true);
    assert.equal(hasOrganizationPermission("member", { billing: ["manage"] }), false);
    assert.equal(hasOrganizationPermission("viewer", { billing: ["read"] }), false);
  });

  it("evaluates trial -> grace period -> full lockout lifecycle accurately", () => {
    const duringTrial = evaluateBillingStateSnapshot(
      makeSnapshot({
        now: new Date("2026-11-25T10:00:00.000Z"),
      }),
    );
    assert.equal(duringTrial.status, BillingSubscriptionStatus.TRIALING);
    assert.equal(duringTrial.isLockedOut, false);
    assert.equal(duringTrial.inGracePeriod, false);
    assert.equal(duringTrial.daysRemainingInTrial, 1);

    const duringGrace = evaluateBillingStateSnapshot(
      makeSnapshot({
        now: new Date("2026-11-28T10:00:00.000Z"),
      }),
    );
    assert.equal(duringGrace.status, BillingSubscriptionStatus.GRACE_PERIOD);
    assert.equal(duringGrace.inGracePeriod, true);
    assert.equal(duringGrace.isLockedOut, false);
    assert.equal(duringGrace.daysRemainingInGrace, 5);

    const afterGrace = evaluateBillingStateSnapshot(
      makeSnapshot({
        now: new Date("2026-12-04T10:00:00.000Z"),
      }),
    );
    assert.equal(afterGrace.status, BillingSubscriptionStatus.EXPIRED);
    assert.equal(afterGrace.isLockedOut, true);
  });

  it("applies system admin overrides for exemptions, forced statuses, quotas, and features", () => {
    const now = new Date("2026-12-10T10:00:00.000Z");

    const exemptEnt = evaluateBillingStateSnapshot(
      makeSnapshot({
        now,
        override: {
          isActive: true,
          exemptFromBilling: true,
          exemptUntil: addDays(now, 30),
          forceStatus: null,
          customTrialEndsAt: null,
          customGracePeriodEndsAt: null,
          customMaxMembers: 250,
          customMaxLocations: null,
          customMaxItems: null,
          customMaxMonthlyOrders: null,
          customMaxStorageBytes: null,
          discountPercent: 100,
          allowMpesaOverride: false,
          featureOverrides: { production: false },
          reason: "Strategic partner comp",
        },
      }),
    );
    assert.equal(exemptEnt.status, BillingSubscriptionStatus.ACTIVE);
    assert.equal(exemptEnt.isExempt, true);
    assert.equal(exemptEnt.isLockedOut, false);
    assert.equal(exemptEnt.limits.maxMembers, 250);
    assert.equal(exemptEnt.features.production, false);
    assert.equal(exemptEnt.mpesaPaymentAvailable, false);

    const suspendedEnt = evaluateBillingStateSnapshot(
      makeSnapshot({
        persistedStatus: BillingSubscriptionStatus.ACTIVE,
        currentPeriodEnd: addDays(now, 15),
        now,
        override: {
          isActive: true,
          exemptFromBilling: false,
          exemptUntil: null,
          forceStatus: BillingSubscriptionStatus.SUSPENDED,
          customTrialEndsAt: null,
          customGracePeriodEndsAt: null,
          customMaxMembers: null,
          customMaxLocations: null,
          customMaxItems: null,
          customMaxMonthlyOrders: null,
          customMaxStorageBytes: null,
          discountPercent: null,
          allowMpesaOverride: null,
          featureOverrides: null,
          reason: "Compliance review hold",
        },
      }),
    );
    assert.equal(suspendedEnt.status, BillingSubscriptionStatus.SUSPENDED);
    assert.equal(suspendedEnt.isLockedOut, true);
    assert.match(suspendedEnt.lockoutReason ?? "", /Compliance review hold/);
  });

  it("verifies SystemAdminGuard blocks non-admins, service principals, and unverified users", async () => {
    let updatedRole: PlatformRole | null = null;
    const mockPrisma = {
      raw: {
        user: {
          findUnique: async ({ where }: { where: { id: string } }) => {
            if (where.id === "usr_admin") {
              return {
                id: "usr_admin",
                email: "admin@scace.test",
                name: "Platform Admin",
                emailVerified: true,
                platformRole: PlatformRole.SYSTEM_ADMIN,
              };
            }
            if (where.id === "usr_regular") {
              return {
                id: "usr_regular",
                email: "owner@org.test",
                name: "Organization Owner",
                emailVerified: true,
                platformRole: PlatformRole.USER,
              };
            }
            return {
              id: "usr_unverified",
              email: "unverified@scace.test",
              name: "Unverified",
              emailVerified: false,
              platformRole: PlatformRole.SYSTEM_ADMIN,
            };
          },
          update: async ({ data }: { data: { platformRole: PlatformRole } }) => {
            updatedRole = data.platformRole;
            return {};
          },
        },
      },
    } as never;

    const guard = new SystemAdminGuard(mockPrisma);

    const makeCtx = (req: Record<string, unknown>) =>
      ({
        switchToHttp: () => ({
          getRequest: () => req,
        }),
      }) as unknown as ExecutionContext;

    await assert.rejects(
      () => guard.canActivate(makeCtx({})),
      UnauthorizedException,
    );

    await assert.rejects(
      () =>
        guard.canActivate(
          makeCtx({
            session: { user: { id: "usr_admin" } },
            authContext: { isServicePrincipal: true },
          }),
        ),
      ForbiddenException,
    );

    await assert.rejects(
      () =>
        guard.canActivate(
          makeCtx({
            session: { user: { id: "usr_unverified" } },
          }),
        ),
      ForbiddenException,
    );

    await assert.rejects(
      () =>
        guard.canActivate(
          makeCtx({
            session: { user: { id: "usr_regular" } },
          }),
        ),
      ForbiddenException,
    );

    const adminReq: Record<string, unknown> = {
      session: { user: { id: "usr_admin" } },
      authContext: { isServicePrincipal: false },
    };
    assert.equal(await guard.canActivate(makeCtx(adminReq)), true);
    assert.equal(
      (adminReq.systemAdmin as { platformRole: PlatformRole }).platformRole,
      PlatformRole.SYSTEM_ADMIN,
    );
    assert.equal(updatedRole, null);
  });

  it("enforces billing lockouts and feature gates system-wide in OrganizationGuard while exempting billing recovery routes", async () => {
    const headers: Record<string, string> = {};
    const reflector = new Reflector();
    const mockPrisma = {
      raw: {
        member: {
          findUnique: async () => ({ id: "mem_1", role: "owner" }),
        },
      },
    } as never;
    const mockRedis = {
      getJson: async () => null,
      setJson: async () => undefined,
    } as never;

    let currentEntitlement = evaluateBillingStateSnapshot(
      makeSnapshot({
        now: new Date("2026-12-10T10:00:00.000Z"), // EXPIRED
      }),
    );

    const mockEnforcement = {
      evaluateOrganizationEntitlement: async () => currentEntitlement,
      assertNotLocked: BillingEnforcementService.prototype.assertNotLocked,
      assertFeatureEnabled: BillingEnforcementService.prototype.assertFeatureEnabled,
    } as unknown as BillingEnforcementService;

    const guard = new OrganizationGuard(
      reflector,
      mockPrisma,
      mockRedis,
      mockEnforcement,
    );

    class NormalErpController {
      createOrder() {
        return true;
      }
    }

    const makeCtx = (cls: unknown, handler: unknown) =>
      ({
        getClass: () => cls,
        getHandler: () => handler,
        switchToHttp: () => ({
          getRequest: () => ({
            session: {
              user: { id: "usr_1", email: "owner@org.test", name: "Owner", emailVerified: true },
              session: { id: "sess_1", activeOrganizationId: "org_1" },
            },
            authContext: { authMethod: "COOKIE_SESSION", organizationId: "org_1" },
          }),
          getResponse: () => ({
            header: (k: string, v: string) => {
              headers[k] = v;
            },
          }),
        }),
      }) as unknown as ExecutionContext;

    // 1. Locked org blocked on normal ERP routes with HTTP 402
    await assert.rejects(
      () =>
        guard.canActivate(
          makeCtx(NormalErpController, NormalErpController.prototype.createOrder),
        ),
      (err: unknown) =>
        err instanceof HttpException && err.getStatus() === HttpStatus.PAYMENT_REQUIRED,
    );
    assert.equal(headers["X-Scace-Billing-Status"], "EXPIRED");

    // 2. Locked org STILL allowed on OrgBillingController (@AllowWhenBillingLocked)
    assert.equal(
      Reflect.getMetadata(BILLING_LOCK_EXEMPT_KEY, OrgBillingController),
      true,
    );
    assert.equal(
      await guard.canActivate(
        makeCtx(
          OrgBillingController,
          OrgBillingController.prototype.initiateMpesaPayment,
        ),
      ),
      true,
    );

    // 3. Grace period allows ERP route and attaches X-Scace-Grace-Ends-At header
    currentEntitlement = evaluateBillingStateSnapshot(
      makeSnapshot({
        now: new Date("2026-11-28T10:00:00.000Z"),
      }),
    );
    assert.equal(
      await guard.canActivate(
        makeCtx(NormalErpController, NormalErpController.prototype.createOrder),
      ),
      true,
    );
    assert.equal(headers["X-Scace-Billing-Status"], "GRACE_PERIOD");
    assert.ok(headers["X-Scace-Grace-Ends-At"]);

    // 4. Feature flag disabled blocks gated controller with ForbiddenException
    class GatedProductionController {
      createBatch() {
        return true;
      }
    }
    Reflect.defineMetadata(
      BILLING_FEATURE_KEY,
      "production",
      GatedProductionController,
    );
    currentEntitlement = evaluateBillingStateSnapshot(
      makeSnapshot({
        persistedStatus: BillingSubscriptionStatus.ACTIVE,
        currentPeriodEnd: new Date("2026-12-26T10:00:00.000Z"),
        now: new Date("2026-11-26T10:00:00.000Z"),
        override: {
          isActive: true,
          exemptFromBilling: false,
          exemptUntil: null,
          forceStatus: null,
          customTrialEndsAt: null,
          customGracePeriodEndsAt: null,
          customMaxMembers: null,
          customMaxLocations: null,
          customMaxItems: null,
          customMaxMonthlyOrders: null,
          customMaxStorageBytes: null,
          discountPercent: null,
          allowMpesaOverride: null,
          featureOverrides: { production: false },
          reason: "Disable production module",
        },
      }),
    );
    await assert.rejects(
      () =>
        guard.canActivate(
          makeCtx(
            GatedProductionController,
            GatedProductionController.prototype.createBatch,
          ),
        ),
      ForbiddenException,
    );
  });

  it("verifies quota enforcement and idempotent M-Pesa subscription settlement", async () => {
    const quotaService = new BillingEnforcementService(
      {
        raw: {
          member: { count: async () => 8 },
          invitation: { count: async () => 2 },
          location: { count: async () => 1 },
          item: { count: async () => 5 },
          order: { count: async () => 10 },
          storedObject: { aggregate: async () => ({ _sum: { sizeBytes: 1000 } }) },
        },
      } as never,
      { getJson: async () => null, setJson: async () => undefined } as never,
    );
    quotaService.evaluateOrganizationEntitlement = async () =>
      evaluateBillingStateSnapshot(
        makeSnapshot({ now: new Date("2026-11-25T10:00:00.000Z") }),
      );

    await assert.rejects(
      () => quotaService.assertQuotaAvailable("org_1", "maxMembers"),
      ForbiddenException,
    );

    // Test PlatformMpesaService callback verification + idempotent invoice settlement
    const platformToken = generateRandomToken(24);
    const txToken = "tx_tok_1234567890abcdef";
    let txStatus: BillingPaymentStatus = BillingPaymentStatus.PENDING;
    let invoiceStatus: BillingInvoiceStatus = BillingInvoiceStatus.OPEN;
    let subStatus: BillingSubscriptionStatus = BillingSubscriptionStatus.EXPIRED;
    let cacheInvalidated = false;

    const fakeTx = {
      billingPaymentTransaction: {
        update: async ({ data }: { data: { status: BillingPaymentStatus } }) => {
          txStatus = data.status;
          return {
            id: "bpay_1",
            organizationId: "org_1",
            invoiceId: "binv_1",
            status: txStatus,
            amountCents: 290_000,
            callbackToken: txToken,
          };
        },
      },
      billingInvoice: {
        findUniqueOrThrow: async () => ({
          id: "binv_1",
          invoiceNumber: "SINV-001",
          organizationId: "org_1",
          planId: "plan_starter",
          billingCycle: SubscriptionBillingCycle.MONTHLY,
          totalCents: 290_000,
          amountPaidCents: 0,
          status: invoiceStatus,
          paidAt: null,
          plan: { id: "plan_starter", gracePeriodDays: 7 },
        }),
        update: async ({
          data,
        }: {
          data: { status: BillingInvoiceStatus; amountPaidCents: number };
        }) => {
          invoiceStatus = data.status;
          return {
            id: "binv_1",
            invoiceNumber: "SINV-001",
            organizationId: "org_1",
            planId: "plan_starter",
            billingCycle: SubscriptionBillingCycle.MONTHLY,
            totalCents: 290_000,
            amountPaidCents: data.amountPaidCents,
            status: invoiceStatus,
            plan: { id: "plan_starter", gracePeriodDays: 7 },
          };
        },
      },
      organizationSubscription: {
        findUnique: async () => ({
          id: "sub_1",
          organizationId: "org_1",
          planId: "plan_starter",
          status: subStatus,
          currentPeriodEnd: null,
        }),
        update: async ({ data }: { data: { status: BillingSubscriptionStatus } }) => {
          subStatus = data.status;
          return {
            id: "sub_1",
            organizationId: "org_1",
            status: subStatus,
            plan: { id: "plan_starter", code: "STARTER" },
          };
        },
      },
      platformBillingAuditLog: {
        create: async () => ({}),
      },
    };

    const platformMpesa = new PlatformMpesaService(
      {
        raw: {
          platformMpesaConfig: {
            findUnique: async () => ({
              id: "default",
              isEnabled: true,
              environment: MpesaEnvironment.LOCAL_SIMULATOR,
              shortcodeType: MpesaShortcodeType.PAYBILL,
              businessShortCode: "174379",
              callbackRouteTokenHash: sha256Hex(platformToken),
              callbackRouteTokenEncrypted: encryptBillingSecret(platformToken),
              callbackIpAllowlist: ["196.201.214.0/24"],
            }),
          },
          billingPaymentTransaction: {
            findFirst: async () => ({
              id: "bpay_1",
              organizationId: "org_1",
              invoiceId: "binv_1",
              method: BillingPaymentMethod.MPESA,
              status: txStatus,
              amountCents: 290_000,
              callbackToken: txToken,
              checkoutRequestId: "ws_CO_PLAT_1",
            }),
            findUniqueOrThrow: async () => ({
              id: "bpay_1",
              organizationId: "org_1",
              invoiceId: "binv_1",
              method: BillingPaymentMethod.MPESA,
              status: txStatus,
              amountCents: 290_000,
              callbackToken: txToken,
              checkoutRequestId: "ws_CO_PLAT_1",
            }),
          },
          $transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
        },
      } as never,
      {} as never,
      {
        invalidateOrganizationCache: async () => {
          cacheInvalidated = true;
        },
      } as never,
    );

    const stkPayload = {
      Body: {
        stkCallback: {
          MerchantRequestID: "MR-1",
          CheckoutRequestID: "ws_CO_PLAT_1",
          ResultCode: 0,
          ResultDesc: "Processed successfully",
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: 2900 },
              { Name: "MpesaReceiptNumber", Value: "PLAT999XYZ" },
            ],
          },
        },
      },
    };

    // Unlisted IP blocked
    await assert.rejects(
      () =>
        platformMpesa.handleStkCallback({
          platformToken,
          txToken,
          payload: stkPayload,
          clientIp: "8.8.8.8",
        }),
      UnauthorizedException,
    );

    // Valid IP settles invoice & unlocks org subscription
    const res1 = await platformMpesa.handleStkCallback({
      platformToken,
      txToken,
      payload: stkPayload,
      clientIp: "196.201.214.12",
    });
    assert.equal(res1.idempotentReplay, false);
    assert.equal(txStatus, BillingPaymentStatus.SUCCEEDED);
    assert.equal(invoiceStatus, BillingInvoiceStatus.PAID);
    assert.equal(subStatus, BillingSubscriptionStatus.ACTIVE);
    assert.equal(cacheInvalidated, true);

    // Duplicate callback replays idempotently
    const res2 = await platformMpesa.handleStkCallback({
      platformToken,
      txToken,
      payload: stkPayload,
      clientIp: "196.201.214.12",
    });
    assert.equal(res2.idempotentReplay, true);
  });
});

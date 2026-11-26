-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('USER', 'SYSTEM_ADMIN');
CREATE TYPE "SubscriptionBillingCycle" AS ENUM ('MONTHLY', 'ANNUAL');
CREATE TYPE "BillingSubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'GRACE_PERIOD', 'PAST_DUE', 'EXPIRED', 'SUSPENDED', 'CANCELED');
CREATE TYPE "BillingInvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'WAIVED', 'VOID', 'FAILED');
CREATE TYPE "BillingPaymentMethod" AS ENUM ('MPESA', 'ADMIN_MANUAL', 'ADMIN_WAIVER');
CREATE TYPE "BillingPaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- AlterTable
ALTER TABLE "user"
    ADD COLUMN IF NOT EXISTS "platformRole" "PlatformRole" NOT NULL DEFAULT 'USER';

-- CreateTable
CREATE TABLE "platform_billing_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "autoTrialEnabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultTrialDays" INTEGER NOT NULL DEFAULT 14,
    "defaultGracePeriodDays" INTEGER NOT NULL DEFAULT 7,
    "defaultCurrency" TEXT NOT NULL DEFAULT 'KES',
    "taxRateBps" INTEGER NOT NULL DEFAULT 0,
    "mpesaEnabled" BOOLEAN NOT NULL DEFAULT true,
    "allowMonthlyBilling" BOOLEAN NOT NULL DEFAULT true,
    "allowAnnualBilling" BOOLEAN NOT NULL DEFAULT true,
    "lockoutAfterGrace" BOOLEAN NOT NULL DEFAULT true,
    "enforceQuotas" BOOLEAN NOT NULL DEFAULT true,
    "enforceFeatureFlags" BOOLEAN NOT NULL DEFAULT true,
    "billingSupportEmail" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_billing_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_mpesa_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "environment" "MpesaEnvironment" NOT NULL DEFAULT 'LOCAL_SIMULATOR',
    "shortcodeType" "MpesaShortcodeType" NOT NULL DEFAULT 'PAYBILL',
    "businessShortCode" TEXT NOT NULL DEFAULT '174379',
    "partyB" TEXT,
    "consumerKeyEncrypted" TEXT,
    "consumerSecretEncrypted" TEXT,
    "passkeyEncrypted" TEXT,
    "callbackRouteTokenHash" TEXT NOT NULL,
    "callbackRouteTokenEncrypted" TEXT NOT NULL,
    "callbackIpAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accountReferencePrefix" TEXT DEFAULT 'SCACE',
    "transactionDescTemplate" TEXT DEFAULT 'Scace Subscription',
    "lastTestedAt" TIMESTAMP(3),
    "lastTestStatus" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_mpesa_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_plan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "isDefaultTrial" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "monthlyPriceCents" INTEGER NOT NULL DEFAULT 0,
    "annualPriceCents" INTEGER NOT NULL DEFAULT 0,
    "trialDays" INTEGER NOT NULL DEFAULT 14,
    "gracePeriodDays" INTEGER NOT NULL DEFAULT 7,
    "maxMembers" INTEGER,
    "maxLocations" INTEGER,
    "maxItems" INTEGER,
    "maxMonthlyOrders" INTEGER,
    "maxStorageBytes" BIGINT,
    "features" JSONB NOT NULL DEFAULT '{}',
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_subscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "billingCycle" "SubscriptionBillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "status" "BillingSubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "trialStartsAt" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "gracePeriodEndsAt" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "canceledAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "suspensionReason" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lastEnforcedStatus" "BillingSubscriptionStatus",
    "lastStatusEvaluatedAt" TIMESTAMP(3),
    "lastPaymentAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_billing_override" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "exemptFromBilling" BOOLEAN NOT NULL DEFAULT false,
    "exemptUntil" TIMESTAMP(3),
    "forceStatus" "BillingSubscriptionStatus",
    "forcePlanId" TEXT,
    "customTrialEndsAt" TIMESTAMP(3),
    "customGracePeriodEndsAt" TIMESTAMP(3),
    "customMaxMembers" INTEGER,
    "customMaxLocations" INTEGER,
    "customMaxItems" INTEGER,
    "customMaxMonthlyOrders" INTEGER,
    "customMaxStorageBytes" BIGINT,
    "discountPercent" INTEGER,
    "allowMpesaOverride" BOOLEAN,
    "featureOverrides" JSONB,
    "reason" TEXT,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_billing_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_invoice" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "billingCycle" "SubscriptionBillingCycle" NOT NULL,
    "currency" TEXT NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "amountPaidCents" INTEGER NOT NULL DEFAULT 0,
    "status" "BillingInvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "waivedAt" TIMESTAMP(3),
    "waivedByUserId" TEXT,
    "waivedReason" TEXT,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_payment_transaction" (
    "id" TEXT NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "method" "BillingPaymentMethod" NOT NULL DEFAULT 'MPESA',
    "status" "BillingPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "currency" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "phoneNumber" TEXT,
    "accountReference" TEXT,
    "callbackToken" TEXT,
    "merchantRequestId" TEXT,
    "checkoutRequestId" TEXT,
    "mpesaReceiptNumber" TEXT,
    "resultCode" TEXT,
    "resultDesc" TEXT,
    "initiatedByUserId" TEXT,
    "processedAt" TIMESTAMP(3),
    "rawCallbackPayload" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_payment_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_billing_audit_log" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "organizationId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_billing_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_mpesa_config_callbackRouteTokenHash_key" ON "platform_mpesa_config"("callbackRouteTokenHash");
CREATE UNIQUE INDEX "billing_plan_code_key" ON "billing_plan"("code");
CREATE INDEX "billing_plan_isActive_isPublic_sortOrder_idx" ON "billing_plan"("isActive", "isPublic", "sortOrder");
CREATE UNIQUE INDEX "organization_subscription_organizationId_key" ON "organization_subscription"("organizationId");
CREATE INDEX "organization_subscription_status_gracePeriodEndsAt_idx" ON "organization_subscription"("status", "gracePeriodEndsAt");
CREATE INDEX "organization_subscription_planId_idx" ON "organization_subscription"("planId");
CREATE UNIQUE INDEX "organization_billing_override_organizationId_key" ON "organization_billing_override"("organizationId");
CREATE UNIQUE INDEX "billing_invoice_invoiceNumber_key" ON "billing_invoice"("invoiceNumber");
CREATE INDEX "billing_invoice_organizationId_status_createdAt_idx" ON "billing_invoice"("organizationId", "status", "createdAt");
CREATE UNIQUE INDEX "billing_payment_transaction_referenceNumber_key" ON "billing_payment_transaction"("referenceNumber");
CREATE UNIQUE INDEX "billing_payment_transaction_callbackToken_key" ON "billing_payment_transaction"("callbackToken");
CREATE UNIQUE INDEX "billing_payment_transaction_checkoutRequestId_key" ON "billing_payment_transaction"("checkoutRequestId");
CREATE UNIQUE INDEX "billing_payment_transaction_mpesaReceiptNumber_key" ON "billing_payment_transaction"("mpesaReceiptNumber");
CREATE INDEX "billing_payment_transaction_organizationId_status_createdAt_idx" ON "billing_payment_transaction"("organizationId", "status", "createdAt");
CREATE INDEX "billing_payment_transaction_invoiceId_status_idx" ON "billing_payment_transaction"("invoiceId", "status");
CREATE INDEX "platform_billing_audit_log_organizationId_createdAt_idx" ON "platform_billing_audit_log"("organizationId", "createdAt");
CREATE INDEX "platform_billing_audit_log_actorUserId_createdAt_idx" ON "platform_billing_audit_log"("actorUserId", "createdAt");
CREATE INDEX "platform_billing_audit_log_action_createdAt_idx" ON "platform_billing_audit_log"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "organization_subscription" ADD CONSTRAINT "organization_subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organization_subscription" ADD CONSTRAINT "organization_subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "billing_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_billing_override" ADD CONSTRAINT "organization_billing_override_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_invoice" ADD CONSTRAINT "billing_invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_invoice" ADD CONSTRAINT "billing_invoice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "billing_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_payment_transaction" ADD CONSTRAINT "billing_payment_transaction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_payment_transaction" ADD CONSTRAINT "billing_payment_transaction_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "billing_invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_billing_audit_log" ADD CONSTRAINT "platform_billing_audit_log_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "platform_billing_audit_log" ADD CONSTRAINT "platform_billing_audit_log_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

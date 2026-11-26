-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'EXPIRY_WRITEOFF';
ALTER TYPE "StorageEntityType" ADD VALUE IF NOT EXISTS 'REPORT_RUN';
ALTER TYPE "CommunicationChannel" ADD VALUE IF NOT EXISTS 'WEBHOOK';
ALTER TYPE "CommunicationChannel" ADD VALUE IF NOT EXISTS 'IN_APP';

-- CreateEnum
CREATE TYPE "ExpiryEnforcementMode" AS ENUM ('BLOCK_EXPIRED', 'WARN_ONLY');
CREATE TYPE "ExpiryAlertSeverity" AS ENUM ('WARNING', 'CRITICAL', 'EXPIRED');
CREATE TYPE "ExpiryAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');
CREATE TYPE "ReportDomain" AS ENUM ('INVENTORY_EXPIRY', 'SALES_MPESA', 'PROCUREMENT_CLAIMS', 'PRODUCTION_COSTING');
CREATE TYPE "ReportFormat" AS ENUM ('JSON', 'CSV', 'PDF');
CREATE TYPE "ReportFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');
CREATE TYPE "ReportRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "CommunicationEventType" AS ENUM (
    'STOCK_EXPIRY_WARNING',
    'STOCK_EXPIRY_CRITICAL',
    'STOCK_EXPIRED',
    'STOCK_AUTO_QUARANTINED',
    'STOCK_EXPIRY_WRITEOFF',
    'SCHEDULED_REPORT_READY',
    'ON_DEMAND_REPORT_DISPATCH'
);
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');
CREATE TYPE "OutboxDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'DISPATCHED', 'PARTIAL', 'FAILED', 'ACKNOWLEDGED', 'CANCELLED');

-- AlterTable: Item
ALTER TABLE "item"
    ADD COLUMN IF NOT EXISTS "trackExpiry" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "shelfLifeDays" INTEGER,
    ADD COLUMN IF NOT EXISTS "expiryWarningDays" INTEGER,
    ADD COLUMN IF NOT EXISTS "expiryCriticalDays" INTEGER,
    ADD COLUMN IF NOT EXISTS "lotAllocationStrategy" "LotAllocationStrategy" NOT NULL DEFAULT 'FEFO';

-- AlterTable: StockMovement
ALTER TABLE "stock_movement"
    ADD COLUMN IF NOT EXISTS "stockLotId" TEXT;

CREATE INDEX IF NOT EXISTS "stock_movement_organizationId_stockLotId_idx" ON "stock_movement"("organizationId", "stockLotId");

ALTER TABLE "stock_movement"
    ADD CONSTRAINT "stock_movement_stockLotId_fkey" FOREIGN KEY ("stockLotId") REFERENCES "stock_lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: StockExpiryPolicy
CREATE TABLE "stock_expiry_policy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "warningDays" INTEGER NOT NULL DEFAULT 30,
    "criticalDays" INTEGER NOT NULL DEFAULT 7,
    "enforcementMode" "ExpiryEnforcementMode" NOT NULL DEFAULT 'BLOCK_EXPIRED',
    "autoQuarantineExpired" BOOLEAN NOT NULL DEFAULT false,
    "autoQuarantineOnCriticalDays" INTEGER,
    "scanIntervalMinutes" INTEGER NOT NULL DEFAULT 60,
    "isScannerActive" BOOLEAN NOT NULL DEFAULT true,
    "lastScannedAt" TIMESTAMP(3),
    "lastScanSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_expiry_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable: StockExpiryAlert
CREATE TABLE "stock_expiry_alert" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "stockLotId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "severity" "ExpiryAlertSeverity" NOT NULL,
    "status" "ExpiryAlertStatus" NOT NULL DEFAULT 'OPEN',
    "dedupeKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "daysUntilExpiry" INTEGER NOT NULL,
    "quantityAtRisk" INTEGER NOT NULL,
    "valueAtRiskCents" INTEGER NOT NULL,
    "outboxEventId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolutionNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_expiry_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable: StockExpiryWriteOff
CREATE TABLE "stock_expiry_write_off" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "writeOffNumber" TEXT NOT NULL,
    "stockLotId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "stockMovementId" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitCostCents" INTEGER NOT NULL,
    "totalLossCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "disposalMethod" TEXT,
    "notes" TEXT,
    "writtenOffByUserId" TEXT,
    "writtenOffAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_expiry_write_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ReportSchedule
CREATE TABLE "report_schedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" "ReportDomain" NOT NULL,
    "format" "ReportFormat" NOT NULL DEFAULT 'PDF',
    "frequency" "ReportFrequency" NOT NULL DEFAULT 'WEEKLY',
    "cronHourUtc" INTEGER NOT NULL DEFAULT 6,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "filters" JSONB,
    "recipientEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "channelHints" "CommunicationChannel"[] DEFAULT ARRAY['EMAIL']::"CommunicationChannel"[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ReportRun
CREATE TABLE "report_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "domain" "ReportDomain" NOT NULL,
    "format" "ReportFormat" NOT NULL,
    "status" "ReportRunStatus" NOT NULL DEFAULT 'COMPLETED',
    "filters" JSONB,
    "summaryKpis" JSONB,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "storedObjectId" TEXT,
    "outboxEventId" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "triggeredByUserId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AlertRule
CREATE TABLE "alert_rule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "eventType" "CommunicationEventType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "channels" "CommunicationChannel"[] DEFAULT ARRAY['EMAIL']::"CommunicationChannel"[],
    "recipientRoles" TEXT[] DEFAULT ARRAY['owner', 'admin', 'manager']::TEXT[],
    "recipientEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "webhookIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 1440,
    "lastTriggeredAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CommunicationWebhook
CREATE TABLE "communication_webhook" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "eventTypes" "CommunicationEventType"[] DEFAULT ARRAY[]::"CommunicationEventType"[],
    "signingSecretEncrypted" TEXT NOT NULL,
    "signingSecretHint" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CommunicationOutboxEvent
CREATE TABLE "communication_outbox_event" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventType" "CommunicationEventType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'INFO',
    "sourceEntityType" TEXT,
    "sourceEntityId" TEXT,
    "dedupeKey" TEXT,
    "channelHints" "CommunicationChannel"[] DEFAULT ARRAY[]::"CommunicationChannel"[],
    "targetRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetWebhookIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT NOT NULL,
    "summaryText" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "deliveryStatus" "OutboxDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextRetryAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "lockedBy" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByUserId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CommunicationDeliveryAttempt
CREATE TABLE "communication_delivery_attempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "outboxEventId" TEXT NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "target" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "providerMessageId" TEXT,
    "errorMessage" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communication_delivery_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_expiry_policy_organizationId_key" ON "stock_expiry_policy"("organizationId");

CREATE UNIQUE INDEX "stock_expiry_alert_organizationId_dedupeKey_key" ON "stock_expiry_alert"("organizationId", "dedupeKey");
CREATE INDEX "stock_expiry_alert_organizationId_status_severity_expiresAt_idx" ON "stock_expiry_alert"("organizationId", "status", "severity", "expiresAt");
CREATE INDEX "stock_expiry_alert_organizationId_stockLotId_idx" ON "stock_expiry_alert"("organizationId", "stockLotId");
CREATE INDEX "stock_expiry_alert_organizationId_itemId_locationId_idx" ON "stock_expiry_alert"("organizationId", "itemId", "locationId");

CREATE UNIQUE INDEX "stock_expiry_write_off_organizationId_writeOffNumber_key" ON "stock_expiry_write_off"("organizationId", "writeOffNumber");
CREATE INDEX "stock_expiry_write_off_organizationId_writtenOffAt_idx" ON "stock_expiry_write_off"("organizationId", "writtenOffAt");
CREATE INDEX "stock_expiry_write_off_organizationId_itemId_locationId_idx" ON "stock_expiry_write_off"("organizationId", "itemId", "locationId");

CREATE INDEX "report_schedule_organizationId_isActive_nextRunAt_idx" ON "report_schedule"("organizationId", "isActive", "nextRunAt");
CREATE INDEX "report_schedule_isActive_nextRunAt_idx" ON "report_schedule"("isActive", "nextRunAt");

CREATE INDEX "report_run_organizationId_domain_createdAt_idx" ON "report_run"("organizationId", "domain", "createdAt");
CREATE INDEX "report_run_organizationId_scheduleId_createdAt_idx" ON "report_run"("organizationId", "scheduleId", "createdAt");

CREATE INDEX "alert_rule_organizationId_eventType_isActive_idx" ON "alert_rule"("organizationId", "eventType", "isActive");

CREATE INDEX "communication_webhook_organizationId_isActive_idx" ON "communication_webhook"("organizationId", "isActive");

CREATE UNIQUE INDEX "communication_outbox_event_organizationId_dedupeKey_key" ON "communication_outbox_event"("organizationId", "dedupeKey");
CREATE INDEX "communication_outbox_event_organizationId_deliveryStatus_nextRetryAt_idx" ON "communication_outbox_event"("organizationId", "deliveryStatus", "nextRetryAt");
CREATE INDEX "communication_outbox_event_deliveryStatus_nextRetryAt_idx" ON "communication_outbox_event"("deliveryStatus", "nextRetryAt");
CREATE INDEX "communication_outbox_event_organizationId_eventType_createdAt_idx" ON "communication_outbox_event"("organizationId", "eventType", "createdAt");

CREATE INDEX "communication_delivery_attempt_organizationId_outboxEventId_attemptedAt_idx" ON "communication_delivery_attempt"("organizationId", "outboxEventId", "attemptedAt");

-- AddForeignKey
ALTER TABLE "stock_expiry_policy" ADD CONSTRAINT "stock_expiry_policy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_expiry_alert" ADD CONSTRAINT "stock_expiry_alert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_expiry_alert" ADD CONSTRAINT "stock_expiry_alert_stockLotId_fkey" FOREIGN KEY ("stockLotId") REFERENCES "stock_lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_expiry_alert" ADD CONSTRAINT "stock_expiry_alert_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_expiry_alert" ADD CONSTRAINT "stock_expiry_alert_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_expiry_write_off" ADD CONSTRAINT "stock_expiry_write_off_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_expiry_write_off" ADD CONSTRAINT "stock_expiry_write_off_stockLotId_fkey" FOREIGN KEY ("stockLotId") REFERENCES "stock_lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_expiry_write_off" ADD CONSTRAINT "stock_expiry_write_off_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_expiry_write_off" ADD CONSTRAINT "stock_expiry_write_off_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "report_schedule" ADD CONSTRAINT "report_schedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "report_run" ADD CONSTRAINT "report_run_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_run" ADD CONSTRAINT "report_run_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "report_schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "alert_rule" ADD CONSTRAINT "alert_rule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "communication_webhook" ADD CONSTRAINT "communication_webhook_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "communication_outbox_event" ADD CONSTRAINT "communication_outbox_event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "communication_delivery_attempt" ADD CONSTRAINT "communication_delivery_attempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "communication_delivery_attempt" ADD CONSTRAINT "communication_delivery_attempt_outboxEventId_fkey" FOREIGN KEY ("outboxEventId") REFERENCES "communication_outbox_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

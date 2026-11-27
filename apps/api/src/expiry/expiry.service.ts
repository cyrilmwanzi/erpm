import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  AlertSeverity,
  CommunicationEventType,
  ExpiryAlertSeverity,
  ExpiryAlertStatus,
  ExpiryEnforcementMode,
  Prisma,
  StockMovementType,
  OrganizationContext,
} from "@scace/db";
import { CommunicationOutboxService } from "../communications/communication-outbox.service.js";
import { getEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import {
  classifyLotExpiry,
  type LotExpiryBucket,
  resolveEffectiveExpiryPolicyTx,
} from "../locations/lot-allocation.utils.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import { RedisService } from "../redis/redis.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";

export interface UpdateExpiryPolicyInput {
  warningDays?: number;
  criticalDays?: number;
  enforcementMode?: ExpiryEnforcementMode;
  autoQuarantineExpired?: boolean;
  autoQuarantineOnCriticalDays?: number | null;
  scanIntervalMinutes?: number;
  isScannerActive?: boolean;
}

export interface ListExpiryLotsQuery {
  locationId?: string;
  itemId?: string;
  bucket?: LotExpiryBucket;
  includeZeroQty?: boolean;
  limit: number;
  cursor?: string;
}

export interface ListExpiryAlertsQuery {
  status?: ExpiryAlertStatus;
  severity?: ExpiryAlertSeverity;
  locationId?: string;
  itemId?: string;
  limit: number;
  cursor?: string;
}

export interface QuarantineLotInput {
  quantity?: number;
  reason?: string;
  notes?: string | null;
}

export interface WriteOffLotInput {
  quantity: number;
  source?: "AUTO" | "QUARANTINED" | "ON_HAND";
  reason: string;
  disposalMethod?: string | null;
  notes?: string | null;
}

export interface ExtendLotExpiryInput {
  newExpiresAt: string;
  reason: string;
}

export interface ExpiryScanSummary {
  organizationId: string;
  trigger: "MANUAL" | "SCHEDULED";
  scannedAt: string;
  lotsScanned: number;
  expiredLotsCount: number;
  criticalLotsCount: number;
  warningLotsCount: number;
  healthyLotsCount: number;
  alertsCreated: number;
  alertsUpdated: number;
  alertsAutoResolved: number;
  autoQuarantinedLotsCount: number;
  autoQuarantinedQty: number;
  outboxEventsEmitted: number;
  valueAtRiskCents: {
    expired: number;
    critical: number;
    warning: number;
    total: number;
  };
}

function generateWriteOffNumber(now = new Date()): string {
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  return `WO-${datePart}-${suffix}`;
}

@Injectable()
export class ExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExpiryService.name);
  private scannerInterval: ReturnType<typeof setInterval> | null = null;
  private isTickRunning = false;

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redisService: RedisService,
    @Inject(CommunicationOutboxService)
    private readonly outboxService: CommunicationOutboxService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  onModuleInit(): void {
    const env = getEnv();
    const enabled =
      env.NODE_ENV !== "test" && env.EXPIRY_SCANNER_ENABLED !== false;
    if (!enabled) {
      return;
    }

    this.scannerInterval = setInterval(() => {
      void this.runBackgroundScannerTick();
    }, 60_000);
    if (typeof this.scannerInterval.unref === "function") {
      this.scannerInterval.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.scannerInterval) {
      clearInterval(this.scannerInterval);
      this.scannerInterval = null;
    }
  }

  private async runBackgroundScannerTick(): Promise<void> {
    if (this.isTickRunning) {
      return;
    }
    this.isTickRunning = true;
    const lockKey = "expiry:scanner:tick-lock";
    try {
      await this.redisService.ensureConnected();
      const acquired = await this.redisService.client.set(
        lockKey,
        randomUUID(),
        "EX",
        55,
        "NX",
      );
      if (acquired !== "OK") {
        return;
      }

      const now = new Date();
      const activePolicies =
        await this.prismaService.raw.stockExpiryPolicy.findMany({
          where: { isScannerActive: true },
          select: {
            organizationId: true,
            scanIntervalMinutes: true,
            lastScannedAt: true,
          },
        });

      for (const pol of activePolicies) {
        const intervalMs = Math.max(5, pol.scanIntervalMinutes) * 60_000;
        if (
          !pol.lastScannedAt ||
          now.getTime() - pol.lastScannedAt.getTime() >= intervalMs
        ) {
          try {
            await this.runScanForOrganization(pol.organizationId, "SCHEDULED");
          } catch (err) {
            this.logger.warn(
              `Expiry scan failed for org ${pol.organizationId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    } catch (error) {
      this.logger.warn(
        `Expiry scanner tick skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.isTickRunning = false;
    }
  }

  // ==========================================
  // Policy Configuration
  // ==========================================

  async getPolicy(tenant: AuthenticatedOrganization) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing = await this.prismaService.raw.stockExpiryPolicy.findUnique({
      where: { organizationId },
    });
    if (existing) {
      return existing;
    }
    return this.prismaService.raw.stockExpiryPolicy.create({
      data: {
        organizationId,
        warningDays: 30,
        criticalDays: 7,
        enforcementMode: ExpiryEnforcementMode.BLOCK_EXPIRED,
        autoQuarantineExpired: false,
        scanIntervalMinutes: 60,
        isScannerActive: true,
      },
    });
  }

  async updatePolicy(
    tenant: AuthenticatedOrganization,
    input: UpdateExpiryPolicyInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const saved = await this.prismaService.raw.$transaction(async (tx) => {
      const current = await tx.stockExpiryPolicy.findUnique({
        where: { organizationId },
      });

      const warningDays = input.warningDays ?? current?.warningDays ?? 30;
      const criticalDays = input.criticalDays ?? current?.criticalDays ?? 7;

      if (criticalDays > warningDays) {
        throw new BadRequestException(
          "criticalDays cannot be greater than warningDays.",
        );
      }

      const policy = current
        ? await tx.stockExpiryPolicy.update({
            where: { id: current.id },
            data: {
              ...(input.warningDays !== undefined
                ? { warningDays: input.warningDays }
                : {}),
              ...(input.criticalDays !== undefined
                ? { criticalDays: input.criticalDays }
                : {}),
              ...(input.enforcementMode !== undefined
                ? { enforcementMode: input.enforcementMode }
                : {}),
              ...(input.autoQuarantineExpired !== undefined
                ? { autoQuarantineExpired: input.autoQuarantineExpired }
                : {}),
              ...(input.autoQuarantineOnCriticalDays !== undefined
                ? {
                    autoQuarantineOnCriticalDays:
                      input.autoQuarantineOnCriticalDays,
                  }
                : {}),
              ...(input.scanIntervalMinutes !== undefined
                ? { scanIntervalMinutes: input.scanIntervalMinutes }
                : {}),
              ...(input.isScannerActive !== undefined
                ? { isScannerActive: input.isScannerActive }
                : {}),
            },
          })
        : await tx.stockExpiryPolicy.create({
            data: {
              organizationId,
              warningDays,
              criticalDays,
              enforcementMode:
                input.enforcementMode ?? ExpiryEnforcementMode.BLOCK_EXPIRED,
              autoQuarantineExpired: input.autoQuarantineExpired ?? false,
              autoQuarantineOnCriticalDays:
                input.autoQuarantineOnCriticalDays ?? null,
              scanIntervalMinutes: input.scanIntervalMinutes ?? 60,
              isScannerActive: input.isScannerActive ?? true,
            },
          });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "inventory.expiry.policy_updated",
          resourceType: "StockExpiryPolicy",
          resourceId: policy.id,
          metadata: {
            warningDays: policy.warningDays,
            criticalDays: policy.criticalDays,
            enforcementMode: policy.enforcementMode,
            autoQuarantineExpired: policy.autoQuarantineExpired,
            autoQuarantineOnCriticalDays: policy.autoQuarantineOnCriticalDays,
            scanIntervalMinutes: policy.scanIntervalMinutes,
            isScannerActive: policy.isScannerActive,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return policy;
    });

    return saved;
  }

  // ==========================================
  // Lot Exposure Summary & Listing
  // ==========================================

  async getSummary(
    tenant: AuthenticatedOrganization,
    query: { locationId?: string; itemId?: string } = {},
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const now = new Date();

    const [policy, lots, openAlertCount] = await Promise.all([
      this.getPolicy(tenant),
      this.prismaService.raw.stockLot.findMany({
        where: {
          organizationId,
          ...(query.locationId ? { locationId: query.locationId } : {}),
          ...(query.itemId ? { itemId: query.itemId } : {}),
          OR: [{ onHandQty: { gt: 0 } }, { quarantinedQty: { gt: 0 } }],
        },
        include: {
          item: {
            select: {
              id: true,
              sku: true,
              name: true,
              costPriceCents: true,
              expiryWarningDays: true,
              expiryCriticalDays: true,
            },
          },
          location: {
            select: { id: true, code: true, name: true },
          },
        },
      }),
      this.prismaService.raw.stockExpiryAlert.count({
        where: {
          organizationId,
          status: { in: [ExpiryAlertStatus.OPEN, ExpiryAlertStatus.ACKNOWLEDGED] },
          ...(query.locationId ? { locationId: query.locationId } : {}),
          ...(query.itemId ? { itemId: query.itemId } : {}),
        },
      }),
    ]);

    const buckets: Record<
      LotExpiryBucket,
      {
        lotCount: number;
        onHandQty: number;
        quarantinedQty: number;
        valueAtRiskCents: number;
      }
    > = {
      EXPIRED: { lotCount: 0, onHandQty: 0, quarantinedQty: 0, valueAtRiskCents: 0 },
      CRITICAL: { lotCount: 0, onHandQty: 0, quarantinedQty: 0, valueAtRiskCents: 0 },
      WARNING: { lotCount: 0, onHandQty: 0, quarantinedQty: 0, valueAtRiskCents: 0 },
      HEALTHY: { lotCount: 0, onHandQty: 0, quarantinedQty: 0, valueAtRiskCents: 0 },
      NO_EXPIRY: { lotCount: 0, onHandQty: 0, quarantinedQty: 0, valueAtRiskCents: 0 },
    };

    for (const lot of lots) {
      const warningDays = lot.item.expiryWarningDays ?? policy.warningDays;
      const criticalDays = lot.item.expiryCriticalDays ?? policy.criticalDays;
      const { bucket } = classifyLotExpiry(
        lot.expiresAt,
        now,
        warningDays,
        criticalDays,
      );
      const unitCost = lot.unitCostCents || lot.item.costPriceCents || 0;
      const qtyTotal = lot.onHandQty + lot.quarantinedQty;
      buckets[bucket].lotCount += 1;
      buckets[bucket].onHandQty += lot.onHandQty;
      buckets[bucket].quarantinedQty += lot.quarantinedQty;
      buckets[bucket].valueAtRiskCents += qtyTotal * unitCost;
    }

    return {
      organizationId,
      asOf: now.toISOString(),
      policy,
      openAlertCount,
      totalActiveLots: lots.length,
      buckets,
    };
  }

  async listLots(tenant: AuthenticatedOrganization, query: ListExpiryLotsQuery) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const now = new Date();
    const policy = await this.getPolicy(tenant);

    const lots = await this.prismaService.raw.stockLot.findMany({
      where: {
        organizationId,
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.itemId ? { itemId: query.itemId } : {}),
        ...(!query.includeZeroQty
          ? { OR: [{ onHandQty: { gt: 0 } }, { quarantinedQty: { gt: 0 } }] }
          : {}),
      },
      include: {
        item: {
          select: {
            id: true,
            sku: true,
            name: true,
            unitOfMeasure: true,
            costPriceCents: true,
            trackExpiry: true,
            expiryWarningDays: true,
            expiryCriticalDays: true,
            lotAllocationStrategy: true,
          },
        },
        location: {
          select: { id: true, code: true, name: true },
        },
      },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    });

    const enriched = lots
      .map((lot) => {
        const warningDays = lot.item.expiryWarningDays ?? policy.warningDays;
        const criticalDays = lot.item.expiryCriticalDays ?? policy.criticalDays;
        const classification = classifyLotExpiry(
          lot.expiresAt,
          now,
          warningDays,
          criticalDays,
        );
        const effectiveUnitCostCents =
          lot.unitCostCents || lot.item.costPriceCents || 0;
        const valueAtRiskCents =
          (lot.onHandQty + lot.quarantinedQty) * effectiveUnitCostCents;
        return {
          ...lot,
          bucket: classification.bucket,
          daysUntilExpiry: classification.daysUntilExpiry,
          effectiveWarningDays: warningDays,
          effectiveCriticalDays: criticalDays,
          effectiveUnitCostCents,
          valueAtRiskCents,
        };
      })
      .filter((row) => !query.bucket || row.bucket === query.bucket);

    let startIdx = 0;
    if (query.cursor) {
      const idx = enriched.findIndex((row) => row.id === query.cursor);
      if (idx >= 0) {
        startIdx = idx + 1;
      }
    }

    const slice = enriched.slice(startIdx, startIdx + take + 1);
    const hasMore = slice.length > take;
    const items = hasMore ? slice.slice(0, take) : slice;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return {
      organizationId,
      asOf: now.toISOString(),
      items,
      nextCursor,
    };
  }

  // ==========================================
  // Scanner & Alert Deduplication + Outbox Emission
  // ==========================================

  async runScanForOrganization(
    organizationId: string,
    trigger: "MANUAL" | "SCHEDULED",
    actorUserId?: string,
    ipAddress?: string,
  ): Promise<ExpiryScanSummary> {
    const now = new Date();

    const summary = await this.prismaService.raw.$transaction(async (tx) => {
      const policy = await resolveEffectiveExpiryPolicyTx(tx, organizationId);

      // 1. Resolve open/acknowledged alerts for lots that are now depleted or safe
      const existingOpenAlerts = await tx.stockExpiryAlert.findMany({
        where: {
          organizationId,
          status: { in: [ExpiryAlertStatus.OPEN, ExpiryAlertStatus.ACKNOWLEDGED] },
        },
        include: {
          stockLot: {
            include: {
              item: {
                select: {
                  expiryWarningDays: true,
                  expiryCriticalDays: true,
                },
              },
            },
          },
        },
      });

      let alertsAutoResolved = 0;
      for (const alert of existingOpenAlerts) {
        const lot = alert.stockLot;
        const remainingQty = lot.onHandQty + lot.quarantinedQty;
        const warnDays = lot.item.expiryWarningDays ?? policy.warningDays;
        const critDays = lot.item.expiryCriticalDays ?? policy.criticalDays;
        const classification = classifyLotExpiry(
          lot.expiresAt,
          now,
          warnDays,
          critDays,
        );
        const shouldResolve =
          remainingQty <= 0 ||
          classification.bucket === "HEALTHY" ||
          classification.bucket === "NO_EXPIRY";

        if (shouldResolve) {
          await tx.stockExpiryAlert.update({
            where: { id: alert.id },
            data: {
              status: ExpiryAlertStatus.RESOLVED,
              resolvedAt: now,
              resolvedByUserId: actorUserId ?? null,
              resolutionNotes:
                remainingQty <= 0
                  ? "Auto-resolved: lot quantity depleted."
                  : "Auto-resolved: lot expiration pushed outside alert window.",
            },
          });
          alertsAutoResolved += 1;
        }
      }

      // 2. Scan active lots with expiry dates
      const lots = await tx.stockLot.findMany({
        where: {
          organizationId,
          expiresAt: { not: null },
          OR: [{ onHandQty: { gt: 0 } }, { quarantinedQty: { gt: 0 } }],
        },
        include: {
          item: {
            select: {
              id: true,
              sku: true,
              name: true,
              unitOfMeasure: true,
              costPriceCents: true,
              trackInventory: true,
              expiryWarningDays: true,
              expiryCriticalDays: true,
            },
          },
          location: {
            select: { id: true, code: true, name: true },
          },
        },
        orderBy: { expiresAt: "asc" },
      });

      let expiredLotsCount = 0;
      let criticalLotsCount = 0;
      let warningLotsCount = 0;
      let healthyLotsCount = 0;
      let alertsCreated = 0;
      let alertsUpdated = 0;
      let autoQuarantinedLotsCount = 0;
      let autoQuarantinedQty = 0;
      let outboxEventsEmitted = 0;

      const valueAtRisk = {
        expired: 0,
        critical: 0,
        warning: 0,
        total: 0,
      };

      for (const lot of lots) {
        if (!lot.expiresAt) {
          continue;
        }
        const warningDays = lot.item.expiryWarningDays ?? policy.warningDays;
        const criticalDays = lot.item.expiryCriticalDays ?? policy.criticalDays;
        const { bucket, daysUntilExpiry } = classifyLotExpiry(
          lot.expiresAt,
          now,
          warningDays,
          criticalDays,
        );

        const unitCost = lot.unitCostCents || lot.item.costPriceCents || 0;
        let currentOnHand = lot.onHandQty;
        let currentQuarantined = lot.quarantinedQty;
        const lotValueCents = (currentOnHand + currentQuarantined) * unitCost;

        if (bucket === "EXPIRED") {
          expiredLotsCount += 1;
          valueAtRisk.expired += lotValueCents;
          valueAtRisk.total += lotValueCents;
        } else if (bucket === "CRITICAL") {
          criticalLotsCount += 1;
          valueAtRisk.critical += lotValueCents;
          valueAtRisk.total += lotValueCents;
        } else if (bucket === "WARNING") {
          warningLotsCount += 1;
          valueAtRisk.warning += lotValueCents;
          valueAtRisk.total += lotValueCents;
        } else {
          healthyLotsCount += 1;
          continue;
        }

        // Auto-quarantine check on sellable onHandQty
        const autoQuarantineTriggered =
          currentOnHand > 0 &&
          ((bucket === "EXPIRED" && policy.autoQuarantineExpired) ||
            (policy.autoQuarantineOnCriticalDays !== null &&
              daysUntilExpiry !== null &&
              daysUntilExpiry <= policy.autoQuarantineOnCriticalDays));

        if (autoQuarantineTriggered) {
          const movedQty = currentOnHand;
          const qUpdate = await tx.stockLot.updateMany({
            where: {
              id: lot.id,
              organizationId,
              onHandQty: movedQty,
            },
            data: {
              onHandQty: 0,
              quarantinedQty: { increment: movedQty },
            },
          });

          if (qUpdate.count === 1) {
            currentOnHand = 0;
            currentQuarantined += movedQty;
            autoQuarantinedLotsCount += 1;
            autoQuarantinedQty += movedQty;

            if (lot.item.trackInventory) {
              const bal = await tx.stockBalance.findUnique({
                where: {
                  organizationId_itemId_locationId: {
                    organizationId,
                    itemId: lot.itemId,
                    locationId: lot.locationId,
                  },
                },
              });
              if (bal) {
                const decrementBy = Math.min(bal.onHandQty, movedQty);
                const updatedBal = await tx.stockBalance.update({
                  where: { id: bal.id },
                  data: { onHandQty: { decrement: decrementBy } },
                });
                await tx.stockMovement.create({
                  data: {
                    organizationId,
                    itemId: lot.itemId,
                    locationId: lot.locationId,
                    type: StockMovementType.ADJUSTMENT,
                    quantityDelta: -decrementBy,
                    balanceAfter: updatedBal.onHandQty,
                    stockLotId: lot.id,
                    referenceType: "StockLot",
                    referenceId: lot.id,
                    reason: `Auto-quarantined ${movedQty} ${lot.item.unitOfMeasure} of expiring/expired lot ${lot.lotNumber}`,
                    actorUserId: actorUserId ?? null,
                  },
                });
              }
            }

            const qOutbox = await this.outboxService.emitEvent(tx, {
              organizationId,
              eventType: CommunicationEventType.STOCK_AUTO_QUARANTINED,
              severity: AlertSeverity.CRITICAL,
              sourceEntityType: "StockLot",
              sourceEntityId: lot.id,
              dedupeKey: `lot_quarantine:${lot.id}:${lot.expiresAt.toISOString().slice(0, 10)}`,
              subject: `Auto-quarantined lot ${lot.lotNumber} (${lot.item.sku})`,
              summaryText: `${movedQty} ${lot.item.unitOfMeasure} of ${lot.item.name} (SKU ${lot.item.sku}, lot ${lot.lotNumber}) at ${lot.location.name} was automatically moved to quarantine (expires ${lot.expiresAt.toISOString().slice(0, 10)}).`,
              payload: {
                stockLotId: lot.id,
                lotNumber: lot.lotNumber,
                itemId: lot.itemId,
                sku: lot.item.sku,
                itemName: lot.item.name,
                locationId: lot.locationId,
                locationCode: lot.location.code,
                locationName: lot.location.name,
                quarantinedQty: movedQty,
                valueAtRiskCents: movedQty * unitCost,
                expiresAt: lot.expiresAt.toISOString(),
                daysUntilExpiry,
              },
            });
            if (!qOutbox.deduplicated) {
              outboxEventsEmitted += 1;
            }
          }
        }

        // Alert severity & CommunicationEventType mapping
        const severity =
          bucket === "EXPIRED"
            ? ExpiryAlertSeverity.EXPIRED
            : bucket === "CRITICAL"
              ? ExpiryAlertSeverity.CRITICAL
              : ExpiryAlertSeverity.WARNING;

        const outboxEventType =
          bucket === "EXPIRED"
            ? CommunicationEventType.STOCK_EXPIRED
            : bucket === "CRITICAL"
              ? CommunicationEventType.STOCK_EXPIRY_CRITICAL
              : CommunicationEventType.STOCK_EXPIRY_WARNING;

        const outboxSeverity =
          bucket === "WARNING" ? AlertSeverity.WARNING : AlertSeverity.CRITICAL;

        const dedupeKey = `lot:${lot.id}:${severity}:${lot.expiresAt.toISOString().slice(0, 10)}`;
        const qtyAtRisk = currentOnHand + currentQuarantined;
        const valAtRiskCents = qtyAtRisk * unitCost;

        const existingAlert = await tx.stockExpiryAlert.findFirst({
          where: { organizationId, dedupeKey },
        });

        if (existingAlert) {
          if (
            existingAlert.status === ExpiryAlertStatus.OPEN ||
            existingAlert.status === ExpiryAlertStatus.ACKNOWLEDGED
          ) {
            await tx.stockExpiryAlert.update({
              where: { id: existingAlert.id },
              data: {
                daysUntilExpiry: daysUntilExpiry ?? 0,
                quantityAtRisk: qtyAtRisk,
                valueAtRiskCents: valAtRiskCents,
              },
            });
            alertsUpdated += 1;
          }
        } else {
          const outboxRes = await this.outboxService.emitEvent(tx, {
            organizationId,
            eventType: outboxEventType,
            severity: outboxSeverity,
            sourceEntityType: "StockLot",
            sourceEntityId: lot.id,
            dedupeKey,
            subject:
              bucket === "EXPIRED"
                ? `Expired stock alert: ${lot.item.sku} lot ${lot.lotNumber}`
                : `Stock expiry ${severity.toLowerCase()}: ${lot.item.sku} lot ${lot.lotNumber}`,
            summaryText: `Lot ${lot.lotNumber} of ${lot.item.name} (SKU ${lot.item.sku}) at ${lot.location.name} (${lot.location.code}) has ${qtyAtRisk} ${lot.item.unitOfMeasure} (${bucket}, ${daysUntilExpiry} day(s) relative to expiry ${lot.expiresAt.toISOString().slice(0, 10)}).`,
            payload: {
              stockLotId: lot.id,
              lotNumber: lot.lotNumber,
              itemId: lot.itemId,
              sku: lot.item.sku,
              itemName: lot.item.name,
              locationId: lot.locationId,
              locationCode: lot.location.code,
              locationName: lot.location.name,
              severity,
              expiresAt: lot.expiresAt.toISOString(),
              daysUntilExpiry: daysUntilExpiry ?? 0,
              onHandQty: currentOnHand,
              quarantinedQty: currentQuarantined,
              quantityAtRisk: qtyAtRisk,
              valueAtRiskCents: valAtRiskCents,
            },
          });

          if (!outboxRes.deduplicated) {
            outboxEventsEmitted += 1;
          }

          await tx.stockExpiryAlert.create({
            data: {
              organizationId,
              stockLotId: lot.id,
              itemId: lot.itemId,
              locationId: lot.locationId,
              severity,
              status: ExpiryAlertStatus.OPEN,
              dedupeKey,
              expiresAt: lot.expiresAt,
              daysUntilExpiry: daysUntilExpiry ?? 0,
              quantityAtRisk: qtyAtRisk,
              valueAtRiskCents: valAtRiskCents,
              outboxEventId: outboxRes.event.id,
            },
          });
          alertsCreated += 1;
        }
      }

      const scanSummary: ExpiryScanSummary = {
        organizationId,
        trigger,
        scannedAt: now.toISOString(),
        lotsScanned: lots.length,
        expiredLotsCount,
        criticalLotsCount,
        warningLotsCount,
        healthyLotsCount,
        alertsCreated,
        alertsUpdated,
        alertsAutoResolved,
        autoQuarantinedLotsCount,
        autoQuarantinedQty,
        outboxEventsEmitted,
        valueAtRiskCents: valueAtRisk,
      };

      await tx.stockExpiryPolicy.upsert({
        where: { organizationId },
        create: {
          organizationId,
          warningDays: policy.warningDays,
          criticalDays: policy.criticalDays,
          enforcementMode: policy.enforcementMode,
          autoQuarantineExpired: policy.autoQuarantineExpired,
          autoQuarantineOnCriticalDays: policy.autoQuarantineOnCriticalDays,
          scanIntervalMinutes: policy.scanIntervalMinutes,
          isScannerActive: policy.isScannerActive,
          lastScannedAt: now,
          lastScanSummary: scanSummary as unknown as Prisma.InputJsonValue,
        },
        update: {
          lastScannedAt: now,
          lastScanSummary: scanSummary as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: actorUserId ?? null,
          action: "inventory.expiry.scan_completed",
          resourceType: "StockExpiryPolicy",
          resourceId: organizationId,
          metadata: scanSummary as unknown as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return scanSummary;
    });

    this.analyticsService.captureDomainEvent({
      event: "inventory.expiry_scan_completed",
      distinctId: actorUserId ?? `system:${organizationId}`,
      organizationId,
      properties: {
        trigger,
        lots_scanned: summary.lotsScanned,
        expired_lots: summary.expiredLotsCount,
        critical_lots: summary.criticalLotsCount,
        alerts_created: summary.alertsCreated,
        auto_quarantined_qty: summary.autoQuarantinedQty,
      },
    });

    return summary;
  }

  async runManualScan(
    tenant: AuthenticatedOrganization,
    ipAddress?: string,
  ): Promise<ExpiryScanSummary> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    return this.runScanForOrganization(
      organizationId,
      "MANUAL",
      tenant.userId,
      ipAddress,
    );
  }

  // ==========================================
  // Alert Lifecycle Management
  // ==========================================

  async listAlerts(tenant: AuthenticatedOrganization, query: ListExpiryAlertsQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);

    const records = await this.prismaService.scoped.stockExpiryAlert.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.severity ? { severity: query.severity } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.itemId ? { itemId: query.itemId } : {}),
      },
      include: {
        stockLot: {
          select: {
            id: true,
            lotNumber: true,
            batchCode: true,
            onHandQty: true,
            quarantinedQty: true,
            expiresAt: true,
            unitCostCents: true,
          },
        },
        item: {
          select: { id: true, sku: true, name: true, unitOfMeasure: true },
        },
        location: {
          select: { id: true, code: true, name: true },
        },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ expiresAt: "asc" }, { createdAt: "desc" }],
    });

    const hasMore = records.length > take;
    const items = hasMore ? records.slice(0, take) : records;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return {
      organizationId: tenant.organizationId,
      items,
      nextCursor,
    };
  }

  async acknowledgeAlert(
    tenant: AuthenticatedOrganization,
    alertId: string,
    notes?: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const now = new Date();

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.stockExpiryAlert.findFirst({
        where: { id: alertId, organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Stock expiry alert was not found.");
      }
      if (existing.status !== ExpiryAlertStatus.OPEN) {
        throw new BadRequestException(
          `Alert cannot be acknowledged in status "${existing.status}".`,
        );
      }

      const updated = await tx.stockExpiryAlert.update({
        where: { id: existing.id },
        data: {
          status: ExpiryAlertStatus.ACKNOWLEDGED,
          acknowledgedAt: now,
          acknowledgedByUserId: tenant.userId,
          ...(notes ? { resolutionNotes: notes.trim() } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "inventory.expiry.alert_acknowledged",
          resourceType: "StockExpiryAlert",
          resourceId: existing.id,
          metadata: {
            severity: existing.severity,
            stockLotId: existing.stockLotId,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async resolveAlert(
    tenant: AuthenticatedOrganization,
    alertId: string,
    notes?: string,
    ipAddress?: string,
  ) {
    return this.transitionAlertTerminalState(
      tenant,
      alertId,
      ExpiryAlertStatus.RESOLVED,
      notes,
      ipAddress,
    );
  }

  async dismissAlert(
    tenant: AuthenticatedOrganization,
    alertId: string,
    notes?: string,
    ipAddress?: string,
  ) {
    return this.transitionAlertTerminalState(
      tenant,
      alertId,
      ExpiryAlertStatus.DISMISSED,
      notes,
      ipAddress,
    );
  }

  private async transitionAlertTerminalState(
    tenant: AuthenticatedOrganization,
    alertId: string,
    targetStatus: ExpiryAlertStatus,
    notes?: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const now = new Date();

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.stockExpiryAlert.findFirst({
        where: { id: alertId, organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Stock expiry alert was not found.");
      }
      if (
        existing.status !== ExpiryAlertStatus.OPEN &&
        existing.status !== ExpiryAlertStatus.ACKNOWLEDGED
      ) {
        throw new BadRequestException(
          `Alert is already in terminal status "${existing.status}".`,
        );
      }

      const updated = await tx.stockExpiryAlert.update({
        where: { id: existing.id },
        data: {
          status: targetStatus,
          resolvedAt: now,
          resolvedByUserId: tenant.userId,
          ...(notes ? { resolutionNotes: notes.trim() } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action:
            targetStatus === ExpiryAlertStatus.RESOLVED
              ? "inventory.expiry.alert_resolved"
              : "inventory.expiry.alert_dismissed",
          resourceType: "StockExpiryAlert",
          resourceId: existing.id,
          metadata: {
            severity: existing.severity,
            stockLotId: existing.stockLotId,
            ...(notes ? { notes: notes.trim() } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  // ==========================================
  // Lot Actions: Quarantine, Write-Off & Extend Expiry
  // ==========================================

  async quarantineLot(
    tenant: AuthenticatedOrganization,
    lotId: string,
    input: QuarantineLotInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const now = new Date();

    return this.prismaService.raw.$transaction(async (tx) => {
      const lot = await tx.stockLot.findFirst({
        where: { id: lotId, organizationId },
        include: {
          item: {
            select: {
              id: true,
              sku: true,
              name: true,
              unitOfMeasure: true,
              trackInventory: true,
              costPriceCents: true,
            },
          },
          location: {
            select: { id: true, code: true, name: true },
          },
        },
      });
      if (!lot) {
        throw new NotFoundException("Stock lot was not found.");
      }

      const qtyToQuarantine = input.quantity ?? lot.onHandQty;
      if (qtyToQuarantine <= 0 || qtyToQuarantine > lot.onHandQty) {
        throw new BadRequestException(
          `Requested quarantine quantity (${qtyToQuarantine}) exceeds available lot on-hand quantity (${lot.onHandQty}).`,
        );
      }

      const upd = await tx.stockLot.updateMany({
        where: {
          id: lot.id,
          organizationId,
          onHandQty: { gte: qtyToQuarantine },
        },
        data: {
          onHandQty: { decrement: qtyToQuarantine },
          quarantinedQty: { increment: qtyToQuarantine },
        },
      });
      if (upd.count !== 1) {
        throw new ConflictException(
          "Stock lot quantity changed concurrently. Retry operation.",
        );
      }

      if (lot.item.trackInventory) {
        const bal = await tx.stockBalance.findUnique({
          where: {
            organizationId_itemId_locationId: {
              organizationId,
              itemId: lot.itemId,
              locationId: lot.locationId,
            },
          },
        });
        if (bal) {
          const dec = Math.min(bal.onHandQty, qtyToQuarantine);
          const updatedBal = await tx.stockBalance.update({
            where: { id: bal.id },
            data: { onHandQty: { decrement: dec } },
          });
          await tx.stockMovement.create({
            data: {
              organizationId,
              itemId: lot.itemId,
              locationId: lot.locationId,
              type: StockMovementType.ADJUSTMENT,
              quantityDelta: -dec,
              balanceAfter: updatedBal.onHandQty,
              stockLotId: lot.id,
              referenceType: "StockLot",
              referenceId: lot.id,
              reason:
                input.reason?.trim() ||
                `Quarantined ${qtyToQuarantine} ${lot.item.unitOfMeasure} from lot ${lot.lotNumber}`,
              actorUserId: tenant.userId,
            },
          });
        }
      }

      const updatedLot = await tx.stockLot.findFirstOrThrow({
        where: { id: lot.id, organizationId },
      });

      const unitCost = lot.unitCostCents || lot.item.costPriceCents || 0;
      await this.outboxService.emitEvent(tx, {
        organizationId,
        eventType: CommunicationEventType.STOCK_AUTO_QUARANTINED,
        severity: AlertSeverity.WARNING,
        sourceEntityType: "StockLot",
        sourceEntityId: lot.id,
        dedupeKey: `lot_manual_quarantine:${lot.id}:${now.getTime()}`,
        subject: `Lot ${lot.lotNumber} (${lot.item.sku}) quarantined`,
        summaryText: `${qtyToQuarantine} ${lot.item.unitOfMeasure} of ${lot.item.name} (SKU ${lot.item.sku}, lot ${lot.lotNumber}) at ${lot.location.name} was moved to quarantine. Reason: ${input.reason?.trim() || "Expiry review"}.`,
        payload: {
          stockLotId: lot.id,
          lotNumber: lot.lotNumber,
          itemId: lot.itemId,
          sku: lot.item.sku,
          locationId: lot.locationId,
          locationCode: lot.location.code,
          quarantinedQty: qtyToQuarantine,
          valueAtRiskCents: qtyToQuarantine * unitCost,
          reason: input.reason?.trim() || "Manual quarantine",
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "inventory.expiry.lot_quarantined",
          resourceType: "StockLot",
          resourceId: lot.id,
          metadata: {
            lotNumber: lot.lotNumber,
            quantity: qtyToQuarantine,
            reason: input.reason?.trim() ?? null,
            notes: input.notes?.trim() ?? null,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updatedLot;
    });
  }

  async writeOffLot(
    tenant: AuthenticatedOrganization,
    lotId: string,
    input: WriteOffLotInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const now = new Date();

    if (input.quantity <= 0) {
      throw new BadRequestException("Write-off quantity must be greater than zero.");
    }

    const result = await this.prismaService.raw.$transaction(async (tx) => {
      const lot = await tx.stockLot.findFirst({
        where: { id: lotId, organizationId },
        include: {
          item: {
            select: {
              id: true,
              sku: true,
              name: true,
              unitOfMeasure: true,
              trackInventory: true,
              costPriceCents: true,
            },
          },
          location: {
            select: { id: true, code: true, name: true },
          },
        },
      });
      if (!lot) {
        throw new NotFoundException("Stock lot was not found.");
      }

      const source = input.source ?? "AUTO";
      let takeFromQuarantined = 0;
      let takeFromOnHand = 0;

      if (source === "QUARANTINED") {
        if (lot.quarantinedQty < input.quantity) {
          throw new BadRequestException(
            `Quarantined quantity (${lot.quarantinedQty}) is less than write-off quantity (${input.quantity}).`,
          );
        }
        takeFromQuarantined = input.quantity;
      } else if (source === "ON_HAND") {
        if (lot.onHandQty < input.quantity) {
          throw new BadRequestException(
            `On-hand quantity (${lot.onHandQty}) is less than write-off quantity (${input.quantity}).`,
          );
        }
        takeFromOnHand = input.quantity;
      } else {
        const totalAvail = lot.quarantinedQty + lot.onHandQty;
        if (totalAvail < input.quantity) {
          throw new BadRequestException(
            `Total available lot quantity (${totalAvail}) is less than write-off quantity (${input.quantity}).`,
          );
        }
        takeFromQuarantined = Math.min(lot.quarantinedQty, input.quantity);
        takeFromOnHand = input.quantity - takeFromQuarantined;
      }

      const upd = await tx.stockLot.updateMany({
        where: {
          id: lot.id,
          organizationId,
          onHandQty: { gte: takeFromOnHand },
          quarantinedQty: { gte: takeFromQuarantined },
        },
        data: {
          ...(takeFromOnHand > 0
            ? { onHandQty: { decrement: takeFromOnHand } }
            : {}),
          ...(takeFromQuarantined > 0
            ? { quarantinedQty: { decrement: takeFromQuarantined } }
            : {}),
          consumedQty: { increment: input.quantity },
        },
      });
      if (upd.count !== 1) {
        throw new ConflictException(
          "Stock lot quantities changed concurrently. Retry write-off.",
        );
      }

      let balanceAfter = 0;
      if (lot.item.trackInventory) {
        const bal = await tx.stockBalance.findUnique({
          where: {
            organizationId_itemId_locationId: {
              organizationId,
              itemId: lot.itemId,
              locationId: lot.locationId,
            },
          },
        });
        if (bal && takeFromOnHand > 0) {
          const dec = Math.min(bal.onHandQty, takeFromOnHand);
          const updatedBal = await tx.stockBalance.update({
            where: { id: bal.id },
            data: { onHandQty: { decrement: dec } },
          });
          balanceAfter = updatedBal.onHandQty;
        } else {
          balanceAfter = bal?.onHandQty ?? 0;
        }
      }

      const unitCostCents = lot.unitCostCents || lot.item.costPriceCents || 0;
      const totalLossCents = input.quantity * unitCostCents;
      const writeOffNumber = generateWriteOffNumber(now);

      const movement = await tx.stockMovement.create({
        data: {
          organizationId,
          itemId: lot.itemId,
          locationId: lot.locationId,
          type: StockMovementType.EXPIRY_WRITEOFF,
          quantityDelta: takeFromOnHand > 0 ? -takeFromOnHand : 0,
          balanceAfter,
          stockLotId: lot.id,
          referenceType: "StockExpiryWriteOff",
          referenceId: writeOffNumber,
          reason: `Expiry write-off (${writeOffNumber}) lot ${lot.lotNumber}: ${input.reason.trim()}`,
          actorUserId: tenant.userId,
        },
      });

      const writeOff = await tx.stockExpiryWriteOff.create({
        data: {
          organizationId,
          writeOffNumber,
          stockLotId: lot.id,
          itemId: lot.itemId,
          locationId: lot.locationId,
          stockMovementId: movement.id,
          quantity: input.quantity,
          unitCostCents,
          totalLossCents,
          reason: input.reason.trim(),
          disposalMethod: input.disposalMethod?.trim() || null,
          notes: input.notes?.trim() || null,
          writtenOffByUserId: tenant.userId,
          writtenOffAt: now,
        },
      });

      if (
        lot.onHandQty - takeFromOnHand === 0 &&
        lot.quarantinedQty - takeFromQuarantined === 0
      ) {
        await tx.stockExpiryAlert.updateMany({
          where: {
            organizationId,
            stockLotId: lot.id,
            status: {
              in: [ExpiryAlertStatus.OPEN, ExpiryAlertStatus.ACKNOWLEDGED],
            },
          },
          data: {
            status: ExpiryAlertStatus.RESOLVED,
            resolvedAt: now,
            resolvedByUserId: tenant.userId,
            resolutionNotes: `Written off under ${writeOffNumber}.`,
          },
        });
      }

      const outbox = await this.outboxService.emitEvent(tx, {
        organizationId,
        eventType: CommunicationEventType.STOCK_EXPIRY_WRITEOFF,
        severity: AlertSeverity.WARNING,
        sourceEntityType: "StockExpiryWriteOff",
        sourceEntityId: writeOff.id,
        dedupeKey: `writeoff:${writeOff.id}`,
        subject: `Expiry write-off ${writeOffNumber} (${lot.item.sku})`,
        summaryText: `Written off ${input.quantity} ${lot.item.unitOfMeasure} of ${lot.item.name} (lot ${lot.lotNumber}) at ${lot.location.name}. Loss value: ${(totalLossCents / 100).toFixed(2)}. Reason: ${input.reason.trim()}.`,
        payload: {
          writeOffId: writeOff.id,
          writeOffNumber,
          stockLotId: lot.id,
          lotNumber: lot.lotNumber,
          itemId: lot.itemId,
          sku: lot.item.sku,
          itemName: lot.item.name,
          locationId: lot.locationId,
          locationCode: lot.location.code,
          quantity: input.quantity,
          unitCostCents,
          totalLossCents,
          reason: input.reason.trim(),
          disposalMethod: writeOff.disposalMethod,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "inventory.expiry.lot_written_off",
          resourceType: "StockExpiryWriteOff",
          resourceId: writeOff.id,
          metadata: {
            writeOffNumber,
            stockLotId: lot.id,
            lotNumber: lot.lotNumber,
            quantity: input.quantity,
            totalLossCents,
            reason: writeOff.reason,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        writeOff,
        outboxEventId: outbox.event.id,
      };
    });

    this.analyticsService.captureDomainEvent({
      event: "inventory.expiry_write_off",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        write_off_id: result.writeOff.id,
        quantity: result.writeOff.quantity,
        total_loss_cents: result.writeOff.totalLossCents,
      },
    });

    return result.writeOff;
  }

  async listWriteOffs(
    tenant: AuthenticatedOrganization,
    query: { locationId?: string; itemId?: string; limit: number; cursor?: string },
  ) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);

    const records = await this.prismaService.scoped.stockExpiryWriteOff.findMany({
      where: {
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.itemId ? { itemId: query.itemId } : {}),
      },
      include: {
        stockLot: { select: { id: true, lotNumber: true, expiresAt: true } },
        item: { select: { id: true, sku: true, name: true, unitOfMeasure: true } },
        location: { select: { id: true, code: true, name: true } },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ writtenOffAt: "desc" }, { id: "desc" }],
    });

    const hasMore = records.length > take;
    const items = hasMore ? records.slice(0, take) : records;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return {
      organizationId: tenant.organizationId,
      items,
      nextCursor,
    };
  }

  async extendLotExpiry(
    tenant: AuthenticatedOrganization,
    lotId: string,
    input: ExtendLotExpiryInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const newExpiresAt = new Date(input.newExpiresAt);
    if (Number.isNaN(newExpiresAt.getTime())) {
      throw new BadRequestException("newExpiresAt must be a valid ISO timestamp.");
    }
    const now = new Date();

    return this.prismaService.raw.$transaction(async (tx) => {
      const lot = await tx.stockLot.findFirst({
        where: { id: lotId, organizationId },
        include: {
          item: {
            select: { expiryWarningDays: true, expiryCriticalDays: true },
          },
        },
      });
      if (!lot) {
        throw new NotFoundException("Stock lot was not found.");
      }

      if (
        lot.manufacturedAt &&
        newExpiresAt.getTime() <= lot.manufacturedAt.getTime()
      ) {
        throw new BadRequestException(
          "newExpiresAt must be later than manufacturedAt.",
        );
      }

      const previousExpiresAt = lot.expiresAt;
      const updated = await tx.stockLot.update({
        where: { id: lot.id },
        data: { expiresAt: newExpiresAt },
      });

      const policy = await resolveEffectiveExpiryPolicyTx(tx, organizationId);
      const warnDays = lot.item.expiryWarningDays ?? policy.warningDays;
      const critDays = lot.item.expiryCriticalDays ?? policy.criticalDays;
      const { bucket } = classifyLotExpiry(newExpiresAt, now, warnDays, critDays);

      if (bucket === "HEALTHY") {
        await tx.stockExpiryAlert.updateMany({
          where: {
            organizationId,
            stockLotId: lot.id,
            status: {
              in: [ExpiryAlertStatus.OPEN, ExpiryAlertStatus.ACKNOWLEDGED],
            },
          },
          data: {
            status: ExpiryAlertStatus.RESOLVED,
            resolvedAt: now,
            resolvedByUserId: tenant.userId,
            resolutionNotes: `Shelf life extended to ${newExpiresAt.toISOString().slice(0, 10)}: ${input.reason.trim()}`,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "inventory.expiry.lot_extended",
          resourceType: "StockLot",
          resourceId: lot.id,
          metadata: {
            lotNumber: lot.lotNumber,
            previousExpiresAt: previousExpiresAt?.toISOString() ?? null,
            newExpiresAt: newExpiresAt.toISOString(),
            reason: input.reason.trim(),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
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

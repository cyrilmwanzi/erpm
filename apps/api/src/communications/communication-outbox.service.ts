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
  CommunicationChannel,
  CommunicationEventType,
  OutboxDeliveryStatus,
  Prisma,
  TenantContext,
} from "@scace/db";
import { getEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { EmailService } from "../email/email.service.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import { RedisService } from "../redis/redis.service.js";
import type { AuthenticatedTenant } from "../tenancy/tenant.decorators.js";
import {
  assertSafeResolvedWebhookHost,
  decryptCommunicationSecret,
  encryptCommunicationSecret,
  escapeEmailHtml,
  generateWebhookSigningSecret,
  maskSecretTail,
  signWebhookPayload,
  validateWebhookDestinationUrl,
} from "./communications-security.utils.js";

export interface EmitOutboxEventInput {
  organizationId: string;
  eventType: CommunicationEventType;
  severity?: AlertSeverity;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  dedupeKey?: string | null;
  channelHints?: CommunicationChannel[];
  targetRoles?: string[];
  targetEmails?: string[];
  targetWebhookIds?: string[];
  subject: string;
  summaryText: string;
  payload: Record<string, unknown>;
  applyAlertRules?: boolean;
}

export interface CreateAlertRuleInput {
  name: string;
  eventType: CommunicationEventType;
  isActive?: boolean;
  channels: CommunicationChannel[];
  recipientRoles?: string[];
  recipientEmails?: string[];
  webhookIds?: string[];
  cooldownMinutes?: number;
}

export interface UpdateAlertRuleInput {
  name?: string;
  eventType?: CommunicationEventType;
  isActive?: boolean;
  channels?: CommunicationChannel[];
  recipientRoles?: string[];
  recipientEmails?: string[];
  webhookIds?: string[];
  cooldownMinutes?: number;
}

export interface CreateWebhookInput {
  name: string;
  url: string;
  eventTypes?: CommunicationEventType[];
  isActive?: boolean;
}

export interface UpdateWebhookInput {
  name?: string;
  url?: string;
  eventTypes?: CommunicationEventType[];
  isActive?: boolean;
}

export interface ListOutboxQuery {
  eventType?: CommunicationEventType;
  deliveryStatus?: OutboxDeliveryStatus;
  severity?: AlertSeverity;
  channel?: CommunicationChannel;
  limit: number;
  cursor?: string;
}

export interface ClaimOutboxInput {
  consumerId: string;
  eventTypes?: CommunicationEventType[];
  channel?: CommunicationChannel;
  limit?: number;
  leaseSeconds?: number;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function dedupeStrings(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const val of values ?? []) {
    const trimmed = val.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

function dedupeChannels(
  values: readonly CommunicationChannel[] | undefined,
): CommunicationChannel[] {
  const seen = new Set<CommunicationChannel>();
  const result: CommunicationChannel[] = [];
  for (const val of values ?? []) {
    if (!seen.has(val)) {
      seen.add(val);
      result.push(val);
    }
  }
  return result;
}

@Injectable()
export class CommunicationOutboxService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CommunicationOutboxService.name);
  private dispatchInterval: ReturnType<typeof setInterval> | null = null;
  private isTickRunning = false;

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redisService: RedisService,
    @Inject(EmailService) private readonly emailService: EmailService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  onModuleInit(): void {
    const env = getEnv();
    const enabled =
      env.NODE_ENV !== "test" && env.OUTBOX_DISPATCHER_ENABLED !== false;
    if (!enabled) {
      return;
    }

    this.dispatchInterval = setInterval(() => {
      void this.runBackgroundDispatchTick();
    }, 30_000);
    if (typeof this.dispatchInterval.unref === "function") {
      this.dispatchInterval.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.dispatchInterval) {
      clearInterval(this.dispatchInterval);
      this.dispatchInterval = null;
    }
  }

  private async runBackgroundDispatchTick(): Promise<void> {
    if (this.isTickRunning) {
      return;
    }
    this.isTickRunning = true;
    const lockKey = "comm:outbox:dispatcher-lock";
    try {
      await this.redisService.ensureConnected();
      const acquired = await this.redisService.client.set(
        lockKey,
        randomUUID(),
        "EX",
        25,
        "NX",
      );
      if (acquired !== "OK") {
        return;
      }
      await this.dispatchPendingEvents(25);
    } catch (error) {
      this.logger.warn(
        `Background outbox dispatch tick skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.isTickRunning = false;
    }
  }

  // ==========================================
  // Universal Outbox Event Emission Seam
  // ==========================================

  async emitEvent(
    txOrNull: Prisma.TransactionClient | null,
    input: EmitOutboxEventInput,
  ) {
    const db = txOrNull ?? this.prismaService.raw;
    const now = new Date();

    if (input.dedupeKey) {
      const existing = await db.communicationOutboxEvent.findFirst({
        where: {
          organizationId: input.organizationId,
          dedupeKey: input.dedupeKey,
        },
      });
      if (existing) {
        return { event: existing, deduplicated: true };
      }
    }

    const channels = [...(input.channelHints ?? [])];
    const targetRoles = [...(input.targetRoles ?? [])];
    const targetEmails = [...(input.targetEmails ?? [])];
    const targetWebhookIds = [...(input.targetWebhookIds ?? [])];

    if (input.applyAlertRules !== false) {
      const rules = await db.alertRule.findMany({
        where: {
          organizationId: input.organizationId,
          eventType: input.eventType,
          isActive: true,
        },
        orderBy: { createdAt: "asc" },
      });

      const triggeredRuleIds: string[] = [];
      for (const rule of rules) {
        const cooldownMs = Math.max(0, rule.cooldownMinutes) * 60_000;
        if (
          rule.lastTriggeredAt &&
          cooldownMs > 0 &&
          now.getTime() - rule.lastTriggeredAt.getTime() < cooldownMs
        ) {
          continue;
        }
        triggeredRuleIds.push(rule.id);
        channels.push(...rule.channels);
        targetRoles.push(...rule.recipientRoles);
        targetEmails.push(...rule.recipientEmails);
        targetWebhookIds.push(...rule.webhookIds);
      }

      if (triggeredRuleIds.length > 0) {
        await db.alertRule.updateMany({
          where: {
            id: { in: triggeredRuleIds },
            organizationId: input.organizationId,
          },
          data: { lastTriggeredAt: now },
        });
      }
    }

    const finalChannels = dedupeChannels(
      channels.length > 0 ? channels : [CommunicationChannel.IN_APP],
    );
    const finalRoles = dedupeStrings(targetRoles).map((r) => r.toLowerCase());
    const finalEmails = dedupeStrings(targetEmails).map((e) => e.toLowerCase());
    const finalWebhookIds = dedupeStrings(targetWebhookIds);

    // Resolve member emails matching targetRoles so downstream dispatchers receive complete recipient list
    if (finalRoles.length > 0 && finalChannels.includes(CommunicationChannel.EMAIL)) {
      const roleMembers = await db.member.findMany({
        where: {
          organizationId: input.organizationId,
          role: { in: finalRoles },
        },
        include: {
          user: { select: { email: true } },
        },
      });
      for (const m of roleMembers) {
        if (m.user?.email) {
          const email = m.user.email.trim().toLowerCase();
          if (email && !finalEmails.includes(email)) {
            finalEmails.push(email);
          }
        }
      }
    }

    try {
      const created = await db.communicationOutboxEvent.create({
        data: {
          organizationId: input.organizationId,
          eventType: input.eventType,
          severity: input.severity ?? AlertSeverity.INFO,
          sourceEntityType: input.sourceEntityType ?? null,
          sourceEntityId: input.sourceEntityId ?? null,
          dedupeKey: input.dedupeKey ?? null,
          channelHints: finalChannels,
          targetRoles: finalRoles,
          targetEmails: finalEmails,
          targetWebhookIds: finalWebhookIds,
          subject: input.subject.slice(0, 240),
          summaryText: input.summaryText.slice(0, 4000),
          payload: input.payload as Prisma.InputJsonValue,
          deliveryStatus: OutboxDeliveryStatus.PENDING,
          attemptCount: 0,
          nextRetryAt: now,
        },
      });

      return { event: created, deduplicated: false };
    } catch (error) {
      if (input.dedupeKey && isUniqueConstraintError(error)) {
        const raced = await db.communicationOutboxEvent.findFirst({
          where: {
            organizationId: input.organizationId,
            dedupeKey: input.dedupeKey,
          },
        });
        if (raced) {
          return { event: raced, deduplicated: true };
        }
      }
      throw error;
    }
  }

  // ==========================================
  // Immediate Hooks Dispatcher (Email & Signed Webhooks)
  // ==========================================

  async dispatchPendingEvents(
    limit = 25,
    explicitOrganizationId?: string,
  ): Promise<{
    processedCount: number;
    dispatchedCount: number;
    partialCount: number;
    failedCount: number;
    results: Array<{
      eventId: string;
      status: OutboxDeliveryStatus;
      attempts: number;
    }>;
  }> {
    const now = new Date();
    const candidates = await this.prismaService.raw.communicationOutboxEvent.findMany({
      where: {
        ...(explicitOrganizationId ? { organizationId: explicitOrganizationId } : {}),
        deliveryStatus: {
          in: [
            OutboxDeliveryStatus.PENDING,
            OutboxDeliveryStatus.FAILED,
            OutboxDeliveryStatus.PARTIAL,
          ],
        },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        AND: [
          {
            OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
          },
        ],
      },
      orderBy: [{ createdAt: "asc" }],
      take: Math.min(Math.max(limit, 1), 100),
    });

    let dispatchedCount = 0;
    let partialCount = 0;
    let failedCount = 0;
    const results: Array<{
      eventId: string;
      status: OutboxDeliveryStatus;
      attempts: number;
    }> = [];

    for (const candidate of candidates) {
      if (candidate.attemptCount >= candidate.maxAttempts) {
        continue;
      }

      const claimed = await this.prismaService.raw.communicationOutboxEvent.updateMany({
        where: {
          id: candidate.id,
          organizationId: candidate.organizationId,
          deliveryStatus: candidate.deliveryStatus,
          OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
        },
        data: {
          deliveryStatus: OutboxDeliveryStatus.PROCESSING,
          lockedBy: "scace-outbox-dispatcher",
          lockedUntil: new Date(Date.now() + 60_000),
        },
      });

      if (claimed.count !== 1) {
        continue;
      }

      const outcome = await this.executeSingleEventDelivery(candidate);
      results.push(outcome);
      if (outcome.status === OutboxDeliveryStatus.DISPATCHED) {
        dispatchedCount += 1;
      } else if (outcome.status === OutboxDeliveryStatus.PARTIAL) {
        partialCount += 1;
      } else if (outcome.status === OutboxDeliveryStatus.FAILED) {
        failedCount += 1;
      }
    }

    return {
      processedCount: results.length,
      dispatchedCount,
      partialCount,
      failedCount,
      results,
    };
  }

  private async executeSingleEventDelivery(event: {
    id: string;
    organizationId: string;
    eventType: CommunicationEventType;
    severity: AlertSeverity;
    channelHints: CommunicationChannel[];
    targetEmails: string[];
    targetWebhookIds: string[];
    subject: string;
    summaryText: string;
    payload: unknown;
    attemptCount: number;
    maxAttempts: number;
  }): Promise<{
    eventId: string;
    status: OutboxDeliveryStatus;
    attempts: number;
  }> {
    const env = getEnv();
    const allowPrivate = Boolean(env.COMMUNICATION_ALLOW_PRIVATE_WEBHOOKS);
    const now = new Date();
    let successCount = 0;
    let failureCount = 0;
    let deferredChannels = false;
    let attemptsMade = 0;
    let lastError: string | null = null;

    // 1. EMAIL hook
    if (
      event.channelHints.includes(CommunicationChannel.EMAIL) &&
      event.targetEmails.length > 0
    ) {
      const safeSubject = escapeEmailHtml(event.subject);
      const safeSummary = escapeEmailHtml(event.summaryText).replace(/\n/g, "<br/>");
      const safeSeverity = escapeEmailHtml(event.severity);
      const safeEventType = escapeEmailHtml(event.eventType);

      for (const email of event.targetEmails) {
        attemptsMade += 1;
        try {
          await this.emailService.sendEmail({
            to: email,
            subject: `[Scace ${event.severity}] ${event.subject}`,
            text: `${event.subject}\nSeverity: ${event.severity}\nEvent: ${event.eventType}\n\n${event.summaryText}`,
            html: `
              <div style="font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#111827;">
                <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.06em;color:#4b5563;">${safeEventType} &bull; ${safeSeverity}</p>
                <h2 style="margin:0 0 12px;font-size:20px;">${safeSubject}</h2>
                <p style="margin:0 0 16px;line-height:1.6;">${safeSummary}</p>
                <p style="margin:0;font-size:12px;color:#6b7280;">Generated at ${now.toISOString()}</p>
              </div>
            `,
          });

          await this.prismaService.raw.communicationDeliveryAttempt.create({
            data: {
              organizationId: event.organizationId,
              outboxEventId: event.id,
              channel: CommunicationChannel.EMAIL,
              target: email,
              status: "SENT",
            },
          });
          successCount += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          lastError = msg;
          failureCount += 1;
          await this.prismaService.raw.communicationDeliveryAttempt.create({
            data: {
              organizationId: event.organizationId,
              outboxEventId: event.id,
              channel: CommunicationChannel.EMAIL,
              target: email,
              status: "FAILED",
              errorMessage: msg.slice(0, 500),
            },
          });
        }
      }
    }

    // 2. SIGNED WEBHOOK hook
    if (event.channelHints.includes(CommunicationChannel.WEBHOOK)) {
      const webhooks = await this.prismaService.raw.communicationWebhook.findMany({
        where: {
          organizationId: event.organizationId,
          isActive: true,
          ...(event.targetWebhookIds.length > 0
            ? { id: { in: event.targetWebhookIds } }
            : {}),
        },
      });

      const matchingWebhooks = webhooks.filter(
        (wh) =>
          wh.eventTypes.length === 0 || wh.eventTypes.includes(event.eventType),
      );

      for (const wh of matchingWebhooks) {
        attemptsMade += 1;
        let httpStatus: number | null = null;
        try {
          await assertSafeResolvedWebhookHost(wh.url, allowPrivate);
          const secret = decryptCommunicationSecret(wh.signingSecretEncrypted);
          const timestampSec = Math.floor(Date.now() / 1000);
          const bodyString = JSON.stringify({
            id: event.id,
            organizationId: event.organizationId,
            eventType: event.eventType,
            severity: event.severity,
            subject: event.subject,
            summaryText: event.summaryText,
            payload: event.payload,
            occurredAt: now.toISOString(),
          });
          const signature = signWebhookPayload(secret, timestampSec, bodyString);

          const res = await fetch(wh.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "Scace-Communication-Outbox/1.0",
              "X-Scace-Delivery-Id": event.id,
              "X-Scace-Event": event.eventType,
              "X-Scace-Signature": signature,
            },
            body: bodyString,
            redirect: "error",
            signal: AbortSignal.timeout(env.COMMUNICATION_WEBHOOK_TIMEOUT_MS),
          });
          httpStatus = res.status;
          if (!res.ok) {
            throw new Error(`Webhook responded with HTTP ${res.status}.`);
          }

          await Promise.all([
            this.prismaService.raw.communicationDeliveryAttempt.create({
              data: {
                organizationId: event.organizationId,
                outboxEventId: event.id,
                channel: CommunicationChannel.WEBHOOK,
                target: wh.url,
                status: "SENT",
                httpStatus,
              },
            }),
            this.prismaService.raw.communicationWebhook.update({
              where: { id: wh.id },
              data: {
                failureCount: 0,
                lastSuccessAt: now,
                lastError: null,
              },
            }),
          ]);
          successCount += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          lastError = msg;
          failureCount += 1;
          await Promise.all([
            this.prismaService.raw.communicationDeliveryAttempt.create({
              data: {
                organizationId: event.organizationId,
                outboxEventId: event.id,
                channel: CommunicationChannel.WEBHOOK,
                target: wh.url,
                status: "FAILED",
                httpStatus,
                errorMessage: msg.slice(0, 500),
              },
            }),
            this.prismaService.raw.communicationWebhook.update({
              where: { id: wh.id },
              data: {
                failureCount: { increment: 1 },
                lastFailureAt: now,
                lastError: msg.slice(0, 500),
              },
            }),
          ]);
        }
      }
    }

    // 3. Deferred channels reserved for the upcoming dedicated Communication Module
    if (
      event.channelHints.includes(CommunicationChannel.SMS) ||
      event.channelHints.includes(CommunicationChannel.WHATSAPP) ||
      event.channelHints.includes(CommunicationChannel.IN_APP)
    ) {
      deferredChannels = true;
    }

    let nextStatus: OutboxDeliveryStatus;
    if (failureCount > 0 && successCount > 0) {
      nextStatus = OutboxDeliveryStatus.PARTIAL;
    } else if (failureCount > 0 && successCount === 0) {
      nextStatus = OutboxDeliveryStatus.FAILED;
    } else if (deferredChannels && successCount === 0) {
      // Remains PENDING so external SMS/WhatsApp/In-App module can claim & dispatch it,
      // unless there were only built-in hooks that already completed.
      nextStatus = OutboxDeliveryStatus.PENDING;
    } else if (deferredChannels && successCount > 0) {
      nextStatus = OutboxDeliveryStatus.PARTIAL;
    } else {
      nextStatus = OutboxDeliveryStatus.DISPATCHED;
    }

    const nextAttemptCount = event.attemptCount + 1;
    const backoffMinutes = Math.min(60, 2 ** Math.min(nextAttemptCount, 6));
    const shouldRetry =
      nextStatus === OutboxDeliveryStatus.FAILED &&
      nextAttemptCount < event.maxAttempts;

    await this.prismaService.raw.communicationOutboxEvent.update({
      where: { id: event.id },
      data: {
        deliveryStatus: nextStatus,
        attemptCount: nextAttemptCount,
        lockedUntil: null,
        lockedBy: null,
        lastError: lastError ? lastError.slice(0, 1000) : null,
        dispatchedAt:
          nextStatus === OutboxDeliveryStatus.DISPATCHED ? now : undefined,
        nextRetryAt: shouldRetry
          ? new Date(Date.now() + backoffMinutes * 60_000)
          : null,
      },
    });

    return {
      eventId: event.id,
      status: nextStatus,
      attempts: attemptsMade,
    };
  }

  // ==========================================
  // Outbox Query / Consumer Claim / Acknowledge APIs
  // ==========================================

  async listOutboxEvents(tenant: AuthenticatedTenant, query: ListOutboxQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);

    const records =
      await this.prismaService.scoped.communicationOutboxEvent.findMany({
        where: {
          ...(query.eventType ? { eventType: query.eventType } : {}),
          ...(query.deliveryStatus
            ? { deliveryStatus: query.deliveryStatus }
            : {}),
          ...(query.severity ? { severity: query.severity } : {}),
          ...(query.channel ? { channelHints: { has: query.channel } } : {}),
        },
        include: {
          deliveryAttempts: {
            orderBy: { attemptedAt: "desc" },
            take: 10,
          },
        },
        take: take + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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

  async getOutboxEvent(tenant: AuthenticatedTenant, eventId: string) {
    this.resolveVerifiedOrganizationId(tenant);
    const event =
      await this.prismaService.scoped.communicationOutboxEvent.findFirst({
        where: { id: eventId },
        include: {
          deliveryAttempts: {
            orderBy: { attemptedAt: "desc" },
          },
        },
      });
    if (!event) {
      throw new NotFoundException("Communication outbox event was not found.");
    }
    return event;
  }

  async claimOutboxEvents(
    tenant: AuthenticatedTenant,
    input: ClaimOutboxInput,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 120, 15), 900);
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + leaseSeconds * 1000);

    const candidates =
      await this.prismaService.raw.communicationOutboxEvent.findMany({
        where: {
          organizationId,
          deliveryStatus: {
            in: [
              OutboxDeliveryStatus.PENDING,
              OutboxDeliveryStatus.PARTIAL,
              OutboxDeliveryStatus.FAILED,
            ],
          },
          ...(input.eventTypes && input.eventTypes.length > 0
            ? { eventType: { in: input.eventTypes } }
            : {}),
          ...(input.channel ? { channelHints: { has: input.channel } } : {}),
          OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
        },
        orderBy: { createdAt: "asc" },
        take: limit,
      });

    const claimedIds: string[] = [];
    for (const c of candidates) {
      const upd =
        await this.prismaService.raw.communicationOutboxEvent.updateMany({
          where: {
            id: c.id,
            organizationId,
            deliveryStatus: c.deliveryStatus,
            OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
          },
          data: {
            deliveryStatus: OutboxDeliveryStatus.PROCESSING,
            lockedBy: input.consumerId.trim(),
            lockedUntil,
          },
        });
      if (upd.count === 1) {
        claimedIds.push(c.id);
      }
    }

    const claimedEvents =
      claimedIds.length > 0
        ? await this.prismaService.raw.communicationOutboxEvent.findMany({
            where: { id: { in: claimedIds }, organizationId },
            orderBy: { createdAt: "asc" },
          })
        : [];

    return {
      organizationId,
      consumerId: input.consumerId.trim(),
      leaseExpiresAt: lockedUntil,
      count: claimedEvents.length,
      items: claimedEvents,
    };
  }

  async acknowledgeOutboxEvent(
    tenant: AuthenticatedTenant,
    eventId: string,
    input: {
      status?: "DISPATCHED" | "ACKNOWLEDGED" | "FAILED" | "CANCELLED";
      channel?: CommunicationChannel;
      target?: string;
      providerMessageId?: string | null;
      errorMessage?: string | null;
    },
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing =
      await this.prismaService.raw.communicationOutboxEvent.findFirst({
        where: { id: eventId, organizationId },
      });
    if (!existing) {
      throw new NotFoundException("Communication outbox event was not found.");
    }

    const nextStatus =
      input.status === "DISPATCHED"
        ? OutboxDeliveryStatus.DISPATCHED
        : input.status === "FAILED"
          ? OutboxDeliveryStatus.FAILED
          : input.status === "CANCELLED"
            ? OutboxDeliveryStatus.CANCELLED
            : OutboxDeliveryStatus.ACKNOWLEDGED;

    const now = new Date();
    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      if (input.channel && input.target) {
        await tx.communicationDeliveryAttempt.create({
          data: {
            organizationId,
            outboxEventId: existing.id,
            channel: input.channel,
            target: input.target.trim(),
            status: nextStatus === OutboxDeliveryStatus.FAILED ? "FAILED" : "SENT",
            providerMessageId: input.providerMessageId ?? null,
            errorMessage: input.errorMessage ?? null,
          },
        });
      }

      const row = await tx.communicationOutboxEvent.update({
        where: { id: existing.id },
        data: {
          deliveryStatus: nextStatus,
          lockedUntil: null,
          lockedBy: null,
          ...(nextStatus === OutboxDeliveryStatus.DISPATCHED
            ? { dispatchedAt: existing.dispatchedAt ?? now }
            : {}),
          ...(nextStatus === OutboxDeliveryStatus.ACKNOWLEDGED
            ? {
                acknowledgedAt: now,
                acknowledgedByUserId: tenant.userId,
              }
            : {}),
          ...(input.errorMessage !== undefined
            ? { lastError: input.errorMessage }
            : {}),
        },
        include: {
          deliveryAttempts: { orderBy: { attemptedAt: "desc" } },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "communication.outbox.updated",
          resourceType: "CommunicationOutboxEvent",
          resourceId: existing.id,
          metadata: {
            eventType: existing.eventType,
            deliveryStatus: nextStatus,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return row;
    });

    return updated;
  }

  async retryOutboxEvent(
    tenant: AuthenticatedTenant,
    eventId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing =
      await this.prismaService.raw.communicationOutboxEvent.findFirst({
        where: { id: eventId, organizationId },
      });
    if (!existing) {
      throw new NotFoundException("Communication outbox event was not found.");
    }

    await this.prismaService.raw.communicationOutboxEvent.update({
      where: { id: existing.id },
      data: {
        deliveryStatus: OutboxDeliveryStatus.PENDING,
        nextRetryAt: new Date(),
        lockedUntil: null,
        lockedBy: null,
      },
    });

    const outcome = await this.executeSingleEventDelivery({
      ...existing,
      attemptCount: 0,
    });

    await this.prismaService.raw.auditLog.create({
      data: {
        organizationId,
        actorUserId: tenant.userId,
        action: "communication.outbox.retried",
        resourceType: "CommunicationOutboxEvent",
        resourceId: existing.id,
        metadata: {
          resultStatus: outcome.status,
          attempts: outcome.attempts,
        } as Prisma.InputJsonValue,
        ipAddress: ipAddress ?? null,
      },
    });

    return this.getOutboxEvent(tenant, existing.id);
  }

  // ==========================================
  // Alert Rules CRUD
  // ==========================================

  async listAlertRules(tenant: AuthenticatedTenant) {
    this.resolveVerifiedOrganizationId(tenant);
    const items = await this.prismaService.scoped.alertRule.findMany({
      orderBy: [{ eventType: "asc" }, { createdAt: "desc" }],
    });
    return {
      organizationId: tenant.organizationId,
      items,
    };
  }

  async createAlertRule(
    tenant: AuthenticatedTenant,
    input: CreateAlertRuleInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const webhookIds = dedupeStrings(input.webhookIds);

    if (webhookIds.length > 0) {
      const count = await this.prismaService.raw.communicationWebhook.count({
        where: { organizationId, id: { in: webhookIds } },
      });
      if (count !== webhookIds.length) {
        throw new BadRequestException(
          "One or more webhookIds do not belong to the active organization.",
        );
      }
    }

    return this.prismaService.raw.$transaction(async (tx) => {
      const created = await tx.alertRule.create({
        data: {
          organizationId,
          name: input.name.trim(),
          eventType: input.eventType,
          isActive: input.isActive ?? true,
          channels: dedupeChannels(input.channels),
          recipientRoles: dedupeStrings(input.recipientRoles).map((r) =>
            r.toLowerCase(),
          ),
          recipientEmails: dedupeStrings(input.recipientEmails).map((e) =>
            e.toLowerCase(),
          ),
          webhookIds,
          cooldownMinutes: input.cooldownMinutes ?? 1440,
          createdByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "communication.alert_rule.created",
          resourceType: "AlertRule",
          resourceId: created.id,
          metadata: {
            name: created.name,
            eventType: created.eventType,
            channels: created.channels,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return created;
    });
  }

  async updateAlertRule(
    tenant: AuthenticatedTenant,
    ruleId: string,
    input: UpdateAlertRuleInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing = await this.prismaService.raw.alertRule.findFirst({
      where: { id: ruleId, organizationId },
    });
    if (!existing) {
      throw new NotFoundException("Alert rule was not found.");
    }

    const webhookIds =
      input.webhookIds !== undefined ? dedupeStrings(input.webhookIds) : undefined;
    if (webhookIds && webhookIds.length > 0) {
      const count = await this.prismaService.raw.communicationWebhook.count({
        where: { organizationId, id: { in: webhookIds } },
      });
      if (count !== webhookIds.length) {
        throw new BadRequestException(
          "One or more webhookIds do not belong to the active organization.",
        );
      }
    }

    return this.prismaService.raw.$transaction(async (tx) => {
      const updated = await tx.alertRule.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.eventType !== undefined
            ? { eventType: input.eventType }
            : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.channels !== undefined
            ? { channels: dedupeChannels(input.channels) }
            : {}),
          ...(input.recipientRoles !== undefined
            ? {
                recipientRoles: dedupeStrings(input.recipientRoles).map((r) =>
                  r.toLowerCase(),
                ),
              }
            : {}),
          ...(input.recipientEmails !== undefined
            ? {
                recipientEmails: dedupeStrings(input.recipientEmails).map((e) =>
                  e.toLowerCase(),
                ),
              }
            : {}),
          ...(webhookIds !== undefined ? { webhookIds } : {}),
          ...(input.cooldownMinutes !== undefined
            ? { cooldownMinutes: input.cooldownMinutes }
            : {}),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "communication.alert_rule.updated",
          resourceType: "AlertRule",
          resourceId: updated.id,
          metadata: {
            name: updated.name,
            eventType: updated.eventType,
            isActive: updated.isActive,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async deleteAlertRule(
    tenant: AuthenticatedTenant,
    ruleId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing = await this.prismaService.raw.alertRule.findFirst({
      where: { id: ruleId, organizationId },
    });
    if (!existing) {
      throw new NotFoundException("Alert rule was not found.");
    }

    await this.prismaService.raw.$transaction(async (tx) => {
      await tx.alertRule.delete({ where: { id: existing.id } });
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "communication.alert_rule.deleted",
          resourceType: "AlertRule",
          resourceId: existing.id,
          metadata: {
            name: existing.name,
            eventType: existing.eventType,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });
    });

    return { deleted: true, id: existing.id };
  }

  // ==========================================
  // Signed Webhooks Management
  // ==========================================

  private serializeWebhook(wh: {
    id: string;
    organizationId: string;
    name: string;
    url: string;
    eventTypes: CommunicationEventType[];
    signingSecretHint: string;
    isActive: boolean;
    failureCount: number;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: wh.id,
      organizationId: wh.organizationId,
      name: wh.name,
      url: wh.url,
      eventTypes: wh.eventTypes,
      signingSecretHint: wh.signingSecretHint,
      isActive: wh.isActive,
      failureCount: wh.failureCount,
      lastSuccessAt: wh.lastSuccessAt,
      lastFailureAt: wh.lastFailureAt,
      lastError: wh.lastError,
      createdAt: wh.createdAt,
      updatedAt: wh.updatedAt,
    };
  }

  async listWebhooks(tenant: AuthenticatedTenant) {
    this.resolveVerifiedOrganizationId(tenant);
    const items = await this.prismaService.scoped.communicationWebhook.findMany({
      orderBy: { createdAt: "desc" },
    });
    return {
      organizationId: tenant.organizationId,
      items: items.map((w) => this.serializeWebhook(w)),
    };
  }

  async createWebhook(
    tenant: AuthenticatedTenant,
    input: CreateWebhookInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const env = getEnv();
    const normalizedUrl = validateWebhookDestinationUrl(
      input.url,
      Boolean(env.COMMUNICATION_ALLOW_PRIVATE_WEBHOOKS),
      env.NODE_ENV === "production",
    );

    const plaintextSecret = generateWebhookSigningSecret();
    const secretEncrypted = encryptCommunicationSecret(plaintextSecret);
    const secretHint = maskSecretTail(plaintextSecret);

    const created = await this.prismaService.raw.$transaction(async (tx) => {
      const row = await tx.communicationWebhook.create({
        data: {
          organizationId,
          name: input.name.trim(),
          url: normalizedUrl,
          eventTypes: input.eventTypes ?? [],
          signingSecretEncrypted: secretEncrypted,
          signingSecretHint: secretHint,
          isActive: input.isActive ?? true,
          createdByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "communication.webhook.created",
          resourceType: "CommunicationWebhook",
          resourceId: row.id,
          metadata: {
            name: row.name,
            url: row.url,
            eventTypes: row.eventTypes,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return row;
    });

    return {
      ...this.serializeWebhook(created),
      signingSecret: plaintextSecret,
    };
  }

  async updateWebhook(
    tenant: AuthenticatedTenant,
    webhookId: string,
    input: UpdateWebhookInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing =
      await this.prismaService.raw.communicationWebhook.findFirst({
        where: { id: webhookId, organizationId },
      });
    if (!existing) {
      throw new NotFoundException("Communication webhook was not found.");
    }

    const env = getEnv();
    const normalizedUrl =
      input.url !== undefined
        ? validateWebhookDestinationUrl(
            input.url,
            Boolean(env.COMMUNICATION_ALLOW_PRIVATE_WEBHOOKS),
            env.NODE_ENV === "production",
          )
        : undefined;

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const row = await tx.communicationWebhook.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(normalizedUrl !== undefined ? { url: normalizedUrl } : {}),
          ...(input.eventTypes !== undefined
            ? { eventTypes: input.eventTypes }
            : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "communication.webhook.updated",
          resourceType: "CommunicationWebhook",
          resourceId: row.id,
          metadata: {
            name: row.name,
            url: row.url,
            isActive: row.isActive,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return row;
    });

    return this.serializeWebhook(updated);
  }

  async rotateWebhookSecret(
    tenant: AuthenticatedTenant,
    webhookId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing =
      await this.prismaService.raw.communicationWebhook.findFirst({
        where: { id: webhookId, organizationId },
      });
    if (!existing) {
      throw new NotFoundException("Communication webhook was not found.");
    }

    const plaintextSecret = generateWebhookSigningSecret();
    const secretEncrypted = encryptCommunicationSecret(plaintextSecret);
    const secretHint = maskSecretTail(plaintextSecret);

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const row = await tx.communicationWebhook.update({
        where: { id: existing.id },
        data: {
          signingSecretEncrypted: secretEncrypted,
          signingSecretHint: secretHint,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "communication.webhook.secret_rotated",
          resourceType: "CommunicationWebhook",
          resourceId: row.id,
          metadata: { signingSecretHint: secretHint } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return row;
    });

    return {
      ...this.serializeWebhook(updated),
      signingSecret: plaintextSecret,
    };
  }

  async deleteWebhook(
    tenant: AuthenticatedTenant,
    webhookId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing =
      await this.prismaService.raw.communicationWebhook.findFirst({
        where: { id: webhookId, organizationId },
      });
    if (!existing) {
      throw new NotFoundException("Communication webhook was not found.");
    }

    await this.prismaService.raw.$transaction(async (tx) => {
      await tx.communicationWebhook.delete({ where: { id: existing.id } });
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "communication.webhook.deleted",
          resourceType: "CommunicationWebhook",
          resourceId: existing.id,
          metadata: { name: existing.name, url: existing.url } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });
    });

    return { deleted: true, id: existing.id };
  }

  async testWebhook(
    tenant: AuthenticatedTenant,
    webhookId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const wh = await this.prismaService.raw.communicationWebhook.findFirst({
      where: { id: webhookId, organizationId },
    });
    if (!wh) {
      throw new NotFoundException("Communication webhook was not found.");
    }

    const env = getEnv();
    const allowPrivate = Boolean(env.COMMUNICATION_ALLOW_PRIVATE_WEBHOOKS);
    await assertSafeResolvedWebhookHost(wh.url, allowPrivate);

    const secret = decryptCommunicationSecret(wh.signingSecretEncrypted);
    const timestampSec = Math.floor(Date.now() / 1000);
    const deliveryId = `test_${randomUUID()}`;
    const bodyString = JSON.stringify({
      id: deliveryId,
      organizationId,
      eventType: "COMMUNICATION_WEBHOOK_TEST",
      severity: "INFO",
      subject: "Scace Communication Webhook Verification",
      summaryText: "Synthetic connectivity test from Scace Communication Outbox.",
      payload: { test: true, webhookId: wh.id, webhookName: wh.name },
      occurredAt: new Date().toISOString(),
    });
    const signature = signWebhookPayload(secret, timestampSec, bodyString);

    let ok = false;
    let statusCode: number | null = null;
    let errorMessage: string | null = null;

    try {
      const res = await fetch(wh.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Scace-Communication-Outbox/1.0",
          "X-Scace-Delivery-Id": deliveryId,
          "X-Scace-Event": "COMMUNICATION_WEBHOOK_TEST",
          "X-Scace-Signature": signature,
        },
        body: bodyString,
        redirect: "error",
        signal: AbortSignal.timeout(env.COMMUNICATION_WEBHOOK_TIMEOUT_MS),
      });
      statusCode = res.status;
      ok = res.ok;
      if (!ok) {
        errorMessage = `Endpoint returned HTTP ${res.status}.`;
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    await this.prismaService.raw.auditLog.create({
      data: {
        organizationId,
        actorUserId: tenant.userId,
        action: "communication.webhook.tested",
        resourceType: "CommunicationWebhook",
        resourceId: wh.id,
        metadata: {
          ok,
          statusCode,
          ...(errorMessage ? { errorMessage } : {}),
        } as Prisma.InputJsonValue,
        ipAddress: ipAddress ?? null,
      },
    });

    this.analyticsService.captureDomainEvent({
      event: "communication.webhook_tested",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        webhook_id: wh.id,
        ok,
        status_code: statusCode,
      },
    });

    return {
      webhookId: wh.id,
      deliveryId,
      ok,
      statusCode,
      errorMessage,
    };
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedTenant): string {
    const contextOrgId = TenantContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active tenant context mismatch.");
    }
    return tenant.organizationId;
  }
}

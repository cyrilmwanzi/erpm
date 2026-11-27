import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { CrmWebhookStatus, type Prisma } from "@scace/db";
import type { IncomingHttpHeaders } from "node:http";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import {
  decryptCrmSecret,
  verifyHmacSha256Signature,
} from "./crm-security.utils.js";

export interface ListWebhookEventsQuery {
  eventType?: string;
  status?: CrmWebhookStatus;
  limit: number;
  cursor?: string;
}

function readHeader(
  headers: IncomingHttpHeaders,
  names: string[],
): string | undefined {
  for (const name of names) {
    const val = headers[name.toLowerCase()];
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
    if (Array.isArray(val) && val[0]) {
      return val[0].trim();
    }
  }
  return undefined;
}

@Injectable()
export class CrmWebhookService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  async ingestWebhook(
    organizationId: string,
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
    parsedBody: unknown,
    ipAddress?: string,
  ) {
    if (!parsedBody || typeof parsedBody !== "object") {
      throw new BadRequestException("Webhook payload must be a JSON object.");
    }

    const conn = await this.prismaService.raw.crmConnection.findFirst({
      where: { organizationId },
    });

    if (!conn || !conn.isEnabled) {
      throw new NotFoundException(
        "Active CustomerMates CRM connection not found for organization.",
      );
    }

    if (!conn.webhookSecretEncrypted) {
      throw new UnauthorizedException(
        "Webhook signing secret is not configured for this organization.",
      );
    }

    const secret = decryptCrmSecret(conn.webhookSecretEncrypted);
    const signatureHeader = readHeader(headers, [
      "x-customermates-signature",
      "x-webhook-signature",
      "x-signature-256",
      "x-hub-signature-256",
    ]);

    const signatureValid = verifyHmacSha256Signature(
      rawBody,
      secret,
      signatureHeader,
    );

    if (!signatureValid) {
      throw new UnauthorizedException("Invalid CustomerMates webhook signature.");
    }

    const bodyRecord = parsedBody as Record<string, unknown>;
    const deliveryId =
      readHeader(headers, [
        "x-customermates-delivery",
        "x-webhook-id",
        "x-delivery-id",
      ]) ??
      (typeof bodyRecord.deliveryId === "string"
        ? bodyRecord.deliveryId.trim()
        : typeof bodyRecord.id === "string"
          ? bodyRecord.id.trim()
          : null);

    const eventType =
      (typeof bodyRecord.event === "string"
        ? bodyRecord.event
        : typeof bodyRecord.eventType === "string"
          ? bodyRecord.eventType
          : typeof bodyRecord.type === "string"
            ? bodyRecord.type
            : "unknown"
      )
        .trim()
        .slice(0, 120) || "unknown";

    const dataObj =
      bodyRecord.data && typeof bodyRecord.data === "object"
        ? (bodyRecord.data as Record<string, unknown>)
        : bodyRecord;

    const externalEntityType =
      typeof bodyRecord.entityType === "string"
        ? bodyRecord.entityType.slice(0, 80)
        : typeof dataObj.entityType === "string"
          ? dataObj.entityType.slice(0, 80)
          : eventType.includes(".")
            ? eventType.split(".")[0] ?? null
            : null;

    const externalEntityId =
      typeof bodyRecord.entityId === "string"
        ? bodyRecord.entityId.slice(0, 128)
        : typeof dataObj.id === "string"
          ? dataObj.id.slice(0, 128)
          : null;

    if (deliveryId) {
      const duplicate = await this.prismaService.raw.crmWebhookEvent.findFirst({
        where: { organizationId, deliveryId },
        select: { id: true, status: true },
      });
      if (duplicate) {
        return {
          accepted: true,
          duplicate: true,
          eventId: duplicate.id,
          status: duplicate.status,
        };
      }
    }

    const saved = await this.prismaService.raw.$transaction(async (tx) => {
      const created = await tx.crmWebhookEvent.create({
        data: {
          organizationId,
          deliveryId,
          eventType,
          externalEntityType,
          externalEntityId,
          signatureValid: true,
          status: CrmWebhookStatus.PROCESSED,
          payload: bodyRecord as Prisma.InputJsonValue,
          processedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          action: "crm.webhook.received",
          resourceType: "CrmWebhookEvent",
          resourceId: created.id,
          metadata: {
            eventType,
            deliveryId,
            externalEntityType,
            externalEntityId,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return created;
    });

    return {
      accepted: true,
      duplicate: false,
      eventId: saved.id,
      eventType: saved.eventType,
      status: saved.status,
    };
  }

  async listWebhookEvents(
    tenant: AuthenticatedOrganization,
    query: ListWebhookEventsQuery,
  ) {
    const take = Math.min(Math.max(query.limit, 1), 100);
    const items = await this.prismaService.scoped.crmWebhookEvent.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(query.eventType ? { eventType: query.eventType } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    });

    const hasMore = items.length > take;
    const slice = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? (slice[slice.length - 1]?.id ?? null) : null;

    return {
      organizationId: tenant.organizationId,
      items: slice,
      nextCursor,
    };
  }
}

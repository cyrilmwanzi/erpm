import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  AlertSeverity,
  CommunicationChannel,
  CommunicationEventType,
  OutboxDeliveryStatus,
} from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredBillingFeature,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { CommunicationOutboxService } from "./communication-outbox.service.js";

const eventTypeEnum = z.enum([
  CommunicationEventType.STOCK_EXPIRY_WARNING,
  CommunicationEventType.STOCK_EXPIRY_CRITICAL,
  CommunicationEventType.STOCK_EXPIRED,
  CommunicationEventType.STOCK_AUTO_QUARANTINED,
  CommunicationEventType.STOCK_EXPIRY_WRITEOFF,
  CommunicationEventType.SCHEDULED_REPORT_READY,
  CommunicationEventType.ON_DEMAND_REPORT_DISPATCH,
]);

const channelEnum = z.enum([
  CommunicationChannel.SMS,
  CommunicationChannel.WHATSAPP,
  CommunicationChannel.EMAIL,
  CommunicationChannel.WEBHOOK,
  CommunicationChannel.IN_APP,
]);

const deliveryStatusEnum = z.enum([
  OutboxDeliveryStatus.PENDING,
  OutboxDeliveryStatus.PROCESSING,
  OutboxDeliveryStatus.DISPATCHED,
  OutboxDeliveryStatus.PARTIAL,
  OutboxDeliveryStatus.FAILED,
  OutboxDeliveryStatus.ACKNOWLEDGED,
  OutboxDeliveryStatus.CANCELLED,
]);

const severityEnum = z.enum([
  AlertSeverity.INFO,
  AlertSeverity.WARNING,
  AlertSeverity.CRITICAL,
]);

const listOutboxQuerySchema = z.object({
  eventType: eventTypeEnum.optional(),
  deliveryStatus: deliveryStatusEnum.optional(),
  severity: severityEnum.optional(),
  channel: channelEnum.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const dispatchOutboxSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
});

const claimOutboxSchema = z.object({
  consumerId: z.string().trim().min(1).max(120),
  eventTypes: z.array(eventTypeEnum).max(20).optional(),
  channel: channelEnum.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  leaseSeconds: z.number().int().min(15).max(900).optional(),
});

const acknowledgeOutboxSchema = z.object({
  status: z
    .enum(["DISPATCHED", "ACKNOWLEDGED", "FAILED", "CANCELLED"])
    .optional(),
  channel: channelEnum.optional(),
  target: z.string().trim().min(1).max(320).optional(),
  providerMessageId: z.string().trim().max(200).nullable().optional(),
  errorMessage: z.string().trim().max(1000).nullable().optional(),
});

const createAlertRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  eventType: eventTypeEnum,
  isActive: z.boolean().optional(),
  channels: z.array(channelEnum).min(1).max(5),
  recipientRoles: z
    .array(z.enum(["owner", "admin", "manager", "member", "viewer"]))
    .max(5)
    .optional(),
  recipientEmails: z.array(z.string().trim().email()).max(50).optional(),
  webhookIds: z.array(z.string().trim().min(1)).max(20).optional(),
  cooldownMinutes: z.number().int().min(0).max(43_200).optional(),
});

const updateAlertRuleSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  eventType: eventTypeEnum.optional(),
  isActive: z.boolean().optional(),
  channels: z.array(channelEnum).min(1).max(5).optional(),
  recipientRoles: z
    .array(z.enum(["owner", "admin", "manager", "member", "viewer"]))
    .max(5)
    .optional(),
  recipientEmails: z.array(z.string().trim().email()).max(50).optional(),
  webhookIds: z.array(z.string().trim().min(1)).max(20).optional(),
  cooldownMinutes: z.number().int().min(0).max(43_200).optional(),
});

const createWebhookSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().url().max(500),
  eventTypes: z.array(eventTypeEnum).max(20).optional(),
  isActive: z.boolean().optional(),
});

const updateWebhookSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  url: z.string().trim().url().max(500).optional(),
  eventTypes: z.array(eventTypeEnum).max(20).optional(),
  isActive: z.boolean().optional(),
});

@Controller("api/v1/communications")
@RequireActiveOrganization()
@RequiredBillingFeature("communications")
export class CommunicationsController {
  constructor(
    @Inject(CommunicationOutboxService)
    private readonly outboxService: CommunicationOutboxService,
  ) {}

  @Get("outbox")
  @RequiredOrgPermissions({ communication: ["read"] })
  async listOutboxEvents(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listOutboxQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid outbox query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.outboxService.listOutboxEvents(tenant, parsed.data);
  }

  @Get("outbox/:eventId")
  @RequiredOrgPermissions({ communication: ["read"] })
  async getOutboxEvent(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("eventId") eventId: string,
  ) {
    return this.outboxService.getOutboxEvent(tenant, eventId);
  }

  @Post("outbox/dispatch")
  @RequiredOrgPermissions({ communication: ["dispatch"] })
  async dispatchOutboxNow(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
  ) {
    const parsed = dispatchOutboxSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid outbox dispatch payload.",
        issues: parsed.error.issues,
      });
    }
    return this.outboxService.dispatchPendingEvents(
      parsed.data.limit,
      tenant.organizationId,
    );
  }

  @Post("outbox/claim")
  @RequiredOrgPermissions({ communication: ["dispatch"] })
  async claimOutboxEvents(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
  ) {
    const parsed = claimOutboxSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid outbox claim payload.",
        issues: parsed.error.issues,
      });
    }
    return this.outboxService.claimOutboxEvents(tenant, parsed.data);
  }

  @Post("outbox/:eventId/acknowledge")
  @RequiredOrgPermissions({ communication: ["dispatch"] })
  async acknowledgeOutboxEvent(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("eventId") eventId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = acknowledgeOutboxSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid outbox acknowledgment payload.",
        issues: parsed.error.issues,
      });
    }
    return this.outboxService.acknowledgeOutboxEvent(
      tenant,
      eventId,
      parsed.data,
      req.ip,
    );
  }

  @Post("outbox/:eventId/retry")
  @RequiredOrgPermissions({ communication: ["dispatch"] })
  async retryOutboxEvent(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("eventId") eventId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.outboxService.retryOutboxEvent(tenant, eventId, req.ip);
  }

  @Get("rules")
  @RequiredOrgPermissions({ communication: ["read"] })
  async listAlertRules(@CurrentOrganization() tenant: AuthenticatedOrganization) {
    return this.outboxService.listAlertRules(tenant);
  }

  @Post("rules")
  @RequiredOrgPermissions({ communication: ["manage"] })
  async createAlertRule(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createAlertRuleSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid alert rule payload.",
        issues: parsed.error.issues,
      });
    }
    return this.outboxService.createAlertRule(tenant, parsed.data, req.ip);
  }

  @Patch("rules/:ruleId")
  @RequiredOrgPermissions({ communication: ["manage"] })
  async updateAlertRule(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("ruleId") ruleId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateAlertRuleSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid alert rule update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.outboxService.updateAlertRule(
      tenant,
      ruleId,
      parsed.data,
      req.ip,
    );
  }

  @Delete("rules/:ruleId")
  @RequiredOrgPermissions({ communication: ["manage"] })
  async deleteAlertRule(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("ruleId") ruleId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.outboxService.deleteAlertRule(tenant, ruleId, req.ip);
  }

  @Get("webhooks")
  @RequiredOrgPermissions({ communication: ["read"] })
  async listWebhooks(@CurrentOrganization() tenant: AuthenticatedOrganization) {
    return this.outboxService.listWebhooks(tenant);
  }

  @Post("webhooks")
  @RequiredOrgPermissions({ communication: ["manage"] })
  async createWebhook(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createWebhookSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid webhook payload.",
        issues: parsed.error.issues,
      });
    }
    return this.outboxService.createWebhook(tenant, parsed.data, req.ip);
  }

  @Patch("webhooks/:webhookId")
  @RequiredOrgPermissions({ communication: ["manage"] })
  async updateWebhook(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("webhookId") webhookId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateWebhookSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid webhook update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.outboxService.updateWebhook(
      tenant,
      webhookId,
      parsed.data,
      req.ip,
    );
  }

  @Post("webhooks/:webhookId/rotate-secret")
  @RequiredOrgPermissions({ communication: ["manage"] })
  async rotateWebhookSecret(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("webhookId") webhookId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.outboxService.rotateWebhookSecret(tenant, webhookId, req.ip);
  }

  @Post("webhooks/:webhookId/test")
  @RequiredOrgPermissions({ communication: ["manage"] })
  async testWebhook(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("webhookId") webhookId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.outboxService.testWebhook(tenant, webhookId, req.ip);
  }

  @Delete("webhooks/:webhookId")
  @RequiredOrgPermissions({ communication: ["manage"] })
  async deleteWebhook(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("webhookId") webhookId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.outboxService.deleteWebhook(tenant, webhookId, req.ip);
  }
}

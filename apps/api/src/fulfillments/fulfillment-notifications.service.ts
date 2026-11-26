import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  CommunicationChannel,
  NotificationDeliveryStatus,
  NotificationEventType,
  Prisma,
  TenantContext,
} from "@scace/db";
import { CrmConnectionService } from "../crm/crm-connection.service.js";
import {
  CustomerMatesClient,
  type CustomerMatesConnectionContext,
} from "../crm/customermates.client.js";
import { PrismaService } from "../database/prisma.service.js";
import { EmailService } from "../email/email.service.js";
import type { AuthenticatedTenant } from "../tenancy/tenant.decorators.js";

export interface UpsertNotificationTemplateInput {
  eventType: NotificationEventType;
  channel: CommunicationChannel;
  name?: string;
  subject?: string | null;
  body: string;
  isActive?: boolean;
}

export interface DispatchFulfillmentNotificationInput {
  fulfillmentId: string;
  eventType: NotificationEventType;
  channel?: CommunicationChannel;
  triggerSource?: "AUTO" | "MANUAL";
  staffJobId?: string | null;
  jobTitle?: string | null;
  customSubject?: string | null;
  customMessage?: string | null;
  overrideDisabled?: boolean;
}

export interface ListNotificationsQuery {
  fulfillmentId?: string;
  orderId?: string;
  customerId?: string;
  eventType?: NotificationEventType;
  channel?: CommunicationChannel;
  status?: NotificationDeliveryStatus;
  limit: number;
  cursor?: string;
}

interface DefaultTemplateDef {
  eventType: NotificationEventType;
  channel: CommunicationChannel;
  name: string;
  subject: string | null;
  body: string;
}

export const SUPPORTED_PLACEHOLDERS = [
  "{customer_name}",
  "{order_id}",
  "{order_number}",
  "{fulfillment_number}",
  "{fulfillment_type}",
  "{pickup_time}",
  "{delivery_window}",
  "{courier_name}",
  "{courier_phone}",
  "{job_title}",
  "{location_name}",
  "{status}",
] as const;

const DEFAULT_TEMPLATES: DefaultTemplateDef[] = [
  // PREORDER_READY
  {
    eventType: NotificationEventType.PREORDER_READY,
    channel: CommunicationChannel.SMS,
    name: "Preorder Ready (SMS)",
    subject: null,
    body: "Hi {customer_name}, your preorder {order_number} is now READY at {location_name}. Pickup slot: {pickup_time}.",
  },
  {
    eventType: NotificationEventType.PREORDER_READY,
    channel: CommunicationChannel.WHATSAPP,
    name: "Preorder Ready (WhatsApp)",
    subject: null,
    body: "Hello {customer_name}! Your preorder *{order_number}* is ready at {location_name}. Scheduled time: {pickup_time}.",
  },
  {
    eventType: NotificationEventType.PREORDER_READY,
    channel: CommunicationChannel.EMAIL,
    name: "Preorder Ready (Email)",
    subject: "Your preorder {order_number} is ready",
    body: "Hi {customer_name},\n\nGood news! Your preorder {order_number} ({fulfillment_number}) is now ready at {location_name}.\n\nScheduled time: {pickup_time}\n\nThank you for your order!",
  },
  // JOB_COMPLETED
  {
    eventType: NotificationEventType.JOB_COMPLETED,
    channel: CommunicationChannel.SMS,
    name: "Staff Job Completed (SMS)",
    subject: null,
    body: "Hi {customer_name}, preparation task '{job_title}' for order {order_number} has been completed.",
  },
  {
    eventType: NotificationEventType.JOB_COMPLETED,
    channel: CommunicationChannel.WHATSAPP,
    name: "Staff Job Completed (WhatsApp)",
    subject: null,
    body: "Hi {customer_name}, our team just finished '{job_title}' for your order *{order_number}*. Current status: {status}.",
  },
  {
    eventType: NotificationEventType.JOB_COMPLETED,
    channel: CommunicationChannel.EMAIL,
    name: "Staff Job Completed (Email)",
    subject: "Update on order {order_number}: {job_title} completed",
    body: "Hi {customer_name},\n\nThe preparation job '{job_title}' for order {order_number} has been marked completed by our staff.\n\nCurrent fulfillment status: {status}.",
  },
  // DELIVERY_OUT_FOR_DELIVERY
  {
    eventType: NotificationEventType.DELIVERY_OUT_FOR_DELIVERY,
    channel: CommunicationChannel.SMS,
    name: "Out for Delivery (SMS)",
    subject: null,
    body: "Hi {customer_name}, order {order_number} is out for delivery with {courier_name} (window: {delivery_window}).",
  },
  {
    eventType: NotificationEventType.DELIVERY_OUT_FOR_DELIVERY,
    channel: CommunicationChannel.WHATSAPP,
    name: "Out for Delivery (WhatsApp)",
    subject: null,
    body: "Hi {customer_name}, your order *{order_number}* is on the way! Courier: {courier_name}. Expected window: {delivery_window}.",
  },
  {
    eventType: NotificationEventType.DELIVERY_OUT_FOR_DELIVERY,
    channel: CommunicationChannel.EMAIL,
    name: "Out for Delivery (Email)",
    subject: "Order {order_number} is out for delivery",
    body: "Hi {customer_name},\n\nYour order {order_number} is now out for delivery.\n\nCourier: {courier_name} ({courier_phone})\nDelivery Window: {delivery_window}",
  },
  // DELIVERY_DELIVERED
  {
    eventType: NotificationEventType.DELIVERY_DELIVERED,
    channel: CommunicationChannel.SMS,
    name: "Delivered (SMS)",
    subject: null,
    body: "Hi {customer_name}, order {order_number} has been delivered. Thank you for choosing us!",
  },
  {
    eventType: NotificationEventType.DELIVERY_DELIVERED,
    channel: CommunicationChannel.WHATSAPP,
    name: "Delivered (WhatsApp)",
    subject: null,
    body: "Hi {customer_name}, your order *{order_number}* has been delivered! Thank you for shopping with us.",
  },
  {
    eventType: NotificationEventType.DELIVERY_DELIVERED,
    channel: CommunicationChannel.EMAIL,
    name: "Delivered (Email)",
    subject: "Order {order_number} has been delivered",
    body: "Hi {customer_name},\n\nYour order {order_number} has been successfully delivered.\n\nThank you for your business!",
  },
  // CUSTOM
  {
    eventType: NotificationEventType.CUSTOM,
    channel: CommunicationChannel.SMS,
    name: "Custom Order Update (SMS)",
    subject: null,
    body: "Hi {customer_name}, update on your order {order_number}: current status is {status}.",
  },
  {
    eventType: NotificationEventType.CUSTOM,
    channel: CommunicationChannel.WHATSAPP,
    name: "Custom Order Update (WhatsApp)",
    subject: null,
    body: "Hi {customer_name}, here is an update on order *{order_number}*: current status is {status}.",
  },
  {
    eventType: NotificationEventType.CUSTOM,
    channel: CommunicationChannel.EMAIL,
    name: "Custom Order Update (Email)",
    subject: "Update on order {order_number}",
    body: "Hi {customer_name},\n\nHere is an update regarding your order {order_number} at {location_name}.\n\nCurrent status: {status}",
  },
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatWindow(
  start: Date | null | undefined,
  end: Date | null | undefined,
  fallback?: Date | null,
): string {
  const fmt = (d: Date) =>
    `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
  if (start && end) {
    return `${fmt(start)} - ${end.toISOString().slice(11, 16)} UTC`;
  }
  if (start) return fmt(start);
  if (fallback) return fmt(fallback);
  return "TBD";
}

function interpolateTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let rendered = template;
  for (const [key, value] of Object.entries(vars)) {
    rendered = rendered.split(`{${key}}`).join(value);
  }
  return rendered;
}

@Injectable()
export class FulfillmentNotificationsService {
  private readonly logger = new Logger(FulfillmentNotificationsService.name);

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(CrmConnectionService)
    private readonly crmConnectionService: CrmConnectionService,
    @Inject(CustomerMatesClient)
    private readonly customerMatesClient: CustomerMatesClient,
    @Inject(EmailService) private readonly emailService: EmailService,
  ) {}

  async listTemplates(tenant: AuthenticatedTenant) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const customRows = await this.prismaService.scoped.notificationTemplate.findMany({
      where: { organizationId },
      orderBy: [{ eventType: "asc" }, { channel: "asc" }],
    });

    const customByKey = new Map(
      customRows.map((row) => [`${row.eventType}:${row.channel}`, row]),
    );

    const items = DEFAULT_TEMPLATES.map((def) => {
      const saved = customByKey.get(`${def.eventType}:${def.channel}`);
      if (saved) {
        return {
          ...saved,
          isDefault: false,
        };
      }
      return {
        id: null,
        organizationId,
        eventType: def.eventType,
        channel: def.channel,
        name: def.name,
        subject: def.subject,
        body: def.body,
        isActive: true,
        isDefault: true,
        updatedAt: null,
      };
    });

    return {
      organizationId,
      supportedPlaceholders: [...SUPPORTED_PLACEHOLDERS],
      items,
    };
  }

  async upsertTemplate(
    tenant: AuthenticatedTenant,
    input: UpsertNotificationTemplateInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const def = DEFAULT_TEMPLATES.find(
      (d) => d.eventType === input.eventType && d.channel === input.channel,
    );

    const name = input.name?.trim() || def?.name || `${input.eventType} (${input.channel})`;
    const subject =
      input.channel === CommunicationChannel.EMAIL
        ? input.subject !== undefined
          ? input.subject?.trim() || null
          : def?.subject ?? null
        : null;

    return this.prismaService.raw.$transaction(async (tx) => {
      const saved = await tx.notificationTemplate.upsert({
        where: {
          organizationId_eventType_channel: {
            organizationId,
            eventType: input.eventType,
            channel: input.channel,
          },
        },
        create: {
          organizationId,
          eventType: input.eventType,
          channel: input.channel,
          name,
          subject,
          body: input.body.trim(),
          isActive: input.isActive ?? true,
          updatedByUserId: tenant.userId,
        },
        update: {
          name,
          ...(input.subject !== undefined ? { subject } : {}),
          body: input.body.trim(),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "fulfillment.template.upserted",
          resourceType: "NotificationTemplate",
          resourceId: saved.id,
          metadata: {
            eventType: saved.eventType,
            channel: saved.channel,
            isActive: saved.isActive,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return { ...saved, isDefault: false };
    });
  }

  async resetTemplateToDefault(
    tenant: AuthenticatedTenant,
    eventType: NotificationEventType,
    channel: CommunicationChannel,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing = await this.prismaService.scoped.notificationTemplate.findFirst({
      where: { organizationId, eventType, channel },
    });

    if (existing) {
      await this.prismaService.raw.$transaction(async (tx) => {
        await tx.notificationTemplate.delete({ where: { id: existing.id } });
        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "fulfillment.template.reset",
            resourceType: "NotificationTemplate",
            resourceId: existing.id,
            metadata: { eventType, channel } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });
      });
    }

    const def = DEFAULT_TEMPLATES.find(
      (d) => d.eventType === eventType && d.channel === channel,
    );
    if (!def) {
      throw new NotFoundException("Default template definition not found.");
    }

    return {
      id: null,
      organizationId,
      eventType: def.eventType,
      channel: def.channel,
      name: def.name,
      subject: def.subject,
      body: def.body,
      isActive: true,
      isDefault: true,
    };
  }

  async listNotifications(
    tenant: AuthenticatedTenant,
    query: ListNotificationsQuery,
  ) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);

    const records = await this.prismaService.scoped.customerNotification.findMany({
      where: {
        ...(query.fulfillmentId ? { fulfillmentId: query.fulfillmentId } : {}),
        ...(query.orderId ? { orderId: query.orderId } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.eventType ? { eventType: query.eventType } : {}),
        ...(query.channel ? { channel: query.channel } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: {
        customer: {
          select: { id: true, code: true, name: true, email: true, phone: true },
        },
        fulfillment: {
          select: { id: true, fulfillmentNumber: true, type: true, status: true },
        },
        order: {
          select: { id: true, orderNumber: true },
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

  async dispatchFulfillmentNotification(
    tenant: AuthenticatedTenant,
    input: DispatchFulfillmentNotificationInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const triggerSource = input.triggerSource ?? "MANUAL";

    const [fulfillment, settings] = await Promise.all([
      this.prismaService.raw.orderFulfillment.findFirst({
        where: { id: input.fulfillmentId, organizationId },
        include: {
          order: { select: { id: true, orderNumber: true } },
          location: { select: { id: true, code: true, name: true } },
          customer: true,
          courierStaff: { select: { id: true, displayName: true, phone: true } },
        },
      }),
      this.prismaService.raw.fulfillmentSettings.findUnique({
        where: { organizationId },
      }),
    ]);

    if (!fulfillment) {
      throw new NotFoundException("Order fulfillment was not found.");
    }

    const channel =
      input.channel ??
      fulfillment.preferredChannel ??
      settings?.defaultChannel ??
      CommunicationChannel.SMS;

    const template = await this.resolveEffectiveTemplate(
      organizationId,
      input.eventType,
      channel,
    );

    const vars: Record<string, string> = {
      customer_name:
        fulfillment.customer?.companyName ||
        fulfillment.customer?.name ||
        "Customer",
      order_id: fulfillment.orderId,
      order_number: fulfillment.order.orderNumber,
      fulfillment_number: fulfillment.fulfillmentNumber,
      fulfillment_type: fulfillment.type,
      pickup_time: formatWindow(
        fulfillment.pickupWindowStart,
        fulfillment.pickupWindowEnd,
        fulfillment.scheduledFulfillmentAt,
      ),
      delivery_window: formatWindow(
        fulfillment.deliveryWindowStart,
        fulfillment.deliveryWindowEnd,
        fulfillment.scheduledFulfillmentAt,
      ),
      courier_name:
        fulfillment.courierStaff?.displayName ||
        fulfillment.courierName ||
        "Assigned Courier",
      courier_phone:
        fulfillment.courierStaff?.phone || fulfillment.courierPhone || "-",
      job_title: input.jobTitle?.trim() || "Order Preparation",
      location_name: fulfillment.location.name,
      status: fulfillment.status,
    };

    const renderedMessage = input.customMessage?.trim()
      ? interpolateTemplate(input.customMessage.trim(), vars)
      : interpolateTemplate(template.body, vars);
    const renderedSubject =
      channel === CommunicationChannel.EMAIL
        ? input.customSubject?.trim()
          ? interpolateTemplate(input.customSubject.trim(), vars)
          : template.subject
            ? interpolateTemplate(template.subject, vars)
            : `Order ${fulfillment.order.orderNumber} update`
        : null;

    const recipient =
      channel === CommunicationChannel.EMAIL
        ? fulfillment.customer?.email ?? null
        : fulfillment.customer?.phone ?? null;

    const isTriggerEnabled = this.isEventTriggerEnabled(
      input.eventType,
      fulfillment,
      settings,
    );

    const notificationsBlockedByToggle =
      !fulfillment.notificationsEnabled || !isTriggerEnabled;

    if (notificationsBlockedByToggle && !input.overrideDisabled) {
      const skipped = await this.prismaService.raw.customerNotification.create({
        data: {
          organizationId,
          fulfillmentId: fulfillment.id,
          orderId: fulfillment.orderId,
          staffJobId: input.staffJobId ?? null,
          customerId: fulfillment.customerId,
          eventType: input.eventType,
          channel,
          triggerSource,
          recipient,
          subject: renderedSubject,
          message: renderedMessage,
          status: NotificationDeliveryStatus.SKIPPED_DISABLED,
          provider: "none",
          errorMessage: !fulfillment.notificationsEnabled
            ? "Customer notifications are disabled on this order."
            : `Automatic notifications are disabled for ${input.eventType}.`,
          sentByUserId: triggerSource === "MANUAL" ? tenant.userId : null,
        },
      });
      return skipped;
    }

    if (!template.isActive && !input.customMessage?.trim()) {
      const skippedTemplate =
        await this.prismaService.raw.customerNotification.create({
          data: {
            organizationId,
            fulfillmentId: fulfillment.id,
            orderId: fulfillment.orderId,
            staffJobId: input.staffJobId ?? null,
            customerId: fulfillment.customerId,
            eventType: input.eventType,
            channel,
            triggerSource,
            recipient,
            subject: renderedSubject,
            message: renderedMessage,
            status: NotificationDeliveryStatus.SKIPPED_DISABLED,
            provider: "none",
            errorMessage: `Template for ${input.eventType} (${channel}) is disabled.`,
            sentByUserId: triggerSource === "MANUAL" ? tenant.userId : null,
          },
        });
      return skippedTemplate;
    }

    if (!recipient) {
      const missingRecipient =
        await this.prismaService.raw.customerNotification.create({
          data: {
            organizationId,
            fulfillmentId: fulfillment.id,
            orderId: fulfillment.orderId,
            staffJobId: input.staffJobId ?? null,
            customerId: fulfillment.customerId,
            eventType: input.eventType,
            channel,
            triggerSource,
            recipient: null,
            subject: renderedSubject,
            message: renderedMessage,
            status: NotificationDeliveryStatus.FAILED,
            provider: "none",
            errorMessage:
              channel === CommunicationChannel.EMAIL
                ? "Linked customer has no email address on file."
                : "Linked customer has no phone number on file for SMS/WhatsApp.",
            sentByUserId: triggerSource === "MANUAL" ? tenant.userId : null,
          },
        });
      return missingRecipient;
    }

    let deliveryStatus: NotificationDeliveryStatus =
      NotificationDeliveryStatus.FAILED;
    let provider = "none";
    let externalMessageId: string | null = null;
    let errorMessage: string | null = null;
    let sentAt: Date | null = null;

    const crmCtx = await this.resolveOptionalCrmConnection(organizationId);

    if (
      crmCtx &&
      (channel === CommunicationChannel.EMAIL ||
        channel === CommunicationChannel.SMS ||
        channel === CommunicationChannel.WHATSAPP)
    ) {
      try {
        const res = await this.customerMatesClient.sendCommunication(crmCtx, {
          channel,
          to: recipient,
          contactId: fulfillment.customer?.externalContactId ?? null,
          subject: renderedSubject,
          message: renderedMessage,
          metadata: {
            orderId: fulfillment.orderId,
            orderNumber: fulfillment.order.orderNumber,
            fulfillmentId: fulfillment.id,
            fulfillmentNumber: fulfillment.fulfillmentNumber,
            eventType: input.eventType,
          },
        });
        externalMessageId = res.id;
        provider = res.provider;
        deliveryStatus =
          res.provider === "customermates-sandbox"
            ? NotificationDeliveryStatus.SANDBOX
            : NotificationDeliveryStatus.SENT;
        sentAt = new Date();
      } catch (err) {
        errorMessage =
          err instanceof Error
            ? err.message
            : "CustomerMates communication dispatch failed.";
        this.logger.warn(
          `CustomerMates notification dispatch failed (${channel}, ${fulfillment.order.orderNumber}): ${errorMessage}`,
        );
      }
    }

    // Fallback to EmailService (Resend or dev logger fallback) when EMAIL cannot be dispatched via CustomerMates
    if (
      channel === CommunicationChannel.EMAIL &&
      deliveryStatus === NotificationDeliveryStatus.FAILED
    ) {
      try {
        const safeOrgTitle = escapeHtml(fulfillment.location.name);
        const safeOrderNum = escapeHtml(fulfillment.order.orderNumber);
        const safeBodyHtml = escapeHtml(renderedMessage).replace(/\n/g, "<br/>");
        await this.emailService.sendEmail({
          to: recipient,
          subject: renderedSubject || `Order ${fulfillment.order.orderNumber} update`,
          text: renderedMessage,
          html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827;"><h2 style="margin:0 0 12px;font-size:18px;">${safeOrgTitle} — Order ${safeOrderNum}</h2><p style="margin:0;line-height:1.6;">${safeBodyHtml}</p></div>`,
        });
        deliveryStatus = NotificationDeliveryStatus.FALLBACK_SENT;
        provider = "email-fallback";
        errorMessage = null;
        sentAt = new Date();
      } catch (emailErr) {
        errorMessage =
          emailErr instanceof Error
            ? emailErr.message
            : "Email fallback delivery failed.";
      }
    } else if (!crmCtx && deliveryStatus === NotificationDeliveryStatus.FAILED) {
      errorMessage =
        "CustomerMates CRM connection is not configured or enabled for SMS/WhatsApp dispatch.";
    }

    const log = await this.prismaService.raw.customerNotification.create({
      data: {
        organizationId,
        fulfillmentId: fulfillment.id,
        orderId: fulfillment.orderId,
        staffJobId: input.staffJobId ?? null,
        customerId: fulfillment.customerId,
        eventType: input.eventType,
        channel,
        triggerSource,
        recipient,
        subject: renderedSubject,
        message: renderedMessage,
        status: deliveryStatus,
        provider,
        externalMessageId,
        errorMessage,
        sentAt,
        sentByUserId: tenant.userId,
      },
    });

    await this.prismaService.raw.auditLog.create({
      data: {
        organizationId,
        actorUserId: tenant.userId,
        action: "fulfillment.notification.dispatched",
        resourceType: "CustomerNotification",
        resourceId: log.id,
        metadata: {
          fulfillmentId: fulfillment.id,
          orderNumber: fulfillment.order.orderNumber,
          eventType: input.eventType,
          channel,
          triggerSource,
          status: deliveryStatus,
          provider,
        } as Prisma.InputJsonValue,
        ipAddress: ipAddress ?? null,
      },
    });

    return log;
  }

  private async resolveEffectiveTemplate(
    organizationId: string,
    eventType: NotificationEventType,
    channel: CommunicationChannel,
  ): Promise<{ subject: string | null; body: string; isActive: boolean }> {
    const custom = await this.prismaService.raw.notificationTemplate.findUnique({
      where: {
        organizationId_eventType_channel: {
          organizationId,
          eventType,
          channel,
        },
      },
    });
    if (custom) {
      return {
        subject: custom.subject,
        body: custom.body,
        isActive: custom.isActive,
      };
    }

    const def = DEFAULT_TEMPLATES.find(
      (d) => d.eventType === eventType && d.channel === channel,
    );
    return {
      subject: def?.subject ?? null,
      body:
        def?.body ??
        "Hi {customer_name}, update for order {order_number}: {status}.",
      isActive: true,
    };
  }

  private isEventTriggerEnabled(
    eventType: NotificationEventType,
    fulfillment: {
      notifyOnPreorderReady: boolean;
      notifyOnJobCompleted: boolean;
      notifyOnDeliveryUpdates: boolean;
    },
    settings: {
      autoNotifyOnPreorderReady: boolean;
      autoNotifyOnJobCompleted: boolean;
      autoNotifyOnDeliveryUpdates: boolean;
    } | null,
  ): boolean {
    switch (eventType) {
      case NotificationEventType.PREORDER_READY:
        return (
          fulfillment.notifyOnPreorderReady &&
          (settings?.autoNotifyOnPreorderReady ?? true)
        );
      case NotificationEventType.JOB_COMPLETED:
        return (
          fulfillment.notifyOnJobCompleted &&
          (settings?.autoNotifyOnJobCompleted ?? true)
        );
      case NotificationEventType.DELIVERY_OUT_FOR_DELIVERY:
      case NotificationEventType.DELIVERY_DELIVERED:
        return (
          fulfillment.notifyOnDeliveryUpdates &&
          (settings?.autoNotifyOnDeliveryUpdates ?? true)
        );
      case NotificationEventType.CUSTOM:
      default:
        return true;
    }
  }

  private async resolveOptionalCrmConnection(
    organizationId: string,
  ): Promise<CustomerMatesConnectionContext | null> {
    try {
      return await this.crmConnectionService.resolveActiveConnection(
        organizationId,
      );
    } catch {
      return null;
    }
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedTenant): string {
    const contextOrgId = TenantContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active tenant context mismatch.");
    }
    return tenant.organizationId;
  }
}

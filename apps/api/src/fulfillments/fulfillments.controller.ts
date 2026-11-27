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
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  CommunicationChannel,
  DeliveryStage,
  FulfillmentStatus,
  FulfillmentType,
  NotificationDeliveryStatus,
  NotificationEventType,
  OrderChannel,
  PreorderDepositStatus,
} from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { MpesaPaymentService } from "../payments/mpesa-payment.service.js";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { FulfillmentNotificationsService } from "./fulfillment-notifications.service.js";
import { FulfillmentsService } from "./fulfillments.service.js";
import { StaffJobsService } from "./staff-jobs.service.js";

const dateStringSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), {
    message: "Must be a valid ISO date or datetime string.",
  });

const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((v) => v.toUpperCase());

const channelEnum = z.enum([
  CommunicationChannel.SMS,
  CommunicationChannel.WHATSAPP,
  CommunicationChannel.EMAIL,
]);

const eventTypeEnum = z.enum([
  NotificationEventType.PREORDER_READY,
  NotificationEventType.JOB_COMPLETED,
  NotificationEventType.DELIVERY_OUT_FOR_DELIVERY,
  NotificationEventType.DELIVERY_DELIVERED,
  NotificationEventType.CUSTOM,
]);

const orderLineSchema = z.object({
  itemId: z.string().trim().min(1),
  quantity: z.number().int().min(1).max(1_000_000),
  packId: z.string().trim().min(1).nullable().optional(),
  servicePlanId: z.string().trim().min(1).nullable().optional(),
  overrideUnitPriceCents: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  description: z.string().trim().max(300).nullable().optional(),
});

const updateSettingsSchema = z.object({
  autoConvertPreordersToJobs: z.boolean().optional(),
  defaultJobLeadMinutes: z.number().int().min(0).max(43_200).optional(),
  defaultJobAssigneeStaffId: z.string().trim().min(1).nullable().optional(),
  defaultJobAssigneeRole: z.string().trim().min(1).max(64).nullable().optional(),
  syncJobsToCrm: z.boolean().optional(),
  defaultChannel: channelEnum.optional(),
  autoNotifyOnPreorderReady: z.boolean().optional(),
  autoNotifyOnJobCompleted: z.boolean().optional(),
  autoNotifyOnDeliveryUpdates: z.boolean().optional(),
});

const upsertTemplateSchema = z.object({
  eventType: eventTypeEnum,
  channel: channelEnum,
  name: z.string().trim().min(1).max(120).optional(),
  subject: z.string().trim().max(240).nullable().optional(),
  body: z.string().trim().min(1).max(4000),
  isActive: z.boolean().optional(),
});

const createFulfillmentSchema = z.object({
  type: z.enum([
    FulfillmentType.PREORDER,
    FulfillmentType.PICKUP,
    FulfillmentType.DELIVERY,
  ]),
  orderId: z.string().trim().min(1).optional(),
  orderNumber: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
  orderChannel: z.enum([OrderChannel.POS, OrderChannel.B2B]).optional(),
  locationId: z.string().trim().min(1).optional(),
  customerId: z.string().trim().min(1).nullable().optional(),
  priceBookId: z.string().trim().min(1).nullable().optional(),
  promoCodes: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  currency: currencySchema.optional(),
  taxCents: z.number().int().min(0).max(1_000_000_000).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: z.array(orderLineSchema).min(1).max(200).optional(),
  confirmImmediately: z.boolean().optional(),
  scheduledFulfillmentAt: dateStringSchema.nullable().optional(),
  depositRequiredCents: z.number().int().min(0).max(1_000_000_000).optional(),
  cashPaymentCents: z.number().int().min(0).max(1_000_000_000).optional(),
  cashTenderedCents: z.number().int().min(0).max(1_000_000_000).optional(),
  paymentMethod: z.enum(["CASH"]).optional(),
  preparationNotes: z.string().trim().max(2000).nullable().optional(),
  autoConvertToJob: z.boolean().nullable().optional(),
  pickupWindowStart: dateStringSchema.nullable().optional(),
  pickupWindowEnd: dateStringSchema.nullable().optional(),
  pickupInstructions: z.string().trim().max(2000).nullable().optional(),
  deliveryAddressLine1: z.string().trim().max(200).nullable().optional(),
  deliveryAddressLine2: z.string().trim().max(200).nullable().optional(),
  deliveryCity: z.string().trim().max(120).nullable().optional(),
  deliveryState: z.string().trim().max(120).nullable().optional(),
  deliveryPostalCode: z.string().trim().max(40).nullable().optional(),
  deliveryCountry: z.string().trim().max(120).nullable().optional(),
  deliveryInstructions: z.string().trim().max(2000).nullable().optional(),
  deliveryWindowStart: dateStringSchema.nullable().optional(),
  deliveryWindowEnd: dateStringSchema.nullable().optional(),
  courierStaffId: z.string().trim().min(1).nullable().optional(),
  courierName: z.string().trim().max(160).nullable().optional(),
  courierPhone: z.string().trim().max(64).nullable().optional(),
  notificationsEnabled: z.boolean().optional(),
  preferredChannel: channelEnum.nullable().optional(),
  notifyOnPreorderReady: z.boolean().optional(),
  notifyOnJobCompleted: z.boolean().optional(),
  notifyOnDeliveryUpdates: z.boolean().optional(),
});

const updateFulfillmentSchema = createFulfillmentSchema
  .omit({
    type: true,
    orderId: true,
    orderNumber: true,
    orderChannel: true,
    locationId: true,
    customerId: true,
    priceBookId: true,
    promoCodes: true,
    currency: true,
    taxCents: true,
    notes: true,
    lines: true,
    confirmImmediately: true,
    cashPaymentCents: true,
    cashTenderedCents: true,
    paymentMethod: true,
    notificationsEnabled: true,
    preferredChannel: true,
    notifyOnPreorderReady: true,
    notifyOnJobCompleted: true,
    notifyOnDeliveryUpdates: true,
  })
  .partial();

const listFulfillmentsQuerySchema = z.object({
  type: z
    .enum([
      FulfillmentType.PREORDER,
      FulfillmentType.PICKUP,
      FulfillmentType.DELIVERY,
    ])
    .optional(),
  status: z
    .enum([
      FulfillmentStatus.PENDING,
      FulfillmentStatus.IN_PROGRESS,
      FulfillmentStatus.READY,
      FulfillmentStatus.COMPLETED,
      FulfillmentStatus.CANCELLED,
    ])
    .optional(),
  deliveryStage: z
    .enum([
      DeliveryStage.NONE,
      DeliveryStage.OUT_FOR_DELIVERY,
      DeliveryStage.DELIVERED,
    ])
    .optional(),
  depositStatus: z
    .enum([
      PreorderDepositStatus.NOT_REQUIRED,
      PreorderDepositStatus.UNPAID,
      PreorderDepositStatus.DEPOSIT_PAID,
      PreorderDepositStatus.PAID,
    ])
    .optional(),
  customerId: z.string().trim().min(1).optional(),
  locationId: z.string().trim().min(1).optional(),
  courierStaffId: z.string().trim().min(1).optional(),
  dateFrom: dateStringSchema.optional(),
  dateTo: dateStringSchema.optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const listNotificationsQuerySchema = z.object({
  fulfillmentId: z.string().trim().min(1).optional(),
  orderId: z.string().trim().min(1).optional(),
  customerId: z.string().trim().min(1).optional(),
  eventType: eventTypeEnum.optional(),
  channel: channelEnum.optional(),
  status: z
    .enum([
      NotificationDeliveryStatus.SENT,
      NotificationDeliveryStatus.SANDBOX,
      NotificationDeliveryStatus.FALLBACK_SENT,
      NotificationDeliveryStatus.SKIPPED_DISABLED,
      NotificationDeliveryStatus.FAILED,
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const recordCashPaymentSchema = z.object({
  method: z.enum(["CASH"]).optional(),
  amountCents: z.number().int().min(1).max(1_000_000_000),
  cashTenderedCents: z.number().int().min(1).max(1_000_000_000).optional(),
  reference: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const transitionStatusSchema = z.object({
  status: z.enum([
    FulfillmentStatus.IN_PROGRESS,
    FulfillmentStatus.READY,
    FulfillmentStatus.COMPLETED,
    FulfillmentStatus.CANCELLED,
  ]),
});

const pickupHandoffSchema = z.object({
  notes: z.string().trim().max(1000).nullable().optional(),
});

const outForDeliverySchema = z.object({
  courierStaffId: z.string().trim().min(1).nullable().optional(),
  courierName: z.string().trim().max(160).nullable().optional(),
  courierPhone: z.string().trim().max(64).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const deliveredSchema = z.object({
  notes: z.string().trim().max(1000).nullable().optional(),
});

const cancelFulfillmentSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

const convertToJobSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  instructions: z.string().trim().max(4000).nullable().optional(),
  priority: z.number().int().min(1).max(3).optional(),
  assignedStaffId: z.string().trim().min(1).nullable().optional(),
  assignedDepartmentId: z.string().trim().min(1).nullable().optional(),
  assignedTeamId: z.string().trim().min(1).nullable().optional(),
  assignedRole: z.string().trim().min(1).max(64).nullable().optional(),
  targetDueAt: dateStringSchema.nullable().optional(),
  syncToCrm: z.boolean().optional(),
  allowMultiple: z.boolean().optional(),
});

const updateNotificationPrefsSchema = z.object({
  notificationsEnabled: z.boolean().optional(),
  preferredChannel: channelEnum.nullable().optional(),
  notifyOnPreorderReady: z.boolean().optional(),
  notifyOnJobCompleted: z.boolean().optional(),
  notifyOnDeliveryUpdates: z.boolean().optional(),
});

const manualNotifySchema = z.object({
  eventType: eventTypeEnum.default(NotificationEventType.CUSTOM),
  channel: channelEnum.optional(),
  customSubject: z.string().trim().max(240).nullable().optional(),
  customMessage: z.string().trim().max(4000).nullable().optional(),
  overrideDisabled: z.boolean().optional(),
});

const fulfillmentMpesaStkSchema = z.object({
  phoneNumber: z.string().trim().min(9).max(20),
  amountCents: z.number().int().min(100).max(1_000_000_000).optional(),
  accountReference: z.string().trim().max(32).nullable().optional(),
  transactionDesc: z.string().trim().max(64).nullable().optional(),
});

@Controller("api/v1/fulfillments")
@RequireActiveOrganization()
export class FulfillmentsController {
  constructor(
    @Inject(FulfillmentsService)
    private readonly fulfillmentsService: FulfillmentsService,
    @Inject(StaffJobsService)
    private readonly staffJobsService: StaffJobsService,
    @Inject(FulfillmentNotificationsService)
    private readonly notificationsService: FulfillmentNotificationsService,
    @Inject(MpesaPaymentService)
    private readonly mpesaPaymentService: MpesaPaymentService,
  ) {}

  // ==========================================
  // Settings, Templates & Notification Log
  // ==========================================

  @Get("settings")
  @RequiredOrgPermissions({ fulfillment: ["read"] })
  async getSettings(@CurrentOrganization() tenant: AuthenticatedOrganization) {
    return this.fulfillmentsService.getOrCreateSettings(tenant);
  }

  @Put("settings")
  @RequiredOrgPermissions({ fulfillment: ["configure"] })
  async updateSettings(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateSettingsSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid fulfillment settings payload.",
        issues: parsed.error.issues,
      });
    }
    return this.fulfillmentsService.updateSettings(tenant, parsed.data, req.ip);
  }

  @Get("templates")
  @RequiredOrgPermissions({ notification: ["read"] })
  async listTemplates(@CurrentOrganization() tenant: AuthenticatedOrganization) {
    return this.notificationsService.listTemplates(tenant);
  }

  @Put("templates")
  @RequiredOrgPermissions({ notification: ["configureTemplates"] })
  async upsertTemplate(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = upsertTemplateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid notification template payload.",
        issues: parsed.error.issues,
      });
    }
    return this.notificationsService.upsertTemplate(tenant, parsed.data, req.ip);
  }

  @Delete("templates/:eventType/:channel")
  @RequiredOrgPermissions({ notification: ["configureTemplates"] })
  async resetTemplate(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("eventType") eventType: string,
    @Param("channel") channel: string,
    @Req() req: FastifyRequest,
  ) {
    const parsedEvent = eventTypeEnum.safeParse(eventType.toUpperCase());
    const parsedChannel = channelEnum.safeParse(channel.toUpperCase());
    if (!parsedEvent.success || !parsedChannel.success) {
      throw new BadRequestException("Invalid template eventType or channel.");
    }
    return this.notificationsService.resetTemplateToDefault(
      tenant,
      parsedEvent.data,
      parsedChannel.data,
      req.ip,
    );
  }

  @Get("notifications")
  @RequiredOrgPermissions({ notification: ["read"] })
  async listNotifications(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listNotificationsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid notifications query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.notificationsService.listNotifications(tenant, parsed.data);
  }

  // ==========================================
  // Fulfillment CRUD & Workflows
  // ==========================================

  @Post()
  @RequiredOrgPermissions({ fulfillment: ["create"] })
  async createFulfillment(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createFulfillmentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid fulfillment payload.",
        issues: parsed.error.issues,
      });
    }
    return this.fulfillmentsService.createFulfillment(
      tenant,
      parsed.data,
      req.ip,
    );
  }

  @Get()
  @RequiredOrgPermissions({ fulfillment: ["read"] })
  async listFulfillments(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listFulfillmentsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid fulfillment query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.fulfillmentsService.listFulfillments(tenant, parsed.data);
  }

  @Get(":fulfillmentId")
  @RequiredOrgPermissions({ fulfillment: ["read"] })
  async getFulfillment(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("fulfillmentId") fulfillmentId: string,
  ) {
    return this.fulfillmentsService.getFulfillment(tenant, fulfillmentId);
  }

  @Patch(":fulfillmentId")
  @RequiredOrgPermissions({ fulfillment: ["update"] })
  async updateFulfillment(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("fulfillmentId") fulfillmentId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateFulfillmentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid fulfillment update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.fulfillmentsService.updateFulfillment(
      tenant,
      fulfillmentId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":fulfillmentId/confirm")
  @RequiredOrgPermissions({ fulfillment: ["confirm"] })
  async confirmFulfillment(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("fulfillmentId") fulfillmentId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.fulfillmentsService.confirmFulfillment(
      tenant,
      fulfillmentId,
      req.ip,
    );
  }

  @Post(":fulfillmentId/status")
  @RequiredOrgPermissions({ fulfillment: ["update"] })
  async transitionStatus(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("fulfillmentId") fulfillmentId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = transitionStatusSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid fulfillment status payload.",
        issues: parsed.error.issues,
      });
    }
    return this.fulfillmentsService.transitionStatus(
      tenant,
      fulfillmentId,
      parsed.data.status,
      req.ip,
    );
  }

  @Post(":fulfillmentId/payments")
  @RequiredOrgPermissions({ payment: ["record"] })
  async recordCashPayment(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("fulfillmentId") fulfillmentId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = recordCashPaymentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid fulfillment cash payment payload.",
        issues: parsed.error.issues,
      });
    }
    return this.fulfillmentsService.recordCashDepositPayment(
      tenant,
      fulfillmentId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":fulfillmentId/payments/mpesa/stk-push")
  @RequiredOrgPermissions({ payment: ["record"] })
  async initiateFulfillmentMpesaStkPush(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("fulfillmentId") fulfillmentId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = fulfillmentMpesaStkSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid M-Pesa STK Push payload.",
        issues: parsed.error.issues,
      });
    }

    return this.mpesaPaymentService.initiateStkPushForFulfillment(
      tenant,
      fulfillmentId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":fulfillmentId/pickup/handoff")
  @RequiredOrgPermissions({ fulfillment: ["complete"] })
  async confirmPickupHandoff(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("fulfillmentId") fulfillmentId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = pickupHandoffSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid pickup handoff payload.",
        issues: parsed.error.issues,
      });
    }
    return this.fulfillmentsService.confirmPickupHandoff(
      tenant,
      fulfillmentId,
      parsed.data.notes,
      req.ip,
    );
  }

  @Post(":fulfillmentId/delivery/out-for-delivery")
  @RequiredOrgPermissions({ fulfillment: ["update"] })
  async markOutForDelivery(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("fulfillmentId") fulfillmentId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = outForDeliverySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid out-for-delivery payload.",
        issues: parsed.error.issues,
      });
    }
    return this.fulfillmentsService.markOutForDelivery(
      tenant,
      fulfillmentId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":fulfillmentId/delivery/delivered")
  @RequiredOrgPermissions({ fulfillment: ["complete"] })
  async markDelivered(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("fulfillmentId") fulfillmentId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = deliveredSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid delivery completion payload.",
        issues: parsed.error.issues,
      });
    }
    return this.fulfillmentsService.markDelivered(
      tenant,
      fulfillmentId,
      parsed.data.notes,
      req.ip,
    );
  }

  @Post(":fulfillmentId/cancel")
  @RequiredOrgPermissions({ fulfillment: ["cancel"] })
  async cancelFulfillment(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("fulfillmentId") fulfillmentId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = cancelFulfillmentSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid cancellation payload.",
        issues: parsed.error.issues,
      });
    }
    return this.fulfillmentsService.cancelFulfillment(
      tenant,
      fulfillmentId,
      parsed.data.reason,
      req.ip,
    );
  }

  @Post(":fulfillmentId/convert-to-job")
  @RequiredOrgPermissions({ staffJob: ["create"] })
  async convertToJob(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("fulfillmentId") fulfillmentId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = convertToJobSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid convert-to-job payload.",
        issues: parsed.error.issues,
      });
    }
    return this.staffJobsService.convertFulfillmentToJob(
      tenant,
      fulfillmentId,
      parsed.data,
      req.ip,
    );
  }

  @Patch(":fulfillmentId/notifications")
  @RequiredOrgPermissions({ fulfillment: ["update"] })
  async updateNotificationPreferences(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("fulfillmentId") fulfillmentId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateNotificationPrefsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid notification preferences payload.",
        issues: parsed.error.issues,
      });
    }
    return this.fulfillmentsService.updateNotificationPreferences(
      tenant,
      fulfillmentId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":fulfillmentId/notify")
  @RequiredOrgPermissions({ notification: ["send"] })
  async notifyCustomer(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("fulfillmentId") fulfillmentId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = manualNotifySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid manual notification payload.",
        issues: parsed.error.issues,
      });
    }
    return this.notificationsService.dispatchFulfillmentNotification(
      tenant,
      {
        fulfillmentId,
        eventType: parsed.data.eventType,
        channel: parsed.data.channel,
        customSubject: parsed.data.customSubject,
        customMessage: parsed.data.customMessage,
        overrideDisabled: parsed.data.overrideDisabled ?? true,
        triggerSource: "MANUAL",
      },
      req.ip,
    );
  }
}

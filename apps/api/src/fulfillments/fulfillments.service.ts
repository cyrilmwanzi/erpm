import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  CommunicationChannel,
  CustomerPaymentStatus,
  CustomerStatus,
  DeliveryStage,
  FulfillmentStatus,
  FulfillmentType,
  LocationStatus,
  NotificationEventType,
  OrderChannel,
  OrderStatus,
  PaymentMethod,
  PreorderDepositStatus,
  PriceBookDirection,
  Prisma,
  StaffJobStatus,
  StaffStatus,
  OrganizationContext,
} from "@scace/db";
import {
  hasOrganizationPermission,
  isValidOrganizationRole,
} from "../auth/permissions.js";
import { PrismaService } from "../database/prisma.service.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import type { PrintableReceiptDocument } from "../orders/document-renderer.utils.js";
import { OrdersService, type OrderLineInput } from "../orders/orders.service.js";
import { PricingEngineService } from "../pricing/pricing-engine.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { FulfillmentNotificationsService } from "./fulfillment-notifications.service.js";
import { StaffJobsService } from "./staff-jobs.service.js";

export interface UpdateFulfillmentSettingsInput {
  autoConvertPreordersToJobs?: boolean;
  defaultJobLeadMinutes?: number;
  defaultJobAssigneeStaffId?: string | null;
  defaultJobAssigneeRole?: string | null;
  syncJobsToCrm?: boolean;
  defaultChannel?: CommunicationChannel;
  autoNotifyOnPreorderReady?: boolean;
  autoNotifyOnJobCompleted?: boolean;
  autoNotifyOnDeliveryUpdates?: boolean;
}

export interface CreateFulfillmentInput {
  type: FulfillmentType;
  orderId?: string;
  orderNumber?: string;
  orderChannel?: OrderChannel;
  locationId?: string;
  customerId?: string | null;
  priceBookId?: string | null;
  promoCodes?: string[];
  currency?: string;
  taxCents?: number;
  notes?: string | null;
  lines?: OrderLineInput[];
  confirmImmediately?: boolean;
  // Preorder fields
  scheduledFulfillmentAt?: string | null;
  depositRequiredCents?: number;
  cashPaymentCents?: number;
  cashTenderedCents?: number;
  paymentMethod?: "CASH";
  preparationNotes?: string | null;
  autoConvertToJob?: boolean | null;
  // Pickup fields
  pickupWindowStart?: string | null;
  pickupWindowEnd?: string | null;
  pickupInstructions?: string | null;
  // Delivery fields
  deliveryAddressLine1?: string | null;
  deliveryAddressLine2?: string | null;
  deliveryCity?: string | null;
  deliveryState?: string | null;
  deliveryPostalCode?: string | null;
  deliveryCountry?: string | null;
  deliveryInstructions?: string | null;
  deliveryWindowStart?: string | null;
  deliveryWindowEnd?: string | null;
  courierStaffId?: string | null;
  courierName?: string | null;
  courierPhone?: string | null;
  // Notification controls
  notificationsEnabled?: boolean;
  preferredChannel?: CommunicationChannel | null;
  notifyOnPreorderReady?: boolean;
  notifyOnJobCompleted?: boolean;
  notifyOnDeliveryUpdates?: boolean;
}

export interface UpdateFulfillmentInput {
  scheduledFulfillmentAt?: string | null;
  depositRequiredCents?: number;
  preparationNotes?: string | null;
  autoConvertToJob?: boolean | null;
  pickupWindowStart?: string | null;
  pickupWindowEnd?: string | null;
  pickupInstructions?: string | null;
  deliveryAddressLine1?: string | null;
  deliveryAddressLine2?: string | null;
  deliveryCity?: string | null;
  deliveryState?: string | null;
  deliveryPostalCode?: string | null;
  deliveryCountry?: string | null;
  deliveryInstructions?: string | null;
  deliveryWindowStart?: string | null;
  deliveryWindowEnd?: string | null;
  courierStaffId?: string | null;
  courierName?: string | null;
  courierPhone?: string | null;
}

export interface UpdateNotificationPreferencesInput {
  notificationsEnabled?: boolean;
  preferredChannel?: CommunicationChannel | null;
  notifyOnPreorderReady?: boolean;
  notifyOnJobCompleted?: boolean;
  notifyOnDeliveryUpdates?: boolean;
}

export interface RecordFulfillmentCashPaymentInput {
  method?: "CASH";
  amountCents: number;
  cashTenderedCents?: number;
  reference?: string | null;
  notes?: string | null;
}

export interface ListFulfillmentsQuery {
  type?: FulfillmentType;
  status?: FulfillmentStatus;
  deliveryStage?: DeliveryStage;
  depositStatus?: PreorderDepositStatus;
  customerId?: string;
  locationId?: string;
  courierStaffId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

function generateDocNumber(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
}

function computeDepositStatus(
  depositRequiredCents: number,
  paidAmountCents: number,
  totalCents: number,
): PreorderDepositStatus {
  if (totalCents > 0 && paidAmountCents >= totalCents) {
    return PreorderDepositStatus.PAID;
  }
  if (depositRequiredCents <= 0) {
    return paidAmountCents > 0
      ? PreorderDepositStatus.DEPOSIT_PAID
      : PreorderDepositStatus.NOT_REQUIRED;
  }
  if (paidAmountCents >= depositRequiredCents) {
    return PreorderDepositStatus.DEPOSIT_PAID;
  }
  return PreorderDepositStatus.UNPAID;
}

@Injectable()
export class FulfillmentsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(PricingEngineService)
    private readonly pricingEngine: PricingEngineService,
    @Inject(OrdersService) private readonly ordersService: OrdersService,
    @Inject(StaffJobsService) private readonly staffJobsService: StaffJobsService,
    @Inject(FulfillmentNotificationsService)
    private readonly notificationsService: FulfillmentNotificationsService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  async getOrCreateSettings(tenant: AuthenticatedOrganization) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing = await this.prismaService.scoped.fulfillmentSettings.findFirst({
      where: { organizationId },
    });
    if (existing) {
      return existing;
    }

    return this.prismaService.raw.fulfillmentSettings.create({
      data: {
        organizationId,
      },
    });
  }

  async updateSettings(
    tenant: AuthenticatedOrganization,
    input: UpdateFulfillmentSettingsInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    if (input.defaultJobAssigneeStaffId) {
      const staff = await this.prismaService.raw.staffProfile.findFirst({
        where: { id: input.defaultJobAssigneeStaffId, organizationId },
        select: { id: true, status: true },
      });
      if (!staff || staff.status === StaffStatus.OFFBOARDED) {
        throw new BadRequestException(
          "Default job assignee staff profile must exist and not be offboarded.",
        );
      }
    }

    if (
      input.defaultJobAssigneeRole &&
      !isValidOrganizationRole(input.defaultJobAssigneeRole)
    ) {
      throw new BadRequestException(
        `Invalid default organization role "${input.defaultJobAssigneeRole}".`,
      );
    }

    return this.prismaService.raw.$transaction(async (tx) => {
      const saved = await tx.fulfillmentSettings.upsert({
        where: { organizationId },
        create: {
          organizationId,
          autoConvertPreordersToJobs: input.autoConvertPreordersToJobs ?? false,
          defaultJobLeadMinutes: input.defaultJobLeadMinutes ?? 120,
          defaultJobAssigneeStaffId: input.defaultJobAssigneeStaffId ?? null,
          defaultJobAssigneeRole: input.defaultJobAssigneeRole ?? null,
          syncJobsToCrm: input.syncJobsToCrm ?? false,
          defaultChannel: input.defaultChannel ?? CommunicationChannel.SMS,
          autoNotifyOnPreorderReady: input.autoNotifyOnPreorderReady ?? true,
          autoNotifyOnJobCompleted: input.autoNotifyOnJobCompleted ?? true,
          autoNotifyOnDeliveryUpdates:
            input.autoNotifyOnDeliveryUpdates ?? true,
        },
        update: {
          ...(input.autoConvertPreordersToJobs !== undefined
            ? { autoConvertPreordersToJobs: input.autoConvertPreordersToJobs }
            : {}),
          ...(input.defaultJobLeadMinutes !== undefined
            ? { defaultJobLeadMinutes: input.defaultJobLeadMinutes }
            : {}),
          ...(input.defaultJobAssigneeStaffId !== undefined
            ? { defaultJobAssigneeStaffId: input.defaultJobAssigneeStaffId }
            : {}),
          ...(input.defaultJobAssigneeRole !== undefined
            ? { defaultJobAssigneeRole: input.defaultJobAssigneeRole }
            : {}),
          ...(input.syncJobsToCrm !== undefined
            ? { syncJobsToCrm: input.syncJobsToCrm }
            : {}),
          ...(input.defaultChannel !== undefined
            ? { defaultChannel: input.defaultChannel }
            : {}),
          ...(input.autoNotifyOnPreorderReady !== undefined
            ? { autoNotifyOnPreorderReady: input.autoNotifyOnPreorderReady }
            : {}),
          ...(input.autoNotifyOnJobCompleted !== undefined
            ? { autoNotifyOnJobCompleted: input.autoNotifyOnJobCompleted }
            : {}),
          ...(input.autoNotifyOnDeliveryUpdates !== undefined
            ? {
                autoNotifyOnDeliveryUpdates: input.autoNotifyOnDeliveryUpdates,
              }
            : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "fulfillment.settings.updated",
          resourceType: "FulfillmentSettings",
          resourceId: saved.id,
          metadata: input as unknown as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });
  }

  async createFulfillment(
    tenant: AuthenticatedOrganization,
    input: CreateFulfillmentInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    if (input.paymentMethod && input.paymentMethod !== PaymentMethod.CASH) {
      throw new BadRequestException(
        "Only CASH payment is currently supported.",
      );
    }

    if (input.courierStaffId) {
      const courier = await this.prismaService.raw.staffProfile.findFirst({
        where: { id: input.courierStaffId, organizationId },
        select: { id: true, status: true },
      });
      if (!courier || courier.status === StaffStatus.OFFBOARDED) {
        throw new BadRequestException(
          "Assigned courier staff profile must exist and not be offboarded.",
        );
      }
    }

    const settings = await this.getOrCreateSettings(tenant);

    if (input.orderId) {
      return this.attachFulfillmentToExistingOrder(
        tenant,
        input,
        settings,
        ipAddress,
      );
    }

    if (!input.locationId || !input.lines || input.lines.length === 0) {
      throw new BadRequestException(
        "Either orderId OR (locationId and lines) must be provided to create a fulfillment.",
      );
    }

    const [location, customer, org, organizationSettings] = await Promise.all([
      this.prismaService.raw.location.findFirst({
        where: { id: input.locationId, organizationId },
      }),
      input.customerId
        ? this.prismaService.raw.customer.findFirst({
            where: { id: input.customerId, organizationId },
          })
        : Promise.resolve(null),
      this.prismaService.raw.organization.findUnique({
        where: { id: organizationId },
        select: { id: true, name: true },
      }),
      this.prismaService.raw.organizationSettings.findUnique({
        where: { organizationId },
        select: { companyLegalName: true, defaultCurrency: true },
      }),
    ]);

    if (!location || location.status !== LocationStatus.ACTIVE) {
      throw new BadRequestException("Location must exist and be ACTIVE.");
    }
    if (input.customerId && !customer) {
      throw new NotFoundException("Customer was not found.");
    }
    if (customer && customer.status === CustomerStatus.ARCHIVED) {
      throw new BadRequestException(
        "Cannot link an archived customer to a fulfillment order.",
      );
    }

    const orderChannel =
      input.orderChannel ??
      (input.type === FulfillmentType.DELIVERY
        ? OrderChannel.B2B
        : OrderChannel.POS);

    const quote = await this.pricingEngine.calculateQuote(tenant, {
      direction: PriceBookDirection.SALES,
      currency:
        input.currency ?? customer?.currency ?? organizationSettings?.defaultCurrency,
      priceBookId: input.priceBookId ?? null,
      customerSegment: customer?.customerSegment ?? null,
      externalAccountId:
        customer?.externalAccountId ??
        customer?.externalCompanyId ??
        customer?.externalContactId ??
        null,
      channel: orderChannel,
      promoCodes: input.promoCodes,
      lines: input.lines.map((l) => ({
        itemId: l.itemId,
        quantity: l.quantity,
        packId: l.packId ?? null,
        servicePlanId: l.servicePlanId ?? null,
        overrideUnitPriceCents: l.overrideUnitPriceCents ?? null,
      })),
    });

    const subtotalCents = quote.subtotalAfterTiersCents;
    const discountTotalCents = quote.totalDiscountCents;
    const taxCents = input.taxCents ?? 0;
    const totalCents = quote.totalCents + taxCents;

    const cashPaymentCents = input.cashPaymentCents ?? 0;
    if (cashPaymentCents > totalCents) {
      throw new BadRequestException(
        `Cash payment (${cashPaymentCents} cents) cannot exceed order total (${totalCents} cents).`,
      );
    }
    const cashTenderedCents =
      input.cashTenderedCents !== undefined
        ? input.cashTenderedCents
        : cashPaymentCents;
    if (cashPaymentCents > 0 && cashTenderedCents < cashPaymentCents) {
      throw new BadRequestException(
        `Cash tendered (${cashTenderedCents} cents) cannot be less than cash payment (${cashPaymentCents} cents).`,
      );
    }

    const depositRequiredCents = input.depositRequiredCents ?? 0;
    const depositStatus = computeDepositStatus(
      depositRequiredCents,
      cashPaymentCents,
      totalCents,
    );

    const orderNumber =
      input.orderNumber?.trim().toUpperCase() ||
      generateDocNumber(
        input.type === FulfillmentType.PREORDER
          ? "PRE"
          : input.type === FulfillmentType.PICKUP
            ? "PKP"
            : "DLV",
      );
    const fulfillmentNumber = generateDocNumber("FUL");
    const now = new Date();
    const shouldConfirm = input.confirmImmediately ?? false;

    const deliveryFields = this.resolveDeliveryFields(input, customer);

    const createdFulfillment = await this.prismaService.raw.$transaction(
      async (tx) => {
        const lineDescMap = new Map<number, string>();
        input.lines!.forEach((l, idx) => {
          if (l.description && l.description.trim().length > 0) {
            lineDescMap.set(idx, l.description.trim());
          }
        });

        const order = await tx.order.create({
          data: {
            organizationId,
            orderNumber,
            channel: orderChannel,
            status: shouldConfirm ? OrderStatus.CONFIRMED : OrderStatus.DRAFT,
            locationId: location.id,
            customerId: customer?.id ?? null,
            priceBookId: input.priceBookId ?? null,
            customerSegment: customer?.customerSegment ?? null,
            promoCodes: quote.promoCodes,
            currency: quote.currency,
            subtotalCents,
            discountTotalCents,
            taxCents,
            totalCents,
            paidAmountCents: cashPaymentCents,
            notes: input.notes?.trim() || null,
            ...(shouldConfirm
              ? { confirmedAt: now, confirmedByUserId: tenant.userId }
              : {}),
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
            lines: {
              create: quote.lines.map((ql, idx) => ({
                organizationId,
                itemId: ql.itemId,
                packId: ql.packId,
                servicePlanId: ql.servicePlanId,
                sku: ql.sku,
                name: ql.name,
                description: lineDescMap.get(idx) ?? ql.name,
                unitOfMeasure: ql.unitOfMeasure,
                unitsPerPack: ql.unitsPerPack,
                quantity: ql.quantity,
                fulfilledQty: 0,
                orderedBaseQty:
                  ql.totalBaseUnits + ql.bonusUnits * ql.unitsPerPack,
                reservedBaseQty: 0,
                fulfilledBaseQty: 0,
                bonusUnits: ql.bonusUnits,
                unitPriceCents: ql.effectiveUnitPriceCents,
                discountCents: ql.lineDiscountCents,
                lineTotalCents: ql.finalLineTotalCents,
                pricingSnapshot: {
                  pricingModel: ql.pricingModel,
                  listUnitPriceCents: ql.listUnitPriceCents,
                  tierSubtotalCents: ql.tierSubtotalCents,
                  appliedTiers: ql.appliedTiers,
                  appliedDiscounts: ql.appliedDiscounts,
                  bundleBreakdown: ql.bundleBreakdown,
                } as unknown as Prisma.InputJsonValue,
              })),
            },
          },
          include: { lines: true },
        });

        if (shouldConfirm) {
          await this.ordersService.reserveOrderStockInTx(tx, {
            organizationId,
            orderId: order.id,
          });
        }

        if (cashPaymentCents > 0) {
          await this.createCashPaymentAndReceiptInTx(tx, {
            organizationId,
            actorUserId: tenant.userId,
            order,
            location,
            customer,
            orgName: org?.name ?? "Organization",
            companyLegalName:
              organizationSettings?.companyLegalName ?? org?.name ?? "Organization",
            amountAppliedCents: cashPaymentCents,
            cashTenderedCents,
            notes: input.notes?.trim() || `Preorder/Order cash payment`,
            now,
          });
        }

        const fulfillment = await tx.orderFulfillment.create({
          data: {
            organizationId,
            fulfillmentNumber,
            orderId: order.id,
            locationId: location.id,
            customerId: customer?.id ?? null,
            type: input.type,
            status: FulfillmentStatus.PENDING,
            deliveryStage: DeliveryStage.NONE,
            stockReserved: shouldConfirm,
            stockDeducted: false,
            scheduledFulfillmentAt: input.scheduledFulfillmentAt
              ? new Date(input.scheduledFulfillmentAt)
              : null,
            depositRequiredCents,
            depositStatus,
            preparationNotes: input.preparationNotes?.trim() || null,
            autoConvertToJob: input.autoConvertToJob ?? null,
            pickupWindowStart: input.pickupWindowStart
              ? new Date(input.pickupWindowStart)
              : null,
            pickupWindowEnd: input.pickupWindowEnd
              ? new Date(input.pickupWindowEnd)
              : null,
            pickupInstructions: input.pickupInstructions?.trim() || null,
            ...deliveryFields,
            notificationsEnabled: input.notificationsEnabled ?? true,
            preferredChannel: input.preferredChannel ?? null,
            notifyOnPreorderReady: input.notifyOnPreorderReady ?? true,
            notifyOnJobCompleted: input.notifyOnJobCompleted ?? true,
            notifyOnDeliveryUpdates: input.notifyOnDeliveryUpdates ?? true,
            ...(shouldConfirm
              ? { confirmedAt: now, confirmedByUserId: tenant.userId }
              : {}),
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "fulfillment.created",
            resourceType: "OrderFulfillment",
            resourceId: fulfillment.id,
            metadata: {
              fulfillmentNumber: fulfillment.fulfillmentNumber,
              orderNumber: order.orderNumber,
              type: fulfillment.type,
              confirmImmediately: shouldConfirm,
              totalCents,
              cashPaymentCents,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return fulfillment;
      },
    );

    const shouldAutoConvert =
      input.type === FulfillmentType.PREORDER &&
      (input.autoConvertToJob ?? settings.autoConvertPreordersToJobs);

    if (shouldAutoConvert) {
      await this.staffJobsService.convertFulfillmentToJob(
        tenant,
        createdFulfillment.id,
        {},
        ipAddress,
      );
    }

    return this.getFulfillment(tenant, createdFulfillment.id);
  }

  private async attachFulfillmentToExistingOrder(
    tenant: AuthenticatedOrganization,
    input: CreateFulfillmentInput,
    settings: { autoConvertPreordersToJobs: boolean },
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const existingOrder = await this.prismaService.raw.order.findFirst({
      where: { id: input.orderId!, organizationId },
      include: {
        location: true,
        customer: true,
        fulfillment: { select: { id: true, fulfillmentNumber: true } },
      },
    });
    if (!existingOrder) {
      throw new NotFoundException("Order was not found.");
    }
    if (existingOrder.status === OrderStatus.CANCELLED) {
      throw new BadRequestException(
        "Cannot create a fulfillment for a cancelled order.",
      );
    }
    if (existingOrder.fulfillment) {
      throw new ConflictException(
        `Order "${existingOrder.orderNumber}" already has fulfillment "${existingOrder.fulfillment.fulfillmentNumber}".`,
      );
    }

    const fulfillmentNumber = generateDocNumber("FUL");
    const depositRequiredCents = input.depositRequiredCents ?? 0;
    const depositStatus = computeDepositStatus(
      depositRequiredCents,
      existingOrder.paidAmountCents,
      existingOrder.totalCents,
    );
    const shouldConfirm = input.confirmImmediately ?? false;
    const now = new Date();
    const deliveryFields = this.resolveDeliveryFields(input, existingOrder.customer);

    const created = await this.prismaService.raw.$transaction(async (tx) => {
      if (shouldConfirm) {
        await this.ordersService.reserveOrderStockInTx(tx, {
          organizationId,
          orderId: existingOrder.id,
        });
        if (existingOrder.status === OrderStatus.DRAFT) {
          await tx.order.update({
            where: { id: existingOrder.id },
            data: {
              status: OrderStatus.CONFIRMED,
              confirmedAt: existingOrder.confirmedAt ?? now,
              confirmedByUserId:
                existingOrder.confirmedByUserId ?? tenant.userId,
              updatedByUserId: tenant.userId,
            },
          });
        }
      }

      const fulfillment = await tx.orderFulfillment.create({
        data: {
          organizationId,
          fulfillmentNumber,
          orderId: existingOrder.id,
          locationId: existingOrder.locationId,
          customerId: existingOrder.customerId,
          type: input.type,
          status: FulfillmentStatus.PENDING,
          deliveryStage: DeliveryStage.NONE,
          stockReserved: shouldConfirm,
          stockDeducted: false,
          scheduledFulfillmentAt: input.scheduledFulfillmentAt
            ? new Date(input.scheduledFulfillmentAt)
            : null,
          depositRequiredCents,
          depositStatus,
          preparationNotes: input.preparationNotes?.trim() || null,
          autoConvertToJob: input.autoConvertToJob ?? null,
          pickupWindowStart: input.pickupWindowStart
            ? new Date(input.pickupWindowStart)
            : null,
          pickupWindowEnd: input.pickupWindowEnd
            ? new Date(input.pickupWindowEnd)
            : null,
          pickupInstructions: input.pickupInstructions?.trim() || null,
          ...deliveryFields,
          notificationsEnabled: input.notificationsEnabled ?? true,
          preferredChannel: input.preferredChannel ?? null,
          notifyOnPreorderReady: input.notifyOnPreorderReady ?? true,
          notifyOnJobCompleted: input.notifyOnJobCompleted ?? true,
          notifyOnDeliveryUpdates: input.notifyOnDeliveryUpdates ?? true,
          ...(shouldConfirm
            ? { confirmedAt: now, confirmedByUserId: tenant.userId }
            : {}),
          createdByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "fulfillment.created_for_order",
          resourceType: "OrderFulfillment",
          resourceId: fulfillment.id,
          metadata: {
            fulfillmentNumber,
            orderNumber: existingOrder.orderNumber,
            type: input.type,
            confirmImmediately: shouldConfirm,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return fulfillment;
    });

    const shouldAutoConvert =
      input.type === FulfillmentType.PREORDER &&
      (input.autoConvertToJob ?? settings.autoConvertPreordersToJobs);

    if (shouldAutoConvert) {
      await this.staffJobsService.convertFulfillmentToJob(
        tenant,
        created.id,
        {},
        ipAddress,
      );
    }

    const fulfillment = await this.getFulfillment(tenant, created.id);
    this.analyticsService.captureDomainEvent({
      event: "fulfillment.created",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        fulfillment_id: fulfillment.id,
        fulfillment_number: fulfillment.fulfillmentNumber,
        order_id: fulfillment.orderId,
        type: fulfillment.type,
        status: fulfillment.status,
      },
    });
    return fulfillment;
  }

  async confirmFulfillment(
    tenant: AuthenticatedOrganization,
    fulfillmentId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const settings = await this.getOrCreateSettings(tenant);

    const txResult = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.orderFulfillment.findFirst({
        where: { id: fulfillmentId, organizationId },
        include: {
          order: true,
          staffJobs: {
            where: { status: { not: StaffJobStatus.CANCELLED } },
            select: { id: true },
          },
        },
      });
      if (!existing) {
        throw new NotFoundException("Order fulfillment was not found.");
      }
      if (
        existing.status === FulfillmentStatus.COMPLETED ||
        existing.status === FulfillmentStatus.CANCELLED
      ) {
        throw new BadRequestException(
          `Cannot confirm a ${existing.status} fulfillment.`,
        );
      }

      if (!existing.stockReserved && !existing.stockDeducted) {
        await this.ordersService.reserveOrderStockInTx(tx, {
          organizationId,
          orderId: existing.orderId,
        });
      }

      const now = new Date();
      if (existing.order.status === OrderStatus.DRAFT) {
        await tx.order.update({
          where: { id: existing.orderId },
          data: {
            status: OrderStatus.CONFIRMED,
            confirmedAt: existing.order.confirmedAt ?? now,
            confirmedByUserId:
              existing.order.confirmedByUserId ?? tenant.userId,
            updatedByUserId: tenant.userId,
          },
        });
      }

      const nextStatus =
        existing.status === FulfillmentStatus.PENDING
          ? FulfillmentStatus.IN_PROGRESS
          : existing.status;

      const updated = await tx.orderFulfillment.update({
        where: { id: existing.id },
        data: {
          status: nextStatus,
          stockReserved: true,
          confirmedAt: existing.confirmedAt ?? now,
          confirmedByUserId: existing.confirmedByUserId ?? tenant.userId,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "fulfillment.confirmed",
          resourceType: "OrderFulfillment",
          resourceId: existing.id,
          metadata: {
            fulfillmentNumber: existing.fulfillmentNumber,
            orderNumber: existing.order.orderNumber,
            stockReserved: true,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        fulfillment: updated,
        hasActiveJobs: existing.staffJobs.length > 0,
      };
    });

    const shouldAutoConvert =
      txResult.fulfillment.type === FulfillmentType.PREORDER &&
      !txResult.hasActiveJobs &&
      (txResult.fulfillment.autoConvertToJob ??
        settings.autoConvertPreordersToJobs);

    if (shouldAutoConvert) {
      await this.staffJobsService.convertFulfillmentToJob(
        tenant,
        txResult.fulfillment.id,
        {},
        ipAddress,
      );
    }

    const confirmed = await this.getFulfillment(tenant, txResult.fulfillment.id);
    this.analyticsService.captureDomainEvent({
      event: "fulfillment.confirmed",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        fulfillment_id: confirmed.id,
        fulfillment_number: confirmed.fulfillmentNumber,
        type: confirmed.type,
        status: confirmed.status,
      },
    });
    return confirmed;
  }

  async updateFulfillment(
    tenant: AuthenticatedOrganization,
    fulfillmentId: string,
    input: UpdateFulfillmentInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    if (input.courierStaffId) {
      const courier = await this.prismaService.raw.staffProfile.findFirst({
        where: { id: input.courierStaffId, organizationId },
        select: { id: true, status: true },
      });
      if (!courier || courier.status === StaffStatus.OFFBOARDED) {
        throw new BadRequestException(
          "Assigned courier staff profile must exist and not be offboarded.",
        );
      }
    }

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.orderFulfillment.findFirst({
        where: { id: fulfillmentId, organizationId },
        include: { order: true },
      });
      if (!existing) {
        throw new NotFoundException("Order fulfillment was not found.");
      }
      if (
        existing.status === FulfillmentStatus.COMPLETED ||
        existing.status === FulfillmentStatus.CANCELLED
      ) {
        throw new BadRequestException(
          `Cannot modify a ${existing.status} fulfillment.`,
        );
      }

      const nextDepositReq =
        input.depositRequiredCents !== undefined
          ? input.depositRequiredCents
          : existing.depositRequiredCents;
      const nextDepositStatus = computeDepositStatus(
        nextDepositReq,
        existing.order.paidAmountCents,
        existing.order.totalCents,
      );

      await tx.orderFulfillment.update({
        where: { id: existing.id },
        data: {
          ...(input.scheduledFulfillmentAt !== undefined
            ? {
                scheduledFulfillmentAt: input.scheduledFulfillmentAt
                  ? new Date(input.scheduledFulfillmentAt)
                  : null,
              }
            : {}),
          ...(input.depositRequiredCents !== undefined
            ? {
                depositRequiredCents: nextDepositReq,
                depositStatus: nextDepositStatus,
              }
            : {}),
          ...(input.preparationNotes !== undefined
            ? { preparationNotes: input.preparationNotes?.trim() || null }
            : {}),
          ...(input.autoConvertToJob !== undefined
            ? { autoConvertToJob: input.autoConvertToJob }
            : {}),
          ...(input.pickupWindowStart !== undefined
            ? {
                pickupWindowStart: input.pickupWindowStart
                  ? new Date(input.pickupWindowStart)
                  : null,
              }
            : {}),
          ...(input.pickupWindowEnd !== undefined
            ? {
                pickupWindowEnd: input.pickupWindowEnd
                  ? new Date(input.pickupWindowEnd)
                  : null,
              }
            : {}),
          ...(input.pickupInstructions !== undefined
            ? { pickupInstructions: input.pickupInstructions?.trim() || null }
            : {}),
          ...(input.deliveryAddressLine1 !== undefined
            ? {
                deliveryAddressLine1:
                  input.deliveryAddressLine1?.trim() || null,
              }
            : {}),
          ...(input.deliveryAddressLine2 !== undefined
            ? {
                deliveryAddressLine2:
                  input.deliveryAddressLine2?.trim() || null,
              }
            : {}),
          ...(input.deliveryCity !== undefined
            ? { deliveryCity: input.deliveryCity?.trim() || null }
            : {}),
          ...(input.deliveryState !== undefined
            ? { deliveryState: input.deliveryState?.trim() || null }
            : {}),
          ...(input.deliveryPostalCode !== undefined
            ? { deliveryPostalCode: input.deliveryPostalCode?.trim() || null }
            : {}),
          ...(input.deliveryCountry !== undefined
            ? { deliveryCountry: input.deliveryCountry?.trim() || null }
            : {}),
          ...(input.deliveryInstructions !== undefined
            ? {
                deliveryInstructions:
                  input.deliveryInstructions?.trim() || null,
              }
            : {}),
          ...(input.deliveryWindowStart !== undefined
            ? {
                deliveryWindowStart: input.deliveryWindowStart
                  ? new Date(input.deliveryWindowStart)
                  : null,
              }
            : {}),
          ...(input.deliveryWindowEnd !== undefined
            ? {
                deliveryWindowEnd: input.deliveryWindowEnd
                  ? new Date(input.deliveryWindowEnd)
                  : null,
              }
            : {}),
          ...(input.courierStaffId !== undefined
            ? { courierStaffId: input.courierStaffId }
            : {}),
          ...(input.courierName !== undefined
            ? { courierName: input.courierName?.trim() || null }
            : {}),
          ...(input.courierPhone !== undefined
            ? { courierPhone: input.courierPhone?.trim() || null }
            : {}),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "fulfillment.updated",
          resourceType: "OrderFulfillment",
          resourceId: existing.id,
          metadata: {
            fulfillmentNumber: existing.fulfillmentNumber,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return this.getFulfillment(tenant, existing.id);
    });
  }

  async recordCashDepositPayment(
    tenant: AuthenticatedOrganization,
    fulfillmentId: string,
    input: RecordFulfillmentCashPaymentInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    if (input.method && input.method !== PaymentMethod.CASH) {
      throw new BadRequestException(
        "Only CASH payment is currently supported.",
      );
    }

    return this.prismaService.raw.$transaction(async (tx) => {
      const [fulfillment, org, organizationSettings] = await Promise.all([
        tx.orderFulfillment.findFirst({
          where: { id: fulfillmentId, organizationId },
          include: {
            order: { include: { lines: true } },
            location: true,
            customer: true,
          },
        }),
        tx.organization.findUnique({
          where: { id: organizationId },
          select: { id: true, name: true },
        }),
        tx.organizationSettings.findUnique({
          where: { organizationId },
          select: { companyLegalName: true },
        }),
      ]);

      if (!fulfillment) {
        throw new NotFoundException("Order fulfillment was not found.");
      }
      if (fulfillment.status === FulfillmentStatus.CANCELLED) {
        throw new BadRequestException(
          "Cannot record payment on a cancelled fulfillment.",
        );
      }

      const remainingBalance = Math.max(
        0,
        fulfillment.order.totalCents - fulfillment.order.paidAmountCents,
      );
      if (remainingBalance <= 0) {
        throw new BadRequestException("Order is already paid in full.");
      }
      if (input.amountCents <= 0 || input.amountCents > remainingBalance) {
        throw new BadRequestException(
          `Cash payment (${input.amountCents} cents) must be between 1 and ${remainingBalance} cents.`,
        );
      }

      const cashTenderedCents =
        input.cashTenderedCents !== undefined
          ? input.cashTenderedCents
          : input.amountCents;
      if (cashTenderedCents < input.amountCents) {
        throw new BadRequestException(
          `Cash tendered (${cashTenderedCents} cents) cannot be less than amount applied (${input.amountCents} cents).`,
        );
      }

      const now = new Date();
      const nextPaid = fulfillment.order.paidAmountCents + input.amountCents;
      const shouldCompleteOrder =
        fulfillment.order.status === OrderStatus.FULFILLED &&
        nextPaid >= fulfillment.order.totalCents;

      await tx.order.update({
        where: { id: fulfillment.orderId },
        data: {
          paidAmountCents: nextPaid,
          ...(shouldCompleteOrder
            ? { status: OrderStatus.COMPLETED, completedAt: now }
            : {}),
          updatedByUserId: tenant.userId,
        },
      });

      const nextDepositStatus = computeDepositStatus(
        fulfillment.depositRequiredCents,
        nextPaid,
        fulfillment.order.totalCents,
      );

      const updatedFulfillment = await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          depositStatus: nextDepositStatus,
          updatedByUserId: tenant.userId,
        },
      });

      const { payment, receipt } =
        await this.createCashPaymentAndReceiptInTx(tx, {
          organizationId,
          actorUserId: tenant.userId,
          order: fulfillment.order,
          location: fulfillment.location,
          customer: fulfillment.customer,
          orgName: org?.name ?? "Organization",
          companyLegalName:
            organizationSettings?.companyLegalName ?? org?.name ?? "Organization",
          amountAppliedCents: input.amountCents,
          cashTenderedCents,
          reference: input.reference ?? null,
          notes:
            input.notes?.trim() ||
            `Cash payment for ${fulfillment.type} ${fulfillment.fulfillmentNumber}`,
          now,
        });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "fulfillment.payment.recorded",
          resourceType: "OrderFulfillment",
          resourceId: fulfillment.id,
          metadata: {
            fulfillmentNumber: fulfillment.fulfillmentNumber,
            paymentNumber: payment.paymentNumber,
            receiptNumber: receipt.receiptNumber,
            amountAppliedCents: input.amountCents,
            depositStatus: nextDepositStatus,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        fulfillment: updatedFulfillment,
        payment,
        receipt,
      };
    });
  }

  async updateNotificationPreferences(
    tenant: AuthenticatedOrganization,
    fulfillmentId: string,
    input: UpdateNotificationPreferencesInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing = await this.prismaService.raw.orderFulfillment.findFirst({
      where: { id: fulfillmentId, organizationId },
    });
    if (!existing) {
      throw new NotFoundException("Order fulfillment was not found.");
    }

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const saved = await tx.orderFulfillment.update({
        where: { id: existing.id },
        data: {
          ...(input.notificationsEnabled !== undefined
            ? { notificationsEnabled: input.notificationsEnabled }
            : {}),
          ...(input.preferredChannel !== undefined
            ? { preferredChannel: input.preferredChannel }
            : {}),
          ...(input.notifyOnPreorderReady !== undefined
            ? { notifyOnPreorderReady: input.notifyOnPreorderReady }
            : {}),
          ...(input.notifyOnJobCompleted !== undefined
            ? { notifyOnJobCompleted: input.notifyOnJobCompleted }
            : {}),
          ...(input.notifyOnDeliveryUpdates !== undefined
            ? { notifyOnDeliveryUpdates: input.notifyOnDeliveryUpdates }
            : {}),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "fulfillment.notifications.updated",
          resourceType: "OrderFulfillment",
          resourceId: existing.id,
          metadata: input as unknown as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });

    return updated;
  }

  async transitionStatus(
    tenant: AuthenticatedOrganization,
    fulfillmentId: string,
    nextStatus: FulfillmentStatus,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    if (nextStatus === FulfillmentStatus.CANCELLED) {
      if (
        !hasOrganizationPermission(tenant.role, { fulfillment: ["cancel"] })
      ) {
        throw new ForbiddenException(
          "Insufficient role permissions to cancel fulfillments.",
        );
      }
      return this.cancelFulfillment(tenant, fulfillmentId, undefined, ipAddress);
    }

    if (
      nextStatus === FulfillmentStatus.COMPLETED &&
      !hasOrganizationPermission(tenant.role, { fulfillment: ["complete"] })
    ) {
      throw new ForbiddenException(
        "Insufficient role permissions to complete fulfillments.",
      );
    }

    const txResult = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.orderFulfillment.findFirst({
        where: { id: fulfillmentId, organizationId },
        include: { order: true },
      });
      if (!existing) {
        throw new NotFoundException("Order fulfillment was not found.");
      }
      if (
        existing.status === FulfillmentStatus.CANCELLED ||
        existing.status === FulfillmentStatus.COMPLETED
      ) {
        throw new BadRequestException(
          `Cannot transition a ${existing.status} fulfillment to ${nextStatus}.`,
        );
      }

      const now = new Date();
      let stockReserved = existing.stockReserved;
      let stockDeducted = existing.stockDeducted;

      if (
        (nextStatus === FulfillmentStatus.IN_PROGRESS ||
          nextStatus === FulfillmentStatus.READY) &&
        !stockReserved &&
        !stockDeducted
      ) {
        await this.ordersService.reserveOrderStockInTx(tx, {
          organizationId,
          orderId: existing.orderId,
        });
        stockReserved = true;
      }

      if (nextStatus === FulfillmentStatus.COMPLETED && !stockDeducted) {
        await this.ordersService.deductOrderStockInTx(tx, {
          organizationId,
          orderId: existing.orderId,
          actorUserId: tenant.userId,
          reason: `${existing.type} fulfillment ${existing.fulfillmentNumber} completed`,
        });
        stockDeducted = true;
        stockReserved = false;

        await tx.order.update({
          where: { id: existing.orderId },
          data: {
            status:
              existing.order.paidAmountCents >= existing.order.totalCents
                ? OrderStatus.COMPLETED
                : OrderStatus.FULFILLED,
            fulfilledAt: now,
            fulfilledByUserId: tenant.userId,
            ...(existing.order.paidAmountCents >= existing.order.totalCents
              ? { completedAt: now }
              : {}),
            updatedByUserId: tenant.userId,
          },
        });
      }

      const updated = await tx.orderFulfillment.update({
        where: { id: existing.id },
        data: {
          status: nextStatus,
          stockReserved,
          stockDeducted,
          ...(nextStatus !== FulfillmentStatus.PENDING && !existing.confirmedAt
            ? { confirmedAt: now, confirmedByUserId: tenant.userId }
            : {}),
          ...(nextStatus === FulfillmentStatus.READY && !existing.readyAt
            ? { readyAt: now }
            : {}),
          ...(nextStatus === FulfillmentStatus.COMPLETED
            ? {
                readyAt: existing.readyAt ?? now,
                completedAt: now,
                completedByUserId: tenant.userId,
              }
            : {}),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "fulfillment.status_updated",
          resourceType: "OrderFulfillment",
          resourceId: existing.id,
          metadata: {
            fulfillmentNumber: existing.fulfillmentNumber,
            previousStatus: existing.status,
            nextStatus,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });

    let notification = null;
    if (
      nextStatus === FulfillmentStatus.READY &&
      txResult.type === FulfillmentType.PREORDER
    ) {
      notification =
        await this.notificationsService.dispatchFulfillmentNotification(
          tenant,
          {
            fulfillmentId: txResult.id,
            eventType: NotificationEventType.PREORDER_READY,
            triggerSource: "AUTO",
          },
          ipAddress,
        );
    }

    const full = await this.getFulfillment(tenant, txResult.id);
    return {
      fulfillment: full,
      notification,
    };
  }

  async confirmPickupHandoff(
    tenant: AuthenticatedOrganization,
    fulfillmentId: string,
    notes?: string | null,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.orderFulfillment.findFirst({
        where: { id: fulfillmentId, organizationId },
        include: { order: true },
      });
      if (!existing) {
        throw new NotFoundException("Order fulfillment was not found.");
      }
      if (
        existing.type !== FulfillmentType.PICKUP &&
        existing.type !== FulfillmentType.PREORDER
      ) {
        throw new BadRequestException(
          "Pickup handoff is only applicable to PICKUP or PREORDER fulfillments.",
        );
      }
      if (
        existing.status === FulfillmentStatus.COMPLETED ||
        existing.status === FulfillmentStatus.CANCELLED
      ) {
        throw new BadRequestException(
          `Cannot confirm handoff for a ${existing.status} fulfillment.`,
        );
      }

      const now = new Date();
      if (!existing.stockDeducted) {
        await this.ordersService.deductOrderStockInTx(tx, {
          organizationId,
          orderId: existing.orderId,
          actorUserId: tenant.userId,
          reason: `Pickup handoff ${existing.fulfillmentNumber}`,
        });
      }

      await tx.order.update({
        where: { id: existing.orderId },
        data: {
          status:
            existing.order.paidAmountCents >= existing.order.totalCents
              ? OrderStatus.COMPLETED
              : OrderStatus.FULFILLED,
          fulfilledAt: now,
          fulfilledByUserId: tenant.userId,
          ...(existing.order.paidAmountCents >= existing.order.totalCents
            ? { completedAt: now }
            : {}),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.orderFulfillment.update({
        where: { id: existing.id },
        data: {
          status: FulfillmentStatus.COMPLETED,
          stockReserved: false,
          stockDeducted: true,
          confirmedAt: existing.confirmedAt ?? now,
          confirmedByUserId: existing.confirmedByUserId ?? tenant.userId,
          readyAt: existing.readyAt ?? now,
          handoffConfirmedAt: now,
          handoffConfirmedByUserId: tenant.userId,
          completedAt: now,
          completedByUserId: tenant.userId,
          ...(notes
            ? {
                pickupInstructions: existing.pickupInstructions
                  ? `${existing.pickupInstructions}\n[Handoff]: ${notes.trim()}`
                  : notes.trim(),
              }
            : {}),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "fulfillment.pickup.handoff_confirmed",
          resourceType: "OrderFulfillment",
          resourceId: existing.id,
          metadata: {
            fulfillmentNumber: existing.fulfillmentNumber,
            orderNumber: existing.order.orderNumber,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });
    });

    return this.getFulfillment(tenant, fulfillmentId);
  }

  async markOutForDelivery(
    tenant: AuthenticatedOrganization,
    fulfillmentId: string,
    input: {
      courierStaffId?: string | null;
      courierName?: string | null;
      courierPhone?: string | null;
      notes?: string | null;
    },
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    if (input.courierStaffId) {
      const courier = await this.prismaService.raw.staffProfile.findFirst({
        where: { id: input.courierStaffId, organizationId },
        select: { id: true, status: true },
      });
      if (!courier || courier.status === StaffStatus.OFFBOARDED) {
        throw new BadRequestException(
          "Assigned courier staff profile must exist and not be offboarded.",
        );
      }
    }

    await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.orderFulfillment.findFirst({
        where: { id: fulfillmentId, organizationId },
        include: { order: true },
      });
      if (!existing) {
        throw new NotFoundException("Order fulfillment was not found.");
      }
      if (
        existing.type !== FulfillmentType.DELIVERY &&
        existing.type !== FulfillmentType.PREORDER
      ) {
        throw new BadRequestException(
          "Delivery dispatch is only valid for DELIVERY or PREORDER fulfillments.",
        );
      }
      if (
        existing.status === FulfillmentStatus.COMPLETED ||
        existing.status === FulfillmentStatus.CANCELLED
      ) {
        throw new BadRequestException(
          `Cannot mark a ${existing.status} fulfillment as out for delivery.`,
        );
      }

      if (!existing.stockReserved && !existing.stockDeducted) {
        await this.ordersService.reserveOrderStockInTx(tx, {
          organizationId,
          orderId: existing.orderId,
        });
      }

      const now = new Date();
      await tx.orderFulfillment.update({
        where: { id: existing.id },
        data: {
          status:
            existing.status === FulfillmentStatus.PENDING
              ? FulfillmentStatus.IN_PROGRESS
              : existing.status,
          deliveryStage: DeliveryStage.OUT_FOR_DELIVERY,
          outForDeliveryAt: now,
          stockReserved: true,
          confirmedAt: existing.confirmedAt ?? now,
          confirmedByUserId: existing.confirmedByUserId ?? tenant.userId,
          ...(input.courierStaffId !== undefined
            ? { courierStaffId: input.courierStaffId }
            : {}),
          ...(input.courierName !== undefined
            ? { courierName: input.courierName?.trim() || null }
            : {}),
          ...(input.courierPhone !== undefined
            ? { courierPhone: input.courierPhone?.trim() || null }
            : {}),
          ...(input.notes
            ? {
                deliveryInstructions: existing.deliveryInstructions
                  ? `${existing.deliveryInstructions}\n[Dispatch]: ${input.notes.trim()}`
                  : input.notes.trim(),
              }
            : {}),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "fulfillment.delivery.out_for_delivery",
          resourceType: "OrderFulfillment",
          resourceId: existing.id,
          metadata: {
            fulfillmentNumber: existing.fulfillmentNumber,
            orderNumber: existing.order.orderNumber,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });
    });

    const notification =
      await this.notificationsService.dispatchFulfillmentNotification(
        tenant,
        {
          fulfillmentId,
          eventType: NotificationEventType.DELIVERY_OUT_FOR_DELIVERY,
          triggerSource: "AUTO",
        },
        ipAddress,
      );

    return {
      fulfillment: await this.getFulfillment(tenant, fulfillmentId),
      notification,
    };
  }

  async markDelivered(
    tenant: AuthenticatedOrganization,
    fulfillmentId: string,
    notes?: string | null,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.orderFulfillment.findFirst({
        where: { id: fulfillmentId, organizationId },
        include: { order: true },
      });
      if (!existing) {
        throw new NotFoundException("Order fulfillment was not found.");
      }
      if (
        existing.type !== FulfillmentType.DELIVERY &&
        existing.type !== FulfillmentType.PREORDER
      ) {
        throw new BadRequestException(
          "Delivery completion is only valid for DELIVERY or PREORDER fulfillments.",
        );
      }
      if (
        existing.status === FulfillmentStatus.COMPLETED ||
        existing.status === FulfillmentStatus.CANCELLED
      ) {
        throw new BadRequestException(
          `Cannot mark a ${existing.status} fulfillment as delivered.`,
        );
      }

      const now = new Date();
      if (!existing.stockDeducted) {
        await this.ordersService.deductOrderStockInTx(tx, {
          organizationId,
          orderId: existing.orderId,
          actorUserId: tenant.userId,
          reason: `Delivered fulfillment ${existing.fulfillmentNumber}`,
        });
      }

      await tx.order.update({
        where: { id: existing.orderId },
        data: {
          status:
            existing.order.paidAmountCents >= existing.order.totalCents
              ? OrderStatus.COMPLETED
              : OrderStatus.FULFILLED,
          fulfilledAt: now,
          fulfilledByUserId: tenant.userId,
          ...(existing.order.paidAmountCents >= existing.order.totalCents
            ? { completedAt: now }
            : {}),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.orderFulfillment.update({
        where: { id: existing.id },
        data: {
          status: FulfillmentStatus.COMPLETED,
          deliveryStage: DeliveryStage.DELIVERED,
          outForDeliveryAt: existing.outForDeliveryAt ?? now,
          deliveredAt: now,
          readyAt: existing.readyAt ?? now,
          completedAt: now,
          completedByUserId: tenant.userId,
          stockReserved: false,
          stockDeducted: true,
          ...(notes
            ? {
                deliveryInstructions: existing.deliveryInstructions
                  ? `${existing.deliveryInstructions}\n[Delivered]: ${notes.trim()}`
                  : notes.trim(),
              }
            : {}),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "fulfillment.delivery.delivered",
          resourceType: "OrderFulfillment",
          resourceId: existing.id,
          metadata: {
            fulfillmentNumber: existing.fulfillmentNumber,
            orderNumber: existing.order.orderNumber,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });
    });

    const notification =
      await this.notificationsService.dispatchFulfillmentNotification(
        tenant,
        {
          fulfillmentId,
          eventType: NotificationEventType.DELIVERY_DELIVERED,
          triggerSource: "AUTO",
        },
        ipAddress,
      );

    const delivered = await this.getFulfillment(tenant, fulfillmentId);
    this.analyticsService.captureDomainEvent({
      event: "fulfillment.delivered",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        fulfillment_id: delivered.id,
        fulfillment_number: delivered.fulfillmentNumber,
        type: delivered.type,
        status: delivered.status,
      },
    });

    return {
      fulfillment: delivered,
      notification,
    };
  }

  async cancelFulfillment(
    tenant: AuthenticatedOrganization,
    fulfillmentId: string,
    reason?: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.orderFulfillment.findFirst({
        where: { id: fulfillmentId, organizationId },
        include: { order: true },
      });
      if (!existing) {
        throw new NotFoundException("Order fulfillment was not found.");
      }
      if (
        existing.status === FulfillmentStatus.COMPLETED ||
        existing.status === FulfillmentStatus.CANCELLED
      ) {
        throw new BadRequestException(
          `Cannot cancel a ${existing.status} fulfillment.`,
        );
      }

      const now = new Date();
      if (existing.stockReserved && !existing.stockDeducted) {
        await this.ordersService.releaseOrderStockInTx(tx, {
          organizationId,
          orderId: existing.orderId,
        });
      }

      await tx.staffJob.updateMany({
        where: {
          organizationId,
          fulfillmentId: existing.id,
          status: { in: [StaffJobStatus.ASSIGNED, StaffJobStatus.IN_PROGRESS] },
        },
        data: {
          status: StaffJobStatus.CANCELLED,
          cancelledAt: now,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.orderFulfillment.update({
        where: { id: existing.id },
        data: {
          status: FulfillmentStatus.CANCELLED,
          stockReserved: false,
          cancelledAt: now,
          cancelReason: reason?.trim() || null,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "fulfillment.cancelled",
          resourceType: "OrderFulfillment",
          resourceId: existing.id,
          metadata: {
            fulfillmentNumber: existing.fulfillmentNumber,
            previousStatus: existing.status,
            ...(reason ? { reason } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });
    });

    const cancelled = await this.getFulfillment(tenant, fulfillmentId);
    this.analyticsService.captureDomainEvent({
      event: "fulfillment.cancelled",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        fulfillment_id: cancelled.id,
        fulfillment_number: cancelled.fulfillmentNumber,
        type: cancelled.type,
      },
    });
    return cancelled;
  }

  async listFulfillments(
    tenant: AuthenticatedOrganization,
    query: ListFulfillmentsQuery,
  ) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const dateFilter: Prisma.DateTimeNullableFilter | undefined =
      query.dateFrom || query.dateTo
        ? {
            ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
            ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
          }
        : undefined;

    const records = await this.prismaService.scoped.orderFulfillment.findMany({
      where: {
        ...(query.type ? { type: query.type } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.deliveryStage ? { deliveryStage: query.deliveryStage } : {}),
        ...(query.depositStatus ? { depositStatus: query.depositStatus } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.courierStaffId ? { courierStaffId: query.courierStaffId } : {}),
        ...(dateFilter ? { scheduledFulfillmentAt: dateFilter } : {}),
        ...(search
          ? {
              OR: [
                { fulfillmentNumber: { contains: search, mode: "insensitive" } },
                {
                  order: {
                    orderNumber: { contains: search, mode: "insensitive" },
                  },
                },
                {
                  customer: {
                    name: { contains: search, mode: "insensitive" },
                  },
                },
                { courierName: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        location: { select: { id: true, code: true, name: true, type: true } },
        customer: {
          select: {
            id: true,
            code: true,
            name: true,
            companyName: true,
            phone: true,
            email: true,
          },
        },
        courierStaff: {
          select: { id: true, displayName: true, phone: true },
        },
        order: {
          select: {
            id: true,
            orderNumber: true,
            channel: true,
            status: true,
            currency: true,
            totalCents: true,
            paidAmountCents: true,
          },
        },
        _count: {
          select: { staffJobs: true, notifications: true },
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

  async getFulfillment(tenant: AuthenticatedOrganization, fulfillmentId: string) {
    this.resolveVerifiedOrganizationId(tenant);
    const fulfillment =
      await this.prismaService.scoped.orderFulfillment.findUnique({
        where: { id: fulfillmentId },
        include: {
          location: { select: { id: true, code: true, name: true, type: true } },
          customer: true,
          courierStaff: {
            select: { id: true, displayName: true, phone: true, workEmail: true },
          },
          order: {
            include: {
              lines: true,
              payments: {
                orderBy: { receivedAt: "desc" },
                include: { receipt: true },
              },
            },
          },
          staffJobs: {
            orderBy: { createdAt: "desc" },
            include: {
              assignedStaff: {
                select: { id: true, displayName: true, jobTitle: true },
              },
              assignedDepartment: {
                select: { id: true, code: true, name: true },
              },
              assignedTeam: {
                select: { id: true, slug: true, name: true },
              },
            },
          },
          notifications: {
            orderBy: { createdAt: "desc" },
            take: 25,
          },
        },
      });

    if (!fulfillment) {
      throw new NotFoundException("Order fulfillment was not found.");
    }

    return fulfillment;
  }

  private resolveDeliveryFields(
    input: CreateFulfillmentInput,
    customer: {
      shippingAddressLine1: string | null;
      shippingAddressLine2: string | null;
      shippingCity: string | null;
      shippingState: string | null;
      shippingPostalCode: string | null;
      shippingCountry: string | null;
      billingAddressLine1: string | null;
      billingAddressLine2: string | null;
      billingCity: string | null;
      billingState: string | null;
      billingPostalCode: string | null;
      billingCountry: string | null;
    } | null,
  ) {
    return {
      deliveryAddressLine1:
        input.deliveryAddressLine1?.trim() ||
        customer?.shippingAddressLine1 ||
        customer?.billingAddressLine1 ||
        null,
      deliveryAddressLine2:
        input.deliveryAddressLine2?.trim() ||
        customer?.shippingAddressLine2 ||
        customer?.billingAddressLine2 ||
        null,
      deliveryCity:
        input.deliveryCity?.trim() ||
        customer?.shippingCity ||
        customer?.billingCity ||
        null,
      deliveryState:
        input.deliveryState?.trim() ||
        customer?.shippingState ||
        customer?.billingState ||
        null,
      deliveryPostalCode:
        input.deliveryPostalCode?.trim() ||
        customer?.shippingPostalCode ||
        customer?.billingPostalCode ||
        null,
      deliveryCountry:
        input.deliveryCountry?.trim() ||
        customer?.shippingCountry ||
        customer?.billingCountry ||
        null,
      deliveryInstructions: input.deliveryInstructions?.trim() || null,
      deliveryWindowStart: input.deliveryWindowStart
        ? new Date(input.deliveryWindowStart)
        : null,
      deliveryWindowEnd: input.deliveryWindowEnd
        ? new Date(input.deliveryWindowEnd)
        : null,
      courierStaffId: input.courierStaffId ?? null,
      courierName: input.courierName?.trim() || null,
      courierPhone: input.courierPhone?.trim() || null,
    };
  }

  private async createCashPaymentAndReceiptInTx(
    tx: Prisma.TransactionClient,
    params: {
      organizationId: string;
      actorUserId: string;
      order: {
        id: string;
        orderNumber: string;
        channel: OrderChannel;
        currency: string;
        subtotalCents: number;
        discountTotalCents: number;
        taxCents: number;
        totalCents: number;
        lines: Array<{
          sku: string;
          name: string;
          description: string | null;
          unitOfMeasure: string;
          quantity: number;
          unitPriceCents: number;
          discountCents: number;
          lineTotalCents: number;
        }>;
      };
      location: { name: string; code: string };
      customer: {
        id: string;
        code: string;
        name: string;
        companyName: string | null;
        email: string | null;
        phone: string | null;
        taxId: string | null;
      } | null;
      orgName: string;
      companyLegalName: string;
      amountAppliedCents: number;
      cashTenderedCents: number;
      reference?: string | null;
      notes?: string | null;
      now: Date;
    },
  ) {
    const paymentNumber = generateDocNumber("PAY");
    const receiptNumber = generateDocNumber("RCP");
    const changeGivenCents = params.cashTenderedCents - params.amountAppliedCents;

    const payment = await tx.customerPayment.create({
      data: {
        organizationId: params.organizationId,
        paymentNumber,
        orderId: params.order.id,
        customerId: params.customer?.id ?? null,
        method: PaymentMethod.CASH,
        status: CustomerPaymentStatus.COMPLETED,
        currency: params.order.currency,
        amountAppliedCents: params.amountAppliedCents,
        cashTenderedCents: params.cashTenderedCents,
        changeGivenCents,
        reference: params.reference?.trim() || null,
        notes: params.notes?.trim() || null,
        receivedByUserId: params.actorUserId,
        receivedAt: params.now,
      },
    });

    const receiptSnapshot: PrintableReceiptDocument = {
      receiptNumber,
      paymentNumber,
      orderNumber: params.order.orderNumber,
      invoiceNumber: null,
      channel: params.order.channel,
      paymentMethod: PaymentMethod.CASH,
      currency: params.order.currency,
      issuedAt: params.now.toISOString(),
      locationName: params.location.name,
      locationCode: params.location.code,
      subtotalCents: params.order.subtotalCents,
      discountTotalCents: params.order.discountTotalCents,
      taxCents: params.order.taxCents,
      totalCents: params.order.totalCents,
      amountAppliedCents: params.amountAppliedCents,
      cashTenderedCents: params.cashTenderedCents,
      changeGivenCents,
      notes: params.notes ?? null,
      organization: {
        name: params.orgName,
        companyName: params.companyLegalName,
      },
      customer: params.customer
        ? {
            name: params.customer.name,
            companyName: params.customer.companyName,
            code: params.customer.code,
            email: params.customer.email,
            phone: params.customer.phone,
            taxId: params.customer.taxId,
          }
        : null,
      lines: params.order.lines.map((l) => ({
        sku: l.sku,
        description: l.description || l.name,
        unitOfMeasure: l.unitOfMeasure,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        discountCents: l.discountCents,
        lineTotalCents: l.lineTotalCents,
      })),
    };

    const receipt = await tx.paymentReceipt.create({
      data: {
        organizationId: params.organizationId,
        receiptNumber,
        paymentId: payment.id,
        orderId: params.order.id,
        customerId: params.customer?.id ?? null,
        channel: params.order.channel,
        currency: params.order.currency,
        totalCents: params.order.totalCents,
        cashTenderedCents: params.cashTenderedCents,
        changeGivenCents,
        snapshot: receiptSnapshot as unknown as Prisma.InputJsonValue,
        issuedAt: params.now,
        issuedByUserId: params.actorUserId,
      },
    });

    return { payment, receipt };
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedOrganization): string {
    const contextOrgId = OrganizationContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active organization context mismatch.");
    }
    return tenant.organizationId;
  }
}

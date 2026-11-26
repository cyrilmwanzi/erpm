import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  CustomerPaymentStatus,
  CustomerStatus,
  ItemStatus,
  ItemVariantKind,
  LocationStatus,
  OrderChannel,
  OrderStatus,
  PaymentMethod,
  PaymentTargetType,
  PriceBookDirection,
  Prisma,
  SalesInvoiceStatus,
  StockMovementType,
  TenantContext,
} from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import { MpesaPaymentService } from "../payments/mpesa-payment.service.js";
import {
  centsToDarajaWholeAmount,
  normalizeKenyanPhoneNumber,
} from "../payments/mpesa-security.utils.js";
import {
  PricingEngineService,
  type CalculatedQuoteLine,
} from "../pricing/pricing-engine.service.js";
import type { AuthenticatedTenant } from "../tenancy/tenant.decorators.js";
import type { PrintableReceiptDocument } from "./document-renderer.utils.js";
import {
  releaseOrderStockInTransaction,
  reserveOrderStockInTransaction,
} from "./order-stock.utils.js";

export interface OrderLineInput {
  itemId: string;
  quantity: number;
  packId?: string | null;
  servicePlanId?: string | null;
  overrideUnitPriceCents?: number | null;
  description?: string | null;
}

export interface PosCheckoutInput {
  orderNumber?: string;
  locationId: string;
  customerId?: string | null;
  priceBookId?: string | null;
  promoCodes?: string[];
  currency?: string;
  taxCents?: number;
  cashTenderedCents?: number;
  paymentMethod?: "CASH" | "MPESA";
  mpesaPhoneNumber?: string | null;
  mpesaAccountReference?: string | null;
  mpesaTransactionDesc?: string | null;
  reference?: string | null;
  notes?: string | null;
  lines: OrderLineInput[];
}

export interface CreateB2bOrderInput {
  orderNumber?: string;
  locationId: string;
  customerId: string;
  priceBookId?: string | null;
  externalDealId?: string | null;
  promoCodes?: string[];
  currency?: string;
  taxCents?: number;
  notes?: string | null;
  lines: OrderLineInput[];
}

export interface UpdateDraftB2bOrderInput {
  locationId?: string;
  customerId?: string;
  priceBookId?: string | null;
  externalDealId?: string | null;
  promoCodes?: string[];
  currency?: string;
  taxCents?: number;
  notes?: string | null;
  lines?: OrderLineInput[];
}

export interface ConfirmB2bOrderInput {
  issueInvoice?: boolean;
  invoiceDueAt?: string | null;
  invoiceNotes?: string | null;
}

export interface FulfillB2bOrderInput {
  lines?: Array<{
    orderLineId: string;
    quantity: number;
  }>;
  notes?: string | null;
}

export interface ListOrdersQuery {
  channel?: OrderChannel;
  status?: OrderStatus;
  customerId?: string;
  locationId?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function generateDocNumber(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
}

interface StockDeductionRequirement {
  itemId: string;
  sku: string;
  baseQty: number;
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(PricingEngineService)
    private readonly pricingEngine: PricingEngineService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
    @Inject(MpesaPaymentService)
    private readonly mpesaPaymentService: MpesaPaymentService,
  ) {}

  async posCheckout(
    tenant: AuthenticatedTenant,
    input: PosCheckoutInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const resolvedMethod = input.paymentMethod ?? PaymentMethod.CASH;

    if (
      resolvedMethod !== PaymentMethod.CASH &&
      resolvedMethod !== PaymentMethod.MPESA
    ) {
      throw new BadRequestException(
        "Only CASH and MPESA payment methods are supported.",
      );
    }

    const [location, customer, org, settings] = await Promise.all([
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
      this.prismaService.raw.tenantSettings.findUnique({
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
        "Cannot link an archived customer to a POS order.",
      );
    }

    const quote = await this.pricingEngine.calculateQuote(tenant, {
      direction: PriceBookDirection.SALES,
      currency: input.currency ?? customer?.currency ?? settings?.defaultCurrency,
      priceBookId: input.priceBookId ?? null,
      customerSegment: customer?.customerSegment ?? null,
      externalAccountId:
        customer?.externalAccountId ??
        customer?.externalCompanyId ??
        customer?.externalContactId ??
        null,
      channel: "POS",
      promoCodes: input.promoCodes,
      lines: input.lines.map((l) => ({
        itemId: l.itemId,
        quantity: l.quantity,
        packId: l.packId ?? null,
        servicePlanId: l.servicePlanId ?? null,
        overrideUnitPriceCents: l.overrideUnitPriceCents ?? null,
      })),
    });

    const templateLine = quote.lines.find(
      (ql) => ql.variantKind === ItemVariantKind.TEMPLATE,
    );
    if (templateLine) {
      throw new BadRequestException(
        `Item "${templateLine.sku}" is a product template. Select a concrete variant SKU instead.`,
      );
    }

    const subtotalCents = quote.subtotalAfterTiersCents;
    const discountTotalCents = quote.totalDiscountCents;
    const taxCents = input.taxCents ?? 0;
    const totalCents = quote.totalCents + taxCents;
    const orderNumber =
      input.orderNumber?.trim().toUpperCase() || generateDocNumber("POS");
    const now = new Date();

    if (resolvedMethod === PaymentMethod.MPESA) {
      const rawPhone = input.mpesaPhoneNumber?.trim() || customer?.phone?.trim();
      if (!rawPhone) {
        throw new BadRequestException(
          "mpesaPhoneNumber is required when checking out with MPESA.",
        );
      }
      const normalizedPhone = normalizeKenyanPhoneNumber(rawPhone);
      centsToDarajaWholeAmount(totalCents);

      const lineDescMap = new Map<number, string>();
      input.lines.forEach((l, idx) => {
        if (l.description && l.description.trim().length > 0) {
          lineDescMap.set(idx, l.description.trim());
        }
      });

      let createdOrder: { id: string; orderNumber: string; currency: string };
      try {
        createdOrder = await this.prismaService.raw.$transaction(async (tx) => {
          const order = await tx.order.create({
            data: {
              organizationId,
              orderNumber,
              channel: OrderChannel.POS,
              status: OrderStatus.CONFIRMED,
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
              paidAmountCents: 0,
              notes: input.notes?.trim() || null,
              confirmedAt: now,
              confirmedByUserId: tenant.userId,
              createdByUserId: tenant.userId,
              updatedByUserId: tenant.userId,
              lines: {
                create: quote.lines.map((ql, idx) => {
                  const orderedBaseQty =
                    ql.totalBaseUnits + ql.bonusUnits * ql.unitsPerPack;
                  return {
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
                    orderedBaseQty,
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
                      parentItemId: ql.parentItemId,
                      pricingInheritedFromParent: ql.pricingInheritedFromParent,
                      variantAttributes: ql.variantAttributes,
                    } as unknown as Prisma.InputJsonValue,
                  };
                }),
              },
            },
          });

          await reserveOrderStockInTransaction(tx, {
            organizationId,
            orderId: order.id,
          });

          await tx.auditLog.create({
            data: {
              organizationId,
              actorUserId: tenant.userId,
              action: "order.pos.mpesa_pending",
              resourceType: "Order",
              resourceId: order.id,
              metadata: {
                orderNumber: order.orderNumber,
                locationCode: location.code,
                customerId: customer?.id ?? null,
                totalCents,
                phoneNumber: normalizedPhone,
              } as Prisma.InputJsonValue,
              ipAddress: ipAddress ?? null,
            },
          });

          return order;
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ConflictException(
            `Order number "${orderNumber}" already exists in this organization.`,
          );
        }
        throw error;
      }

      try {
        const stkResult = await this.mpesaPaymentService.dispatchStkPush({
          organizationId,
          actorUserId: tenant.userId,
          targetType: PaymentTargetType.POS_ORDER,
          orderId: createdOrder.id,
          customerId: customer?.id ?? null,
          currency: createdOrder.currency,
          amountCents: totalCents,
          phoneNumber: normalizedPhone,
          defaultAccountReference: createdOrder.orderNumber,
          accountReference: input.mpesaAccountReference,
          transactionDesc: input.mpesaTransactionDesc,
          ipAddress,
        });

        const fullOrder = await this.getOrder(tenant, createdOrder.id);
        return {
          checkoutStatus: "PENDING_MPESA_CONFIRMATION",
          order: fullOrder,
          ...stkResult,
        };
      } catch (error) {
        await this.prismaService.raw.$transaction(async (tx) => {
          await releaseOrderStockInTransaction(tx, {
            organizationId,
            orderId: createdOrder.id,
          });
          await tx.order.update({
            where: { id: createdOrder.id },
            data: {
              status: OrderStatus.CANCELLED,
              cancelledAt: new Date(),
              cancelReason: "M-Pesa STK Push initiation failed",
              updatedByUserId: tenant.userId,
            },
          });
        });
        throw error;
      }
    }

    const cashTenderedCents =
      input.cashTenderedCents !== undefined
        ? input.cashTenderedCents
        : totalCents;

    if (cashTenderedCents < totalCents) {
      throw new BadRequestException(
        `Insufficient cash tendered (${cashTenderedCents} cents) for POS total (${totalCents} cents).`,
      );
    }

    const changeGivenCents = cashTenderedCents - totalCents;
    const paymentNumber = generateDocNumber("PAY");
    const receiptNumber = generateDocNumber("RCP");

    try {
      const result = await this.prismaService.raw.$transaction(async (tx) => {
        const lineDescMap = new Map<number, string>();
        input.lines.forEach((l, idx) => {
          if (l.description && l.description.trim().length > 0) {
            lineDescMap.set(idx, l.description.trim());
          }
        });

        const deductionRequirements = await this.collectDeductionRequirements(
          tx,
          organizationId,
          quote.lines,
        );

        const order = await tx.order.create({
          data: {
            organizationId,
            orderNumber,
            channel: OrderChannel.POS,
            status: OrderStatus.COMPLETED,
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
            paidAmountCents: totalCents,
            notes: input.notes?.trim() || null,
            confirmedAt: now,
            confirmedByUserId: tenant.userId,
            fulfilledAt: now,
            fulfilledByUserId: tenant.userId,
            completedAt: now,
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
            lines: {
              create: quote.lines.map((ql, idx) => {
                const orderedBaseQty =
                  ql.totalBaseUnits + ql.bonusUnits * ql.unitsPerPack;
                return {
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
                  fulfilledQty: ql.quantity,
                  orderedBaseQty,
                  reservedBaseQty: 0,
                  fulfilledBaseQty: orderedBaseQty,
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
                    parentItemId: ql.parentItemId,
                    pricingInheritedFromParent: ql.pricingInheritedFromParent,
                    variantAttributes: ql.variantAttributes,
                  } as unknown as Prisma.InputJsonValue,
                };
              }),
            },
          },
          include: {
            location: { select: { id: true, code: true, name: true, type: true } },
            customer: {
              select: {
                id: true,
                code: true,
                name: true,
                companyName: true,
                email: true,
                phone: true,
                taxId: true,
                type: true,
              },
            },
            lines: true,
          },
        });

        for (const req of deductionRequirements) {
          await this.deductStockBalance(tx, {
            organizationId,
            itemId: req.itemId,
            locationId: location.id,
            locationCode: location.code,
            baseQty: req.baseQty,
            releaseReservedQty: 0,
            referenceType: "Order",
            referenceId: order.id,
            reason: `POS sale ${order.orderNumber}`,
            actorUserId: tenant.userId,
          });
        }

        const payment = await tx.customerPayment.create({
          data: {
            organizationId,
            paymentNumber,
            orderId: order.id,
            customerId: customer?.id ?? null,
            method: PaymentMethod.CASH,
            status: CustomerPaymentStatus.COMPLETED,
            currency: order.currency,
            amountAppliedCents: totalCents,
            cashTenderedCents,
            changeGivenCents,
            reference: input.reference?.trim() || null,
            notes: input.notes?.trim() || null,
            receivedByUserId: tenant.userId,
            receivedAt: now,
          },
        });

        const receiptSnapshot: PrintableReceiptDocument = {
          receiptNumber,
          paymentNumber,
          orderNumber: order.orderNumber,
          invoiceNumber: null,
          channel: OrderChannel.POS,
          paymentMethod: PaymentMethod.CASH,
          currency: order.currency,
          issuedAt: now.toISOString(),
          locationName: location.name,
          locationCode: location.code,
          subtotalCents,
          discountTotalCents,
          taxCents,
          totalCents,
          amountAppliedCents: totalCents,
          cashTenderedCents,
          changeGivenCents,
          notes: order.notes,
          organization: {
            name: org?.name ?? "Organization",
            companyName: settings?.companyLegalName ?? org?.name ?? "Organization",
          },
          customer: customer
            ? {
                name: customer.name,
                companyName: customer.companyName,
                code: customer.code,
                email: customer.email,
                phone: customer.phone,
                taxId: customer.taxId,
              }
            : null,
          lines: order.lines.map((l) => ({
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
            organizationId,
            receiptNumber,
            paymentId: payment.id,
            orderId: order.id,
            customerId: customer?.id ?? null,
            channel: OrderChannel.POS,
            currency: order.currency,
            totalCents,
            cashTenderedCents,
            changeGivenCents,
            snapshot: receiptSnapshot as unknown as Prisma.InputJsonValue,
            issuedAt: now,
            issuedByUserId: tenant.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "order.pos.checked_out",
            resourceType: "Order",
            resourceId: order.id,
            metadata: {
              orderNumber: order.orderNumber,
              locationCode: location.code,
              customerId: customer?.id ?? null,
              totalCents,
              cashTenderedCents,
              changeGivenCents,
              paymentNumber: payment.paymentNumber,
              receiptNumber: receipt.receiptNumber,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return {
          order,
          payment,
          receipt,
        };
      });

      this.analyticsService.captureDomainEvent({
        event: "pos_checkout.completed",
        distinctId: tenant.userId,
        organizationId,
        properties: {
          order_id: result.order.id,
          order_number: result.order.orderNumber,
          location_id: location.id,
          has_customer: Boolean(customer),
          currency: result.order.currency,
          total_cents: result.order.totalCents,
          line_count: result.order.lines.length,
          payment_method: PaymentMethod.CASH,
        },
      });

      return result;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `Order number "${orderNumber}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async createB2bOrder(
    tenant: AuthenticatedTenant,
    input: CreateB2bOrderInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const [location, customer, settings] = await Promise.all([
      this.prismaService.raw.location.findFirst({
        where: { id: input.locationId, organizationId },
      }),
      this.prismaService.raw.customer.findFirst({
        where: { id: input.customerId, organizationId },
      }),
      this.prismaService.raw.tenantSettings.findUnique({
        where: { organizationId },
        select: { defaultCurrency: true },
      }),
    ]);

    if (!location || location.status !== LocationStatus.ACTIVE) {
      throw new BadRequestException("Location must exist and be ACTIVE.");
    }
    if (!customer) {
      throw new NotFoundException("Customer was not found.");
    }
    if (customer.status === CustomerStatus.ARCHIVED) {
      throw new BadRequestException(
        "Cannot create a B2B order for an archived customer.",
      );
    }

    const quote = await this.pricingEngine.calculateQuote(tenant, {
      direction: PriceBookDirection.SALES,
      currency: input.currency ?? customer.currency ?? settings?.defaultCurrency,
      priceBookId: input.priceBookId ?? null,
      customerSegment: customer.customerSegment ?? null,
      externalAccountId:
        customer.externalAccountId ??
        customer.externalCompanyId ??
        customer.externalContactId ??
        null,
      channel: "B2B",
      promoCodes: input.promoCodes,
      lines: input.lines.map((l) => ({
        itemId: l.itemId,
        quantity: l.quantity,
        packId: l.packId ?? null,
        servicePlanId: l.servicePlanId ?? null,
        overrideUnitPriceCents: l.overrideUnitPriceCents ?? null,
      })),
    });

    const templateLine = quote.lines.find(
      (ql) => ql.variantKind === ItemVariantKind.TEMPLATE,
    );
    if (templateLine) {
      throw new BadRequestException(
        `Item "${templateLine.sku}" is a product template. Select a concrete variant SKU instead.`,
      );
    }

    const subtotalCents = quote.subtotalAfterTiersCents;
    const discountTotalCents = quote.totalDiscountCents;
    const taxCents = input.taxCents ?? 0;
    const totalCents = quote.totalCents + taxCents;
    const orderNumber =
      input.orderNumber?.trim().toUpperCase() || generateDocNumber("B2B");

    try {
      const order = await this.prismaService.raw.$transaction(async (tx) => {
        const lineDescMap = new Map<number, string>();
        input.lines.forEach((l, idx) => {
          if (l.description && l.description.trim().length > 0) {
            lineDescMap.set(idx, l.description.trim());
          }
        });

        const order = await tx.order.create({
          data: {
            organizationId,
            orderNumber,
            channel: OrderChannel.B2B,
            status: OrderStatus.DRAFT,
            locationId: location.id,
            customerId: customer.id,
            priceBookId: input.priceBookId ?? null,
            externalDealId: input.externalDealId?.trim() || null,
            customerSegment: customer.customerSegment ?? null,
            promoCodes: quote.promoCodes,
            currency: quote.currency,
            subtotalCents,
            discountTotalCents,
            taxCents,
            totalCents,
            paidAmountCents: 0,
            notes: input.notes?.trim() || null,
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
                orderedBaseQty: ql.totalBaseUnits + ql.bonusUnits * ql.unitsPerPack,
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
                  parentItemId: ql.parentItemId,
                  pricingInheritedFromParent: ql.pricingInheritedFromParent,
                  variantAttributes: ql.variantAttributes,
                } as unknown as Prisma.InputJsonValue,
              })),
            },
          },
          include: {
            location: { select: { id: true, code: true, name: true, type: true } },
            customer: {
              select: {
                id: true,
                code: true,
                name: true,
                companyName: true,
                type: true,
              },
            },
            lines: true,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "order.b2b.created",
            resourceType: "Order",
            resourceId: order.id,
            metadata: {
              orderNumber: order.orderNumber,
              customerId: customer.id,
              locationCode: location.code,
              totalCents,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return order;
      });

      this.analyticsService.captureDomainEvent({
        event: "order.created",
        distinctId: tenant.userId,
        organizationId,
        properties: {
          order_id: order.id,
          order_number: order.orderNumber,
          channel: order.channel,
          currency: order.currency,
          total_cents: order.totalCents,
          line_count: order.lines.length,
        },
      });

      return order;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `Order number "${orderNumber}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async updateDraftB2bOrder(
    tenant: AuthenticatedTenant,
    orderId: string,
    input: UpdateDraftB2bOrderInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const existing = await this.prismaService.raw.order.findFirst({
      where: { id: orderId, organizationId },
      include: { lines: true, customer: true },
    });
    if (!existing) {
      throw new NotFoundException("Order was not found.");
    }
    if (existing.channel !== OrderChannel.B2B) {
      throw new BadRequestException("Only B2B orders can be edited.");
    }
    if (existing.status !== OrderStatus.DRAFT) {
      throw new BadRequestException(
        `Only DRAFT B2B orders can be edited (current status: ${existing.status}).`,
      );
    }

    const nextLocationId = input.locationId ?? existing.locationId;
    const nextCustomerId = input.customerId ?? existing.customerId;
    if (!nextCustomerId) {
      throw new BadRequestException("B2B orders require a linked customer.");
    }

    const [location, customer] = await Promise.all([
      this.prismaService.raw.location.findFirst({
        where: { id: nextLocationId, organizationId },
      }),
      this.prismaService.raw.customer.findFirst({
        where: { id: nextCustomerId, organizationId },
      }),
    ]);

    if (!location || location.status !== LocationStatus.ACTIVE) {
      throw new BadRequestException("Location must exist and be ACTIVE.");
    }
    if (!customer || customer.status === CustomerStatus.ARCHIVED) {
      throw new BadRequestException("Customer must exist and not be archived.");
    }

    const linesInput: OrderLineInput[] =
      input.lines ??
      existing.lines.map((l) => ({
        itemId: l.itemId,
        quantity: l.quantity,
        packId: l.packId,
        servicePlanId: l.servicePlanId,
        overrideUnitPriceCents: l.unitPriceCents,
        description: l.description,
      }));

    const quote = await this.pricingEngine.calculateQuote(tenant, {
      direction: PriceBookDirection.SALES,
      currency: input.currency ?? existing.currency,
      priceBookId:
        input.priceBookId !== undefined ? input.priceBookId : existing.priceBookId,
      customerSegment: customer.customerSegment ?? null,
      externalAccountId:
        customer.externalAccountId ??
        customer.externalCompanyId ??
        customer.externalContactId ??
        null,
      channel: "B2B",
      promoCodes: input.promoCodes ?? existing.promoCodes,
      lines: linesInput.map((l) => ({
        itemId: l.itemId,
        quantity: l.quantity,
        packId: l.packId ?? null,
        servicePlanId: l.servicePlanId ?? null,
        overrideUnitPriceCents: l.overrideUnitPriceCents ?? null,
      })),
    });

    const templateLine = quote.lines.find(
      (ql) => ql.variantKind === ItemVariantKind.TEMPLATE,
    );
    if (templateLine) {
      throw new BadRequestException(
        `Item "${templateLine.sku}" is a product template. Select a concrete variant SKU instead.`,
      );
    }

    const subtotalCents = quote.subtotalAfterTiersCents;
    const discountTotalCents = quote.totalDiscountCents;
    const taxCents = input.taxCents !== undefined ? input.taxCents : existing.taxCents;
    const totalCents = quote.totalCents + taxCents;

    return this.prismaService.raw.$transaction(async (tx) => {
      await tx.orderLine.deleteMany({
        where: { orderId: existing.id, organizationId },
      });

      const lineDescMap = new Map<number, string>();
      linesInput.forEach((l, idx) => {
        if (l.description && l.description.trim().length > 0) {
          lineDescMap.set(idx, l.description.trim());
        }
      });

      const updated = await tx.order.update({
        where: { id: existing.id },
        data: {
          locationId: location.id,
          customerId: customer.id,
          priceBookId:
            input.priceBookId !== undefined
              ? input.priceBookId
              : existing.priceBookId,
          externalDealId:
            input.externalDealId !== undefined
              ? input.externalDealId?.trim() || null
              : existing.externalDealId,
          customerSegment: customer.customerSegment ?? null,
          promoCodes: quote.promoCodes,
          currency: quote.currency,
          subtotalCents,
          discountTotalCents,
          taxCents,
          totalCents,
          notes:
            input.notes !== undefined
              ? input.notes?.trim() || null
              : existing.notes,
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
              orderedBaseQty: ql.totalBaseUnits + ql.bonusUnits * ql.unitsPerPack,
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
                parentItemId: ql.parentItemId,
                pricingInheritedFromParent: ql.pricingInheritedFromParent,
                variantAttributes: ql.variantAttributes,
              } as unknown as Prisma.InputJsonValue,
            })),
          },
        },
        include: {
          location: { select: { id: true, code: true, name: true, type: true } },
          customer: {
            select: {
              id: true,
              code: true,
              name: true,
              companyName: true,
              type: true,
            },
          },
          lines: true,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "order.b2b.updated",
          resourceType: "Order",
          resourceId: updated.id,
          metadata: {
            orderNumber: updated.orderNumber,
            totalCents,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async confirmB2bOrder(
    tenant: AuthenticatedTenant,
    orderId: string,
    input: ConfirmB2bOrderInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const confirmed = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.order.findFirst({
        where: { id: orderId, organizationId },
        include: {
          location: true,
          customer: true,
          lines: { include: { item: true } },
        },
      });

      if (!existing) {
        throw new NotFoundException("Order was not found.");
      }
      if (existing.channel !== OrderChannel.B2B) {
        throw new BadRequestException("Only B2B orders can be confirmed.");
      }
      if (existing.status !== OrderStatus.DRAFT) {
        throw new BadRequestException(
          `Only DRAFT B2B orders can be confirmed (current status: ${existing.status}).`,
        );
      }
      if (existing.location.status !== LocationStatus.ACTIVE) {
        throw new BadRequestException("Order location must be ACTIVE.");
      }

      const now = new Date();
      const claimed = await tx.order.updateMany({
        where: {
          id: existing.id,
          organizationId,
          status: OrderStatus.DRAFT,
        },
        data: {
          status: OrderStatus.CONFIRMED,
          confirmedAt: now,
          confirmedByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          "Order state changed concurrently. Refresh and retry.",
        );
      }

      // Reserve inventory on confirmation
      for (const line of existing.lines) {
        const reserveTargets = await this.resolveLineStockTargets(
          tx,
          organizationId,
          line.item,
          line.orderedBaseQty,
          line.quantity,
        );

        let totalReservedForLine = 0;
        for (const target of reserveTargets) {
          await this.reserveStockBalance(tx, {
            organizationId,
            itemId: target.itemId,
            locationId: existing.locationId,
            locationCode: existing.location.code,
            baseQty: target.baseQty,
          });
          totalReservedForLine += target.baseQty;
        }

        if (totalReservedForLine > 0) {
          await tx.orderLine.update({
            where: { id: line.id },
            data: { reservedBaseQty: totalReservedForLine },
          });
        }
      }

      let issuedInvoice = null;
      if (input.issueInvoice) {
        const [org, settings] = await Promise.all([
          tx.organization.findUnique({
            where: { id: organizationId },
            select: { id: true, name: true },
          }),
          tx.tenantSettings.findUnique({
            where: { organizationId },
            select: { companyLegalName: true },
          }),
        ]);
        const dueAt = input.invoiceDueAt
          ? new Date(input.invoiceDueAt)
          : new Date(
              now.getTime() +
                (existing.customer?.paymentTermsDays ?? 30) * 86_400_000,
            );
        const invoiceNumber = generateDocNumber("INV");
        issuedInvoice = await tx.salesInvoice.create({
          data: {
            organizationId,
            invoiceNumber,
            orderId: existing.id,
            customerId: existing.customerId,
            status: SalesInvoiceStatus.ISSUED,
            currency: existing.currency,
            subtotalCents: existing.subtotalCents,
            discountTotalCents: existing.discountTotalCents,
            taxCents: existing.taxCents,
            totalCents: existing.totalCents,
            paidAmountCents: 0,
            issuedAt: now,
            dueAt,
            notes: input.invoiceNotes?.trim() || existing.notes,
            customerSnapshot: existing.customer
              ? ({
                  id: existing.customer.id,
                  code: existing.customer.code,
                  type: existing.customer.type,
                  name: existing.customer.name,
                  companyName: existing.customer.companyName,
                  email: existing.customer.email,
                  phone: existing.customer.phone,
                  taxId: existing.customer.taxId,
                  billingAddressLine1: existing.customer.billingAddressLine1,
                  billingAddressLine2: existing.customer.billingAddressLine2,
                  billingCity: existing.customer.billingCity,
                  billingState: existing.customer.billingState,
                  billingPostalCode: existing.customer.billingPostalCode,
                  billingCountry: existing.customer.billingCountry,
                } as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            organizationSnapshot: {
              id: organizationId,
              name: org?.name ?? "Organization",
              companyLegalName:
                settings?.companyLegalName ?? org?.name ?? "Organization",
            } as Prisma.InputJsonValue,
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
            lines: {
              create: existing.lines.map((l) => ({
                organizationId,
                orderLineId: l.id,
                itemId: l.itemId,
                sku: l.sku,
                description: l.description || l.name,
                unitOfMeasure: l.unitOfMeasure,
                quantity: l.quantity,
                unitPriceCents: l.unitPriceCents,
                discountCents: l.discountCents,
                lineTotalCents: l.lineTotalCents,
              })),
            },
          },
          include: { lines: true },
        });
      }

      const confirmed = await tx.order.findFirstOrThrow({
        where: { id: existing.id, organizationId },
        include: {
          location: { select: { id: true, code: true, name: true, type: true } },
          customer: true,
          lines: true,
          invoices: true,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "order.b2b.confirmed",
          resourceType: "Order",
          resourceId: existing.id,
          metadata: {
            orderNumber: existing.orderNumber,
            issuedInvoiceNumber: issuedInvoice?.invoiceNumber ?? null,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return confirmed;
    });

    this.analyticsService.captureDomainEvent({
      event: "order.confirmed",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        order_id: confirmed.id,
        order_number: confirmed.orderNumber,
        channel: confirmed.channel,
        currency: confirmed.currency,
        total_cents: confirmed.totalCents,
        issued_invoice: (confirmed.invoices?.length ?? 0) > 0,
      },
    });

    return confirmed;
  }

  async fulfillB2bOrder(
    tenant: AuthenticatedTenant,
    orderId: string,
    input: FulfillB2bOrderInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.order.findFirst({
        where: { id: orderId, organizationId },
        include: {
          location: true,
          customer: true,
          lines: { include: { item: true } },
        },
      });

      if (!existing) {
        throw new NotFoundException("Order was not found.");
      }
      if (existing.channel !== OrderChannel.B2B) {
        throw new BadRequestException("Only B2B orders have a fulfillment step.");
      }
      if (
        existing.status !== OrderStatus.CONFIRMED &&
        existing.status !== OrderStatus.PARTIALLY_FULFILLED
      ) {
        throw new BadRequestException(
          `Only CONFIRMED or PARTIALLY_FULFILLED orders can be fulfilled (current status: ${existing.status}).`,
        );
      }

      const lineById = new Map(existing.lines.map((l) => [l.id, l]));
      const fulfillRequests =
        input.lines && input.lines.length > 0
          ? input.lines
          : existing.lines
              .filter((l) => l.quantity - l.fulfilledQty > 0)
              .map((l) => ({
                orderLineId: l.id,
                quantity: l.quantity - l.fulfilledQty,
              }));

      if (fulfillRequests.length === 0) {
        throw new BadRequestException("No remaining quantities to fulfill.");
      }

      for (const req of fulfillRequests) {
        const orderLine = lineById.get(req.orderLineId);
        if (!orderLine) {
          throw new NotFoundException(
            `Order line "${req.orderLineId}" was not found on this order.`,
          );
        }
        const remainingQty = orderLine.quantity - orderLine.fulfilledQty;
        if (req.quantity < 1 || req.quantity > remainingQty) {
          throw new BadRequestException(
            `Fulfillment quantity (${req.quantity}) for SKU "${orderLine.sku}" must be between 1 and ${remainingQty}.`,
          );
        }

        const remainingBaseQty = Math.max(
          0,
          orderLine.orderedBaseQty - orderLine.fulfilledBaseQty,
        );
        const fulfillBaseQty =
          req.quantity === remainingQty
            ? remainingBaseQty
            : req.quantity * orderLine.unitsPerPack;
        const releaseReserved = Math.min(orderLine.reservedBaseQty, fulfillBaseQty);

        const targets = await this.resolveLineStockTargets(
          tx,
          organizationId,
          orderLine.item,
          fulfillBaseQty,
          req.quantity,
        );

        let remainingReserveToRelease = releaseReserved;
        for (const target of targets) {
          const releaseForTarget = Math.min(
            remainingReserveToRelease,
            target.baseQty,
          );
          remainingReserveToRelease -= releaseForTarget;

          await this.deductStockBalance(tx, {
            organizationId,
            itemId: target.itemId,
            locationId: existing.locationId,
            locationCode: existing.location.code,
            baseQty: target.baseQty,
            releaseReservedQty: releaseForTarget,
            referenceType: "Order",
            referenceId: existing.id,
            reason: `B2B fulfillment ${existing.orderNumber}`,
            actorUserId: tenant.userId,
          });
        }

        await tx.orderLine.update({
          where: { id: orderLine.id },
          data: {
            fulfilledQty: orderLine.fulfilledQty + req.quantity,
            fulfilledBaseQty: orderLine.fulfilledBaseQty + fulfillBaseQty,
            reservedBaseQty: Math.max(0, orderLine.reservedBaseQty - releaseReserved),
          },
        });
      }

      const refreshedLines = await tx.orderLine.findMany({
        where: { orderId: existing.id, organizationId },
      });
      const allFulfilled = refreshedLines.every(
        (l) => l.fulfilledQty >= l.quantity,
      );
      const now = new Date();
      const nextStatus = allFulfilled
        ? existing.paidAmountCents >= existing.totalCents
          ? OrderStatus.COMPLETED
          : OrderStatus.FULFILLED
        : OrderStatus.PARTIALLY_FULFILLED;

      const updated = await tx.order.update({
        where: { id: existing.id },
        data: {
          status: nextStatus,
          ...(allFulfilled
            ? {
                fulfilledAt: now,
                fulfilledByUserId: tenant.userId,
                ...(nextStatus === OrderStatus.COMPLETED
                  ? { completedAt: now }
                  : {}),
              }
            : {}),
          updatedByUserId: tenant.userId,
        },
        include: {
          location: { select: { id: true, code: true, name: true, type: true } },
          customer: true,
          lines: true,
          invoices: true,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "order.b2b.fulfilled",
          resourceType: "Order",
          resourceId: existing.id,
          metadata: {
            orderNumber: existing.orderNumber,
            status: nextStatus,
            notes: input.notes ?? null,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });

    this.analyticsService.captureDomainEvent({
      event: "order.fulfilled",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        order_id: updated.id,
        order_number: updated.orderNumber,
        status: updated.status,
        channel: updated.channel,
        total_cents: updated.totalCents,
      },
    });

    return updated;
  }

  async cancelB2bOrder(
    tenant: AuthenticatedTenant,
    orderId: string,
    reason?: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const cancelled = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.order.findFirst({
        where: { id: orderId, organizationId },
        include: {
          lines: { include: { item: true } },
          invoices: { where: { status: { not: SalesInvoiceStatus.VOID } } },
        },
      });

      if (!existing) {
        throw new NotFoundException("Order was not found.");
      }
      if (
        existing.status !== OrderStatus.DRAFT &&
        existing.status !== OrderStatus.CONFIRMED
      ) {
        throw new BadRequestException(
          `Only DRAFT or CONFIRMED orders can be cancelled (current status: ${existing.status}).`,
        );
      }
      if (existing.paidAmountCents > 0) {
        throw new BadRequestException(
          "Cannot cancel an order that already has recorded payments.",
        );
      }

      const claimed = await tx.order.updateMany({
        where: {
          id: existing.id,
          organizationId,
          status: existing.status,
        },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: reason?.trim() || null,
          updatedByUserId: tenant.userId,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          "Order state changed concurrently. Refresh and retry.",
        );
      }

      // Release reserved stock if any
      for (const line of existing.lines) {
        if (line.reservedBaseQty > 0) {
          const targets = await this.resolveLineStockTargets(
            tx,
            organizationId,
            line.item,
            line.reservedBaseQty,
            line.quantity,
          );
          let toRelease = line.reservedBaseQty;
          for (const target of targets) {
            const chunk = Math.min(toRelease, target.baseQty);
            toRelease -= chunk;
            if (chunk > 0) {
              const bal = await tx.stockBalance.findUnique({
                where: {
                  organizationId_itemId_locationId: {
                    organizationId,
                    itemId: target.itemId,
                    locationId: existing.locationId,
                  },
                },
              });
              if (bal) {
                await tx.stockBalance.update({
                  where: { id: bal.id },
                  data: { reservedQty: Math.max(0, bal.reservedQty - chunk) },
                });
              }
            }
          }
          await tx.orderLine.update({
            where: { id: line.id },
            data: { reservedBaseQty: 0 },
          });
        }
      }

      // Void any unpaid draft/issued invoices attached to this cancelled order
      if (existing.invoices.length > 0) {
        await tx.salesInvoice.updateMany({
          where: {
            orderId: existing.id,
            organizationId,
            paidAmountCents: 0,
            status: { not: SalesInvoiceStatus.VOID },
          },
          data: {
            status: SalesInvoiceStatus.VOID,
            voidedAt: new Date(),
            voidReason: reason?.trim() || "Order cancelled",
            updatedByUserId: tenant.userId,
          },
        });
      }

      const cancelled = await tx.order.findFirstOrThrow({
        where: { id: existing.id, organizationId },
        include: {
          location: { select: { id: true, code: true, name: true, type: true } },
          customer: true,
          lines: true,
          invoices: true,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "order.b2b.cancelled",
          resourceType: "Order",
          resourceId: existing.id,
          metadata: {
            orderNumber: existing.orderNumber,
            previousStatus: existing.status,
            ...(reason ? { reason } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return cancelled;
    });

    this.analyticsService.captureDomainEvent({
      event: "order.cancelled",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        order_id: cancelled.id,
        order_number: cancelled.orderNumber,
        channel: cancelled.channel,
        total_cents: cancelled.totalCents,
      },
    });

    return cancelled;
  }

  async listOrders(tenant: AuthenticatedTenant, query: ListOrdersQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const records = await this.prismaService.scoped.order.findMany({
      where: {
        ...(query.channel ? { channel: query.channel } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(search
          ? {
              OR: [
                { orderNumber: { contains: search, mode: "insensitive" } },
                {
                  customer: {
                    name: { contains: search, mode: "insensitive" },
                  },
                },
                {
                  customer: {
                    companyName: { contains: search, mode: "insensitive" },
                  },
                },
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
            type: true,
          },
        },
        _count: {
          select: { lines: true, invoices: true, payments: true, receipts: true },
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

  async getOrder(tenant: AuthenticatedTenant, orderId: string) {
    this.resolveVerifiedOrganizationId(tenant);
    const order = await this.prismaService.scoped.order.findUnique({
      where: { id: orderId },
      include: {
        location: { select: { id: true, code: true, name: true, type: true } },
        customer: true,
        lines: true,
        invoices: {
          orderBy: { createdAt: "desc" },
        },
        payments: {
          orderBy: { receivedAt: "desc" },
          include: { receipt: true },
        },
      },
    });

    if (!order) {
      throw new NotFoundException("Order was not found.");
    }

    return order;
  }

  async reserveOrderStockInTx(
    tx: Prisma.TransactionClient,
    params: {
      organizationId: string;
      orderId: string;
    },
  ): Promise<boolean> {
    const order = await tx.order.findFirst({
      where: { id: params.orderId, organizationId: params.organizationId },
      include: {
        location: { select: { id: true, code: true, status: true } },
        lines: { include: { item: true } },
      },
    });
    if (!order) {
      throw new NotFoundException("Order was not found.");
    }
    if (order.location.status !== LocationStatus.ACTIVE) {
      throw new BadRequestException("Order location must be ACTIVE.");
    }

    let reservedAny = false;
    for (const line of order.lines) {
      const remainingToReserve = Math.max(
        0,
        line.orderedBaseQty - line.fulfilledBaseQty - line.reservedBaseQty,
      );
      if (remainingToReserve <= 0) {
        continue;
      }

      const targets = await this.resolveLineStockTargets(
        tx,
        params.organizationId,
        line.item,
        remainingToReserve,
        Math.max(1, line.quantity - line.fulfilledQty),
      );

      let totalReservedForLine = 0;
      for (const target of targets) {
        await this.reserveStockBalance(tx, {
          organizationId: params.organizationId,
          itemId: target.itemId,
          locationId: order.locationId,
          locationCode: order.location.code,
          baseQty: target.baseQty,
        });
        totalReservedForLine += target.baseQty;
      }

      if (totalReservedForLine > 0) {
        reservedAny = true;
        await tx.orderLine.update({
          where: { id: line.id },
          data: { reservedBaseQty: line.reservedBaseQty + totalReservedForLine },
        });
      }
    }

    return reservedAny;
  }

  async deductOrderStockInTx(
    tx: Prisma.TransactionClient,
    params: {
      organizationId: string;
      orderId: string;
      actorUserId: string;
      reason: string;
    },
  ): Promise<void> {
    const order = await tx.order.findFirst({
      where: { id: params.orderId, organizationId: params.organizationId },
      include: {
        location: { select: { id: true, code: true } },
        lines: { include: { item: true } },
      },
    });
    if (!order) {
      throw new NotFoundException("Order was not found.");
    }

    for (const line of order.lines) {
      const remainingBaseQty = Math.max(
        0,
        line.orderedBaseQty - line.fulfilledBaseQty,
      );
      const remainingLineQty = Math.max(0, line.quantity - line.fulfilledQty);
      if (remainingBaseQty <= 0 && remainingLineQty <= 0) {
        continue;
      }

      const releaseReserved = Math.min(line.reservedBaseQty, remainingBaseQty);
      const targets = await this.resolveLineStockTargets(
        tx,
        params.organizationId,
        line.item,
        remainingBaseQty,
        Math.max(1, remainingLineQty),
      );

      let remainingReserveToRelease = releaseReserved;
      for (const target of targets) {
        const releaseForTarget = Math.min(
          remainingReserveToRelease,
          target.baseQty,
        );
        remainingReserveToRelease -= releaseForTarget;

        await this.deductStockBalance(tx, {
          organizationId: params.organizationId,
          itemId: target.itemId,
          locationId: order.locationId,
          locationCode: order.location.code,
          baseQty: target.baseQty,
          releaseReservedQty: releaseForTarget,
          referenceType: "Order",
          referenceId: order.id,
          reason: params.reason,
          actorUserId: params.actorUserId,
        });
      }

      await tx.orderLine.update({
        where: { id: line.id },
        data: {
          fulfilledQty: line.quantity,
          fulfilledBaseQty: line.orderedBaseQty,
          reservedBaseQty: 0,
        },
      });
    }
  }

  async releaseOrderStockInTx(
    tx: Prisma.TransactionClient,
    params: {
      organizationId: string;
      orderId: string;
    },
  ): Promise<void> {
    const order = await tx.order.findFirst({
      where: { id: params.orderId, organizationId: params.organizationId },
      include: {
        lines: { include: { item: true } },
      },
    });
    if (!order) {
      return;
    }

    for (const line of order.lines) {
      if (line.reservedBaseQty <= 0) {
        continue;
      }
      const targets = await this.resolveLineStockTargets(
        tx,
        params.organizationId,
        line.item,
        line.reservedBaseQty,
        Math.max(1, line.quantity - line.fulfilledQty),
      );
      let toRelease = line.reservedBaseQty;
      for (const target of targets) {
        const chunk = Math.min(toRelease, target.baseQty);
        toRelease -= chunk;
        if (chunk > 0) {
          const bal = await tx.stockBalance.findUnique({
            where: {
              organizationId_itemId_locationId: {
                organizationId: params.organizationId,
                itemId: target.itemId,
                locationId: order.locationId,
              },
            },
          });
          if (bal) {
            await tx.stockBalance.update({
              where: { id: bal.id },
              data: { reservedQty: Math.max(0, bal.reservedQty - chunk) },
            });
          }
        }
      }
      await tx.orderLine.update({
        where: { id: line.id },
        data: { reservedBaseQty: 0 },
      });
    }
  }

  private async collectDeductionRequirements(
    tx: Prisma.TransactionClient,
    organizationId: string,
    quotedLines: CalculatedQuoteLine[],
  ): Promise<StockDeductionRequirement[]> {
    const merged = new Map<string, StockDeductionRequirement>();

    for (const ql of quotedLines) {
      const item = await tx.item.findFirst({
        where: { id: ql.itemId, organizationId },
      });
      if (!item || item.status === ItemStatus.ARCHIVED) {
        throw new BadRequestException(
          `Item "${ql.sku}" does not exist or is archived.`,
        );
      }

      const totalBaseQty = ql.totalBaseUnits + ql.bonusUnits * ql.unitsPerPack;
      const targets = await this.resolveLineStockTargets(
        tx,
        organizationId,
        item,
        totalBaseQty,
        ql.quantity,
      );

      for (const t of targets) {
        const prev = merged.get(t.itemId);
        if (prev) {
          prev.baseQty += t.baseQty;
        } else {
          merged.set(t.itemId, { ...t });
        }
      }
    }

    return Array.from(merged.values());
  }

  private async resolveLineStockTargets(
    tx: Prisma.TransactionClient,
    organizationId: string,
    item: {
      id: string;
      sku: string;
      trackInventory: boolean;
      isBundle: boolean;
    },
    baseQty: number,
    lineQty: number,
  ): Promise<StockDeductionRequirement[]> {
    if (item.trackInventory) {
      return [{ itemId: item.id, sku: item.sku, baseQty }];
    }

    if (!item.isBundle) {
      return [];
    }

    const components = await tx.itemBundleComponent.findMany({
      where: { organizationId, bundleItemId: item.id, isOptional: false },
      include: {
        componentItem: {
          select: { id: true, sku: true, trackInventory: true },
        },
        componentPack: {
          select: { unitsPerPack: true },
        },
      },
    });

    const targets: StockDeductionRequirement[] = [];
    for (const comp of components) {
      if (comp.componentItem.trackInventory) {
        const compBase =
          comp.quantity * lineQty * (comp.componentPack?.unitsPerPack ?? 1);
        targets.push({
          itemId: comp.componentItem.id,
          sku: comp.componentItem.sku,
          baseQty: compBase,
        });
      }
    }

    return targets;
  }

  private async reserveStockBalance(
    tx: Prisma.TransactionClient,
    params: {
      organizationId: string;
      itemId: string;
      locationId: string;
      locationCode: string;
      baseQty: number;
    },
  ) {
    if (params.baseQty <= 0) return;

    const item = await tx.item.findFirstOrThrow({
      where: { id: params.itemId, organizationId: params.organizationId },
      select: { sku: true, trackInventory: true, allowNegativeStock: true },
    });
    if (!item.trackInventory) return;

    const bal = await tx.stockBalance.findUnique({
      where: {
        organizationId_itemId_locationId: {
          organizationId: params.organizationId,
          itemId: params.itemId,
          locationId: params.locationId,
        },
      },
    });

    const onHand = bal?.onHandQty ?? 0;
    const reserved = bal?.reservedQty ?? 0;
    const available = onHand - reserved;

    if (available < params.baseQty && !item.allowNegativeStock) {
      throw new BadRequestException(
        `Insufficient available stock to reserve SKU "${item.sku}" at "${params.locationCode}" (available: ${available}, requested: ${params.baseQty}).`,
      );
    }

    if (bal) {
      await tx.stockBalance.update({
        where: { id: bal.id },
        data: { reservedQty: reserved + params.baseQty },
      });
    } else {
      await tx.stockBalance.create({
        data: {
          organizationId: params.organizationId,
          itemId: params.itemId,
          locationId: params.locationId,
          onHandQty: 0,
          reservedQty: params.baseQty,
        },
      });
    }
  }

  private async deductStockBalance(
    tx: Prisma.TransactionClient,
    params: {
      organizationId: string;
      itemId: string;
      locationId: string;
      locationCode: string;
      baseQty: number;
      releaseReservedQty: number;
      referenceType: string;
      referenceId: string;
      reason: string;
      actorUserId: string;
    },
  ) {
    if (params.baseQty <= 0) return;

    const item = await tx.item.findFirstOrThrow({
      where: { id: params.itemId, organizationId: params.organizationId },
      select: { sku: true, trackInventory: true, allowNegativeStock: true },
    });
    if (!item.trackInventory) return;

    const bal = await tx.stockBalance.findUnique({
      where: {
        organizationId_itemId_locationId: {
          organizationId: params.organizationId,
          itemId: params.itemId,
          locationId: params.locationId,
        },
      },
    });

    const currentQty = bal?.onHandQty ?? 0;
    const nextQty = currentQty - params.baseQty;

    if (nextQty < 0 && !item.allowNegativeStock) {
      throw new BadRequestException(
        `Insufficient stock for SKU "${item.sku}" at location "${params.locationCode}" (on hand: ${currentQty}, needed: ${params.baseQty}).`,
      );
    }

    const nextReserved = Math.max(
      0,
      (bal?.reservedQty ?? 0) - params.releaseReservedQty,
    );

    const updatedBalance = bal
      ? await tx.stockBalance.update({
          where: { id: bal.id },
          data: { onHandQty: nextQty, reservedQty: nextReserved },
        })
      : await tx.stockBalance.create({
          data: {
            organizationId: params.organizationId,
            itemId: params.itemId,
            locationId: params.locationId,
            onHandQty: nextQty,
            reservedQty: 0,
          },
        });

    await tx.stockMovement.create({
      data: {
        organizationId: params.organizationId,
        itemId: params.itemId,
        locationId: params.locationId,
        type: StockMovementType.SALE,
        quantityDelta: -params.baseQty,
        balanceAfter: updatedBalance.onHandQty,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        reason: params.reason,
        actorUserId: params.actorUserId,
      },
    });
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedTenant): string {
    const contextOrgId = TenantContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active tenant context mismatch.");
    }
    return tenant.organizationId;
  }
}

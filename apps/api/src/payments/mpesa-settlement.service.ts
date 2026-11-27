import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  CustomerPaymentStatus,
  OrderChannel,
  OrderStatus,
  PaymentMethod,
  PaymentTargetType,
  PaymentTransactionStatus,
  PreorderDepositStatus,
  Prisma,
  SalesInvoiceStatus,
} from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import type { PrintableReceiptDocument } from "../orders/document-renderer.utils.js";
import { deductOrderStockInTransaction } from "../orders/order-stock.utils.js";

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

export interface SettleMpesaTransactionInput {
  organizationId: string;
  transactionId: string;
  mpesaReceiptNumber: string;
  settledAmountCents: number;
  phoneNumber?: string | null;
  payerName?: string | null;
  resultCode?: string | null;
  resultDesc?: string | null;
  callbackMetadata?: Record<string, unknown> | null;
  rawCallbackPayload?: Record<string, unknown> | null;
  actorUserId?: string | null;
  ipAddress?: string | null;
  targetOverride?: {
    targetType: PaymentTargetType;
    orderId?: string | null;
    salesInvoiceId?: string | null;
    fulfillmentId?: string | null;
  };
}

@Injectable()
export class MpesaSettlementService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  async settleSuccessfulTransaction(input: SettleMpesaTransactionInput) {
    const { organizationId } = input;
    const now = new Date();

    const settled = await this.prismaService.raw.$transaction(async (tx) => {
      const txRecord = await tx.paymentTransaction.findFirst({
        where: { id: input.transactionId, organizationId },
      });
      if (!txRecord) {
        throw new NotFoundException("Payment transaction was not found.");
      }

      if (
        txRecord.status === PaymentTransactionStatus.SUCCEEDED &&
        txRecord.customerPaymentId
      ) {
        return {
          alreadySettled: true,
          transaction: txRecord,
          payment: null,
          receipt: null,
        };
      }

      const existingReceiptDup = await tx.paymentTransaction.findFirst({
        where: {
          organizationId,
          mpesaReceiptNumber: input.mpesaReceiptNumber,
          id: { not: txRecord.id },
          status: PaymentTransactionStatus.SUCCEEDED,
        },
      });
      if (existingReceiptDup) {
        throw new ConflictException(
          `M-Pesa receipt "${input.mpesaReceiptNumber}" has already been settled in this organization.`,
        );
      }

      const targetType = input.targetOverride?.targetType ?? txRecord.targetType;
      let orderId = input.targetOverride?.orderId ?? txRecord.orderId;
      let salesInvoiceId =
        input.targetOverride?.salesInvoiceId ?? txRecord.salesInvoiceId;
      let fulfillmentId =
        input.targetOverride?.fulfillmentId ?? txRecord.fulfillmentId;

      const actorId =
        input.actorUserId ?? txRecord.initiatedByUserId ?? "mpesa-webhook";
      const amountAppliedCents = input.settledAmountCents;

      const [org, settings] = await Promise.all([
        tx.organization.findUnique({
          where: { id: organizationId },
          select: { id: true, name: true },
        }),
        tx.organizationSettings.findUnique({
          where: { organizationId },
          select: { companyLegalName: true },
        }),
      ]);

      let resolvedOrder: {
        id: string;
        orderNumber: string;
        channel: OrderChannel;
        status: OrderStatus;
        currency: string;
        subtotalCents: number;
        discountTotalCents: number;
        taxCents: number;
        totalCents: number;
        paidAmountCents: number;
        notes: string | null;
        location: { id: string; code: string; name: string };
        customer: {
          id: string;
          code: string;
          name: string;
          companyName: string | null;
          email: string | null;
          phone: string | null;
          taxId: string | null;
        } | null;
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
        fulfillment: {
          id: string;
          depositRequiredCents: number;
        } | null;
      } | null = null;
      let resolvedInvoiceNumber: string | null = null;

      if (targetType === PaymentTargetType.SALES_INVOICE || salesInvoiceId) {
        if (!salesInvoiceId) {
          throw new BadRequestException("Missing salesInvoiceId for invoice settlement.");
        }
        const invoice = await tx.salesInvoice.findFirst({
          where: { id: salesInvoiceId, organizationId },
          include: {
            order: {
              include: {
                location: { select: { id: true, code: true, name: true } },
                customer: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    companyName: true,
                    email: true,
                    phone: true,
                    taxId: true,
                  },
                },
                lines: true,
                fulfillment: {
                  select: { id: true, depositRequiredCents: true },
                },
              },
            },
          },
        });
        if (!invoice) {
          throw new NotFoundException("Target sales invoice was not found.");
        }
        if (
          invoice.status !== SalesInvoiceStatus.ISSUED &&
          invoice.status !== SalesInvoiceStatus.PARTIALLY_PAID
        ) {
          throw new BadRequestException(
            `Invoice "${invoice.invoiceNumber}" cannot accept payments in status ${invoice.status}.`,
          );
        }
        const remainingInvoiceCents = Math.max(
          0,
          invoice.totalCents - invoice.paidAmountCents,
        );
        if (amountAppliedCents > remainingInvoiceCents) {
          throw new BadRequestException(
            `M-Pesa amount (${amountAppliedCents} cents) exceeds remaining invoice balance (${remainingInvoiceCents} cents).`,
          );
        }

        const nextInvoicePaid = invoice.paidAmountCents + amountAppliedCents;
        const nextInvoiceStatus =
          nextInvoicePaid >= invoice.totalCents
            ? SalesInvoiceStatus.PAID
            : SalesInvoiceStatus.PARTIALLY_PAID;

        const claimedInv = await tx.salesInvoice.updateMany({
          where: {
            id: invoice.id,
            organizationId,
            paidAmountCents: invoice.paidAmountCents,
            status: {
              in: [SalesInvoiceStatus.ISSUED, SalesInvoiceStatus.PARTIALLY_PAID],
            },
          },
          data: {
            paidAmountCents: nextInvoicePaid,
            status: nextInvoiceStatus,
            ...(nextInvoiceStatus === SalesInvoiceStatus.PAID ? { paidAt: now } : {}),
            ...(input.actorUserId ? { updatedByUserId: input.actorUserId } : {}),
          },
        });
        if (claimedInv.count !== 1) {
          throw new ConflictException(
            "Invoice balance changed concurrently during M-Pesa settlement.",
          );
        }

        orderId = invoice.orderId;
        fulfillmentId = invoice.order.fulfillment?.id ?? fulfillmentId;
        resolvedInvoiceNumber = invoice.invoiceNumber;
        resolvedOrder = invoice.order;

        const nextOrderPaid = Math.min(
          invoice.order.totalCents,
          invoice.order.paidAmountCents + amountAppliedCents,
        );
        const shouldCompleteOrder =
          invoice.order.status === OrderStatus.FULFILLED &&
          nextOrderPaid >= invoice.order.totalCents;

        await tx.order.update({
          where: { id: invoice.orderId },
          data: {
            paidAmountCents: nextOrderPaid,
            ...(shouldCompleteOrder
              ? { status: OrderStatus.COMPLETED, completedAt: now }
              : {}),
            ...(input.actorUserId ? { updatedByUserId: input.actorUserId } : {}),
          },
        });

        if (invoice.order.fulfillment) {
          await tx.orderFulfillment.update({
            where: { id: invoice.order.fulfillment.id },
            data: {
              depositStatus: computeDepositStatus(
                invoice.order.fulfillment.depositRequiredCents,
                nextOrderPaid,
                invoice.order.totalCents,
              ),
              ...(input.actorUserId ? { updatedByUserId: input.actorUserId } : {}),
            },
          });
        }
      } else if (targetType === PaymentTargetType.FULFILLMENT || fulfillmentId) {
        if (!fulfillmentId) {
          throw new BadRequestException("Missing fulfillmentId for fulfillment settlement.");
        }
        const fulfillment = await tx.orderFulfillment.findFirst({
          where: { id: fulfillmentId, organizationId },
          include: {
            order: {
              include: {
                location: { select: { id: true, code: true, name: true } },
                customer: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    companyName: true,
                    email: true,
                    phone: true,
                    taxId: true,
                  },
                },
                lines: true,
                fulfillment: {
                  select: { id: true, depositRequiredCents: true },
                },
                invoices: {
                  where: {
                    status: {
                      in: [
                        SalesInvoiceStatus.ISSUED,
                        SalesInvoiceStatus.PARTIALLY_PAID,
                      ],
                    },
                  },
                  take: 1,
                },
              },
            },
          },
        });
        if (!fulfillment) {
          throw new NotFoundException("Target fulfillment was not found.");
        }
        const remainingOrderCents = Math.max(
          0,
          fulfillment.order.totalCents - fulfillment.order.paidAmountCents,
        );
        if (amountAppliedCents > remainingOrderCents) {
          throw new BadRequestException(
            `M-Pesa amount (${amountAppliedCents} cents) exceeds remaining order balance (${remainingOrderCents} cents).`,
          );
        }

        const nextOrderPaid = fulfillment.order.paidAmountCents + amountAppliedCents;
        const claimedOrder = await tx.order.updateMany({
          where: {
            id: fulfillment.orderId,
            organizationId,
            paidAmountCents: fulfillment.order.paidAmountCents,
            status: { not: OrderStatus.CANCELLED },
          },
          data: {
            paidAmountCents: nextOrderPaid,
            ...(fulfillment.order.status === OrderStatus.FULFILLED &&
            nextOrderPaid >= fulfillment.order.totalCents
              ? { status: OrderStatus.COMPLETED, completedAt: now }
              : {}),
            ...(input.actorUserId ? { updatedByUserId: input.actorUserId } : {}),
          },
        });
        if (claimedOrder.count !== 1) {
          throw new ConflictException(
            "Order balance changed concurrently during M-Pesa fulfillment settlement.",
          );
        }

        await tx.orderFulfillment.update({
          where: { id: fulfillment.id },
          data: {
            depositStatus: computeDepositStatus(
              fulfillment.depositRequiredCents,
              nextOrderPaid,
              fulfillment.order.totalCents,
            ),
            ...(input.actorUserId ? { updatedByUserId: input.actorUserId } : {}),
          },
        });

        const linkedInvoice = fulfillment.order.invoices[0];
        if (linkedInvoice) {
          const invRemaining = Math.max(
            0,
            linkedInvoice.totalCents - linkedInvoice.paidAmountCents,
          );
          const invApply = Math.min(amountAppliedCents, invRemaining);
          if (invApply > 0) {
            const nextInvPaid = linkedInvoice.paidAmountCents + invApply;
            const nextInvStatus =
              nextInvPaid >= linkedInvoice.totalCents
                ? SalesInvoiceStatus.PAID
                : SalesInvoiceStatus.PARTIALLY_PAID;
            await tx.salesInvoice.update({
              where: { id: linkedInvoice.id },
              data: {
                paidAmountCents: nextInvPaid,
                status: nextInvStatus,
                ...(nextInvStatus === SalesInvoiceStatus.PAID
                  ? { paidAt: now }
                  : {}),
              },
            });
            salesInvoiceId = linkedInvoice.id;
            resolvedInvoiceNumber = linkedInvoice.invoiceNumber;
          }
        }

        orderId = fulfillment.orderId;
        resolvedOrder = fulfillment.order;
      } else if (
        targetType === PaymentTargetType.POS_ORDER ||
        targetType === PaymentTargetType.ORDER ||
        orderId
      ) {
        if (!orderId) {
          throw new BadRequestException("Missing orderId for order settlement.");
        }
        const order = await tx.order.findFirst({
          where: { id: orderId, organizationId },
          include: {
            location: { select: { id: true, code: true, name: true } },
            customer: {
              select: {
                id: true,
                code: true,
                name: true,
                companyName: true,
                email: true,
                phone: true,
                taxId: true,
              },
            },
            lines: true,
            fulfillment: {
              select: { id: true, depositRequiredCents: true },
            },
            invoices: {
              where: {
                status: {
                  in: [
                    SalesInvoiceStatus.ISSUED,
                    SalesInvoiceStatus.PARTIALLY_PAID,
                  ],
                },
              },
              take: 1,
            },
          },
        });
        if (!order) {
          throw new NotFoundException("Target order was not found.");
        }
        if (order.status === OrderStatus.CANCELLED) {
          throw new BadRequestException(
            `Order "${order.orderNumber}" is cancelled and cannot be settled.`,
          );
        }
        const remainingOrderCents = Math.max(
          0,
          order.totalCents - order.paidAmountCents,
        );
        if (amountAppliedCents > remainingOrderCents) {
          throw new BadRequestException(
            `M-Pesa amount (${amountAppliedCents} cents) exceeds remaining order balance (${remainingOrderCents} cents).`,
          );
        }

        const nextOrderPaid = order.paidAmountCents + amountAppliedCents;
        const isDirectPosOrder =
          order.channel === OrderChannel.POS && !order.fulfillment;
        const shouldFulfillAndCompletePos =
          isDirectPosOrder &&
          nextOrderPaid >= order.totalCents &&
          order.status === OrderStatus.CONFIRMED;
        const shouldCompleteFulfilledOrder =
          order.status === OrderStatus.FULFILLED &&
          nextOrderPaid >= order.totalCents;

        const claimedOrder = await tx.order.updateMany({
          where: {
            id: order.id,
            organizationId,
            paidAmountCents: order.paidAmountCents,
            status: { not: OrderStatus.CANCELLED },
          },
          data: {
            paidAmountCents: nextOrderPaid,
            ...(shouldFulfillAndCompletePos
              ? {
                  status: OrderStatus.COMPLETED,
                  fulfilledAt: now,
                  fulfilledByUserId: actorId,
                  completedAt: now,
                }
              : shouldCompleteFulfilledOrder
                ? {
                    status: OrderStatus.COMPLETED,
                    completedAt: now,
                  }
                : {}),
            ...(input.actorUserId ? { updatedByUserId: input.actorUserId } : {}),
          },
        });
        if (claimedOrder.count !== 1) {
          throw new ConflictException(
            "Order balance changed concurrently during M-Pesa settlement.",
          );
        }

        if (shouldFulfillAndCompletePos) {
          await deductOrderStockInTransaction(tx, {
            organizationId,
            orderId: order.id,
            actorUserId: actorId,
            reason: `POS M-Pesa sale ${order.orderNumber} (${input.mpesaReceiptNumber})`,
          });
        }

        if (order.fulfillment) {
          fulfillmentId = order.fulfillment.id;
          await tx.orderFulfillment.update({
            where: { id: order.fulfillment.id },
            data: {
              depositStatus: computeDepositStatus(
                order.fulfillment.depositRequiredCents,
                nextOrderPaid,
                order.totalCents,
              ),
            },
          });
        }

        const linkedInvoice = order.invoices[0];
        if (linkedInvoice) {
          const invRemaining = Math.max(
            0,
            linkedInvoice.totalCents - linkedInvoice.paidAmountCents,
          );
          const invApply = Math.min(amountAppliedCents, invRemaining);
          if (invApply > 0) {
            const nextInvPaid = linkedInvoice.paidAmountCents + invApply;
            const nextInvStatus =
              nextInvPaid >= linkedInvoice.totalCents
                ? SalesInvoiceStatus.PAID
                : SalesInvoiceStatus.PARTIALLY_PAID;
            await tx.salesInvoice.update({
              where: { id: linkedInvoice.id },
              data: {
                paidAmountCents: nextInvPaid,
                status: nextInvStatus,
                ...(nextInvStatus === SalesInvoiceStatus.PAID
                  ? { paidAt: now }
                  : {}),
              },
            });
            salesInvoiceId = linkedInvoice.id;
            resolvedInvoiceNumber = linkedInvoice.invoiceNumber;
          }
        }

        resolvedOrder = order;
      } else {
        throw new BadRequestException("Payment transaction has no valid settlement target.");
      }

      if (!resolvedOrder || !orderId) {
        throw new BadRequestException("Unable to resolve order for payment receipt.");
      }

      const paymentNumber = generateDocNumber("PAY");
      const receiptNumber = generateDocNumber("RCP");

      const payment = await tx.customerPayment.create({
        data: {
          organizationId,
          paymentNumber,
          orderId,
          salesInvoiceId: salesInvoiceId ?? null,
          customerId: resolvedOrder.customer?.id ?? txRecord.customerId ?? null,
          method: PaymentMethod.MPESA,
          status: CustomerPaymentStatus.COMPLETED,
          currency: resolvedOrder.currency,
          amountAppliedCents,
          cashTenderedCents: amountAppliedCents,
          changeGivenCents: 0,
          reference: input.mpesaReceiptNumber,
          notes: `M-Pesa receipt ${input.mpesaReceiptNumber}${
            input.phoneNumber ? ` (${input.phoneNumber})` : ""
          }`,
          receivedByUserId: input.actorUserId ?? txRecord.initiatedByUserId ?? null,
          receivedAt: now,
        },
      });

      const receiptSnapshot: PrintableReceiptDocument = {
        receiptNumber,
        paymentNumber,
        orderNumber: resolvedOrder.orderNumber,
        invoiceNumber: resolvedInvoiceNumber,
        channel: resolvedOrder.channel,
        paymentMethod: PaymentMethod.MPESA,
        reference: input.mpesaReceiptNumber,
        mpesaReceiptNumber: input.mpesaReceiptNumber,
        phoneNumber: input.phoneNumber ?? txRecord.phoneNumber ?? null,
        currency: resolvedOrder.currency,
        issuedAt: now.toISOString(),
        locationName: resolvedOrder.location.name,
        locationCode: resolvedOrder.location.code,
        subtotalCents: resolvedOrder.subtotalCents,
        discountTotalCents: resolvedOrder.discountTotalCents,
        taxCents: resolvedOrder.taxCents,
        totalCents: resolvedOrder.totalCents,
        amountAppliedCents,
        cashTenderedCents: amountAppliedCents,
        changeGivenCents: 0,
        notes: resolvedOrder.notes,
        organization: {
          name: org?.name ?? "Organization",
          companyName: settings?.companyLegalName ?? org?.name ?? "Organization",
        },
        customer: resolvedOrder.customer
          ? {
              name: resolvedOrder.customer.name,
              companyName: resolvedOrder.customer.companyName,
              code: resolvedOrder.customer.code,
              email: resolvedOrder.customer.email,
              phone: resolvedOrder.customer.phone,
              taxId: resolvedOrder.customer.taxId,
            }
          : null,
        lines: resolvedOrder.lines.map((l) => ({
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
          orderId,
          salesInvoiceId: salesInvoiceId ?? null,
          customerId: resolvedOrder.customer?.id ?? txRecord.customerId ?? null,
          channel: resolvedOrder.channel,
          currency: resolvedOrder.currency,
          totalCents: resolvedOrder.totalCents,
          cashTenderedCents: amountAppliedCents,
          changeGivenCents: 0,
          snapshot: receiptSnapshot as unknown as Prisma.InputJsonValue,
          issuedAt: now,
          issuedByUserId: input.actorUserId ?? txRecord.initiatedByUserId ?? null,
        },
      });

      const claimedTx = await tx.paymentTransaction.updateMany({
        where: {
          id: txRecord.id,
          organizationId,
          customerPaymentId: null,
          status: {
            in: [
              PaymentTransactionStatus.PENDING,
              PaymentTransactionStatus.UNMATCHED_C2B,
            ],
          },
        },
        data: {
          status: PaymentTransactionStatus.SUCCEEDED,
          targetType,
          orderId,
          salesInvoiceId: salesInvoiceId ?? null,
          fulfillmentId: fulfillmentId ?? null,
          customerId: resolvedOrder.customer?.id ?? txRecord.customerId ?? null,
          customerPaymentId: payment.id,
          mpesaReceiptNumber: input.mpesaReceiptNumber,
          ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
          ...(input.payerName ? { payerName: input.payerName } : {}),
          ...(input.resultCode !== undefined ? { resultCode: input.resultCode } : {}),
          ...(input.resultDesc !== undefined ? { resultDesc: input.resultDesc } : {}),
          ...(input.callbackMetadata
            ? {
                callbackMetadata:
                  input.callbackMetadata as Prisma.InputJsonValue,
              }
            : {}),
          ...(input.rawCallbackPayload
            ? {
                rawCallbackPayload:
                  input.rawCallbackPayload as Prisma.InputJsonValue,
              }
            : {}),
          ...(input.actorUserId
            ? { reconciledByUserId: input.actorUserId, reconciledAt: now }
            : {}),
          completedAt: now,
        },
      });
      if (claimedTx.count !== 1) {
        throw new ConflictException(
          "Payment transaction was settled concurrently by another process.",
        );
      }

      const updatedTx = await tx.paymentTransaction.findFirstOrThrow({
        where: { id: txRecord.id, organizationId },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: input.actorUserId ?? txRecord.initiatedByUserId ?? null,
          action: "payment.mpesa.settled",
          resourceType: "PaymentTransaction",
          resourceId: updatedTx.id,
          metadata: {
            transactionNumber: updatedTx.transactionNumber,
            flow: updatedTx.flow,
            targetType,
            orderId,
            salesInvoiceId: salesInvoiceId ?? null,
            fulfillmentId: fulfillmentId ?? null,
            mpesaReceiptNumber: input.mpesaReceiptNumber,
            paymentNumber: payment.paymentNumber,
            receiptNumber: receipt.receiptNumber,
            amountAppliedCents,
          } as Prisma.InputJsonValue,
          ipAddress: input.ipAddress ?? null,
        },
      });

      return {
        alreadySettled: false,
        transaction: updatedTx,
        payment,
        receipt,
      };
    });

    if (!settled.alreadySettled) {
      this.analyticsService.captureDomainEvent({
        event: "payment.mpesa.settled",
        distinctId:
          input.actorUserId ??
          settled.transaction.initiatedByUserId ??
          organizationId,
        organizationId,
        properties: {
          transaction_id: settled.transaction.id,
          flow: settled.transaction.flow,
          target_type: settled.transaction.targetType,
          order_id: settled.transaction.orderId,
          sales_invoice_id: settled.transaction.salesInvoiceId,
          fulfillment_id: settled.transaction.fulfillmentId,
          currency: settled.transaction.currency,
          amount_cents: settled.transaction.amountCents,
        },
      });
    }

    return settled;
  }
}

import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { OrderStatus, SalesInvoiceStatus } from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";

export interface CustomerCreditEvaluation {
  customerId: string;
  customerName: string;
  companyName: string | null;
  creditHold: boolean;
  creditLimitCents: number | null;
  paymentTermsDays: number;
  invoiceExposureCents: number;
  unInvoicedOrderExposureCents: number;
  totalCurrentExposureCents: number;
  additionalExposureCents: number;
  projectedExposureCents: number;
  availableCreditCents: number | null;
  isExceeded: boolean;
  allowed: boolean;
  rejectionReason: string | null;
}

@Injectable()
export class CreditControlService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  async evaluateCustomerCredit(
    organizationId: string,
    customerId: string,
    additionalExposureCents = 0,
  ): Promise<CustomerCreditEvaluation> {
    const customer = await this.prismaService.raw.customer.findFirst({
      where: { id: customerId, organizationId },
      select: {
        id: true,
        name: true,
        companyName: true,
        creditHold: true,
        creditLimitCents: true,
        paymentTermsDays: true,
      },
    });

    if (!customer) {
      throw new BadRequestException("Customer was not found for credit evaluation.");
    }

    // 1. Outstanding unpaid / partially paid issued invoices
    const activeInvoices = await this.prismaService.raw.salesInvoice.findMany({
      where: {
        organizationId,
        customerId,
        status: { in: [SalesInvoiceStatus.ISSUED, SalesInvoiceStatus.PARTIALLY_PAID] },
      },
      select: {
        id: true,
        totalCents: true,
        paidAmountCents: true,
        orderId: true,
      },
    });

    const invoiceExposureCents = activeInvoices.reduce(
      (sum, inv) => sum + Math.max(0, inv.totalCents - inv.paidAmountCents),
      0,
    );

    // Active order IDs that already have an invoice considered above
    const invoicedOrderIds = new Set(
      activeInvoices.map((inv) => inv.orderId).filter((id): id is string => Boolean(id)),
    );

    // 2. Outstanding confirmed / fulfilled orders not yet covered by active issued invoices
    const activeOrders = await this.prismaService.raw.order.findMany({
      where: {
        organizationId,
        customerId,
        status: { in: [OrderStatus.CONFIRMED, OrderStatus.FULFILLED] },
      },
      select: {
        id: true,
        totalCents: true,
        paidAmountCents: true,
      },
    });

    const unInvoicedOrderExposureCents = activeOrders
      .filter((ord) => !invoicedOrderIds.has(ord.id))
      .reduce(
        (sum, ord) => sum + Math.max(0, ord.totalCents - ord.paidAmountCents),
        0,
      );

    const totalCurrentExposureCents =
      invoiceExposureCents + unInvoicedOrderExposureCents;
    const projectedExposureCents =
      totalCurrentExposureCents + Math.max(0, additionalExposureCents);

    const creditLimitCents = customer.creditLimitCents;
    const creditHold = customer.creditHold;

    const isExceeded =
      creditLimitCents !== null && projectedExposureCents > creditLimitCents;

    let rejectionReason: string | null = null;
    if (creditHold) {
      rejectionReason = `Customer "${customer.companyName || customer.name}" is currently on credit hold. Settlement of outstanding balance or administrative release is required.`;
    } else if (isExceeded && creditLimitCents !== null) {
      const available = Math.max(0, creditLimitCents - totalCurrentExposureCents);
      rejectionReason = `Credit limit exceeded for customer "${customer.companyName || customer.name}". Limit: ${creditLimitCents} cents, current exposure: ${totalCurrentExposureCents} cents, available: ${available} cents, requested: ${additionalExposureCents} cents.`;
    }

    const allowed = !creditHold && !isExceeded;
    const availableCreditCents =
      creditLimitCents !== null
        ? Math.max(0, creditLimitCents - totalCurrentExposureCents)
        : null;

    return {
      customerId: customer.id,
      customerName: customer.name,
      companyName: customer.companyName,
      creditHold,
      creditLimitCents,
      paymentTermsDays: customer.paymentTermsDays,
      invoiceExposureCents,
      unInvoicedOrderExposureCents,
      totalCurrentExposureCents,
      additionalExposureCents,
      projectedExposureCents,
      availableCreditCents,
      isExceeded,
      allowed,
      rejectionReason,
    };
  }

  async assertCreditAllowed(
    organizationId: string,
    customerId: string,
    additionalExposureCents: number,
    options?: { allowOverride?: boolean; actorRole?: string },
  ): Promise<CustomerCreditEvaluation> {
    const evaluation = await this.evaluateCustomerCredit(
      organizationId,
      customerId,
      additionalExposureCents,
    );

    if (!evaluation.allowed) {
      const canOverride =
        options?.allowOverride === true &&
        (options.actorRole === "owner" || options.actorRole === "admin");

      if (!canOverride) {
        throw new BadRequestException(evaluation.rejectionReason ?? "Credit check failed.");
      }
    }

    return evaluation;
  }
}

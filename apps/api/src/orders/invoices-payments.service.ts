import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  CommunicationChannel,
  CommunicationEventType,
  CustomerPaymentStatus,
  ItemVariantKind,
  OrderChannel,
  OrderStatus,
  PaymentMethod,
  Prisma,
  SalesInvoiceStatus,
  OrganizationContext,
} from "@scace/db";
import { CommunicationOutboxService } from "../communications/communication-outbox.service.js";
import { PrismaService } from "../database/prisma.service.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { CreditControlService } from "./credit-control.service.js";
import type {
  PrintableInvoiceDocument,
  PrintableParty,
  PrintableReceiptDocument,
} from "./document-renderer.utils.js";

export interface CreateStandaloneInvoiceLineInput {
  itemId: string;
  quantity: number;
  unitPriceCents?: number;
  discountCents?: number;
  description?: string | null;
  unitOfMeasure?: string | null;
}

export interface CreateStandaloneInvoiceInput {
  customerId: string;
  invoiceNumber?: string;
  status?: "DRAFT" | "ISSUED";
  currency?: string;
  paymentTermsDays?: number;
  customerPoNumber?: string | null;
  dueAt?: string | null;
  notes?: string | null;
  taxCents?: number;
  lines: CreateStandaloneInvoiceLineInput[];
}

export interface CreateInvoiceFromOrderInput {
  invoiceNumber?: string;
  status?: "DRAFT" | "ISSUED";
  taxCents?: number;
  dueAt?: string | null;
  notes?: string | null;
}

export interface ListInvoicesQuery {
  status?: SalesInvoiceStatus;
  orderId?: string;
  customerId?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface RecordCashPaymentInput {
  method?: "CASH";
  amountCents?: number;
  cashTenderedCents?: number;
  reference?: string | null;
  notes?: string | null;
}

export interface ListPaymentsQuery {
  orderId?: string;
  salesInvoiceId?: string;
  customerId?: string;
  status?: CustomerPaymentStatus;
  limit: number;
  cursor?: string;
}

export interface ListReceiptsQuery {
  orderId?: string;
  salesInvoiceId?: string;
  customerId?: string;
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

@Injectable()
export class InvoicesPaymentsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(CreditControlService)
    private readonly creditControlService: CreditControlService,
    @Inject(CommunicationOutboxService)
    private readonly outboxService: CommunicationOutboxService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  async createStandaloneInvoice(
    tenant: AuthenticatedOrganization,
    input: CreateStandaloneInvoiceInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    if (!input.lines || input.lines.length === 0) {
      throw new BadRequestException("An invoice must have at least one line item.");
    }

    const customer = await this.prismaService.raw.customer.findFirst({
      where: { id: input.customerId, organizationId },
    });
    if (!customer) {
      throw new NotFoundException("Customer was not found.");
    }
    if (customer.status === "ARCHIVED") {
      throw new BadRequestException("Cannot create an invoice for an archived customer.");
    }

    const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
    const items = await this.prismaService.raw.item.findMany({
      where: { id: { in: itemIds }, organizationId },
    });
    const itemMap = new Map(items.map((it) => [it.id, it]));

    for (const line of input.lines) {
      const it = itemMap.get(line.itemId);
      if (!it) {
        throw new BadRequestException(`Item "${line.itemId}" does not exist in this organization.`);
      }
      if (it.variantKind === ItemVariantKind.TEMPLATE) {
        throw new BadRequestException(`Item "${it.sku}" is a template item. Select a concrete variant SKU.`);
      }
    }

    let subtotalCents = 0;
    let discountTotalCents = 0;

    const calculatedLines = input.lines.map((l) => {
      const it = itemMap.get(l.itemId)!;
      const unitPriceCents =
        l.unitPriceCents !== undefined ? Math.max(0, l.unitPriceCents) : it.salePriceCents;
      const discountCents =
        l.discountCents !== undefined ? Math.max(0, l.discountCents) : 0;
      const lineTotalCents = Math.max(0, l.quantity * unitPriceCents - discountCents);

      subtotalCents += l.quantity * unitPriceCents;
      discountTotalCents += discountCents;

      return {
        itemId: it.id,
        sku: it.sku,
        description: l.description?.trim() || it.description || it.name,
        unitOfMeasure: l.unitOfMeasure?.trim() || it.unitOfMeasure || "unit",
        quantity: l.quantity,
        unitPriceCents,
        discountCents,
        lineTotalCents,
      };
    });

    const taxCents = input.taxCents !== undefined ? Math.max(0, input.taxCents) : 0;
    const totalCents = Math.max(0, subtotalCents - discountTotalCents + taxCents);

    const targetStatus =
      input.status === "DRAFT" ? SalesInvoiceStatus.DRAFT : SalesInvoiceStatus.ISSUED;

    if (targetStatus === SalesInvoiceStatus.ISSUED) {
      await this.creditControlService.assertCreditAllowed(
        organizationId,
        customer.id,
        totalCents,
        { actorRole: tenant.role },
      );
    }

    const invoiceNumber =
      input.invoiceNumber?.trim().toUpperCase() || generateDocNumber("INV");
    const currency = (input.currency || customer.currency || "USD").toUpperCase();
    const paymentTermsDays =
      input.paymentTermsDays !== undefined
        ? input.paymentTermsDays
        : customer.paymentTermsDays;

    const now = new Date();
    const dueAt = input.dueAt
      ? new Date(input.dueAt)
      : new Date(now.getTime() + paymentTermsDays * 86_400_000);

    try {
      const createdInvoice = await this.prismaService.raw.$transaction(async (tx) => {
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

        const invoice = await tx.salesInvoice.create({
          data: {
            organizationId,
            invoiceNumber,
            customerId: customer.id,
            orderId: null,
            customerPoNumber: input.customerPoNumber?.trim() || null,
            paymentTermsDays,
            status: targetStatus,
            currency,
            subtotalCents,
            discountTotalCents,
            taxCents,
            totalCents,
            paidAmountCents: 0,
            issuedAt: targetStatus === SalesInvoiceStatus.ISSUED ? now : null,
            dueAt,
            notes: input.notes?.trim() || null,
            customerSnapshot: {
              id: customer.id,
              code: customer.code,
              type: customer.type,
              name: customer.name,
              companyName: customer.companyName,
              email: customer.email,
              phone: customer.phone,
              taxId: customer.taxId,
              billingAddressLine1: customer.billingAddressLine1,
              billingAddressLine2: customer.billingAddressLine2,
              billingCity: customer.billingCity,
              billingState: customer.billingState,
              billingPostalCode: customer.billingPostalCode,
              billingCountry: customer.billingCountry,
            } as Prisma.InputJsonValue,
            organizationSnapshot: {
              id: organizationId,
              name: org?.name ?? "Organization",
              companyLegalName:
                settings?.companyLegalName ?? org?.name ?? "Organization",
            } as Prisma.InputJsonValue,
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
            lines: {
              create: calculatedLines.map((l) => ({
                organizationId,
                itemId: l.itemId,
                sku: l.sku,
                description: l.description,
                unitOfMeasure: l.unitOfMeasure,
                quantity: l.quantity,
                unitPriceCents: l.unitPriceCents,
                discountCents: l.discountCents,
                lineTotalCents: l.lineTotalCents,
              })),
            },
          },
          include: {
            customer: true,
            lines: true,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "invoice.created",
            resourceType: "SalesInvoice",
            resourceId: invoice.id,
            metadata: {
              invoiceNumber: invoice.invoiceNumber,
              customerPoNumber: invoice.customerPoNumber,
              status: invoice.status,
              totalCents: invoice.totalCents,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return {
          ...invoice,
          balanceDueCents: invoice.totalCents,
        };
      });

      if (targetStatus === SalesInvoiceStatus.ISSUED && customer.email) {
        await this.outboxService.emitEvent(null, {
          organizationId,
          eventType: CommunicationEventType.INVOICE_ISSUED,
          targetEmails: [customer.email],
          channelHints: [CommunicationChannel.EMAIL],
          subject: `Invoice ${createdInvoice.invoiceNumber}`,
          summaryText: `An invoice has been issued. Total Due: ${createdInvoice.currency} ${(createdInvoice.totalCents / 100).toFixed(2)}, due on ${dueAt.toISOString().slice(0, 10)}.`,
          sourceEntityType: "SalesInvoice",
          sourceEntityId: createdInvoice.id,
          payload: {
            invoiceId: createdInvoice.id,
            invoiceNumber: createdInvoice.invoiceNumber,
            customerId: customer.id,
            totalCents: createdInvoice.totalCents,
            dueAt: dueAt.toISOString(),
          },
        });
      }

      this.analyticsService.captureDomainEvent({
        event: "invoice.created",
        distinctId: tenant.userId,
        organizationId,
        properties: {
          invoice_id: createdInvoice.id,
          invoice_number: createdInvoice.invoiceNumber,
          is_standalone: true,
          status: createdInvoice.status,
          currency: createdInvoice.currency,
          total_cents: createdInvoice.totalCents,
        },
      });

      return createdInvoice;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `Invoice number "${invoiceNumber}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async createInvoiceFromOrder(
    tenant: AuthenticatedOrganization,
    orderId: string,
    input: CreateInvoiceFromOrderInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const invoiceNumber =
      input.invoiceNumber?.trim().toUpperCase() || generateDocNumber("INV");
    const targetStatus = input.status ?? SalesInvoiceStatus.ISSUED;

    try {
      const createdInvoice = await this.prismaService.raw.$transaction(async (tx) => {
        const [order, org, settings] = await Promise.all([
          tx.order.findFirst({
            where: { id: orderId, organizationId },
            include: {
              customer: true,
              lines: true,
              invoices: {
                where: { status: { not: SalesInvoiceStatus.VOID } },
                select: { id: true, invoiceNumber: true, totalCents: true },
              },
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

        if (!order) {
          throw new NotFoundException("Order was not found.");
        }
        if (order.status === OrderStatus.CANCELLED) {
          throw new BadRequestException(
            "Cannot create an invoice for a cancelled order.",
          );
        }
        if (order.invoices.length > 0) {
          throw new ConflictException(
            `Order "${order.orderNumber}" already has an active invoice (${order.invoices[0]?.invoiceNumber}).`,
          );
        }

        const now = new Date();
        const taxCents =
          input.taxCents !== undefined ? input.taxCents : order.taxCents;
        const totalCents = Math.max(
          0,
          order.subtotalCents - order.discountTotalCents + taxCents,
        );
        const alreadyPaid = Math.min(order.paidAmountCents, totalCents);
        const computedStatus =
          alreadyPaid >= totalCents && totalCents > 0
            ? SalesInvoiceStatus.PAID
            : alreadyPaid > 0
              ? SalesInvoiceStatus.PARTIALLY_PAID
              : targetStatus;

        if (computedStatus === SalesInvoiceStatus.ISSUED && order.customerId) {
          await this.creditControlService.assertCreditAllowed(
            organizationId,
            order.customerId,
            totalCents,
            { actorRole: tenant.role },
          );
        }

        const dueAt = input.dueAt
          ? new Date(input.dueAt)
          : new Date(
              now.getTime() +
                (order.customer?.paymentTermsDays ?? 30) * 86_400_000,
            );

        const invoice = await tx.salesInvoice.create({
          data: {
            organizationId,
            invoiceNumber,
            orderId: order.id,
            customerId: order.customerId,
            customerPurchaseOrderId: order.customerPurchaseOrderId,
            customerPoNumber: order.customerPoNumber,
            paymentTermsDays: order.customer?.paymentTermsDays ?? 30,
            status: computedStatus,
            currency: order.currency,
            subtotalCents: order.subtotalCents,
            discountTotalCents: order.discountTotalCents,
            taxCents,
            totalCents,
            paidAmountCents: alreadyPaid,
            issuedAt:
              computedStatus === SalesInvoiceStatus.DRAFT ? null : now,
            dueAt,
            paidAt: computedStatus === SalesInvoiceStatus.PAID ? now : null,
            notes: input.notes?.trim() || order.notes,
            customerSnapshot: order.customer
              ? ({
                  id: order.customer.id,
                  code: order.customer.code,
                  type: order.customer.type,
                  name: order.customer.name,
                  companyName: order.customer.companyName,
                  email: order.customer.email,
                  phone: order.customer.phone,
                  taxId: order.customer.taxId,
                  billingAddressLine1: order.customer.billingAddressLine1,
                  billingAddressLine2: order.customer.billingAddressLine2,
                  billingCity: order.customer.billingCity,
                  billingState: order.customer.billingState,
                  billingPostalCode: order.customer.billingPostalCode,
                  billingCountry: order.customer.billingCountry,
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
              create: order.lines.map((l) => ({
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
          include: {
            order: { select: { id: true, orderNumber: true, channel: true, status: true } },
            customer: true,
            lines: true,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "invoice.created",
            resourceType: "SalesInvoice",
            resourceId: invoice.id,
            metadata: {
              invoiceNumber: invoice.invoiceNumber,
              orderNumber: order.orderNumber,
              status: invoice.status,
              totalCents: invoice.totalCents,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return {
          ...invoice,
          balanceDueCents: Math.max(0, invoice.totalCents - invoice.paidAmountCents),
        };
      });

      if (
        createdInvoice.status === SalesInvoiceStatus.ISSUED &&
        createdInvoice.customer?.email
      ) {
        await this.outboxService.emitEvent(null, {
          organizationId,
          eventType: CommunicationEventType.INVOICE_ISSUED,
          targetEmails: [createdInvoice.customer.email],
          channelHints: [CommunicationChannel.EMAIL],
          subject: `Invoice ${createdInvoice.invoiceNumber}`,
          summaryText: `Invoice ${createdInvoice.invoiceNumber} has been issued. Amount due: ${createdInvoice.currency} ${(createdInvoice.totalCents / 100).toFixed(2)}.`,
          sourceEntityType: "SalesInvoice",
          sourceEntityId: createdInvoice.id,
          payload: {
            invoiceId: createdInvoice.id,
            invoiceNumber: createdInvoice.invoiceNumber,
            totalCents: createdInvoice.totalCents,
            dueAt: createdInvoice.dueAt?.toISOString() ?? null,
          },
        });
      }

      this.analyticsService.captureDomainEvent({
        event: "invoice.created",
        distinctId: tenant.userId,
        organizationId,
        properties: {
          invoice_id: createdInvoice.id,
          invoice_number: createdInvoice.invoiceNumber,
          order_id: createdInvoice.orderId,
          status: createdInvoice.status,
          currency: createdInvoice.currency,
          total_cents: createdInvoice.totalCents,
        },
      });

      return createdInvoice;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `Invoice number "${invoiceNumber}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async issueInvoice(
    tenant: AuthenticatedOrganization,
    invoiceId: string,
    dueAt?: string | null,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const result = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.salesInvoice.findFirst({
        where: { id: invoiceId, organizationId },
        include: { customer: true },
      });
      if (!existing) {
        throw new NotFoundException("Invoice was not found.");
      }
      if (existing.status !== SalesInvoiceStatus.DRAFT) {
        throw new BadRequestException(
          `Only DRAFT invoices can be issued (current status: ${existing.status}).`,
        );
      }

      if (existing.customerId) {
        await this.creditControlService.assertCreditAllowed(
          organizationId,
          existing.customerId,
          existing.totalCents,
          { actorRole: tenant.role },
        );
      }

      const now = new Date();
      const resolvedDueAt = dueAt
        ? new Date(dueAt)
        : existing.dueAt ??
          new Date(
            now.getTime() +
              (existing.paymentTermsDays || existing.customer?.paymentTermsDays || 30) * 86_400_000,
          );

      const claimed = await tx.salesInvoice.updateMany({
        where: {
          id: existing.id,
          organizationId,
          status: SalesInvoiceStatus.DRAFT,
        },
        data: {
          status: SalesInvoiceStatus.ISSUED,
          issuedAt: now,
          dueAt: resolvedDueAt,
          updatedByUserId: tenant.userId,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          "Invoice state changed concurrently. Refresh and retry.",
        );
      }

      const updated = await tx.salesInvoice.findFirstOrThrow({
        where: { id: existing.id, organizationId },
        include: {
          order: { select: { id: true, orderNumber: true, channel: true, status: true } },
          customer: true,
          lines: true,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "invoice.issued",
          resourceType: "SalesInvoice",
          resourceId: existing.id,
          metadata: {
            invoiceNumber: existing.invoiceNumber,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        ...updated,
        balanceDueCents: Math.max(0, updated.totalCents - updated.paidAmountCents),
      };
    });

    if (result.customer?.email) {
      await this.outboxService.emitEvent(null, {
        organizationId,
        eventType: CommunicationEventType.INVOICE_ISSUED,
        targetEmails: [result.customer.email],
        channelHints: [CommunicationChannel.EMAIL],
        subject: `Invoice ${result.invoiceNumber} Issued`,
        summaryText: `Invoice ${result.invoiceNumber} has been issued. Total Due: ${result.currency} ${(result.totalCents / 100).toFixed(2)}, due on ${result.dueAt ? result.dueAt.toISOString().slice(0, 10) : "-"}.`,
        sourceEntityType: "SalesInvoice",
        sourceEntityId: result.id,
        payload: {
          invoiceId: result.id,
          invoiceNumber: result.invoiceNumber,
          customerId: result.customerId,
          totalCents: result.totalCents,
          dueAt: result.dueAt?.toISOString() ?? null,
        },
      });
    }

    this.analyticsService.captureDomainEvent({
      event: "invoice.issued",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        invoice_id: result.id,
        invoice_number: result.invoiceNumber,
        currency: result.currency,
        total_cents: result.totalCents,
      },
    });

    return result;
  }

  async voidInvoice(
    tenant: AuthenticatedOrganization,
    invoiceId: string,
    reason?: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const result = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.salesInvoice.findFirst({
        where: { id: invoiceId, organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Invoice was not found.");
      }
      if (existing.status === SalesInvoiceStatus.VOID) {
        throw new BadRequestException("Invoice is already void.");
      }
      if (existing.paidAmountCents > 0) {
        throw new BadRequestException(
          "Cannot void an invoice that has recorded cash payments.",
        );
      }

      const claimed = await tx.salesInvoice.updateMany({
        where: {
          id: existing.id,
          organizationId,
          paidAmountCents: 0,
          status: { in: [SalesInvoiceStatus.DRAFT, SalesInvoiceStatus.ISSUED] },
        },
        data: {
          status: SalesInvoiceStatus.VOID,
          voidedAt: new Date(),
          voidReason: reason?.trim() || null,
          updatedByUserId: tenant.userId,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          "Invoice state changed concurrently. Refresh and retry.",
        );
      }

      const voided = await tx.salesInvoice.findFirstOrThrow({
        where: { id: existing.id, organizationId },
        include: {
          order: { select: { id: true, orderNumber: true, channel: true, status: true } },
          customer: true,
          lines: true,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "invoice.voided",
          resourceType: "SalesInvoice",
          resourceId: existing.id,
          metadata: {
            invoiceNumber: existing.invoiceNumber,
            ...(reason ? { reason } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        ...voided,
        balanceDueCents: 0,
      };
    });

    this.analyticsService.captureDomainEvent({
      event: "invoice.voided",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        invoice_id: result.id,
        invoice_number: result.invoiceNumber,
        total_cents: result.totalCents,
      },
    });

    return result;
  }

  async recordCashPayment(
    tenant: AuthenticatedOrganization,
    invoiceId: string,
    input: RecordCashPaymentInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    if (input.method && input.method !== PaymentMethod.CASH) {
      throw new BadRequestException(
        "Only CASH payment is currently supported.",
      );
    }

    const result = await this.prismaService.raw.$transaction(async (tx) => {
      const invoice = await tx.salesInvoice.findFirst({
        where: { id: invoiceId, organizationId },
        include: {
          order: {
            include: {
              location: { select: { id: true, code: true, name: true } },
            },
          },
          customer: true,
          lines: true,
        },
      });

      if (!invoice) {
        throw new NotFoundException("Invoice was not found.");
      }
      if (
        invoice.status !== SalesInvoiceStatus.ISSUED &&
        invoice.status !== SalesInvoiceStatus.PARTIALLY_PAID
      ) {
        throw new BadRequestException(
          `Payments can only be recorded on ISSUED or PARTIALLY_PAID invoices (current status: ${invoice.status}).`,
        );
      }

      const remainingCents = invoice.totalCents - invoice.paidAmountCents;
      if (remainingCents <= 0) {
        throw new BadRequestException("Invoice is already fully paid.");
      }

      const amountAppliedCents =
        input.amountCents !== undefined
          ? input.amountCents
          : input.cashTenderedCents !== undefined
            ? Math.min(input.cashTenderedCents, remainingCents)
            : remainingCents;

      if (amountAppliedCents <= 0) {
        throw new BadRequestException(
          "Payment amount must be greater than 0 cents.",
        );
      }
      if (amountAppliedCents > remainingCents) {
        throw new BadRequestException(
          `Payment amount (${amountAppliedCents} cents) exceeds remaining balance due (${remainingCents} cents).`,
        );
      }

      const cashTenderedCents =
        input.cashTenderedCents !== undefined
          ? input.cashTenderedCents
          : amountAppliedCents;

      if (cashTenderedCents < amountAppliedCents) {
        throw new BadRequestException(
          `Cash tendered (${cashTenderedCents} cents) cannot be less than amount applied (${amountAppliedCents} cents).`,
        );
      }

      const changeGivenCents = cashTenderedCents - amountAppliedCents;
      const nextPaidAmount = invoice.paidAmountCents + amountAppliedCents;
      const nextInvoiceStatus =
        nextPaidAmount >= invoice.totalCents
          ? SalesInvoiceStatus.PAID
          : SalesInvoiceStatus.PARTIALLY_PAID;
      const now = new Date();

      const claimed = await tx.salesInvoice.updateMany({
        where: {
          id: invoice.id,
          organizationId,
          paidAmountCents: invoice.paidAmountCents,
          status: {
            in: [SalesInvoiceStatus.ISSUED, SalesInvoiceStatus.PARTIALLY_PAID],
          },
        },
        data: {
          paidAmountCents: nextPaidAmount,
          status: nextInvoiceStatus,
          ...(nextInvoiceStatus === SalesInvoiceStatus.PAID
            ? { paidAt: now }
            : {}),
          updatedByUserId: tenant.userId,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          "Invoice balance changed concurrently. Refresh and retry.",
        );
      }

      if (invoice.order && invoice.orderId) {
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
            updatedByUserId: tenant.userId,
          },
        });
      }

      const paymentNumber = generateDocNumber("PAY");
      const receiptNumber = generateDocNumber("RCP");

      const payment = await tx.customerPayment.create({
        data: {
          organizationId,
          paymentNumber,
          orderId: invoice.orderId,
          salesInvoiceId: invoice.id,
          customerId: invoice.customerId,
          method: PaymentMethod.CASH,
          status: CustomerPaymentStatus.COMPLETED,
          currency: invoice.currency,
          amountAppliedCents,
          cashTenderedCents,
          changeGivenCents,
          reference: input.reference?.trim() || null,
          notes: input.notes?.trim() || null,
          receivedByUserId: tenant.userId,
          receivedAt: now,
        },
      });

      const orgSnap = invoice.organizationSnapshot as {
        name?: string;
        companyLegalName?: string;
      } | null;

      const resolvedChannel = invoice.order?.channel ?? OrderChannel.B2B;
      const receiptSnapshot: PrintableReceiptDocument = {
        receiptNumber,
        paymentNumber,
        orderNumber: invoice.order?.orderNumber ?? invoice.invoiceNumber,
        invoiceNumber: invoice.invoiceNumber,
        channel: resolvedChannel,
        paymentMethod: PaymentMethod.CASH,
        currency: invoice.currency,
        issuedAt: now.toISOString(),
        locationName: invoice.order?.location?.name ?? null,
        locationCode: invoice.order?.location?.code ?? null,
        subtotalCents: invoice.subtotalCents,
        discountTotalCents: invoice.discountTotalCents,
        taxCents: invoice.taxCents,
        totalCents: invoice.totalCents,
        amountAppliedCents,
        cashTenderedCents,
        changeGivenCents,
        notes: input.notes?.trim() || invoice.notes,
        organization: {
          name: orgSnap?.name ?? "Organization",
          companyName: orgSnap?.companyLegalName ?? orgSnap?.name ?? "Organization",
        },
        customer: invoice.customer
          ? {
              name: invoice.customer.name,
              companyName: invoice.customer.companyName,
              code: invoice.customer.code,
              email: invoice.customer.email,
              phone: invoice.customer.phone,
              taxId: invoice.customer.taxId,
            }
          : null,
        lines: invoice.lines.map((l) => ({
          sku: l.sku,
          description: l.description,
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
          orderId: invoice.orderId,
          salesInvoiceId: invoice.id,
          customerId: invoice.customerId,
          channel: resolvedChannel,
          currency: invoice.currency,
          totalCents: invoice.totalCents,
          cashTenderedCents,
          changeGivenCents,
          snapshot: receiptSnapshot as unknown as Prisma.InputJsonValue,
          issuedAt: now,
          issuedByUserId: tenant.userId,
        },
      });

      const updatedInvoice = await tx.salesInvoice.findFirstOrThrow({
        where: { id: invoice.id, organizationId },
        include: {
          order: { select: { id: true, orderNumber: true, channel: true, status: true } },
          customer: true,
          lines: true,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "invoice.payment.recorded",
          resourceType: "SalesInvoice",
          resourceId: invoice.id,
          metadata: {
            invoiceNumber: invoice.invoiceNumber,
            paymentNumber: payment.paymentNumber,
            receiptNumber: receipt.receiptNumber,
            method: PaymentMethod.CASH,
            amountAppliedCents,
            cashTenderedCents,
            changeGivenCents,
            nextStatus: nextInvoiceStatus,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        invoice: {
          ...updatedInvoice,
          balanceDueCents: Math.max(
            0,
            updatedInvoice.totalCents - updatedInvoice.paidAmountCents,
          ),
        },
        payment,
        receipt,
      };
    });

    this.analyticsService.captureDomainEvent({
      event: "payment.recorded",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        payment_id: result.payment.id,
        payment_number: result.payment.paymentNumber,
        invoice_id: result.invoice.id,
        order_id: result.payment.orderId,
        method: result.payment.method,
        currency: result.payment.currency,
        amount_applied_cents: result.payment.amountAppliedCents,
        invoice_status: result.invoice.status,
      },
    });

    return result;
  }

  async listInvoices(tenant: AuthenticatedOrganization, query: ListInvoicesQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const records = await this.prismaService.scoped.salesInvoice.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.orderId ? { orderId: query.orderId } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(search
          ? {
              OR: [
                { invoiceNumber: { contains: search, mode: "insensitive" } },
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
              ],
            }
          : {}),
      },
      include: {
        order: { select: { id: true, orderNumber: true, channel: true, status: true } },
        customer: {
          select: {
            id: true,
            code: true,
            name: true,
            companyName: true,
            type: true,
          },
        },
        _count: { select: { lines: true, payments: true } },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    const hasMore = records.length > take;
    const sliced = hasMore ? records.slice(0, take) : records;
    const nextCursor = hasMore ? (sliced[sliced.length - 1]?.id ?? null) : null;

    return {
      organizationId: tenant.organizationId,
      items: sliced.map((inv) => ({
        ...inv,
        balanceDueCents: Math.max(0, inv.totalCents - inv.paidAmountCents),
      })),
      nextCursor,
    };
  }

  async getInvoice(tenant: AuthenticatedOrganization, invoiceId: string) {
    this.resolveVerifiedOrganizationId(tenant);
    const invoice = await this.prismaService.scoped.salesInvoice.findUnique({
      where: { id: invoiceId },
      include: {
        order: { select: { id: true, orderNumber: true, channel: true, status: true } },
        customer: true,
        lines: true,
        payments: {
          orderBy: { receivedAt: "desc" },
          include: { receipt: true },
        },
      },
    });

    if (!invoice) {
      throw new NotFoundException("Invoice was not found.");
    }

    return {
      ...invoice,
      balanceDueCents: Math.max(0, invoice.totalCents - invoice.paidAmountCents),
    };
  }

  async buildInvoicePrintableDocument(
    tenant: AuthenticatedOrganization,
    invoiceId: string,
  ): Promise<PrintableInvoiceDocument> {
    const invoice = await this.getInvoice(tenant, invoiceId);
    const orgSnap = invoice.organizationSnapshot as {
      name?: string;
      companyLegalName?: string;
    } | null;

    const custSnap = invoice.customerSnapshot as {
      name?: string;
      companyName?: string | null;
      code?: string | null;
      email?: string | null;
      phone?: string | null;
      taxId?: string | null;
      billingAddressLine1?: string | null;
      billingAddressLine2?: string | null;
      billingCity?: string | null;
      billingState?: string | null;
      billingPostalCode?: string | null;
      billingCountry?: string | null;
    } | null;

    let customerParty: PrintableParty | null = null;
    if (custSnap?.name) {
      const cityStateZip = [
        custSnap.billingCity,
        custSnap.billingState,
        custSnap.billingPostalCode,
      ]
        .filter(Boolean)
        .join(", ");
      customerParty = {
        name: custSnap.name,
        companyName: custSnap.companyName ?? null,
        code: custSnap.code ?? null,
        email: custSnap.email ?? null,
        phone: custSnap.phone ?? null,
        taxId: custSnap.taxId ?? null,
        addressLines: [
          custSnap.billingAddressLine1,
          custSnap.billingAddressLine2,
          cityStateZip || null,
          custSnap.billingCountry,
        ].filter((v): v is string => Boolean(v && v.trim().length > 0)),
      };
    } else if (invoice.customer) {
      const cityStateZip = [
        invoice.customer.billingCity,
        invoice.customer.billingState,
        invoice.customer.billingPostalCode,
      ]
        .filter(Boolean)
        .join(", ");
      customerParty = {
        name: invoice.customer.name,
        companyName: invoice.customer.companyName,
        code: invoice.customer.code,
        email: invoice.customer.email,
        phone: invoice.customer.phone,
        taxId: invoice.customer.taxId,
        addressLines: [
          invoice.customer.billingAddressLine1,
          invoice.customer.billingAddressLine2,
          cityStateZip || null,
          invoice.customer.billingCountry,
        ].filter((v): v is string => Boolean(v && v.trim().length > 0)),
      };
    }

    return {
      invoiceNumber: invoice.invoiceNumber,
      orderNumber: invoice.order?.orderNumber ?? null,
      customerPoNumber: invoice.customerPoNumber ?? null,
      paymentTermsDays: invoice.paymentTermsDays,
      status: invoice.status,
      currency: invoice.currency,
      issuedAt: invoice.issuedAt ? invoice.issuedAt.toISOString() : null,
      dueAt: invoice.dueAt ? invoice.dueAt.toISOString() : null,
      paidAt: invoice.paidAt ? invoice.paidAt.toISOString() : null,
      subtotalCents: invoice.subtotalCents,
      discountTotalCents: invoice.discountTotalCents,
      taxCents: invoice.taxCents,
      totalCents: invoice.totalCents,
      paidAmountCents: invoice.paidAmountCents,
      balanceDueCents: invoice.balanceDueCents,
      notes: invoice.notes,
      organization: {
        name: orgSnap?.name ?? "Organization",
        companyName: orgSnap?.companyLegalName ?? orgSnap?.name ?? "Organization",
      },
      customer: customerParty,
      lines: invoice.lines.map((l) => ({
        sku: l.sku,
        description: l.description,
        unitOfMeasure: l.unitOfMeasure,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        discountCents: l.discountCents,
        lineTotalCents: l.lineTotalCents,
      })),
    };
  }

  async listPayments(tenant: AuthenticatedOrganization, query: ListPaymentsQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);

    const records = await this.prismaService.scoped.customerPayment.findMany({
      where: {
        ...(query.orderId ? { orderId: query.orderId } : {}),
        ...(query.salesInvoiceId
          ? { salesInvoiceId: query.salesInvoiceId }
          : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: {
        order: { select: { id: true, orderNumber: true, channel: true } },
        salesInvoice: { select: { id: true, invoiceNumber: true, status: true } },
        customer: {
          select: { id: true, code: true, name: true, companyName: true },
        },
        receipt: { select: { id: true, receiptNumber: true, issuedAt: true } },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
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

  async getPayment(tenant: AuthenticatedOrganization, paymentId: string) {
    this.resolveVerifiedOrganizationId(tenant);
    const payment = await this.prismaService.scoped.customerPayment.findUnique({
      where: { id: paymentId },
      include: {
        order: { select: { id: true, orderNumber: true, channel: true, status: true } },
        salesInvoice: { select: { id: true, invoiceNumber: true, status: true } },
        customer: true,
        receipt: true,
      },
    });
    if (!payment) {
      throw new NotFoundException("Payment was not found.");
    }
    return payment;
  }

  async listReceipts(tenant: AuthenticatedOrganization, query: ListReceiptsQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const records = await this.prismaService.scoped.paymentReceipt.findMany({
      where: {
        ...(query.orderId ? { orderId: query.orderId } : {}),
        ...(query.salesInvoiceId
          ? { salesInvoiceId: query.salesInvoiceId }
          : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(search
          ? {
              OR: [
                { receiptNumber: { contains: search, mode: "insensitive" } },
                {
                  order: {
                    orderNumber: { contains: search, mode: "insensitive" },
                  },
                },
              ],
            }
          : {}),
      },
      include: {
        order: { select: { id: true, orderNumber: true, channel: true } },
        salesInvoice: { select: { id: true, invoiceNumber: true } },
        customer: {
          select: { id: true, code: true, name: true, companyName: true },
        },
        payment: {
          select: {
            id: true,
            paymentNumber: true,
            method: true,
            amountAppliedCents: true,
          },
        },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
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

  async getReceipt(tenant: AuthenticatedOrganization, receiptId: string) {
    this.resolveVerifiedOrganizationId(tenant);
    const receipt = await this.prismaService.scoped.paymentReceipt.findUnique({
      where: { id: receiptId },
      include: {
        payment: true,
        order: { select: { id: true, orderNumber: true, channel: true, status: true } },
        salesInvoice: { select: { id: true, invoiceNumber: true, status: true } },
        customer: true,
      },
    });
    if (!receipt) {
      throw new NotFoundException("Receipt was not found.");
    }
    return receipt;
  }

  async buildReceiptPrintableDocument(
    tenant: AuthenticatedOrganization,
    receiptId: string,
  ): Promise<PrintableReceiptDocument> {
    const receipt = await this.getReceipt(tenant, receiptId);
    const snap = receipt.snapshot as unknown as PrintableReceiptDocument | null;
    if (snap && typeof snap === "object" && snap.receiptNumber) {
      return snap;
    }
    return {
      receiptNumber: receipt.receiptNumber,
      paymentNumber: receipt.payment.paymentNumber,
      orderNumber: receipt.order?.orderNumber ?? receipt.salesInvoice?.invoiceNumber ?? receipt.receiptNumber,
      invoiceNumber: receipt.salesInvoice?.invoiceNumber ?? null,
      channel: receipt.channel,
      paymentMethod: receipt.payment.method,
      currency: receipt.currency,
      issuedAt: receipt.issuedAt.toISOString(),
      subtotalCents: receipt.totalCents,
      discountTotalCents: 0,
      taxCents: 0,
      totalCents: receipt.totalCents,
      amountAppliedCents: receipt.payment.amountAppliedCents,
      cashTenderedCents: receipt.cashTenderedCents,
      changeGivenCents: receipt.changeGivenCents,
      organization: { name: "Organization" },
      customer: receipt.customer
        ? {
            name: receipt.customer.name,
            companyName: receipt.customer.companyName,
            code: receipt.customer.code,
          }
        : null,
      lines: [],
    };
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedOrganization): string {
    const contextOrgId = OrganizationContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active organization context mismatch.");
    }
    return tenant.organizationId;
  }
}

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
  CustomerPoStatus,
  CustomerStatus,
  ItemVariantKind,
  OrderChannel,
  OrderStatus,
  Prisma,
  SalesInvoiceStatus,
  OrganizationContext,
} from "@scace/db";
import { CommunicationOutboxService } from "../communications/communication-outbox.service.js";
import { PrismaService } from "../database/prisma.service.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { CreditControlService } from "./credit-control.service.js";

export interface CustomerPoLineInput {
  itemId: string;
  quantity: number;
  unitPriceCents?: number;
  discountCents?: number;
  description?: string | null;
  unitOfMeasure?: string | null;
}

export interface CreateCustomerPoInput {
  poNumber: string;
  customerId: string;
  internalRef?: string;
  currency?: string;
  paymentTermsDays?: number;
  issueDate?: string | null;
  expiryDate?: string | null;
  notes?: string | null;
  taxCents?: number;
  lines: CustomerPoLineInput[];
  metadata?: Record<string, unknown> | null;
}

export interface UpdateCustomerPoInput {
  poNumber?: string;
  issueDate?: string | null;
  expiryDate?: string | null;
  notes?: string | null;
  taxCents?: number;
  lines?: CustomerPoLineInput[];
  metadata?: Record<string, unknown> | null;
}

export interface ListCustomerPosQuery {
  customerId?: string;
  status?: CustomerPoStatus;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface ConvertPoToOrderInput {
  locationId: string;
  orderNumber?: string;
  notes?: string | null;
}

export interface ConvertPoToInvoiceInput {
  invoiceNumber?: string;
  dueAt?: string | null;
  notes?: string | null;
  status?: "DRAFT" | "ISSUED";
}

function generateDocNumber(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

@Injectable()
export class CustomerPoService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(CreditControlService)
    private readonly creditControlService: CreditControlService,
    @Inject(CommunicationOutboxService)
    private readonly outboxService: CommunicationOutboxService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  async createCustomerPo(
    tenant: AuthenticatedOrganization,
    input: CreateCustomerPoInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    if (!input.lines || input.lines.length === 0) {
      throw new BadRequestException("A Customer PO must have at least one line item.");
    }

    const customer = await this.prismaService.raw.customer.findFirst({
      where: { id: input.customerId, organizationId },
    });
    if (!customer) {
      throw new NotFoundException("Customer was not found.");
    }
    if (customer.status === CustomerStatus.ARCHIVED) {
      throw new BadRequestException("Cannot create a PO for an archived customer.");
    }

    const internalRef =
      input.internalRef?.trim().toUpperCase() || generateDocNumber("CPO");
    const currency = (
      input.currency ||
      customer.currency ||
      "USD"
    ).toUpperCase();
    const paymentTermsDays =
      input.paymentTermsDays !== undefined
        ? input.paymentTermsDays
        : customer.paymentTermsDays;

    const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
    const items = await this.prismaService.raw.item.findMany({
      where: { id: { in: itemIds }, organizationId },
    });
    const itemMap = new Map(items.map((it) => [it.id, it]));

    for (const line of input.lines) {
      const item = itemMap.get(line.itemId);
      if (!item) {
        throw new BadRequestException(`Item "${line.itemId}" does not exist in this organization.`);
      }
      if (item.variantKind === ItemVariantKind.TEMPLATE) {
        throw new BadRequestException(`Item "${item.sku}" is a template item. Select a concrete variant SKU.`);
      }
    }

    let subtotalCents = 0;
    let discountTotalCents = 0;

    const calculatedLines = input.lines.map((l) => {
      const it = itemMap.get(l.itemId)!;
      const unitPriceCents =
        l.unitPriceCents !== undefined ? Math.max(0, l.unitPriceCents) : it.salePriceCents;
      const discountCents = l.discountCents !== undefined ? Math.max(0, l.discountCents) : 0;
      const lineTotalCents = Math.max(0, l.quantity * unitPriceCents - discountCents);

      subtotalCents += l.quantity * unitPriceCents;
      discountTotalCents += discountCents;

      return {
        itemId: it.id,
        sku: it.sku,
        name: it.name,
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

    try {
      const cpo = await this.prismaService.raw.$transaction(async (tx) => {
        const created = await tx.customerPurchaseOrder.create({
          data: {
            organizationId,
            internalRef,
            poNumber: input.poNumber.trim(),
            status: CustomerPoStatus.RECEIVED,
            customerId: customer.id,
            currency,
            paymentTermsDays,
            issueDate: input.issueDate ? new Date(input.issueDate) : new Date(),
            expiryDate: input.expiryDate
              ? new Date(input.expiryDate)
              : null,
            subtotalCents,
            discountTotalCents,
            taxCents,
            totalCents,
            notes: input.notes?.trim() || null,
            metadata: (input.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            lines: {
              create: calculatedLines.map((cl) => ({
                organizationId,
                itemId: cl.itemId,
                sku: cl.sku,
                name: cl.name,
                description: cl.description,
                unitOfMeasure: cl.unitOfMeasure,
                quantity: cl.quantity,
                unitPriceCents: cl.unitPriceCents,
                discountCents: cl.discountCents,
                lineTotalCents: cl.lineTotalCents,
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
            action: "customer_po.created",
            resourceType: "CustomerPurchaseOrder",
            resourceId: created.id,
            metadata: {
              internalRef: created.internalRef,
              poNumber: created.poNumber,
              customerId: customer.id,
              totalCents: created.totalCents,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return created;
      });

      this.analyticsService.captureDomainEvent({
        event: "customer_po.created",
        distinctId: tenant.userId,
        organizationId,
        properties: {
          cpo_id: cpo.id,
          internal_ref: cpo.internalRef,
          po_number: cpo.poNumber,
          customer_id: cpo.customerId,
          total_cents: cpo.totalCents,
          line_count: cpo.lines.length,
        },
      });

      return cpo;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `Customer PO with internal reference "${internalRef}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async listCustomerPos(tenant: AuthenticatedOrganization, query: ListCustomerPosQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const records = await this.prismaService.scoped.customerPurchaseOrder.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(search
          ? {
              OR: [
                { internalRef: { contains: search, mode: "insensitive" } },
                { poNumber: { contains: search, mode: "insensitive" } },
                { customer: { name: { contains: search, mode: "insensitive" } } },
                { customer: { companyName: { contains: search, mode: "insensitive" } } },
              ],
            }
          : {}),
      },
      include: {
        customer: {
          select: {
            id: true,
            code: true,
            name: true,
            companyName: true,
            creditHold: true,
            creditLimitCents: true,
            paymentTermsDays: true,
          },
        },
        _count: {
          select: { lines: true, orders: true, invoices: true },
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

  async getCustomerPo(tenant: AuthenticatedOrganization, poId: string) {
    this.resolveVerifiedOrganizationId(tenant);
    const po = await this.prismaService.scoped.customerPurchaseOrder.findUnique({
      where: { id: poId },
      include: {
        customer: true,
        lines: {
          include: {
            item: {
              select: {
                id: true,
                sku: true,
                name: true,
                unitOfMeasure: true,
                trackInventory: true,
              },
            },
          },
        },
        orders: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            totalCents: true,
            paidAmountCents: true,
            createdAt: true,
          },
        },
        invoices: {
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            totalCents: true,
            paidAmountCents: true,
            issuedAt: true,
            dueAt: true,
          },
        },
      },
    });

    if (!po) {
      throw new NotFoundException("Customer Purchase Order was not found.");
    }

    return po;
  }

  async confirmCustomerPo(
    tenant: AuthenticatedOrganization,
    poId: string,
    options?: { allowOverrideCredit?: boolean },
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const po = await this.prismaService.raw.customerPurchaseOrder.findFirst({
      where: { id: poId, organizationId },
      include: { customer: true, lines: true },
    });
    if (!po) {
      throw new NotFoundException("Customer Purchase Order was not found.");
    }
    if (po.status !== CustomerPoStatus.RECEIVED) {
      throw new BadRequestException(
        `Only RECEIVED Customer POs can be confirmed (current status: ${po.status}).`,
      );
    }

    // Run Credit Limit & Credit Hold Risk Check
    const creditEval = await this.creditControlService.assertCreditAllowed(
      organizationId,
      po.customerId,
      po.totalCents,
      {
        allowOverride: options?.allowOverrideCredit,
        actorRole: tenant.role,
      },
    );

    const now = new Date();
    const confirmed = await this.prismaService.raw.$transaction(async (tx) => {
      const updated = await tx.customerPurchaseOrder.update({
        where: { id: po.id },
        data: {
          status: CustomerPoStatus.CONFIRMED,
          confirmedAt: now,
          confirmedByUserId: tenant.userId,
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
          action: "customer_po.confirmed",
          resourceType: "CustomerPurchaseOrder",
          resourceId: po.id,
          metadata: {
            internalRef: po.internalRef,
            poNumber: po.poNumber,
            totalCents: po.totalCents,
            creditEvaluated: {
              creditLimitCents: creditEval.creditLimitCents,
              currentExposureCents: creditEval.totalCurrentExposureCents,
              projectedExposureCents: creditEval.projectedExposureCents,
            },
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });

    // Queue Outbox notification for Customer PO Confirmation
    if (po.customer.email) {
      await this.outboxService.emitEvent(null, {
        organizationId,
        eventType: CommunicationEventType.CUSTOMER_PO_CONFIRMED,
        targetEmails: [po.customer.email],
        channelHints: [CommunicationChannel.EMAIL],
        subject: `Order Confirmation: Purchase Order ${po.poNumber} (${po.internalRef})`,
        summaryText: `Your Purchase Order ${po.poNumber} has been received and confirmed. Total: ${po.currency} ${(po.totalCents / 100).toFixed(2)}.`,
        sourceEntityType: "CustomerPurchaseOrder",
        sourceEntityId: po.id,
        payload: {
          cpoId: po.id,
          internalRef: po.internalRef,
          poNumber: po.poNumber,
          customerId: po.customerId,
          customerName: po.customer.name,
          currency: po.currency,
          totalCents: po.totalCents,
          lineCount: po.lines.length,
          confirmedAt: now.toISOString(),
        },
      });
    }

    this.analyticsService.captureDomainEvent({
      event: "customer_po.confirmed",
      distinctId: tenant.userId,
      organizationId,
      properties: {
        cpo_id: confirmed.id,
        internal_ref: confirmed.internalRef,
        po_number: confirmed.poNumber,
        total_cents: confirmed.totalCents,
      },
    });

    return confirmed;
  }

  async cancelCustomerPo(
    tenant: AuthenticatedOrganization,
    poId: string,
    reason?: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const po = await this.prismaService.raw.customerPurchaseOrder.findFirst({
      where: { id: poId, organizationId },
    });
    if (!po) {
      throw new NotFoundException("Customer Purchase Order was not found.");
    }
    if (
      po.status === CustomerPoStatus.CANCELLED ||
      po.status === CustomerPoStatus.COMPLETED
    ) {
      throw new BadRequestException(
        `Cannot cancel Customer PO in status ${po.status}.`,
      );
    }
    if (po.invoicedAmountCents > 0) {
      throw new BadRequestException(
        "Cannot cancel a Customer PO with active billed invoices.",
      );
    }

    const cancelled = await this.prismaService.raw.$transaction(async (tx) => {
      const updated = await tx.customerPurchaseOrder.update({
        where: { id: po.id },
        data: {
          status: CustomerPoStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledByUserId: tenant.userId,
          cancelReason: reason ?? null,
        },
        include: { customer: true, lines: true },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "customer_po.cancelled",
          resourceType: "CustomerPurchaseOrder",
          resourceId: po.id,
          metadata: {
            internalRef: po.internalRef,
            poNumber: po.poNumber,
            reason: reason ?? null,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });

    return cancelled;
  }

  async convertToOrder(
    tenant: AuthenticatedOrganization,
    poId: string,
    input: ConvertPoToOrderInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const po = await this.prismaService.raw.customerPurchaseOrder.findFirst({
      where: { id: poId, organizationId },
      include: { customer: true, lines: true },
    });
    if (!po) {
      throw new NotFoundException("Customer Purchase Order was not found.");
    }
    if (
      po.status !== CustomerPoStatus.RECEIVED &&
      po.status !== CustomerPoStatus.CONFIRMED &&
      po.status !== CustomerPoStatus.PARTIALLY_INVOICED
    ) {
      throw new BadRequestException(
        `Cannot convert PO to order in status ${po.status}.`,
      );
    }

    const location = await this.prismaService.raw.location.findFirst({
      where: { id: input.locationId, organizationId },
    });
    if (!location) {
      throw new NotFoundException("Location was not found.");
    }

    for (const line of po.lines) {
      if (!line.itemId || !line.sku) {
        throw new BadRequestException(
          `PO line "${line.name}" is missing a catalog item reference and cannot be converted into an Order.`,
        );
      }
    }

    const orderNumber =
      input.orderNumber?.trim().toUpperCase() || generateDocNumber("B2B");

    const order = await this.prismaService.raw.$transaction(async (tx) => {
      const createdOrder = await tx.order.create({
        data: {
          organizationId,
          orderNumber,
          channel: OrderChannel.B2B,
          status: OrderStatus.DRAFT,
          locationId: location.id,
          customerId: po.customerId,
          customerPurchaseOrderId: po.id,
          customerPoNumber: po.poNumber,
          currency: po.currency,
          subtotalCents: po.subtotalCents,
          discountTotalCents: po.discountTotalCents,
          taxCents: po.taxCents,
          totalCents: po.totalCents,
          paidAmountCents: 0,
          notes: input.notes?.trim() || po.notes,
          createdByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
          lines: {
            create: po.lines.map((l) => ({
              organizationId,
              itemId: l.itemId!,
              sku: l.sku!,
              name: l.name,
              description: l.description || l.name,
              unitOfMeasure: l.unitOfMeasure,
              quantity: l.quantity,
              fulfilledQty: 0,
              orderedBaseQty: l.quantity,
              reservedBaseQty: 0,
              fulfilledBaseQty: 0,
              unitPriceCents: l.unitPriceCents,
              discountCents: l.discountCents,
              lineTotalCents: l.lineTotalCents,
            })),
          },
        },
        include: {
          customer: true,
          lines: true,
          location: true,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "customer_po.converted_to_order",
          resourceType: "Order",
          resourceId: createdOrder.id,
          metadata: {
            orderNumber: createdOrder.orderNumber,
            internalRef: po.internalRef,
            poNumber: po.poNumber,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return createdOrder;
    });

    return order;
  }

  async convertToInvoice(
    tenant: AuthenticatedOrganization,
    poId: string,
    input: ConvertPoToInvoiceInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const po = await this.prismaService.raw.customerPurchaseOrder.findFirst({
      where: { id: poId, organizationId },
      include: {
        customer: true,
        lines: true,
      },
    });
    if (!po) {
      throw new NotFoundException("Customer Purchase Order was not found.");
    }
    if (
      po.status === CustomerPoStatus.CANCELLED ||
      po.status === CustomerPoStatus.REJECTED ||
      po.status === CustomerPoStatus.COMPLETED
    ) {
      throw new BadRequestException(
        `Cannot invoice Customer PO in status ${po.status}.`,
      );
    }

    const targetStatus =
      input.status === "DRAFT"
        ? SalesInvoiceStatus.DRAFT
        : SalesInvoiceStatus.ISSUED;

    // If issuing right away, assert credit limits
    if (targetStatus === SalesInvoiceStatus.ISSUED) {
      await this.creditControlService.assertCreditAllowed(
        organizationId,
        po.customerId,
        po.totalCents,
        { actorRole: tenant.role },
      );
    }

    const [org, settings] = await Promise.all([
      this.prismaService.raw.organization.findUnique({
        where: { id: organizationId },
        select: { id: true, name: true },
      }),
      this.prismaService.raw.organizationSettings.findUnique({
        where: { organizationId },
        select: { companyLegalName: true },
      }),
    ]);

    const invoiceNumber =
      input.invoiceNumber?.trim().toUpperCase() || generateDocNumber("INV");
    const now = new Date();
    const paymentTermsDays = po.paymentTermsDays ?? 30;
    const dueAt = input.dueAt
      ? new Date(input.dueAt)
      : new Date(now.getTime() + paymentTermsDays * 86_400_000);

    const invoice = await this.prismaService.raw.$transaction(async (tx) => {
      const createdInvoice = await tx.salesInvoice.create({
        data: {
          organizationId,
          invoiceNumber,
          customerId: po.customerId,
          customerPurchaseOrderId: po.id,
          customerPoNumber: po.poNumber,
          paymentTermsDays,
          status: targetStatus,
          currency: po.currency,
          subtotalCents: po.subtotalCents,
          discountTotalCents: po.discountTotalCents,
          taxCents: po.taxCents,
          totalCents: po.totalCents,
          paidAmountCents: 0,
          issuedAt: targetStatus === SalesInvoiceStatus.ISSUED ? now : null,
          dueAt,
          notes: input.notes?.trim() || po.notes,
          customerSnapshot: po.customer
            ? ({
                id: po.customer.id,
                code: po.customer.code,
                type: po.customer.type,
                name: po.customer.name,
                companyName: po.customer.companyName,
                email: po.customer.email,
                phone: po.customer.phone,
                taxId: po.customer.taxId,
                billingAddressLine1: po.customer.billingAddressLine1,
                billingAddressLine2: po.customer.billingAddressLine2,
                billingCity: po.customer.billingCity,
                billingState: po.customer.billingState,
                billingPostalCode: po.customer.billingPostalCode,
                billingCountry: po.customer.billingCountry,
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
            create: po.lines.map((l) => ({
              organizationId,
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
          customer: true,
          customerPurchaseOrder: true,
          lines: true,
        },
      });

      // Update PO invoiced amount and status
      const nextInvoicedTotal = po.invoicedAmountCents + po.totalCents;
      const nextPoStatus =
        nextInvoicedTotal >= po.totalCents
          ? CustomerPoStatus.INVOICED
          : CustomerPoStatus.PARTIALLY_INVOICED;

      await tx.customerPurchaseOrder.update({
        where: { id: po.id },
        data: {
          invoicedAmountCents: nextInvoicedTotal,
          status: nextPoStatus,
        },
      });

      for (const poLine of po.lines) {
        await tx.customerPurchaseOrderLine.update({
          where: { id: poLine.id },
          data: { invoicedQuantity: poLine.quantity },
        });
      }

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "customer_po.converted_to_invoice",
          resourceType: "SalesInvoice",
          resourceId: createdInvoice.id,
          metadata: {
            invoiceNumber: createdInvoice.invoiceNumber,
            internalRef: po.internalRef,
            poNumber: po.poNumber,
            status: createdInvoice.status,
            totalCents: createdInvoice.totalCents,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        ...createdInvoice,
        balanceDueCents: createdInvoice.totalCents,
      };
    });

    if (targetStatus === SalesInvoiceStatus.ISSUED && po.customer.email) {
      await this.outboxService.emitEvent(null, {
        organizationId,
        eventType: CommunicationEventType.INVOICE_ISSUED,
        targetEmails: [po.customer.email],
        channelHints: [CommunicationChannel.EMAIL],
        subject: `Invoice ${invoice.invoiceNumber} for PO ${po.poNumber}`,
        summaryText: `An invoice has been issued for Purchase Order ${po.poNumber}. Total Due: ${po.currency} ${(invoice.totalCents / 100).toFixed(2)}, due on ${dueAt.toISOString().slice(0, 10)}.`,
        sourceEntityType: "SalesInvoice",
        sourceEntityId: invoice.id,
        payload: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          poNumber: po.poNumber,
          internalRef: po.internalRef,
          customerId: po.customerId,
          totalCents: invoice.totalCents,
          dueAt: dueAt.toISOString(),
        },
      });
    }

    return invoice;
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedOrganization): string {
    const contextOrgId = OrganizationContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active organization context mismatch.");
    }
    return tenant.organizationId;
  }
}

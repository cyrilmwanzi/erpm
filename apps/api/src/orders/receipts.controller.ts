import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Res,
} from "@nestjs/common";
import { CustomerPaymentStatus } from "@scace/db";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import {
  renderReceiptHtml,
  renderReceiptPdf,
} from "./document-renderer.utils.js";
import { InvoicesPaymentsService } from "./invoices-payments.service.js";

const listPaymentsQuerySchema = z.object({
  orderId: z.string().trim().min(1).optional(),
  salesInvoiceId: z.string().trim().min(1).optional(),
  customerId: z.string().trim().min(1).optional(),
  status: z
    .enum([CustomerPaymentStatus.COMPLETED, CustomerPaymentStatus.VOIDED])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const listReceiptsQuerySchema = z.object({
  orderId: z.string().trim().min(1).optional(),
  salesInvoiceId: z.string().trim().min(1).optional(),
  customerId: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

function sanitizeFilenameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "receipt";
}

@Controller("api/v1")
@RequireActiveOrganization()
export class ReceiptsController {
  constructor(
    @Inject(InvoicesPaymentsService)
    private readonly invoicesPaymentsService: InvoicesPaymentsService,
  ) {}

  @Get("payments")
  @RequiredOrgPermissions({ payment: ["read"] })
  async listPayments(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listPaymentsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid payment query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.invoicesPaymentsService.listPayments(tenant, parsed.data);
  }

  @Get("payments/:paymentId")
  @RequiredOrgPermissions({ payment: ["read"] })
  async getPayment(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("paymentId") paymentId: string,
  ) {
    return this.invoicesPaymentsService.getPayment(tenant, paymentId);
  }

  @Get("receipts")
  @RequiredOrgPermissions({ receipt: ["read"] })
  async listReceipts(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listReceiptsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid receipt query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.invoicesPaymentsService.listReceipts(tenant, parsed.data);
  }

  @Get("receipts/:receiptId")
  @RequiredOrgPermissions({ receipt: ["read"] })
  async getReceipt(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("receiptId") receiptId: string,
  ) {
    return this.invoicesPaymentsService.getReceipt(tenant, receiptId);
  }

  @Get("receipts/:receiptId/html")
  @RequiredOrgPermissions({ receipt: ["read"] })
  async getReceiptHtml(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("receiptId") receiptId: string,
    @Res() reply: FastifyReply,
  ) {
    const doc = await this.invoicesPaymentsService.buildReceiptPrintableDocument(
      tenant,
      receiptId,
    );
    const html = renderReceiptHtml(doc);
    return reply
      .header("Content-Type", "text/html; charset=utf-8")
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'",
      )
      .send(html);
  }

  @Get("receipts/:receiptId/pdf")
  @RequiredOrgPermissions({ receipt: ["read"] })
  async getReceiptPdf(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("receiptId") receiptId: string,
    @Res() reply: FastifyReply,
  ) {
    const doc = await this.invoicesPaymentsService.buildReceiptPrintableDocument(
      tenant,
      receiptId,
    );
    const pdfBuffer = renderReceiptPdf(doc);
    const safeName = sanitizeFilenameSegment(doc.receiptNumber);
    return reply
      .header("Content-Type", "application/pdf")
      .header(
        "Content-Disposition",
        `attachment; filename="receipt-${safeName}.pdf"`,
      )
      .header("X-Content-Type-Options", "nosniff")
      .send(pdfBuffer);
  }
}

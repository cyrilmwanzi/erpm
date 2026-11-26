import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  AlertSeverity,
  CommunicationChannel,
  CommunicationEventType,
  PaymentProvider,
  PaymentTransactionStatus,
  Prisma,
  ReportDomain,
  ReportFormat,
  ReportFrequency,
  ReportRunStatus,
  StorageEntityType,
  TenantContext,
} from "@scace/db";
import { CommunicationOutboxService } from "../communications/communication-outbox.service.js";
import { getEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import {
  classifyLotExpiry,
  resolveEffectiveExpiryPolicyTx,
} from "../locations/lot-allocation.utils.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import { RedisService } from "../redis/redis.service.js";
import { StorageService } from "../storage/storage.service.js";
import type { AuthenticatedTenant } from "../tenancy/tenant.decorators.js";
import {
  computeNextRunAt,
  type GeneratedReportResult,
  renderReportCsv,
  renderReportPdf,
  sanitizeReportFilename,
} from "./reports-export.utils.js";

export interface ReportFiltersInput {
  from?: string;
  to?: string;
  locationId?: string;
  itemId?: string;
  supplierId?: string;
  channel?: string;
  status?: string;
  limit?: number;
}

export interface DispatchReportInput {
  domain: ReportDomain;
  format: ReportFormat;
  filters?: ReportFiltersInput;
  recipientEmails?: string[];
  channelHints?: CommunicationChannel[];
  subject?: string;
}

export interface CreateReportScheduleInput {
  name: string;
  domain: ReportDomain;
  format?: ReportFormat;
  frequency?: ReportFrequency;
  cronHourUtc?: number;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  filters?: ReportFiltersInput | null;
  recipientEmails?: string[];
  channelHints?: CommunicationChannel[];
  isActive?: boolean;
}

export interface UpdateReportScheduleInput {
  name?: string;
  format?: ReportFormat;
  frequency?: ReportFrequency;
  cronHourUtc?: number;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  filters?: ReportFiltersInput | null;
  recipientEmails?: string[];
  channelHints?: CommunicationChannel[];
  isActive?: boolean;
}

function parseDateFilter(
  raw: string | undefined,
  label: string,
): Date | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`Invalid ISO date for "${label}".`);
  }
  return parsed;
}

function formatMoneyAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

@Injectable()
export class ReportsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportsService.name);
  private schedulerInterval: ReturnType<typeof setInterval> | null = null;
  private isTickRunning = false;

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redisService: RedisService,
    @Inject(StorageService) private readonly storageService: StorageService,
    @Inject(CommunicationOutboxService)
    private readonly outboxService: CommunicationOutboxService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  onModuleInit(): void {
    const env = getEnv();
    const enabled =
      env.NODE_ENV !== "test" && env.REPORT_SCHEDULER_ENABLED !== false;
    if (!enabled) {
      return;
    }

    this.schedulerInterval = setInterval(() => {
      void this.runScheduledReportsTick();
    }, 60_000);
    if (typeof this.schedulerInterval.unref === "function") {
      this.schedulerInterval.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
  }

  private async runScheduledReportsTick(): Promise<void> {
    if (this.isTickRunning) {
      return;
    }
    this.isTickRunning = true;
    const lockKey = "reports:scheduler:tick-lock";
    try {
      await this.redisService.ensureConnected();
      const acquired = await this.redisService.client.set(
        lockKey,
        randomUUID(),
        "EX",
        55,
        "NX",
      );
      if (acquired !== "OK") {
        return;
      }

      const now = new Date();
      const dueSchedules = await this.prismaService.raw.reportSchedule.findMany({
        where: {
          isActive: true,
          nextRunAt: { lte: now },
        },
        orderBy: { nextRunAt: "asc" },
        take: 20,
      });

      for (const schedule of dueSchedules) {
        try {
          await this.executeScheduleInternal(schedule, "SCHEDULED");
        } catch (err) {
          this.logger.warn(
            `Scheduled report ${schedule.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Report scheduler tick skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.isTickRunning = false;
    }
  }

  // ==========================================
  // Domain Report Generators
  // ==========================================

  async generateReport(
    organizationId: string,
    domain: ReportDomain,
    filters: ReportFiltersInput = {},
  ): Promise<GeneratedReportResult> {
    const org = await this.prismaService.raw.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true },
    });
    const orgName = org?.name ?? organizationId;

    switch (domain) {
      case ReportDomain.INVENTORY_EXPIRY:
        return this.buildInventoryExpiryReport(organizationId, orgName, filters);
      case ReportDomain.SALES_MPESA:
        return this.buildSalesMpesaReport(organizationId, orgName, filters);
      case ReportDomain.PROCUREMENT_CLAIMS:
        return this.buildProcurementClaimsReport(
          organizationId,
          orgName,
          filters,
        );
      case ReportDomain.PRODUCTION_COSTING:
        return this.buildProductionCostingReport(
          organizationId,
          orgName,
          filters,
        );
      default:
        throw new BadRequestException(`Unsupported report domain "${domain}".`);
    }
  }

  async queryDomainReport(
    tenant: AuthenticatedTenant,
    domain: ReportDomain,
    filters: ReportFiltersInput,
  ): Promise<GeneratedReportResult> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    return this.generateReport(organizationId, domain, filters);
  }

  async exportReport(
    tenant: AuthenticatedTenant,
    domain: ReportDomain,
    format: ReportFormat,
    filters: ReportFiltersInput,
    ipAddress?: string,
  ): Promise<{
    contentType: string;
    filename: string;
    body: Buffer | string;
    report: GeneratedReportResult;
  }> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const report = await this.generateReport(organizationId, domain, filters);
    const filename = sanitizeReportFilename(domain, format);

    await this.prismaService.raw.auditLog.create({
      data: {
        organizationId,
        actorUserId: tenant.userId,
        action: "report.exported",
        resourceType: "ReportDomain",
        resourceId: domain,
        metadata: {
          domain,
          format,
          rowCount: report.rows.length,
          filters,
        } as unknown as Prisma.InputJsonValue,
        ipAddress: ipAddress ?? null,
      },
    });

    if (format === ReportFormat.CSV) {
      return {
        contentType: "text/csv; charset=utf-8",
        filename,
        body: renderReportCsv(report),
        report,
      };
    }

    if (format === ReportFormat.PDF) {
      return {
        contentType: "application/pdf",
        filename,
        body: renderReportPdf(report),
        report,
      };
    }

    return {
      contentType: "application/json; charset=utf-8",
      filename,
      body: JSON.stringify(report, null, 2),
      report,
    };
  }

  private async buildInventoryExpiryReport(
    organizationId: string,
    organizationName: string,
    filters: ReportFiltersInput,
  ): Promise<GeneratedReportResult> {
    const now = new Date();
    const fromDate = parseDateFilter(filters.from, "from");
    const toDate = parseDateFilter(filters.to, "to");
    const takeLimit = Math.min(Math.max(filters.limit ?? 250, 1), 1000);

    const [policy, balances, lots, writeOffs] = await Promise.all([
      this.prismaService.raw.$transaction((tx) =>
        resolveEffectiveExpiryPolicyTx(tx, organizationId),
      ),
      this.prismaService.raw.stockBalance.findMany({
        where: {
          organizationId,
          ...(filters.locationId ? { locationId: filters.locationId } : {}),
          ...(filters.itemId ? { itemId: filters.itemId } : {}),
        },
        include: {
          item: {
            select: {
              id: true,
              sku: true,
              name: true,
              costPriceCents: true,
              currency: true,
            },
          },
          location: { select: { id: true, code: true, name: true } },
        },
      }),
      this.prismaService.raw.stockLot.findMany({
        where: {
          organizationId,
          ...(filters.locationId ? { locationId: filters.locationId } : {}),
          ...(filters.itemId ? { itemId: filters.itemId } : {}),
          OR: [{ onHandQty: { gt: 0 } }, { quarantinedQty: { gt: 0 } }],
        },
        include: {
          item: {
            select: {
              id: true,
              sku: true,
              name: true,
              costPriceCents: true,
              expiryWarningDays: true,
              expiryCriticalDays: true,
            },
          },
          location: { select: { id: true, code: true, name: true } },
        },
        orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
        take: takeLimit,
      }),
      this.prismaService.raw.stockExpiryWriteOff.findMany({
        where: {
          organizationId,
          ...(filters.locationId ? { locationId: filters.locationId } : {}),
          ...(filters.itemId ? { itemId: filters.itemId } : {}),
          ...(fromDate || toDate
            ? {
                writtenOffAt: {
                  ...(fromDate ? { gte: fromDate } : {}),
                  ...(toDate ? { lte: toDate } : {}),
                },
              }
            : {}),
        },
        select: { quantity: true, totalLossCents: true },
      }),
    ]);

    let totalInventoryUnits = 0;
    let totalReservedUnits = 0;
    let totalValuationCents = 0;
    for (const b of balances) {
      totalInventoryUnits += b.onHandQty;
      totalReservedUnits += b.reservedQty;
      totalValuationCents += b.onHandQty * (b.item.costPriceCents ?? 0);
    }

    let expiredValueCents = 0;
    let criticalValueCents = 0;
    let warningValueCents = 0;
    let expiredQty = 0;
    let criticalQty = 0;
    let warningQty = 0;

    const rows = lots.map((lot) => {
      const warnDays = lot.item.expiryWarningDays ?? policy.warningDays;
      const critDays = lot.item.expiryCriticalDays ?? policy.criticalDays;
      const { bucket, daysUntilExpiry } = classifyLotExpiry(
        lot.expiresAt,
        now,
        warnDays,
        critDays,
      );
      const unitCostCents = lot.unitCostCents || lot.item.costPriceCents || 0;
      const totalQty = lot.onHandQty + lot.quarantinedQty;
      const valuationCents = totalQty * unitCostCents;

      if (bucket === "EXPIRED") {
        expiredValueCents += valuationCents;
        expiredQty += totalQty;
      } else if (bucket === "CRITICAL") {
        criticalValueCents += valuationCents;
        criticalQty += totalQty;
      } else if (bucket === "WARNING") {
        warningValueCents += valuationCents;
        warningQty += totalQty;
      }

      return {
        lotNumber: lot.lotNumber,
        sku: lot.item.sku,
        itemName: lot.item.name,
        locationCode: lot.location.code,
        bucket,
        expiresAt: lot.expiresAt ? lot.expiresAt.toISOString().slice(0, 10) : "N/A",
        daysUntilExpiry: daysUntilExpiry ?? "",
        onHandQty: lot.onHandQty,
        quarantinedQty: lot.quarantinedQty,
        unitCost: formatMoneyAmount(unitCostCents),
        valuation: formatMoneyAmount(valuationCents),
      };
    });

    const totalWriteOffQty = writeOffs.reduce((s, w) => s + w.quantity, 0);
    const totalWriteOffLossCents = writeOffs.reduce(
      (s, w) => s + w.totalLossCents,
      0,
    );

    return {
      organizationId,
      organizationName,
      domain: ReportDomain.INVENTORY_EXPIRY,
      title: "Inventory Valuation & Stock Expiry Report",
      generatedAt: now.toISOString(),
      filters: filters as Record<string, unknown>,
      summaryKpis: {
        totalOnHandUnits: totalInventoryUnits,
        totalReservedUnits,
        totalValuation: formatMoneyAmount(totalValuationCents),
        activeLots: lots.length,
        expiredQty,
        expiredValue: formatMoneyAmount(expiredValueCents),
        criticalQty,
        criticalValue: formatMoneyAmount(criticalValueCents),
        warningQty,
        warningValue: formatMoneyAmount(warningValueCents),
        writeOffQty: totalWriteOffQty,
        writeOffLoss: formatMoneyAmount(totalWriteOffLossCents),
      },
      columns: [
        { key: "lotNumber", label: "Lot #", widthChars: 18 },
        { key: "sku", label: "SKU", widthChars: 14 },
        { key: "itemName", label: "Item", widthChars: 22 },
        { key: "locationCode", label: "Location", widthChars: 10 },
        { key: "bucket", label: "Status", widthChars: 10 },
        { key: "expiresAt", label: "Expires", widthChars: 12 },
        { key: "daysUntilExpiry", label: "Days", align: "right", widthChars: 8 },
        { key: "onHandQty", label: "On Hand", align: "right", widthChars: 9 },
        { key: "quarantinedQty", label: "Quar.", align: "right", widthChars: 8 },
        { key: "valuation", label: "Value", align: "right", widthChars: 12 },
      ],
      rows,
    };
  }

  private async buildSalesMpesaReport(
    organizationId: string,
    organizationName: string,
    filters: ReportFiltersInput,
  ): Promise<GeneratedReportResult> {
    const now = new Date();
    const fromDate = parseDateFilter(filters.from, "from");
    const toDate = parseDateFilter(filters.to, "to");
    const takeLimit = Math.min(Math.max(filters.limit ?? 250, 1), 1000);

    const dateRange =
      fromDate || toDate
        ? {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          }
        : undefined;

    const [orders, invoices, mpesaTxs] = await Promise.all([
      this.prismaService.raw.order.findMany({
        where: {
          organizationId,
          ...(filters.locationId ? { locationId: filters.locationId } : {}),
          ...(filters.status ? { status: filters.status as never } : {}),
          ...(filters.channel ? { channel: filters.channel as never } : {}),
          ...(dateRange ? { createdAt: dateRange } : {}),
        },
        include: {
          location: { select: { code: true, name: true } },
          customer: { select: { name: true, code: true } },
        },
        orderBy: { createdAt: "desc" },
        take: takeLimit,
      }),
      this.prismaService.raw.salesInvoice.findMany({
        where: {
          organizationId,
          ...(dateRange ? { createdAt: dateRange } : {}),
        },
        select: {
          status: true,
          totalCents: true,
          paidAmountCents: true,
        },
      }),
      this.prismaService.raw.paymentTransaction.findMany({
        where: {
          organizationId,
          provider: PaymentProvider.MPESA,
          ...(dateRange ? { createdAt: dateRange } : {}),
        },
        select: {
          status: true,
          flow: true,
          amountCents: true,
          mpesaReceiptNumber: true,
        },
      }),
    ]);

    let grossSalesCents = 0;
    let paidOrdersCents = 0;
    for (const o of orders) {
      grossSalesCents += o.totalCents;
      paidOrdersCents += o.paidAmountCents;
    }

    let invoiceTotalCents = 0;
    let invoicePaidCents = 0;
    let invoiceOutstandingCents = 0;
    for (const inv of invoices) {
      invoiceTotalCents += inv.totalCents;
      invoicePaidCents += inv.paidAmountCents;
      if (inv.status !== "VOID") {
        invoiceOutstandingCents += Math.max(0, inv.totalCents - inv.paidAmountCents);
      }
    }

    let mpesaSucceededCount = 0;
    let mpesaSucceededCents = 0;
    let mpesaFailedCount = 0;
    let mpesaPendingCount = 0;
    let mpesaUnmatchedC2bCount = 0;

    for (const tx of mpesaTxs) {
      if (tx.status === PaymentTransactionStatus.SUCCEEDED) {
        mpesaSucceededCount += 1;
        mpesaSucceededCents += tx.amountCents;
      } else if (tx.status === PaymentTransactionStatus.FAILED) {
        mpesaFailedCount += 1;
      } else if (tx.status === PaymentTransactionStatus.PENDING) {
        mpesaPendingCount += 1;
      } else if (tx.status === PaymentTransactionStatus.UNMATCHED_C2B) {
        mpesaUnmatchedC2bCount += 1;
      }
    }

    const rows = orders.map((o) => ({
      orderNumber: o.orderNumber,
      channel: o.channel,
      status: o.status,
      locationCode: o.location.code,
      customer: o.customer?.name ?? "Walk-in",
      currency: o.currency,
      total: formatMoneyAmount(o.totalCents),
      paid: formatMoneyAmount(o.paidAmountCents),
      balanceDue: formatMoneyAmount(Math.max(0, o.totalCents - o.paidAmountCents)),
      createdAt: o.createdAt.toISOString().slice(0, 10),
    }));

    return {
      organizationId,
      organizationName,
      domain: ReportDomain.SALES_MPESA,
      title: "Sales Orders, Invoices & M-Pesa Payments Report",
      generatedAt: now.toISOString(),
      filters: filters as Record<string, unknown>,
      summaryKpis: {
        orderCount: orders.length,
        grossSales: formatMoneyAmount(grossSalesCents),
        ordersPaid: formatMoneyAmount(paidOrdersCents),
        invoiceCount: invoices.length,
        invoiceTotal: formatMoneyAmount(invoiceTotalCents),
        invoicePaid: formatMoneyAmount(invoicePaidCents),
        invoiceOutstanding: formatMoneyAmount(invoiceOutstandingCents),
        mpesaTxCount: mpesaTxs.length,
        mpesaSucceededCount,
        mpesaSettledAmount: formatMoneyAmount(mpesaSucceededCents),
        mpesaPendingCount,
        mpesaFailedCount,
        mpesaUnmatchedC2bCount,
      },
      columns: [
        { key: "orderNumber", label: "Order #", widthChars: 16 },
        { key: "channel", label: "Channel", widthChars: 10 },
        { key: "status", label: "Status", widthChars: 12 },
        { key: "locationCode", label: "Loc", widthChars: 8 },
        { key: "customer", label: "Customer", widthChars: 20 },
        { key: "total", label: "Total", align: "right", widthChars: 12 },
        { key: "paid", label: "Paid", align: "right", widthChars: 12 },
        { key: "balanceDue", label: "Due", align: "right", widthChars: 12 },
        { key: "createdAt", label: "Date", widthChars: 12 },
      ],
      rows,
    };
  }

  private async buildProcurementClaimsReport(
    organizationId: string,
    organizationName: string,
    filters: ReportFiltersInput,
  ): Promise<GeneratedReportResult> {
    const now = new Date();
    const fromDate = parseDateFilter(filters.from, "from");
    const toDate = parseDateFilter(filters.to, "to");
    const takeLimit = Math.min(Math.max(filters.limit ?? 250, 1), 1000);

    const dateRange =
      fromDate || toDate
        ? {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          }
        : undefined;

    const [purchaseOrders, vendorBills, supplierClaims] = await Promise.all([
      this.prismaService.raw.purchaseOrder.findMany({
        where: {
          organizationId,
          ...(filters.locationId ? { locationId: filters.locationId } : {}),
          ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
          ...(dateRange ? { createdAt: dateRange } : {}),
        },
        include: {
          supplier: { select: { code: true, name: true } },
          location: { select: { code: true } },
        },
        orderBy: { createdAt: "desc" },
        take: takeLimit,
      }),
      this.prismaService.raw.vendorBill.findMany({
        where: {
          organizationId,
          ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
          ...(dateRange ? { issuedAt: dateRange } : {}),
        },
        select: {
          status: true,
          totalCents: true,
          paidAmountCents: true,
        },
      }),
      this.prismaService.raw.supplierClaim.findMany({
        where: {
          organizationId,
          ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
          ...(filters.itemId ? { itemId: filters.itemId } : {}),
          ...(dateRange ? { createdAt: dateRange } : {}),
        },
        select: {
          claimType: true,
          status: true,
          rejectedBaseQty: true,
          claimAmountCents: true,
        },
      }),
    ]);

    let poTotalCents = 0;
    for (const po of purchaseOrders) {
      poTotalCents += po.totalCents;
    }

    let billTotalCents = 0;
    let billPaidCents = 0;
    let billPayableCents = 0;
    for (const bill of vendorBills) {
      billTotalCents += bill.totalCents;
      billPaidCents += bill.paidAmountCents;
      if (bill.status !== "VOID") {
        billPayableCents += Math.max(0, bill.totalCents - bill.paidAmountCents);
      }
    }

    let claimAmountCents = 0;
    let openClaimAmountCents = 0;
    let openClaimCount = 0;
    let rejectedUnitsTotal = 0;
    for (const c of supplierClaims) {
      claimAmountCents += c.claimAmountCents;
      rejectedUnitsTotal += c.rejectedBaseQty;
      if (c.status === "OPEN" || c.status === "SUBMITTED") {
        openClaimCount += 1;
        openClaimAmountCents += c.claimAmountCents;
      }
    }

    const rows = purchaseOrders.map((po) => ({
      poNumber: po.poNumber,
      supplierCode: po.supplier.code,
      supplierName: po.supplier.name,
      locationCode: po.location.code,
      status: po.status,
      currency: po.currency,
      total: formatMoneyAmount(po.totalCents),
      expectedAt: po.expectedAt ? po.expectedAt.toISOString().slice(0, 10) : "-",
      createdAt: po.createdAt.toISOString().slice(0, 10),
    }));

    return {
      organizationId,
      organizationName,
      domain: ReportDomain.PROCUREMENT_CLAIMS,
      title: "Procurement, Vendor Bills & Supplier Claims Report",
      generatedAt: now.toISOString(),
      filters: filters as Record<string, unknown>,
      summaryKpis: {
        purchaseOrderCount: purchaseOrders.length,
        poTotalValue: formatMoneyAmount(poTotalCents),
        vendorBillCount: vendorBills.length,
        vendorBillTotal: formatMoneyAmount(billTotalCents),
        vendorBillPaid: formatMoneyAmount(billPaidCents),
        accountsPayableBalance: formatMoneyAmount(billPayableCents),
        supplierClaimCount: supplierClaims.length,
        openClaimCount,
        supplierClaimTotal: formatMoneyAmount(claimAmountCents),
        openClaimValue: formatMoneyAmount(openClaimAmountCents),
        rejectedBaseUnits: rejectedUnitsTotal,
      },
      columns: [
        { key: "poNumber", label: "PO #", widthChars: 16 },
        { key: "supplierCode", label: "Sup Code", widthChars: 12 },
        { key: "supplierName", label: "Supplier", widthChars: 24 },
        { key: "locationCode", label: "Loc", widthChars: 8 },
        { key: "status", label: "Status", widthChars: 14 },
        { key: "total", label: "Total", align: "right", widthChars: 12 },
        { key: "expectedAt", label: "Expected", widthChars: 12 },
        { key: "createdAt", label: "Created", widthChars: 12 },
      ],
      rows,
    };
  }

  private async buildProductionCostingReport(
    organizationId: string,
    organizationName: string,
    filters: ReportFiltersInput,
  ): Promise<GeneratedReportResult> {
    const now = new Date();
    const fromDate = parseDateFilter(filters.from, "from");
    const toDate = parseDateFilter(filters.to, "to");
    const takeLimit = Math.min(Math.max(filters.limit ?? 250, 1), 1000);

    const dateRange =
      fromDate || toDate
        ? {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          }
        : undefined;

    const batches = await this.prismaService.raw.productionBatch.findMany({
      where: {
        organizationId,
        ...(filters.locationId ? { locationId: filters.locationId } : {}),
        ...(filters.itemId ? { outputItemId: filters.itemId } : {}),
        ...(filters.status ? { status: filters.status as never } : {}),
        ...(dateRange ? { createdAt: dateRange } : {}),
      },
      include: {
        outputItem: { select: { sku: true, name: true } },
        location: { select: { code: true } },
      },
      orderBy: { createdAt: "desc" },
      take: takeLimit,
    });

    let plannedQtyTotal = 0;
    let actualOutputTotal = 0;
    let scrapQtyTotal = 0;
    let standardCostTotalCents = 0;
    let actualCostTotalCents = 0;
    let varianceTotalCents = 0;
    let materialCostTotalCents = 0;
    let laborCostTotalCents = 0;
    let machineCostTotalCents = 0;
    let overheadCostTotalCents = 0;

    const rows = batches.map((b) => {
      plannedQtyTotal += b.plannedOutputQty;
      actualOutputTotal += b.actualOutputQty;
      scrapQtyTotal += b.scrapQty;
      standardCostTotalCents += b.standardTotalCostCents;
      actualCostTotalCents += b.actualTotalCostCents;
      varianceTotalCents += b.costVarianceCents;
      materialCostTotalCents += b.actualMaterialCostCents;
      laborCostTotalCents += b.actualLaborCostCents;
      machineCostTotalCents += b.actualMachineCostCents;
      overheadCostTotalCents += b.actualOverheadCostCents;

      const yieldPct =
        b.plannedOutputQty > 0
          ? ((b.actualOutputQty / b.plannedOutputQty) * 100).toFixed(1)
          : "0.0";

      return {
        batchNumber: b.batchNumber,
        outputSku: b.outputItem?.sku ?? "-",
        locationCode: b.location.code,
        status: b.status,
        plannedQty: b.plannedOutputQty,
        actualQty: b.actualOutputQty,
        scrapQty: b.scrapQty,
        yieldPct: `${yieldPct}%`,
        standardCost: formatMoneyAmount(b.standardTotalCostCents),
        actualCost: formatMoneyAmount(b.actualTotalCostCents),
        variance: formatMoneyAmount(b.costVarianceCents),
      };
    });

    const overallYieldPct =
      plannedQtyTotal > 0
        ? Number(((actualOutputTotal / plannedQtyTotal) * 100).toFixed(2))
        : 0;

    return {
      organizationId,
      organizationName,
      domain: ReportDomain.PRODUCTION_COSTING,
      title: "Production Batches, Yields & Costing Report",
      generatedAt: now.toISOString(),
      filters: filters as Record<string, unknown>,
      summaryKpis: {
        batchCount: batches.length,
        plannedOutputUnits: plannedQtyTotal,
        actualOutputUnits: actualOutputTotal,
        scrapUnits: scrapQtyTotal,
        overallYieldPct: `${overallYieldPct}%`,
        standardTotalCost: formatMoneyAmount(standardCostTotalCents),
        actualTotalCost: formatMoneyAmount(actualCostTotalCents),
        costVariance: formatMoneyAmount(varianceTotalCents),
        materialCost: formatMoneyAmount(materialCostTotalCents),
        laborCost: formatMoneyAmount(laborCostTotalCents),
        machineCost: formatMoneyAmount(machineCostTotalCents),
        overheadCost: formatMoneyAmount(overheadCostTotalCents),
      },
      columns: [
        { key: "batchNumber", label: "Batch #", widthChars: 16 },
        { key: "outputSku", label: "SKU", widthChars: 14 },
        { key: "locationCode", label: "Loc", widthChars: 8 },
        { key: "status", label: "Status", widthChars: 12 },
        { key: "plannedQty", label: "Plan", align: "right", widthChars: 8 },
        { key: "actualQty", label: "Actual", align: "right", widthChars: 8 },
        { key: "scrapQty", label: "Scrap", align: "right", widthChars: 8 },
        { key: "yieldPct", label: "Yield", align: "right", widthChars: 8 },
        { key: "actualCost", label: "Actual Cost", align: "right", widthChars: 12 },
        { key: "variance", label: "Variance", align: "right", widthChars: 12 },
      ],
      rows,
    };
  }

  // ==========================================
  // On-Demand Dispatch & Schedule Execution
  // ==========================================

  async dispatchReport(
    tenant: AuthenticatedTenant,
    input: DispatchReportInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    return this.executeReportRun({
      organizationId,
      tenant,
      scheduleId: null,
      domain: input.domain,
      format: input.format,
      filters: input.filters ?? {},
      recipientEmails: input.recipientEmails ?? [],
      channelHints: input.channelHints,
      eventType: CommunicationEventType.ON_DEMAND_REPORT_DISPATCH,
      subjectOverride: input.subject,
      ipAddress,
    });
  }

  async createSchedule(
    tenant: AuthenticatedTenant,
    input: CreateReportScheduleInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const frequency = input.frequency ?? ReportFrequency.WEEKLY;
    const cronHourUtc = input.cronHourUtc ?? 6;
    const nextRunAt = computeNextRunAt(
      frequency,
      cronHourUtc,
      input.dayOfWeek,
      input.dayOfMonth,
    );

    return this.prismaService.raw.$transaction(async (tx) => {
      const schedule = await tx.reportSchedule.create({
        data: {
          organizationId,
          name: input.name.trim(),
          domain: input.domain,
          format: input.format ?? ReportFormat.PDF,
          frequency,
          cronHourUtc,
          dayOfWeek: input.dayOfWeek ?? null,
          dayOfMonth: input.dayOfMonth ?? null,
          filters: (input.filters ?? null) as Prisma.InputJsonValue,
          recipientEmails: (input.recipientEmails ?? []).map((e) =>
            e.trim().toLowerCase(),
          ),
          channelHints: input.channelHints ?? [CommunicationChannel.EMAIL],
          isActive: input.isActive ?? true,
          nextRunAt,
          createdByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "report.schedule.created",
          resourceType: "ReportSchedule",
          resourceId: schedule.id,
          metadata: {
            name: schedule.name,
            domain: schedule.domain,
            format: schedule.format,
            frequency: schedule.frequency,
            nextRunAt: schedule.nextRunAt.toISOString(),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return schedule;
    });
  }

  async listSchedules(tenant: AuthenticatedTenant) {
    this.resolveVerifiedOrganizationId(tenant);
    const items = await this.prismaService.scoped.reportSchedule.findMany({
      orderBy: [{ isActive: "desc" }, { nextRunAt: "asc" }],
    });
    return {
      organizationId: tenant.organizationId,
      items,
    };
  }

  async updateSchedule(
    tenant: AuthenticatedTenant,
    scheduleId: string,
    input: UpdateReportScheduleInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing = await this.prismaService.raw.reportSchedule.findFirst({
      where: { id: scheduleId, organizationId },
    });
    if (!existing) {
      throw new NotFoundException("Report schedule was not found.");
    }

    const nextFreq = input.frequency ?? existing.frequency;
    const nextHour = input.cronHourUtc ?? existing.cronHourUtc;
    const nextDow =
      input.dayOfWeek !== undefined ? input.dayOfWeek : existing.dayOfWeek;
    const nextDom =
      input.dayOfMonth !== undefined ? input.dayOfMonth : existing.dayOfMonth;
    const nextRunAt = computeNextRunAt(nextFreq, nextHour, nextDow, nextDom);

    return this.prismaService.raw.$transaction(async (tx) => {
      const updated = await tx.reportSchedule.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.format !== undefined ? { format: input.format } : {}),
          ...(input.frequency !== undefined ? { frequency: input.frequency } : {}),
          ...(input.cronHourUtc !== undefined
            ? { cronHourUtc: input.cronHourUtc }
            : {}),
          ...(input.dayOfWeek !== undefined ? { dayOfWeek: input.dayOfWeek } : {}),
          ...(input.dayOfMonth !== undefined
            ? { dayOfMonth: input.dayOfMonth }
            : {}),
          ...(input.filters !== undefined
            ? { filters: input.filters as Prisma.InputJsonValue }
            : {}),
          ...(input.recipientEmails !== undefined
            ? {
                recipientEmails: input.recipientEmails.map((e) =>
                  e.trim().toLowerCase(),
                ),
              }
            : {}),
          ...(input.channelHints !== undefined
            ? { channelHints: input.channelHints }
            : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          nextRunAt,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "report.schedule.updated",
          resourceType: "ReportSchedule",
          resourceId: updated.id,
          metadata: {
            name: updated.name,
            isActive: updated.isActive,
            nextRunAt: updated.nextRunAt.toISOString(),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async deleteSchedule(
    tenant: AuthenticatedTenant,
    scheduleId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing = await this.prismaService.raw.reportSchedule.findFirst({
      where: { id: scheduleId, organizationId },
    });
    if (!existing) {
      throw new NotFoundException("Report schedule was not found.");
    }

    await this.prismaService.raw.$transaction(async (tx) => {
      await tx.reportSchedule.delete({ where: { id: existing.id } });
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "report.schedule.deleted",
          resourceType: "ReportSchedule",
          resourceId: existing.id,
          metadata: {
            name: existing.name,
            domain: existing.domain,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });
    });

    return { deleted: true, id: existing.id };
  }

  async runScheduleNow(
    tenant: AuthenticatedTenant,
    scheduleId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const schedule = await this.prismaService.raw.reportSchedule.findFirst({
      where: { id: scheduleId, organizationId },
    });
    if (!schedule) {
      throw new NotFoundException("Report schedule was not found.");
    }
    return this.executeScheduleInternal(schedule, "MANUAL", tenant, ipAddress);
  }

  private async executeScheduleInternal(
    schedule: {
      id: string;
      organizationId: string;
      name: string;
      domain: ReportDomain;
      format: ReportFormat;
      frequency: ReportFrequency;
      cronHourUtc: number;
      dayOfWeek: number | null;
      dayOfMonth: number | null;
      filters: unknown;
      recipientEmails: string[];
      channelHints: CommunicationChannel[];
      createdByUserId: string | null;
    },
    trigger: "MANUAL" | "SCHEDULED",
    actorTenant?: AuthenticatedTenant,
    ipAddress?: string,
  ) {
    const syntheticTenant: AuthenticatedTenant = actorTenant ?? {
      organizationId: schedule.organizationId,
      memberId: "system",
      role: "owner",
      userId: schedule.createdByUserId ?? "system",
    };

    const runResult = await this.executeReportRun({
      organizationId: schedule.organizationId,
      tenant: syntheticTenant,
      scheduleId: schedule.id,
      domain: schedule.domain,
      format: schedule.format,
      filters: (schedule.filters ?? {}) as ReportFiltersInput,
      recipientEmails: schedule.recipientEmails,
      channelHints: schedule.channelHints,
      eventType: CommunicationEventType.SCHEDULED_REPORT_READY,
      subjectOverride: `${schedule.name} (${schedule.domain})`,
      ipAddress,
    });

    const now = new Date();
    const nextRunAt = computeNextRunAt(
      schedule.frequency,
      schedule.cronHourUtc,
      schedule.dayOfWeek,
      schedule.dayOfMonth,
      now,
    );

    await this.prismaService.raw.reportSchedule.update({
      where: { id: schedule.id },
      data: {
        lastRunAt: now,
        nextRunAt,
      },
    });

    return {
      ...runResult,
      trigger,
      nextRunAt,
    };
  }

  private async executeReportRun(params: {
    organizationId: string;
    tenant: AuthenticatedTenant;
    scheduleId: string | null;
    domain: ReportDomain;
    format: ReportFormat;
    filters: ReportFiltersInput;
    recipientEmails: string[];
    channelHints?: CommunicationChannel[];
    eventType: CommunicationEventType;
    subjectOverride?: string;
    ipAddress?: string;
  }) {
    const startedAt = Date.now();
    const now = new Date();

    const initialRun = await this.prismaService.raw.reportRun.create({
      data: {
        organizationId: params.organizationId,
        scheduleId: params.scheduleId,
        domain: params.domain,
        format: params.format,
        status: ReportRunStatus.RUNNING,
        filters: params.filters as Prisma.InputJsonValue,
        triggeredByUserId: params.tenant.userId,
        startedAt: now,
      },
    });

    try {
      const report = await this.generateReport(
        params.organizationId,
        params.domain,
        params.filters,
      );

      let storedObjectId: string | null = null;
      const filename = sanitizeReportFilename(params.domain, params.format, now);
      let artifactBuffer: Buffer;
      let mimeType: string;

      if (params.format === ReportFormat.CSV) {
        artifactBuffer = Buffer.from(renderReportCsv(report), "utf8");
        mimeType = "text/csv";
      } else if (params.format === ReportFormat.PDF) {
        artifactBuffer = renderReportPdf(report);
        mimeType = "application/pdf";
      } else {
        artifactBuffer = Buffer.from(JSON.stringify(report, null, 2), "utf8");
        mimeType = "application/json";
      }

      try {
        const stored = await this.storageService.uploadDirect(
          params.tenant,
          {
            buffer: artifactBuffer,
            filename,
            mimeType,
            entityType: StorageEntityType.REPORT_RUN,
            entityId: initialRun.id,
            tags: ["report", params.domain.toLowerCase()],
            metadata: {
              domain: params.domain,
              format: params.format,
              reportRunId: initialRun.id,
            },
          },
          params.ipAddress,
        );
        storedObjectId = stored.id;
      } catch (storageErr) {
        this.logger.warn(
          `Report artifact upload deferred/skipped for run ${initialRun.id}: ${storageErr instanceof Error ? storageErr.message : String(storageErr)}`,
        );
      }

      const downloadPath = `/api/v1/reports/runs/${initialRun.id}/download`;
      const outbox = await this.outboxService.emitEvent(null, {
        organizationId: params.organizationId,
        eventType: params.eventType,
        severity: AlertSeverity.INFO,
        sourceEntityType: "ReportRun",
        sourceEntityId: initialRun.id,
        dedupeKey: `report_run:${initialRun.id}`,
        channelHints: params.channelHints,
        targetEmails: params.recipientEmails,
        subject: params.subjectOverride?.trim() || report.title,
        summaryText: `${report.title} completed with ${report.rows.length} row(s). Key metrics: ${Object.entries(
          report.summaryKpis,
        )
          .slice(0, 6)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(", ")}. Download: ${downloadPath}`,
        payload: {
          reportRunId: initialRun.id,
          scheduleId: params.scheduleId,
          domain: params.domain,
          format: params.format,
          rowCount: report.rows.length,
          storedObjectId,
          downloadPath,
          summaryKpis: report.summaryKpis,
          rowsPreview: report.rows.slice(0, 25),
        },
      });

      const completedAt = new Date();
      const durationMs = Date.now() - startedAt;

      const updatedRun = await this.prismaService.raw.reportRun.update({
        where: { id: initialRun.id },
        data: {
          status: ReportRunStatus.COMPLETED,
          summaryKpis: report.summaryKpis as Prisma.InputJsonValue,
          rowCount: report.rows.length,
          storedObjectId,
          outboxEventId: outbox.event.id,
          durationMs,
          completedAt,
        },
      });

      this.analyticsService.captureDomainEvent({
        event: "report.run_completed",
        distinctId: params.tenant.userId,
        organizationId: params.organizationId,
        properties: {
          report_run_id: updatedRun.id,
          domain: params.domain,
          format: params.format,
          row_count: report.rows.length,
          duration_ms: durationMs,
        },
      });

      return {
        run: updatedRun,
        outboxEventId: outbox.event.id,
        downloadPath,
        summaryKpis: report.summaryKpis,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.prismaService.raw.reportRun.update({
        where: { id: initialRun.id },
        data: {
          status: ReportRunStatus.FAILED,
          errorMessage: msg.slice(0, 1000),
          durationMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

  async listRuns(
    tenant: AuthenticatedTenant,
    query: { domain?: ReportDomain; scheduleId?: string; limit: number; cursor?: string },
  ) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);

    const records = await this.prismaService.scoped.reportRun.findMany({
      where: {
        ...(query.domain ? { domain: query.domain } : {}),
        ...(query.scheduleId ? { scheduleId: query.scheduleId } : {}),
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

  async getRun(tenant: AuthenticatedTenant, runId: string) {
    this.resolveVerifiedOrganizationId(tenant);
    const run = await this.prismaService.scoped.reportRun.findFirst({
      where: { id: runId },
      include: {
        schedule: { select: { id: true, name: true, frequency: true } },
      },
    });
    if (!run) {
      throw new NotFoundException("Report run was not found.");
    }
    return run;
  }

  async downloadRunArtifact(tenant: AuthenticatedTenant, runId: string) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const run = await this.prismaService.raw.reportRun.findFirst({
      where: { id: runId, organizationId },
    });
    if (!run) {
      throw new NotFoundException("Report run was not found.");
    }

    if (run.storedObjectId) {
      try {
        const direct = await this.storageService.downloadDirect(
          tenant,
          run.storedObjectId,
          "attachment",
        );
        return direct;
      } catch {
        // Fall through to deterministic regeneration if object storage is unavailable
      }
    }

    const report = await this.generateReport(
      organizationId,
      run.domain,
      (run.filters ?? {}) as ReportFiltersInput,
    );
    const filename = sanitizeReportFilename(run.domain, run.format, run.createdAt);

    let buffer: Buffer;
    let contentType: string;
    if (run.format === ReportFormat.CSV) {
      buffer = Buffer.from(renderReportCsv(report), "utf8");
      contentType = "text/csv; charset=utf-8";
    } else if (run.format === ReportFormat.PDF) {
      buffer = renderReportPdf(report);
      contentType = "application/pdf";
    } else {
      buffer = Buffer.from(JSON.stringify(report, null, 2), "utf8");
      contentType = "application/json; charset=utf-8";
    }

    return {
      body: buffer,
      contentType,
      contentLength: buffer.byteLength,
      contentDisposition: `attachment; filename="${filename}"`,
      etag: null as string | null,
    };
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedTenant): string {
    const contextOrgId = TenantContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active tenant context mismatch.");
    }
    return tenant.organizationId;
  }
}

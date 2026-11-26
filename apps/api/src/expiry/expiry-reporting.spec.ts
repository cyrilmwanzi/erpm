import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import {
  AlertSeverity,
  CommunicationChannel,
  CommunicationEventType,
  ExpiryAlertSeverity,
  ExpiryAlertStatus,
  ExpiryEnforcementMode,
  LotAllocationStrategy,
  OutboxDeliveryStatus,
  PaymentProvider,
  PaymentTransactionStatus,
  ReportDomain,
  ReportFormat,
  ReportFrequency,
  StockMovementType,
} from "@scace/db";
import { hasOrganizationPermission } from "../auth/permissions.js";
import { CommunicationOutboxService } from "../communications/communication-outbox.service.js";
import {
  decryptCommunicationSecret,
  encryptCommunicationSecret,
  escapeEmailHtml,
  generateWebhookSigningSecret,
  maskSecretTail,
  signWebhookPayload,
  validateWebhookDestinationUrl,
} from "../communications/communications-security.utils.js";
import {
  allocateAndDeductLotsInTx,
  assertReservableStockExpiryInTx,
  classifyLotExpiry,
  computeExpiresAtFromShelfLife,
} from "../locations/lot-allocation.utils.js";
import {
  computeNextRunAt,
  renderReportCsv,
  renderReportPdf,
  sanitizeCsvCell,
} from "../reports/reports-export.utils.js";
import { ReportsService } from "../reports/reports.service.js";
import { ExpiryService } from "./expiry.service.js";

function createTestHarness() {
  let seq = 1;
  const nextId = (prefix: string) => `${prefix}_${seq++}`;

  const organizations = new Map<string, any>([
    ["org_a", { id: "org_a", name: "Alpha Manufacturing Ltd" }],
    ["org_b", { id: "org_b", name: "Beta Retail Co" }],
  ]);

  const items = new Map<string, any>([
    [
      "item_milk",
      {
        id: "item_milk",
        organizationId: "org_a",
        sku: "DAIRY-MILK-1L",
        name: "Whole Milk 1L",
        unitOfMeasure: "bottle",
        costPriceCents: 120,
        currency: "KES",
        trackInventory: true,
        trackExpiry: true,
        shelfLifeDays: 14,
        expiryWarningDays: 10,
        expiryCriticalDays: 3,
        lotAllocationStrategy: LotAllocationStrategy.FEFO,
      },
    ],
    [
      "item_sugar",
      {
        id: "item_sugar",
        organizationId: "org_b",
        sku: "SUGAR-1KG",
        name: "Sugar 1kg",
        unitOfMeasure: "bag",
        costPriceCents: 150,
        currency: "KES",
        trackInventory: true,
        trackExpiry: true,
        shelfLifeDays: 180,
        expiryWarningDays: null,
        expiryCriticalDays: null,
        lotAllocationStrategy: LotAllocationStrategy.FEFO,
      },
    ],
  ]);

  const locations = new Map<string, any>([
    [
      "loc_a",
      { id: "loc_a", organizationId: "org_a", code: "MAIN", name: "Main Cold Store" },
    ],
    [
      "loc_b",
      { id: "loc_b", organizationId: "org_b", code: "WH1", name: "Beta Warehouse" },
    ],
  ]);

  const members: any[] = [
    {
      id: "mem_1",
      organizationId: "org_a",
      role: "owner",
      user: { email: "owner@alpha.test" },
    },
    {
      id: "mem_2",
      organizationId: "org_a",
      role: "manager",
      user: { email: "ops-mgr@alpha.test" },
    },
    {
      id: "mem_3",
      organizationId: "org_b",
      role: "owner",
      user: { email: "owner@beta.test" },
    },
  ];

  const stockBalances = new Map<string, any>();
  const stockLots = new Map<string, any>();
  const stockMovements: any[] = [];
  const expiryPolicies = new Map<string, any>();
  const expiryAlerts = new Map<string, any>();
  const expiryWriteOffs: any[] = [];
  const alertRules = new Map<string, any>();
  const outboxEvents = new Map<string, any>();
  const deliveryAttempts: any[] = [];
  const reportSchedules = new Map<string, any>();
  const reportRuns = new Map<string, any>();
  const auditLogs: any[] = [];

  const orders: any[] = [
    {
      id: "ord_a1",
      organizationId: "org_a",
      orderNumber: "SO-1001",
      channel: "POS",
      status: "COMPLETED",
      locationId: "loc_a",
      currency: "KES",
      totalCents: 25000,
      paidAmountCents: 25000,
      createdAt: new Date("2026-11-20T10:00:00Z"),
      location: { code: "MAIN", name: "Main Cold Store" },
      customer: { name: "Nairobi Cafe", code: "C-01" },
    },
    {
      id: "ord_b1",
      organizationId: "org_b",
      orderNumber: "SO-9001",
      channel: "B2B",
      status: "CONFIRMED",
      locationId: "loc_b",
      currency: "KES",
      totalCents: 99000,
      paidAmountCents: 0,
      createdAt: new Date("2026-11-20T10:00:00Z"),
      location: { code: "WH1", name: "Beta Warehouse" },
      customer: { name: "Beta Buyer", code: "C-09" },
    },
  ];

  const salesInvoices: any[] = [
    {
      id: "inv_a1",
      organizationId: "org_a",
      status: "PAID",
      totalCents: 25000,
      paidAmountCents: 25000,
      createdAt: new Date("2026-11-20T10:00:00Z"),
    },
  ];

  const paymentTransactions: any[] = [
    {
      id: "ptx_a1",
      organizationId: "org_a",
      provider: PaymentProvider.MPESA,
      status: PaymentTransactionStatus.SUCCEEDED,
      flow: "STK_PUSH",
      amountCents: 25000,
      mpesaReceiptNumber: "UAK12345XY",
      createdAt: new Date("2026-11-20T10:05:00Z"),
    },
  ];

  const purchaseOrders: any[] = [
    {
      id: "po_a1",
      organizationId: "org_a",
      poNumber: "PO-5001",
      supplierId: "sup_a1",
      locationId: "loc_a",
      status: "RECEIVED",
      currency: "KES",
      totalCents: 40000,
      expectedAt: new Date("2026-11-22T00:00:00Z"),
      createdAt: new Date("2026-11-18T00:00:00Z"),
      supplier: { code: "SUP-01", name: "=HYPERLINK(\"http://evil\",\"FreshFarms\")" },
      location: { code: "MAIN" },
    },
  ];

  const vendorBills: any[] = [
    {
      id: "vb_a1",
      organizationId: "org_a",
      supplierId: "sup_a1",
      status: "PARTIALLY_PAID",
      totalCents: 40000,
      paidAmountCents: 15000,
      issuedAt: new Date("2026-11-19T00:00:00Z"),
    },
  ];

  const supplierClaims: any[] = [
    {
      id: "clm_a1",
      organizationId: "org_a",
      supplierId: "sup_a1",
      itemId: "item_milk",
      claimType: "CREDIT",
      status: "OPEN",
      rejectedBaseQty: 5,
      claimAmountCents: 600,
      createdAt: new Date("2026-11-19T00:00:00Z"),
    },
  ];

  const productionBatches: any[] = [
    {
      id: "pb_a1",
      organizationId: "org_a",
      batchNumber: "PB-2026-01",
      locationId: "loc_a",
      outputItemId: "item_milk",
      status: "COMPLETED",
      plannedOutputQty: 100,
      actualOutputQty: 95,
      scrapQty: 5,
      standardTotalCostCents: 10000,
      actualMaterialCostCents: 7000,
      actualLaborCostCents: 1800,
      actualMachineCostCents: 600,
      actualOverheadCostCents: 400,
      actualTotalCostCents: 9800,
      costVarianceCents: -200,
      createdAt: new Date("2026-11-21T00:00:00Z"),
      outputItem: { sku: "DAIRY-MILK-1L", name: "Whole Milk 1L" },
      location: { code: "MAIN" },
    },
  ];

  const balKey = (orgId: string, itemId: string, locationId: string) =>
    `${orgId}:${itemId}:${locationId}`;

  function matchesWhere(rec: any, where: any = {}): boolean {
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      if (k === "OR" && Array.isArray(v)) {
        if (!v.some((sub) => matchesWhere(rec, sub))) return false;
        continue;
      }
      if (k === "AND" && Array.isArray(v)) {
        if (!v.every((sub) => matchesWhere(rec, sub))) return false;
        continue;
      }
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const ops = v as Record<string, any>;
        if ("in" in ops) {
          if (!ops.in.includes(rec[k])) return false;
          continue;
        }
        if ("has" in ops) {
          if (!Array.isArray(rec[k]) || !rec[k].includes(ops.has)) return false;
          continue;
        }
        if (
          "gt" in ops ||
          "gte" in ops ||
          "lte" in ops ||
          "lt" in ops ||
          "not" in ops
        ) {
          const val = rec[k];
          if ("not" in ops && ops.not === null) {
            if (val === null || val === undefined) return false;
          }
          const numVal = val instanceof Date ? val.getTime() : val;
          if ("gt" in ops) {
            const cmp = ops.gt instanceof Date ? ops.gt.getTime() : ops.gt;
            if (!(numVal > cmp)) return false;
          }
          if ("gte" in ops) {
            const cmp = ops.gte instanceof Date ? ops.gte.getTime() : ops.gte;
            if (!(numVal >= cmp)) return false;
          }
          if ("lte" in ops) {
            const cmp = ops.lte instanceof Date ? ops.lte.getTime() : ops.lte;
            if (!(numVal <= cmp)) return false;
          }
          continue;
        }
      }
      if (rec[k] !== v) return false;
    }
    return true;
  }

  function applyUpdateData(rec: any, data: any) {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
        const ops = v as Record<string, any>;
        if ("increment" in ops) {
          rec[k] = (rec[k] ?? 0) + ops.increment;
          continue;
        }
        if ("decrement" in ops) {
          rec[k] = (rec[k] ?? 0) - ops.decrement;
          continue;
        }
      }
      rec[k] = v;
    }
    rec.updatedAt = new Date();
  }

  const rawDb: any = {
    $transaction: async (fn: any) => fn(rawDb),
    organization: {
      findUnique: async ({ where }: any) => organizations.get(where.id) ?? null,
    },
    member: {
      findMany: async ({ where }: any) =>
        members.filter((m) => matchesWhere(m, where)),
    },
    stockExpiryPolicy: {
      findUnique: async ({ where }: any) =>
        expiryPolicies.get(where.organizationId) ?? null,
      create: async ({ data }: any) => {
        const rec = { id: nextId("pol"), ...data, createdAt: new Date(), updatedAt: new Date() };
        expiryPolicies.set(rec.organizationId, rec);
        return rec;
      },
      update: async ({ where, data }: any) => {
        for (const p of expiryPolicies.values()) {
          if (p.id === where.id) {
            applyUpdateData(p, data);
            return p;
          }
        }
        return null;
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = expiryPolicies.get(where.organizationId);
        if (existing) {
          applyUpdateData(existing, update);
          return existing;
        }
        return rawDb.stockExpiryPolicy.create({ data: create });
      },
    },
    stockBalance: {
      findUnique: async ({ where }: any) => {
        const keyObj = where.organizationId_itemId_locationId;
        if (keyObj) {
          return (
            stockBalances.get(
              balKey(keyObj.organizationId, keyObj.itemId, keyObj.locationId),
            ) ?? null
          );
        }
        return null;
      },
      findMany: async ({ where }: any) =>
        Array.from(stockBalances.values())
          .filter((b) => matchesWhere(b, where))
          .map((b) => ({
            ...b,
            item: items.get(b.itemId),
            location: locations.get(b.locationId),
          })),
      update: async ({ where, data }: any) => {
        for (const b of stockBalances.values()) {
          if (b.id === where.id) {
            applyUpdateData(b, data);
            return b;
          }
        }
        return null;
      },
    },
    stockLot: {
      findFirst: async ({ where }: any) => {
        const lot = Array.from(stockLots.values()).find((l) =>
          matchesWhere(l, where),
        );
        if (!lot) return null;
        return {
          ...lot,
          item: items.get(lot.itemId),
          location: locations.get(lot.locationId),
        };
      },
      findMany: async ({ where, orderBy, take }: any) => {
        let res = Array.from(stockLots.values())
          .filter((l) => matchesWhere(l, where))
          .map((l) => ({
            ...l,
            item: items.get(l.itemId),
            location: locations.get(l.locationId),
          }));
        if (orderBy) {
          res = res.sort((a, b) => {
            const ae = a.expiresAt ? a.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
            const be = b.expiresAt ? b.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
            return ae - be;
          });
        }
        return take ? res.slice(0, take) : res;
      },
      update: async ({ where, data }: any) => {
        const lot = stockLots.get(where.id);
        if (!lot) return null;
        applyUpdateData(lot, data);
        return lot;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const lot of stockLots.values()) {
          if (matchesWhere(lot, where)) {
            applyUpdateData(lot, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    stockMovement: {
      create: async ({ data }: any) => {
        const rec = { id: nextId("mov"), ...data, createdAt: new Date() };
        stockMovements.push(rec);
        return rec;
      },
    },
    stockExpiryAlert: {
      findFirst: async ({ where }: any) => {
        return (
          Array.from(expiryAlerts.values()).find((a) => matchesWhere(a, where)) ??
          null
        );
      },
      findMany: async ({ where }: any) => {
        return Array.from(expiryAlerts.values())
          .filter((a) => matchesWhere(a, where))
          .map((a) => {
            const lot = stockLots.get(a.stockLotId);
            return {
              ...a,
              stockLot: lot ? { ...lot, item: items.get(lot.itemId) } : null,
              item: items.get(a.itemId),
              location: locations.get(a.locationId),
            };
          });
      },
      count: async ({ where }: any) =>
        Array.from(expiryAlerts.values()).filter((a) => matchesWhere(a, where))
          .length,
      create: async ({ data }: any) => {
        const rec = {
          id: nextId("alert"),
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        expiryAlerts.set(rec.id, rec);
        return rec;
      },
      update: async ({ where, data }: any) => {
        const rec = expiryAlerts.get(where.id);
        if (!rec) return null;
        applyUpdateData(rec, data);
        return rec;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const rec of expiryAlerts.values()) {
          if (matchesWhere(rec, where)) {
            applyUpdateData(rec, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    stockExpiryWriteOff: {
      create: async ({ data }: any) => {
        const rec = { id: nextId("wo"), ...data, createdAt: new Date() };
        expiryWriteOffs.push(rec);
        return rec;
      },
      findMany: async ({ where }: any) =>
        expiryWriteOffs.filter((w) => matchesWhere(w, where)),
    },
    alertRule: {
      findMany: async ({ where }: any) =>
        Array.from(alertRules.values()).filter((r) => matchesWhere(r, where)),
      findFirst: async ({ where }: any) =>
        Array.from(alertRules.values()).find((r) => matchesWhere(r, where)) ??
        null,
      create: async ({ data }: any) => {
        const rec = {
          id: nextId("rule"),
          lastTriggeredAt: null,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        alertRules.set(rec.id, rec);
        return rec;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const r of alertRules.values()) {
          if (matchesWhere(r, where)) {
            applyUpdateData(r, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    communicationWebhook: {
      count: async () => 0,
      findMany: async () => [],
    },
    communicationOutboxEvent: {
      findFirst: async ({ where }: any) =>
        Array.from(outboxEvents.values()).find((e) => matchesWhere(e, where)) ??
        null,
      findMany: async ({ where, take }: any) => {
        const list = Array.from(outboxEvents.values())
          .filter((e) => matchesWhere(e, where))
          .map((e) => ({
            ...e,
            deliveryAttempts: deliveryAttempts.filter(
              (a) => a.outboxEventId === e.id,
            ),
          }));
        return take ? list.slice(0, take) : list;
      },
      create: async ({ data }: any) => {
        const rec = {
          id: nextId("outbox"),
          maxAttempts: 5,
          dispatchedAt: null,
          acknowledgedAt: null,
          acknowledgedByUserId: null,
          lastError: null,
          lockedUntil: null,
          lockedBy: null,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        outboxEvents.set(rec.id, rec);
        return rec;
      },
      update: async ({ where, data }: any) => {
        const rec = outboxEvents.get(where.id);
        if (!rec) return null;
        applyUpdateData(rec, data);
        return {
          ...rec,
          deliveryAttempts: deliveryAttempts.filter(
            (a) => a.outboxEventId === rec.id,
          ),
        };
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const rec of outboxEvents.values()) {
          if (matchesWhere(rec, where)) {
            applyUpdateData(rec, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    communicationDeliveryAttempt: {
      create: async ({ data }: any) => {
        const rec = { id: nextId("att"), ...data, attemptedAt: new Date() };
        deliveryAttempts.push(rec);
        return rec;
      },
    },
    order: {
      findMany: async ({ where }: any) =>
        orders.filter((o) => matchesWhere(o, where)),
    },
    salesInvoice: {
      findMany: async ({ where }: any) =>
        salesInvoices.filter((i) => matchesWhere(i, where)),
    },
    paymentTransaction: {
      findMany: async ({ where }: any) =>
        paymentTransactions.filter((t) => matchesWhere(t, where)),
    },
    purchaseOrder: {
      findMany: async ({ where }: any) =>
        purchaseOrders.filter((p) => matchesWhere(p, where)),
    },
    vendorBill: {
      findMany: async ({ where }: any) =>
        vendorBills.filter((b) => matchesWhere(b, where)),
    },
    supplierClaim: {
      findMany: async ({ where }: any) =>
        supplierClaims.filter((c) => matchesWhere(c, where)),
    },
    productionBatch: {
      findMany: async ({ where }: any) =>
        productionBatches.filter((b) => matchesWhere(b, where)),
    },
    reportSchedule: {
      create: async ({ data }: any) => {
        const rec = {
          id: nextId("sched"),
          lastRunAt: null,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        reportSchedules.set(rec.id, rec);
        return rec;
      },
      findFirst: async ({ where }: any) =>
        Array.from(reportSchedules.values()).find((s) =>
          matchesWhere(s, where),
        ) ?? null,
      findMany: async ({ where }: any) =>
        Array.from(reportSchedules.values()).filter((s) =>
          matchesWhere(s, where),
        ),
      update: async ({ where, data }: any) => {
        const rec = reportSchedules.get(where.id);
        if (!rec) return null;
        applyUpdateData(rec, data);
        return rec;
      },
      delete: async ({ where }: any) => reportSchedules.delete(where.id),
    },
    reportRun: {
      create: async ({ data }: any) => {
        const rec = {
          id: nextId("run"),
          summaryKpis: null,
          rowCount: 0,
          storedObjectId: null,
          outboxEventId: null,
          durationMs: 0,
          errorMessage: null,
          completedAt: null,
          ...data,
          createdAt: new Date(),
        };
        reportRuns.set(rec.id, rec);
        return rec;
      },
      findFirst: async ({ where }: any) => {
        const rec = Array.from(reportRuns.values()).find((r) =>
          matchesWhere(r, where),
        );
        if (!rec) return null;
        return {
          ...rec,
          schedule: rec.scheduleId ? reportSchedules.get(rec.scheduleId) ?? null : null,
        };
      },
      findMany: async ({ where }: any) =>
        Array.from(reportRuns.values()).filter((r) => matchesWhere(r, where)),
      update: async ({ where, data }: any) => {
        const rec = reportRuns.get(where.id);
        if (!rec) return null;
        applyUpdateData(rec, data);
        return rec;
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        const rec = { id: nextId("aud"), ...data, createdAt: new Date() };
        auditLogs.push(rec);
        return rec;
      },
    },
  };

  // Mimics TenantPrismaExtension scoping org_a vs org_b
  let activeTenantOrgId = "org_a";
  const scopedProxy = new Proxy(rawDb, {
    get(target, prop: string) {
      const delegate = target[prop];
      if (!delegate) return undefined;
      return {
        ...delegate,
        findMany: async (args: any = {}) =>
          delegate.findMany({
            ...args,
            where: { ...(args.where ?? {}), organizationId: activeTenantOrgId },
          }),
        findFirst: async (args: any = {}) =>
          delegate.findFirst({
            ...args,
            where: { ...(args.where ?? {}), organizationId: activeTenantOrgId },
          }),
      };
    },
  });

  const prismaService: any = {
    raw: rawDb,
    scoped: scopedProxy,
  };

  const sentEmails: any[] = [];
  const emailService: any = {
    sendEmail: async (payload: any) => {
      sentEmails.push(payload);
    },
  };

  const storageService: any = {
    uploadDirect: async (_tenant: any, input: any) => ({
      id: nextId("obj"),
      originalName: input.filename,
      sizeBytes: input.buffer.byteLength,
    }),
    downloadDirect: async () => ({
      body: Buffer.from("stored-artifact"),
      contentType: "application/pdf",
      contentLength: 15,
      contentDisposition: 'attachment; filename="stored.pdf"',
      etag: "etag1",
    }),
  };

  const redisService: any = {
    ensureConnected: async () => undefined,
    client: { set: async () => "OK" },
  };

  const analyticsService: any = {
    captureDomainEvent: () => undefined,
  };

  const outboxService = new CommunicationOutboxService(
    prismaService,
    redisService,
    emailService,
    analyticsService,
  );
  const expiryService = new ExpiryService(
    prismaService,
    redisService,
    outboxService,
    analyticsService,
  );
  const reportsService = new ReportsService(
    prismaService,
    redisService,
    storageService,
    outboxService,
    analyticsService,
  );

  return {
    setOrg: (orgId: string) => {
      activeTenantOrgId = orgId;
    },
    seedBalance: (orgId: string, itemId: string, locationId: string, qty: number) => {
      const rec = {
        id: nextId("bal"),
        organizationId: orgId,
        itemId,
        locationId,
        onHandQty: qty,
        reservedQty: 0,
        updatedAt: new Date(),
      };
      stockBalances.set(balKey(orgId, itemId, locationId), rec);
      return rec;
    },
    seedLot: (lot: {
      id?: string;
      organizationId: string;
      itemId: string;
      locationId: string;
      lotNumber: string;
      expiresAt: Date | null;
      onHandQty: number;
      quarantinedQty?: number;
      unitCostCents?: number;
      createdAt?: Date;
    }) => {
      const id = lot.id ?? nextId("lot");
      const rec = {
        id,
        organizationId: lot.organizationId,
        itemId: lot.itemId,
        locationId: lot.locationId,
        lotNumber: lot.lotNumber,
        batchCode: null,
        supplierId: null,
        supplierItemId: null,
        supplierSku: null,
        supplierBatchNumber: null,
        manufacturedAt: new Date("2026-11-01T00:00:00Z"),
        expiresAt: lot.expiresAt,
        onHandQty: lot.onHandQty,
        quarantinedQty: lot.quarantinedQty ?? 0,
        initialQty: lot.onHandQty,
        consumedQty: 0,
        unitCostCents: lot.unitCostCents ?? 120,
        createdAt: lot.createdAt ?? new Date(),
        updatedAt: new Date(),
      };
      stockLots.set(id, rec);
      return rec;
    },
    rawDb,
    stockBalances,
    stockLots,
    stockMovements,
    expiryAlerts,
    expiryWriteOffs,
    outboxEvents,
    sentEmails,
    reportRuns,
    auditLogs,
    outboxService,
    expiryService,
    reportsService,
  };
}

describe("Stock Expiry Utilities, FEFO Allocation & Permissions", () => {
  it("calculates shelf-life expiration dates and classifies buckets accurately", () => {
    const base = new Date("2026-11-01T00:00:00.000Z");
    const expiresAt = computeExpiresAtFromShelfLife(base, 14);
    assert.equal(expiresAt?.toISOString(), "2026-11-15T00:00:00.000Z");
    assert.equal(computeExpiresAtFromShelfLife(base, null), null);

    const now = new Date("2026-11-10T00:00:00.000Z");
    assert.equal(classifyLotExpiry(new Date("2026-11-09T00:00:00Z"), now, 30, 7).bucket, "EXPIRED");
    assert.equal(classifyLotExpiry(new Date("2026-11-12T00:00:00Z"), now, 30, 7).bucket, "CRITICAL");
    assert.equal(classifyLotExpiry(new Date("2026-11-25T00:00:00Z"), now, 30, 7).bucket, "WARNING");
    assert.equal(classifyLotExpiry(new Date("2027-02-01T00:00:00Z"), now, 30, 7).bucket, "HEALTHY");
    assert.equal(classifyLotExpiry(null, now, 30, 7).bucket, "NO_EXPIRY");
  });

  it("allocates lots strictly in FEFO order and blocks expired lots under BLOCK_EXPIRED", async () => {
    const h = createTestHarness();
    const now = new Date("2026-11-15T00:00:00.000Z");

    const expiredLot = h.seedLot({
      organizationId: "org_a",
      itemId: "item_milk",
      locationId: "loc_a",
      lotNumber: "LOT-EXPIRED",
      expiresAt: new Date("2026-11-10T00:00:00Z"),
      onHandQty: 10,
    });
    const soonLot = h.seedLot({
      organizationId: "org_a",
      itemId: "item_milk",
      locationId: "loc_a",
      lotNumber: "LOT-SOON",
      expiresAt: new Date("2026-11-20T00:00:00Z"),
      onHandQty: 4,
    });
    const laterLot = h.seedLot({
      organizationId: "org_a",
      itemId: "item_milk",
      locationId: "loc_a",
      lotNumber: "LOT-LATER",
      expiresAt: new Date("2026-12-01T00:00:00Z"),
      onHandQty: 8,
    });

    // Only 12 non-expired units exist (expiredLot=10 must be blocked when reserving 15)
    await assert.rejects(
      () =>
        assertReservableStockExpiryInTx(h.rawDb, {
          organizationId: "org_a",
          itemId: "item_milk",
          sku: "DAIRY-MILK-1L",
          trackExpiry: true,
          allowNegativeStock: false,
          locationId: "loc_a",
          locationCode: "MAIN",
          stockBalanceOnHand: 22,
          alreadyReservedQty: 0,
          requestedBaseQty: 15,
          now,
        }),
      BadRequestException,
    );

    // Deduct 7 units -> must take 4 from LOT-SOON and 3 from LOT-LATER, skipping LOT-EXPIRED
    const allocation = await allocateAndDeductLotsInTx(h.rawDb, {
      organizationId: "org_a",
      itemId: "item_milk",
      sku: "DAIRY-MILK-1L",
      trackExpiry: true,
      allowNegativeStock: false,
      lotAllocationStrategy: LotAllocationStrategy.FEFO,
      locationId: "loc_a",
      locationCode: "MAIN",
      currentBalanceOnHand: 22,
      baseQty: 7,
      now,
    });

    assert.equal(allocation.unlottedQty, 0);
    assert.deepEqual(
      allocation.usedLots.map((s) => ({ lot: s.lotNumber, qty: s.quantity })),
      [
        { lot: "LOT-SOON", qty: 4 },
        { lot: "LOT-LATER", qty: 3 },
      ],
    );
    assert.equal(soonLot.onHandQty, 0);
    assert.equal(laterLot.onHandQty, 5);
    assert.equal(expiredLot.onHandQty, 10);
  });

  it("enforces inventory expiry, reporting, and communication RBAC permissions", () => {
    assert.equal(hasOrganizationPermission("admin", { inventory: ["manageExpiry", "writeOff"] }), true);
    assert.equal(hasOrganizationPermission("manager", { inventory: ["manageExpiry", "writeOff"] }), true);
    assert.equal(hasOrganizationPermission("member", { inventory: ["manageExpiry"] }), false);
    assert.equal(hasOrganizationPermission("manager", { report: ["read", "export", "schedule"] }), true);
    assert.equal(hasOrganizationPermission("member", { report: ["schedule"] }), false);
    assert.equal(hasOrganizationPermission("admin", { communication: ["read", "manage", "dispatch"] }), true);
    assert.equal(hasOrganizationPermission("member", { communication: ["manage"] }), false);
  });
});

describe("Expiry Scanner, Auto-Quarantine, Write-Offs & Communication Outbox", () => {
  it("scans lots idempotently, auto-quarantines expired stock, and routes outbox alerts with AlertRule cooldowns", async () => {
    const h = createTestHarness();
    const tenantA = {
      organizationId: "org_a",
      memberId: "mem_1",
      role: "owner",
      userId: "user_owner_a",
    };

    await h.expiryService.updatePolicy(tenantA, {
      warningDays: 30,
      criticalDays: 7,
      enforcementMode: ExpiryEnforcementMode.BLOCK_EXPIRED,
      autoQuarantineExpired: true,
      isScannerActive: true,
    });

    await h.outboxService.createAlertRule(tenantA, {
      name: "Expired Stock Operations Rule",
      eventType: CommunicationEventType.STOCK_EXPIRED,
      channels: [CommunicationChannel.EMAIL, CommunicationChannel.IN_APP],
      recipientRoles: ["owner", "manager"],
      recipientEmails: ["qa@alpha.test"],
      cooldownMinutes: 1440,
    });

    h.seedBalance("org_a", "item_milk", "loc_a", 12);
    const expiredLot = h.seedLot({
      organizationId: "org_a",
      itemId: "item_milk",
      locationId: "loc_a",
      lotNumber: "LOT-EXP-01",
      expiresAt: new Date(Date.now() - 2 * 86_400_000),
      onHandQty: 5,
      unitCostCents: 120,
    });
    const critLot = h.seedLot({
      organizationId: "org_a",
      itemId: "item_milk",
      locationId: "loc_a",
      lotNumber: "LOT-CRIT-02",
      expiresAt: new Date(Date.now() + 2 * 86_400_000),
      onHandQty: 7,
      unitCostCents: 120,
    });

    const scan1 = await h.expiryService.runManualScan(tenantA);
    assert.equal(scan1.expiredLotsCount, 1);
    assert.equal(scan1.criticalLotsCount, 1);
    assert.equal(scan1.alertsCreated, 2);
    assert.equal(scan1.autoQuarantinedQty, 5);
    assert.equal(expiredLot.onHandQty, 0);
    assert.equal(expiredLot.quarantinedQty, 5);
    assert.equal(critLot.onHandQty, 7);

    // Outbox event emitted for expired alert resolved role emails + static email
    const expiredOutbox = Array.from(h.outboxEvents.values()).find(
      (e) => e.eventType === CommunicationEventType.STOCK_EXPIRED,
    );
    assert.ok(expiredOutbox);
    assert.ok(expiredOutbox.targetEmails.includes("owner@alpha.test"));
    assert.ok(expiredOutbox.targetEmails.includes("ops-mgr@alpha.test"));
    assert.ok(expiredOutbox.targetEmails.includes("qa@alpha.test"));

    // Second scan on same day must deduplicate alerts (0 new alerts)
    const scan2 = await h.expiryService.runManualScan(tenantA);
    assert.equal(scan2.alertsCreated, 0);
    assert.equal(scan2.alertsUpdated, 2);

    // Write off the quarantined expired lot -> resolves alert & emits STOCK_EXPIRY_WRITEOFF
    const writeOff = await h.expiryService.writeOffLot(tenantA, expiredLot.id, {
      quantity: 5,
      source: "QUARANTINED",
      reason: "Expired past shelf life",
      disposalMethod: "INCINERATION",
    });
    assert.equal(writeOff.totalLossCents, 600);
    assert.equal(expiredLot.quarantinedQty, 0);

    const resolvedAlert = Array.from(h.expiryAlerts.values()).find(
      (a) => a.stockLotId === expiredLot.id,
    );
    assert.equal(resolvedAlert?.status, ExpiryAlertStatus.RESOLVED);

    // Dispatch pending outbox events -> sends email via EmailService & records attempts
    const dispatchRes = await h.outboxService.dispatchPendingEvents(25, "org_a");
    assert.ok(dispatchRes.processedCount >= 2);
    assert.ok(h.sentEmails.length >= 3);

    // Consumer claim & acknowledge flow (isolated per org)
    h.setOrg("org_b");
    const tenantB = {
      organizationId: "org_b",
      memberId: "mem_3",
      role: "owner",
      userId: "user_owner_b",
    };
    const orgBOutbox = await h.outboxService.listOutboxEvents(tenantB, { limit: 25 });
    assert.equal(orgBOutbox.items.length, 0);

    // Test extendLotExpiry resolves open critical alert when pushed outside warning window
    h.setOrg("org_a");
    await h.expiryService.extendLotExpiry(tenantA, critLot.id, {
      newExpiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      reason: "Lab stability extension approved",
    });
    const critAlert = Array.from(h.expiryAlerts.values()).find(
      (a) => a.stockLotId === critLot.id,
    );
    assert.equal(critAlert?.status, ExpiryAlertStatus.RESOLVED);
  });

  it("enforces SSRF guards, AES-256-GCM encryption, HMAC signing & HTML escaping for webhooks/email", () => {
    const secret = generateWebhookSigningSecret();
    assert.ok(secret.startsWith("whsec_"));
    const encrypted = encryptCommunicationSecret(secret);
    assert.equal(decryptCommunicationSecret(encrypted), secret);
    assert.equal(maskSecretTail(secret), `****${secret.slice(-4)}`);

    const sig = signWebhookPayload(secret, 1700000000, '{"hello":"world"}');
    assert.match(sig, /^t=1700000000,v1=[a-f0-9]{64}$/);

    assert.equal(
      validateWebhookDestinationUrl("https://hooks.partner.com/scace", false, true),
      "https://hooks.partner.com/scace",
    );
    assert.throws(() =>
      validateWebhookDestinationUrl("http://127.0.0.1:8080/hook", false, false),
    );
    assert.throws(() =>
      validateWebhookDestinationUrl("http://169.254.169.254/latest/meta-data", false, false),
    );
    assert.throws(() =>
      validateWebhookDestinationUrl("http://10.0.5.10/internal", false, false),
    );
    assert.throws(() =>
      validateWebhookDestinationUrl("http://hooks.partner.com/plain", false, true),
    );

    assert.equal(
      escapeEmailHtml('<script>alert("x")</script>'),
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });
});

describe("Multi-Domain Operational Reporting, Exports & Schedules", () => {
  it("generates all 4 report domains with strict tenant isolation, safe CSV, and valid PDF exports", async () => {
    const h = createTestHarness();
    h.seedBalance("org_a", "item_milk", "loc_a", 20);
    h.seedBalance("org_b", "item_sugar", "loc_b", 999);
    h.seedLot({
      organizationId: "org_a",
      itemId: "item_milk",
      locationId: "loc_a",
      lotNumber: "LOT-REP-1",
      expiresAt: new Date(Date.now() + 2 * 86_400_000),
      onHandQty: 20,
      unitCostCents: 120,
    });

    const tenantA = {
      organizationId: "org_a",
      memberId: "mem_1",
      role: "owner",
      userId: "user_owner_a",
    };

    const inv = await h.reportsService.queryDomainReport(
      tenantA,
      ReportDomain.INVENTORY_EXPIRY,
      {},
    );
    assert.equal(inv.summaryKpis.totalOnHandUnits, 20);
    assert.equal(inv.rows.length, 1);

    const sales = await h.reportsService.queryDomainReport(
      tenantA,
      ReportDomain.SALES_MPESA,
      {},
    );
    assert.equal(sales.summaryKpis.orderCount, 1);
    assert.equal(sales.summaryKpis.mpesaSucceededCount, 1);
    assert.equal(sales.summaryKpis.mpesaSettledAmount, "250.00");

    const proc = await h.reportsService.queryDomainReport(
      tenantA,
      ReportDomain.PROCUREMENT_CLAIMS,
      {},
    );
    assert.equal(proc.summaryKpis.purchaseOrderCount, 1);
    assert.equal(proc.summaryKpis.accountsPayableBalance, "250.00");
    assert.equal(proc.summaryKpis.openClaimCount, 1);

    const prod = await h.reportsService.queryDomainReport(
      tenantA,
      ReportDomain.PRODUCTION_COSTING,
      {},
    );
    assert.equal(prod.summaryKpis.batchCount, 1);
    assert.equal(prod.summaryKpis.overallYieldPct, "95%");

    // Verify CSV formula injection neutralization on supplierName starting with '='
    assert.equal(sanitizeCsvCell("=SUM(A1:A2)"), "'=SUM(A1:A2)");
    assert.equal(sanitizeCsvCell("+cmd|' /C calc'!A0"), "'+cmd|' /C calc'!A0");
    assert.equal(sanitizeCsvCell(-125), "-125");

    const csvExport = await h.reportsService.exportReport(
      tenantA,
      ReportDomain.PROCUREMENT_CLAIMS,
      ReportFormat.CSV,
      {},
    );
    assert.ok(String(csvExport.body).includes("'=HYPERLINK("));

    // Verify PDF export header & EOF structure
    const pdfExport = await h.reportsService.exportReport(
      tenantA,
      ReportDomain.PRODUCTION_COSTING,
      ReportFormat.PDF,
      {},
    );
    const pdfBuf = pdfExport.body as Buffer;
    assert.ok(Buffer.isBuffer(pdfBuf));
    assert.ok(pdfBuf.toString("latin1").startsWith("%PDF-1.4\n"));
    assert.ok(pdfBuf.toString("latin1").includes("%%EOF"));

    // Verify schedule nextRunAt UTC computation & schedule execution -> outbox handoff
    const nextDaily = computeNextRunAt(
      ReportFrequency.DAILY,
      6,
      null,
      null,
      new Date("2026-11-26T08:00:00Z"),
    );
    assert.equal(nextDaily.toISOString(), "2026-11-27T06:00:00.000Z");

    const sched = await h.reportsService.createSchedule(tenantA, {
      name: "Daily Sales & M-Pesa Close",
      domain: ReportDomain.SALES_MPESA,
      format: ReportFormat.PDF,
      frequency: ReportFrequency.DAILY,
      cronHourUtc: 18,
      recipientEmails: ["cfo@alpha.test"],
      channelHints: [CommunicationChannel.EMAIL, CommunicationChannel.IN_APP],
    });

    const runOutcome = await h.reportsService.runScheduleNow(tenantA, sched.id);
    assert.equal(runOutcome.run.status, "COMPLETED");
    assert.equal(runOutcome.run.rowCount, 1);
    assert.ok(runOutcome.outboxEventId);

    const outboxEvent = h.outboxEvents.get(runOutcome.outboxEventId);
    assert.equal(outboxEvent?.eventType, CommunicationEventType.SCHEDULED_REPORT_READY);
    assert.ok(outboxEvent?.targetEmails.includes("cfo@alpha.test"));
    assert.equal(
      outboxEvent?.deliveryStatus,
      OutboxDeliveryStatus.PENDING,
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  MpesaC2bResponseType,
  MpesaEnvironment,
  MpesaShortcodeType,
  OrderChannel,
  OrderStatus,
  PaymentMethod,
  PaymentTransactionStatus,
  SalesInvoiceStatus,
} from "@scace/db";
import { generateRandomToken } from "../auth/crypto.utils.js";
import { hasOrganizationPermission } from "../auth/permissions.js";
import { scrubObject, scrubStringValue } from "../observability/scrubbing.utils.js";
import { renderReceiptHtml } from "../orders/document-renderer.utils.js";
import { MpesaConfigService } from "./mpesa-config.service.js";
import { MpesaDarajaClient } from "./mpesa-daraja.client.js";
import { MpesaPaymentService } from "./mpesa-payment.service.js";
import {
  centsToDarajaWholeAmount,
  decryptPaymentSecret,
  encryptPaymentSecret,
  formatDarajaTimestamp,
  generateDarajaStkPassword,
  maskSecretTail,
  normalizeKenyanPhoneNumber,
  parseDarajaAmountToCents,
  validateIpAllowlistEntries,
} from "./mpesa-security.utils.js";
import { MpesaSettlementService } from "./mpesa-settlement.service.js";

describe("M-Pesa Security & Daraja Utilities", () => {
  it("encrypts and decrypts payment secrets with AES-256-GCM and masks tails", () => {
    const secret = "daraja_super_secret_consumer_key_9876";
    const encrypted = encryptPaymentSecret(secret);
    assert.ok(encrypted.startsWith("v1:"));
    assert.notEqual(encrypted, secret);
    assert.equal(decryptPaymentSecret(encrypted), secret);
    assert.equal(maskSecretTail(secret), "****9876");
  });

  it("normalizes Kenyan phone numbers and rejects invalid formats", () => {
    assert.equal(normalizeKenyanPhoneNumber("0712345678"), "254712345678");
    assert.equal(normalizeKenyanPhoneNumber("+254 712-345-678"), "254712345678");
    assert.equal(normalizeKenyanPhoneNumber("0110123456"), "254110123456");
    assert.throws(() => normalizeKenyanPhoneNumber("12345"));
    assert.throws(() => normalizeKenyanPhoneNumber("254812345678"));
  });

  it("generates EAT timestamps and base64 STK passwords accurately", () => {
    const sampleDate = new Date("2026-11-25T09:30:15.000Z"); // 12:30:15 EAT
    const ts = formatDarajaTimestamp(sampleDate);
    assert.equal(ts, "20261125123015");
    const pw = generateDarajaStkPassword("174379", "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919", ts);
    assert.equal(
      Buffer.from(pw, "base64").toString("utf8"),
      "174379bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c91920261125123015",
    );
  });

  it("validates whole shilling amounts and C2B decimal amounts", () => {
    assert.equal(centsToDarajaWholeAmount(15000), 150);
    assert.throws(() => centsToDarajaWholeAmount(50));
    assert.throws(() => centsToDarajaWholeAmount(15050));
    assert.equal(parseDarajaAmountToCents("1500.50"), 150050);
  });

  it("validates IP allowlist CIDRs and scrubs M-Pesa secrets in telemetry", () => {
    assert.deepEqual(
      validateIpAllowlistEntries(["196.201.214.200/32", " 196.201.214.206 "]),
      ["196.201.214.200/32", "196.201.214.206"],
    );
    assert.throws(() => validateIpAllowlistEntries(["not-an-ip"]));

    const scrubbed = scrubObject({
      consumerKey: "abc123456",
      consumerSecret: "sec999999",
      passkey: "pk12345678",
      businessShortCode: "174379",
    });
    assert.equal(scrubbed.consumerKey, "[REDACTED]");
    assert.equal(scrubbed.consumerSecret, "[REDACTED]");
    assert.equal(scrubbed.passkey, "[REDACTED]");
    assert.equal(scrubbed.businessShortCode, "174379");
    assert.equal(
      scrubStringValue("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload123.sig123"),
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("restricts M-Pesa configuration permission to owner and admin roles", () => {
    assert.equal(hasOrganizationPermission("admin", { payment: ["configure"] }), true);
    assert.equal(hasOrganizationPermission("owner", { payment: ["configure"] }), true);
    assert.equal(hasOrganizationPermission("manager", { payment: ["configure"] }), false);
    assert.equal(hasOrganizationPermission("member", { payment: ["configure"] }), false);
    assert.equal(hasOrganizationPermission("manager", { payment: ["reconcile"] }), true);
    assert.equal(hasOrganizationPermission("member", { payment: ["record"] }), true);
  });
});

describe("M-Pesa Multi-Tenant Isolation, Callback Hardening & Settlement", () => {
  function createInMemoryHarness() {
    const configs = new Map<string, any>();
    const txRecords = new Map<string, any>();
    const invoices = new Map<string, any>();
    const orders = new Map<string, any>();
    const fulfillments = new Map<string, any>();
    const payments = new Map<string, any>();
    const receipts = new Map<string, any>();
    const stockBalances = new Map<string, any>();
    const auditLogs: any[] = [];
    const analyticsEvents: any[] = [];

    let idSeq = 1;
    const nextId = (prefix: string) => `${prefix}_${idSeq++}`;

    const rawDb: any = {
      organization: {
        findUnique: async ({ where }: any) => ({
          id: where.id,
          name: where.id === "org_a" ? "Org Alpha" : "Org Beta",
        }),
      },
      tenantSettings: {
        findUnique: async ({ where }: any) => ({
          organizationId: where.organizationId,
          companyLegalName: where.organizationId === "org_a" ? "Org Alpha Ltd" : "Org Beta Ltd",
        }),
      },
      mpesaConfiguration: {
        findUnique: async ({ where }: any) => {
          if (where.organizationId) {
            return configs.get(where.organizationId) ?? null;
          }
          if (where.callbackRouteTokenHash) {
            for (const c of configs.values()) {
              if (c.callbackRouteTokenHash === where.callbackRouteTokenHash) {
                return c;
              }
            }
          }
          return null;
        },
        findFirst: async ({ where }: any) => {
          return rawDb.mpesaConfiguration.findUnique({ where });
        },
        create: async ({ data }: any) => {
          const rec = {
            id: nextId("mpcfg"),
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          configs.set(rec.organizationId, rec);
          return rec;
        },
        update: async ({ where, data }: any) => {
          const current = configs.get(where.organizationId);
          const updated = { ...current, ...data, updatedAt: new Date() };
          configs.set(where.organizationId, updated);
          return updated;
        },
      },
      paymentTransaction: {
        findFirst: async ({ where }: any) => {
          for (const t of txRecords.values()) {
            if (where.id && t.id !== where.id) continue;
            if (where.organizationId && t.organizationId !== where.organizationId) continue;
            if (where.checkoutRequestId && t.checkoutRequestId !== where.checkoutRequestId) continue;
            if (where.mpesaReceiptNumber && t.mpesaReceiptNumber !== where.mpesaReceiptNumber) continue;
            if (where.status && t.status !== where.status) continue;
            if (where.id?.not && t.id === where.id.not) continue;
            return t;
          }
          return null;
        },
        findFirstOrThrow: async ({ where }: any) => {
          const found = await rawDb.paymentTransaction.findFirst({ where });
          if (!found) throw new Error("Not found");
          return found;
        },
        findUnique: async ({ where }: any) => txRecords.get(where.id) ?? null,
        create: async ({ data }: any) => {
          const rec = {
            id: nextId("ptx"),
            customerPaymentId: null,
            resultCode: null,
            resultDesc: null,
            mpesaReceiptNumber: null,
            payerName: null,
            callbackMetadata: null,
            rawCallbackPayload: null,
            reconciledByUserId: null,
            reconciledAt: null,
            completedAt: null,
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          txRecords.set(rec.id, rec);
          return rec;
        },
        update: async ({ where, data }: any) => {
          const curr = txRecords.get(where.id);
          const next = { ...curr, ...data, updatedAt: new Date() };
          txRecords.set(where.id, next);
          return next;
        },
        updateMany: async ({ where, data }: any) => {
          let count = 0;
          for (const [id, curr] of txRecords.entries()) {
            if (where.id && curr.id !== where.id) continue;
            if (where.organizationId && curr.organizationId !== where.organizationId) continue;
            if (where.customerPaymentId === null && curr.customerPaymentId !== null) continue;
            if (where.status?.in && !where.status.in.includes(curr.status)) continue;
            if (typeof where.status === "string" && curr.status !== where.status) continue;
            txRecords.set(id, { ...curr, ...data, updatedAt: new Date() });
            count++;
          }
          return { count };
        },
      },
      salesInvoice: {
        findFirst: async ({ where }: any) => {
          for (const inv of invoices.values()) {
            if (where.id && inv.id !== where.id) continue;
            if (where.organizationId && inv.organizationId !== where.organizationId) continue;
            if (where.invoiceNumber && inv.invoiceNumber !== where.invoiceNumber) continue;
            if (where.status?.in && !where.status.in.includes(inv.status)) continue;
            return {
              ...inv,
              order: orders.get(inv.orderId),
            };
          }
          return null;
        },
        update: async ({ where, data }: any) => {
          const curr = invoices.get(where.id);
          const next = { ...curr, ...data, updatedAt: new Date() };
          invoices.set(where.id, next);
          return next;
        },
        updateMany: async ({ where, data }: any) => {
          const curr = invoices.get(where.id);
          if (!curr || curr.organizationId !== where.organizationId) return { count: 0 };
          if (
            where.paidAmountCents !== undefined &&
            curr.paidAmountCents !== where.paidAmountCents
          ) {
            return { count: 0 };
          }
          if (where.status?.in && !where.status.in.includes(curr.status)) {
            return { count: 0 };
          }
          invoices.set(where.id, { ...curr, ...data, updatedAt: new Date() });
          return { count: 1 };
        },
      },
      order: {
        findFirst: async ({ where }: any) => {
          for (const ord of orders.values()) {
            if (where.id && ord.id !== where.id) continue;
            if (where.organizationId && ord.organizationId !== where.organizationId) continue;
            if (where.orderNumber && ord.orderNumber !== where.orderNumber) continue;
            if (where.status?.notIn && where.status.notIn.includes(ord.status)) continue;
            return ord;
          }
          return null;
        },
        update: async ({ where, data }: any) => {
          const curr = orders.get(where.id);
          const next = { ...curr, ...data, updatedAt: new Date() };
          orders.set(where.id, next);
          return next;
        },
        updateMany: async ({ where, data }: any) => {
          const curr = orders.get(where.id);
          if (!curr || curr.organizationId !== where.organizationId) return { count: 0 };
          if (
            where.paidAmountCents !== undefined &&
            curr.paidAmountCents !== where.paidAmountCents
          ) {
            return { count: 0 };
          }
          orders.set(where.id, { ...curr, ...data, updatedAt: new Date() });
          return { count: 1 };
        },
      },
      orderLine: {
        update: async ({ where, data }: any) => {
          for (const ord of orders.values()) {
            const line = ord.lines.find((l: any) => l.id === where.id);
            if (line) {
              Object.assign(line, data);
              return line;
            }
          }
          return null;
        },
      },
      orderFulfillment: {
        findFirst: async ({ where }: any) => {
          for (const ful of fulfillments.values()) {
            if (where.id && ful.id !== where.id) continue;
            if (where.organizationId && ful.organizationId !== where.organizationId) continue;
            if (where.fulfillmentNumber && ful.fulfillmentNumber !== where.fulfillmentNumber) continue;
            return {
              ...ful,
              order: orders.get(ful.orderId),
            };
          }
          return null;
        },
        update: async ({ where, data }: any) => {
          const curr = fulfillments.get(where.id);
          const next = { ...curr, ...data, updatedAt: new Date() };
          fulfillments.set(where.id, next);
          return next;
        },
      },
      item: {
        findFirstOrThrow: async ({ where }: any) => ({
          id: where.id,
          sku: "SKU-1",
          trackInventory: true,
          allowNegativeStock: false,
          trackExpiry: false,
          lotAllocationStrategy: "FEFO",
        }),
      },
      location: {
        findFirst: async ({ where }: any) => ({
          id: where.id,
          code: "MAIN",
        }),
      },
      stockLot: {
        findMany: async () => [],
      },
      stockBalance: {
        findUnique: async ({ where }: any) => {
          const key = `${where.organizationId_itemId_locationId.organizationId}:${where.organizationId_itemId_locationId.itemId}:${where.organizationId_itemId_locationId.locationId}`;
          return stockBalances.get(key) ?? null;
        },
        update: async ({ where, data }: any) => {
          for (const [key, bal] of stockBalances.entries()) {
            if (bal.id === where.id) {
              const next = { ...bal, ...data };
              stockBalances.set(key, next);
              return next;
            }
          }
          return null;
        },
      },
      stockMovement: {
        create: async ({ data }: any) => ({ id: nextId("mv"), ...data }),
      },
      customerPayment: {
        create: async ({ data }: any) => {
          const rec = { id: nextId("pay"), ...data };
          payments.set(rec.id, rec);
          return rec;
        },
      },
      paymentReceipt: {
        create: async ({ data }: any) => {
          const rec = { id: nextId("rcp"), ...data };
          receipts.set(rec.id, rec);
          return rec;
        },
      },
      auditLog: {
        create: async ({ data }: any) => {
          auditLogs.push(data);
          return data;
        },
      },
      $transaction: async (fn: (tx: any) => Promise<any>) => fn(rawDb),
    };

    const prismaService: any = {
      raw: rawDb,
      scoped: rawDb,
    };
    const redisService: any = {
      getJson: async () => null,
      setJson: async () => undefined,
    };
    const analyticsService: any = {
      captureDomainEvent: (ev: any) => analyticsEvents.push(ev),
    };

    const darajaClient = new MpesaDarajaClient(redisService);
    const configService = new MpesaConfigService(prismaService, darajaClient);
    const settlementService = new MpesaSettlementService(
      prismaService,
      analyticsService,
    );
    const paymentService = new MpesaPaymentService(
      prismaService,
      configService,
      darajaClient,
      settlementService,
      analyticsService,
    );

    return {
      configs,
      txRecords,
      invoices,
      orders,
      fulfillments,
      payments,
      receipts,
      stockBalances,
      auditLogs,
      configService,
      paymentService,
    };
  }

  it("enforces strict org isolation, IP allowlist, txToken verification, and idempotent POS STK settlement", async () => {
    const h = createInMemoryHarness();
    const adminA: any = { userId: "usr_a", organizationId: "org_a", role: "admin" };
    const adminB: any = { userId: "usr_b", organizationId: "org_b", role: "admin" };

    const cfgA = await h.configService.upsertConfig(adminA, {
      isEnabled: true,
      environment: MpesaEnvironment.LOCAL_SIMULATOR,
      shortcodeType: MpesaShortcodeType.PAYBILL,
      businessShortCode: "600111",
      consumerKey: "ck_alpha_1234",
      consumerSecret: "cs_alpha_5678",
      passkey: "pk_alpha_abcdefgh",
      callbackIpAllowlist: ["196.201.214.0/24"],
    });
    assert.equal(cfgA.maskedConsumerKey, "****1234");
    assert.equal(cfgA.maskedConsumerSecret, "****5678");
    assert.equal(cfgA.maskedPasskey, "****efgh");

    const cfgB = await h.configService.upsertConfig(adminB, {
      isEnabled: true,
      environment: MpesaEnvironment.LOCAL_SIMULATOR,
      shortcodeType: MpesaShortcodeType.TILL,
      businessShortCode: "700222",
    });

    const orgAToken = cfgA.callbackUrls.c2bConfirmationUrl
      .split("/api/v1/webhooks/daraja/o/")[1]!
      .split("/")[0]!;
    const orgBToken = cfgB.callbackUrls.c2bConfirmationUrl
      .split("/api/v1/webhooks/daraja/o/")[1]!
      .split("/")[0]!;

    // Seed Org A POS order with reserved stock
    h.stockBalances.set("org_a:item_1:loc_1", {
      id: "bal_1",
      organizationId: "org_a",
      itemId: "item_1",
      locationId: "loc_1",
      onHandQty: 10,
      reservedQty: 2,
    });
    h.orders.set("ord_a1", {
      id: "ord_a1",
      organizationId: "org_a",
      orderNumber: "POS-A1",
      channel: OrderChannel.POS,
      status: OrderStatus.CONFIRMED,
      locationId: "loc_1",
      location: { id: "loc_1", code: "MAIN", name: "Main Store" },
      customerId: null,
      customer: null,
      currency: "KES",
      subtotalCents: 25000,
      discountTotalCents: 0,
      taxCents: 0,
      totalCents: 25000,
      paidAmountCents: 0,
      notes: null,
      fulfillment: null,
      invoices: [],
      lines: [
        {
          id: "ol_1",
          itemId: "item_1",
          sku: "SKU-1",
          name: "Coffee Beans 1kg",
          description: "Coffee Beans 1kg",
          unitOfMeasure: "bag",
          quantity: 2,
          fulfilledQty: 0,
          orderedBaseQty: 2,
          reservedBaseQty: 2,
          fulfilledBaseQty: 0,
          unitPriceCents: 12500,
          discountCents: 0,
          lineTotalCents: 25000,
          item: { id: "item_1", sku: "SKU-1", trackInventory: true, isBundle: false },
        },
      ],
    });

    const stkInit = await h.paymentService.initiateStkPushForOrder(adminA, "ord_a1", {
      phoneNumber: "0712345678",
    });
    assert.equal(stkInit.transaction.status, PaymentTransactionStatus.PENDING);
    assert.ok(stkInit.simulatorTxToken);

    const payload = {
      Body: {
        stkCallback: {
          MerchantRequestID: stkInit.stkResponse.merchantRequestId,
          CheckoutRequestID: stkInit.stkResponse.checkoutRequestId,
          ResultCode: 0,
          ResultDesc: "Success",
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: 250 },
              { Name: "MpesaReceiptNumber", Value: "MPESA998877" },
              { Name: "TransactionDate", Value: "20261125120000" },
              { Name: "PhoneNumber", Value: 254712345678 },
            ],
          },
        },
      },
    };

    // 1. Disallowed IP rejected
    await assert.rejects(
      () =>
        h.paymentService.handleStkCallback({
          orgToken: orgAToken,
          txToken: stkInit.simulatorTxToken!,
          payload,
          clientIp: "10.0.0.5",
        }),
      ForbiddenException,
    );

    // 2. Cross-org callback token rejected even with valid CheckoutRequestID
    await assert.rejects(
      () =>
        h.paymentService.handleStkCallback({
          orgToken: orgBToken,
          txToken: stkInit.simulatorTxToken!,
          payload,
          clientIp: "196.201.214.10",
        }),
      UnauthorizedException,
    );

    // 3. Forged per-transaction token rejected
    await assert.rejects(
      () =>
        h.paymentService.handleStkCallback({
          orgToken: orgAToken,
          txToken: generateRandomToken(24),
          payload,
          clientIp: "196.201.214.10",
        }),
      UnauthorizedException,
    );

    // 4. Valid Org A token + IP + txToken settles order, stock, payment & receipt
    const ack1 = await h.paymentService.handleStkCallback({
      orgToken: orgAToken,
      txToken: stkInit.simulatorTxToken!,
      payload,
      clientIp: "196.201.214.10",
    });
    assert.equal(ack1.ResultCode, 0);

    // 5. Duplicate callback retry is idempotent (only 1 payment & 1 receipt)
    const ack2 = await h.paymentService.handleStkCallback({
      orgToken: orgAToken,
      txToken: stkInit.simulatorTxToken!,
      payload,
      clientIp: "196.201.214.10",
    });
    assert.equal(ack2.ResultCode, 0);
    assert.equal(h.payments.size, 1);
    assert.equal(h.receipts.size, 1);
    const [settledPayment] = Array.from(h.payments.values());
    assert.equal(settledPayment.method, PaymentMethod.MPESA);

    const updatedOrder = h.orders.get("ord_a1");
    assert.equal(updatedOrder.status, OrderStatus.COMPLETED);
    assert.equal(updatedOrder.paidAmountCents, 25000);
    assert.equal(h.stockBalances.get("org_a:item_1:loc_1").onHandQty, 8);
    assert.equal(h.stockBalances.get("org_a:item_1:loc_1").reservedQty, 0);

    const [receipt] = Array.from(h.receipts.values());
    const html = renderReceiptHtml(receipt.snapshot);
    assert.ok(html.includes("MPESA998877"));
    assert.ok(html.includes("M-Pesa Receipt #"));

    // 6. Rotating callback token invalidates old orgAToken immediately
    const rotated = await h.configService.rotateCallbackToken(adminA);
    assert.notEqual(
      rotated.callbackUrls.c2bConfirmationUrl,
      cfgA.callbackUrls.c2bConfirmationUrl,
    );
    await assert.rejects(
      () =>
        h.paymentService.handleC2bValidation({
          orgToken: orgAToken,
          payload: {
            TransID: "C2B123",
            TransAmount: "100.00",
            BusinessShortCode: "600111",
            BillRefNumber: "INV-1",
          },
          clientIp: "196.201.214.10",
        }),
      UnauthorizedException,
    );
  });

  it("validates and settles C2B invoice payments and captures unmatched C2B safely", async () => {
    const h = createInMemoryHarness();
    const adminA: any = { userId: "usr_a", organizationId: "org_a", role: "admin" };

    const cfgA = await h.configService.upsertConfig(adminA, {
      isEnabled: true,
      environment: MpesaEnvironment.LOCAL_SIMULATOR,
      shortcodeType: MpesaShortcodeType.PAYBILL,
      businessShortCode: "600111",
      c2bResponseType: MpesaC2bResponseType.COMPLETED,
      c2bValidateReference: true,
    });
    const orgAToken = cfgA.callbackUrls.c2bConfirmationUrl
      .split("/api/v1/webhooks/daraja/o/")[1]!
      .split("/")[0]!;

    h.orders.set("ord_b2b", {
      id: "ord_b2b",
      organizationId: "org_a",
      orderNumber: "B2B-100",
      channel: OrderChannel.B2B,
      status: OrderStatus.FULFILLED,
      locationId: "loc_1",
      location: { id: "loc_1", code: "MAIN", name: "Main Warehouse" },
      customerId: "cust_1",
      customer: {
        id: "cust_1",
        code: "CUST-1",
        name: "Acme Buyer",
        companyName: "Acme Ltd",
        email: "ap@acme.test",
        phone: "254700000001",
        taxId: "PIN123",
      },
      currency: "KES",
      subtotalCents: 50000,
      discountTotalCents: 0,
      taxCents: 0,
      totalCents: 50000,
      paidAmountCents: 0,
      notes: null,
      fulfillment: null,
      lines: [],
    });
    h.invoices.set("inv_1", {
      id: "inv_1",
      organizationId: "org_a",
      invoiceNumber: "INV-100",
      orderId: "ord_b2b",
      customerId: "cust_1",
      status: SalesInvoiceStatus.ISSUED,
      currency: "KES",
      totalCents: 50000,
      paidAmountCents: 0,
    });

    // Validation rejects unknown reference
    const badVal = await h.paymentService.handleC2bValidation({
      orgToken: orgAToken,
      payload: {
        TransID: "T1",
        TransAmount: "500.00",
        BusinessShortCode: "600111",
        BillRefNumber: "UNKNOWN-INV",
      },
    });
    assert.equal(badVal.ResultCode, "C2B00012");

    // Validation rejects wrong shortcode
    await assert.rejects(
      () =>
        h.paymentService.handleC2bValidation({
          orgToken: orgAToken,
          payload: {
            TransID: "T2",
            TransAmount: "500.00",
            BusinessShortCode: "999999",
            BillRefNumber: "INV-100",
          },
        }),
      UnauthorizedException,
    );

    // Valid C2B validation & confirmation settles invoice partially then completes on second payment
    const goodVal = await h.paymentService.handleC2bValidation({
      orgToken: orgAToken,
      payload: {
        TransID: "C2B_P1",
        TransAmount: "200.00",
        BusinessShortCode: "600111",
        BillRefNumber: "INV-100",
      },
    });
    assert.equal(goodVal.ResultCode, 0);

    await h.paymentService.handleC2bConfirmation({
      orgToken: orgAToken,
      payload: {
        TransID: "C2B_P1",
        TransAmount: "200.00",
        BusinessShortCode: "600111",
        BillRefNumber: "INV-100",
        MSISDN: "254712345678",
        FirstName: "Jane",
        LastName: "Doe",
      },
    });
    assert.equal(h.invoices.get("inv_1").status, SalesInvoiceStatus.PARTIALLY_PAID);
    assert.equal(h.invoices.get("inv_1").paidAmountCents, 20000);

    // Unmatched C2B captured safely without failing Daraja confirmation
    await h.paymentService.handleC2bConfirmation({
      orgToken: orgAToken,
      payload: {
        TransID: "C2B_UNMATCHED",
        TransAmount: "300.00",
        BusinessShortCode: "600111",
        BillRefNumber: "TYPO-INV-100",
        MSISDN: "254712345678",
      },
    });
    const unmatched = Array.from(h.txRecords.values()).find(
      (t) => t.mpesaReceiptNumber === "C2B_UNMATCHED",
    );
    assert.equal(unmatched.status, PaymentTransactionStatus.UNMATCHED_C2B);

    // Admin manually reconciles unmatched C2B payment to INV-100
    const reconciled = await h.paymentService.reconcileUnmatchedC2b(
      adminA,
      unmatched.id,
      { targetType: "SALES_INVOICE", targetId: "inv_1" },
    );
    assert.equal(reconciled.transaction.status, PaymentTransactionStatus.SUCCEEDED);
    assert.equal(h.invoices.get("inv_1").status, SalesInvoiceStatus.PAID);
    assert.equal(h.orders.get("ord_b2b").status, OrderStatus.COMPLETED);
  });
});

#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

// 1. Verify dual ESM and CommonJS entrypoints load cleanly
const esm = await import(resolve(pkgRoot, "dist/esm/index.js"));
const cjs = require(resolve(pkgRoot, "dist/cjs/index.js"));

assert.equal(typeof esm.createScaceClient, "function");
assert.equal(typeof cjs.createScaceClient, "function");
assert.equal(typeof esm.isScaceApiError, "function");
assert.equal(typeof cjs.isScaceApiError, "function");
assert.ok(
  Array.isArray(esm.GENERATED_ENDPOINTS) && esm.GENERATED_ENDPOINTS.length >= 300,
  `Expected >= 300 generated endpoints, got ${esm.GENERATED_ENDPOINTS?.length}`,
);

// 2. Verify auth & domain namespaces on both ESM and CJS clients
const requests = [];
const mockFetch = async (url, init) => {
  const headers = new Headers(init?.headers);
  requests.push({
    url: String(url),
    method: init?.method ?? "GET",
    headers: Object.fromEntries(headers.entries()),
    body: init?.body,
    credentials: init?.credentials,
  });

  const parsedUrl = new URL(String(url));

  if (parsedUrl.pathname === "/api/v1/oauth/token") {
    return new Response(
      JSON.stringify({
        token_type: "Bearer",
        access_token: "jwt.mock.token",
        expires_in: 900,
        scope: "order:read",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  if (parsedUrl.pathname === "/api/v1/orders/missing") {
    return new Response(
      JSON.stringify({
        statusCode: 404,
        error: "Not Found",
        code: "NOT_FOUND",
        message: "Order missing was not found.",
        requestId: headers.get("x-request-id"),
        sentryEventId: "sentry_evt_123",
        timestamp: "2026-11-25T10:00:00.000Z",
        path: parsedUrl.pathname,
      }),
      {
        status: 404,
        headers: {
          "content-type": "application/json",
          "x-request-id": headers.get("x-request-id") ?? "",
        },
      },
    );
  }

  if (parsedUrl.pathname.endsWith("/pdf")) {
    return new Response(new Uint8Array([37, 80, 68, 70]), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="doc.pdf"',
      },
    });
  }

  if (parsedUrl.pathname.endsWith("/html")) {
    return new Response("<html><body>Receipt</body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return new Response(JSON.stringify({ ok: true, path: parsedUrl.pathname }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const sdk = esm.createScaceClient({
  baseUrl: "https://api.scace.test",
  auth: { type: "pat", token: "scace_pat_test_123" },
  organizationId: "org_abc",
  fetch: mockFetch,
});

// Verify namespace structure
for (const key of [
  "auth",
  "tenants",
  "invitations",
  "items",
  "variants",
  "locations",
  "inventory",
  "pricing",
  "customers",
  "crm",
  "orders",
  "invoices",
  "payments",
  "receipts",
  "suppliers",
  "purchaseOrders",
  "deliveries",
  "vendorBills",
  "engineering",
  "production",
  "staff",
  "departments",
  "teams",
  "schedules",
  "holidays",
  "timeOff",
  "calendar",
  "fulfillments",
  "staffJobs",
  "storage",
  "observability",
  "health",
  "system",
  "billing",
  "systemBilling",
]) {
  assert.ok(key in sdk, `Missing namespace sdk.${key}`);
}
for (const billingKey of [
  "getSubscription",
  "getBillingOptions",
  "listInvoices",
  "listPayments",
  "createCheckout",
  "initiateMpesaPayment",
  "queryMpesaStatus",
  "simulateMpesaCallback",
]) {
  assert.equal(typeof sdk.billing[billingKey], "function", `Missing sdk.billing.${billingKey}`);
}
for (const sysBillingKey of [
  "getPlatformConfig",
  "updatePlatformConfig",
  "upsertPlatformMpesaConfig",
  "rotatePlatformMpesaToken",
  "testPlatformMpesaConnection",
  "listPlans",
  "createPlan",
  "updatePlan",
  "listOrganizations",
  "getOrganizationBilling",
  "updateOrganizationSubscription",
  "upsertOrganizationOverride",
  "clearOrganizationOverride",
  "extendOrganizationTrial",
  "suspendOrganization",
  "reactivateOrganization",
  "createAdminInvoice",
  "markInvoicePaid",
  "waiveInvoice",
  "voidInvoice",
  "listAuditLogs",
  "listSystemAdmins",
  "setUserPlatformRole",
]) {
  assert.equal(
    typeof sdk.systemBilling[sysBillingKey],
    "function",
    `Missing sdk.systemBilling.${sysBillingKey}`,
  );
}
for (const variantKey of [
  "createOption",
  "listOptions",
  "createTemplate",
  "promoteToTemplate",
  "configureTemplateOptions",
  "previewMatrix",
  "generateMatrix",
  "createVariant",
  "bulkUpdateVariants",
  "resolveByAttributes",
  "getVariant",
  "updateVariant",
]) {
  assert.equal(typeof sdk.variants[variantKey], "function", `Missing sdk.variants.${variantKey}`);
}
for (const authKey of [
  "signUpWithEmail",
  "signInWithEmail",
  "signOut",
  "getSession",
  "setActiveOrganization",
  "me",
  "pats",
  "oauthClients",
  "devices",
  "oauth",
  "sso",
  "useToken",
  "useOrganization",
]) {
  assert.ok(authKey in sdk.auth, `Missing sdk.auth.${authKey}`);
}

// Test PAT + org header + query serialization + path encoding
await sdk.items.listItems({ limit: 10, search: "espresso" });
const itemReq = requests.at(-1);
assert.equal(itemReq.headers.authorization, "Bearer scace_pat_test_123");
assert.equal(itemReq.headers["x-organization-id"], "org_abc");
assert.ok(itemReq.headers["x-request-id"]);
assert.equal(
  itemReq.url,
  "https://api.scace.test/api/v1/items?limit=10&search=espresso",
);

// Test ScaceApiError + sdk.safe() result wrapper
await assert.rejects(
  () => sdk.orders.getOrder("missing"),
  (err) => {
    assert.ok(esm.isScaceApiError(err));
    assert.equal(err.statusCode, 404);
    assert.equal(err.code, "NOT_FOUND");
    assert.equal(err.sentryEventId, "sentry_evt_123");
    assert.ok(err.requestId);
    assert.equal(err.isNotFound(), true);
    return true;
  },
);

const safeRes = await sdk.safe(sdk.orders.getOrder("missing"));
assert.equal(safeRes.ok, false);
if (!safeRes.ok) {
  assert.equal(safeRes.error.code, "NOT_FOUND");
  assert.equal(safeRes.error.sentryEventId, "sentry_evt_123");
}

// Test binary & HTML response parsing
const pdf = await sdk.invoices.getInvoicePdf("inv_1");
assert.equal(pdf.contentType, "application/pdf");
assert.equal(pdf.data.byteLength, 4);
const html = await sdk.receipts.getReceiptHtml("rec_1");
assert.equal(html, "<html><body>Receipt</body></html>");

// Test multipart upload
await sdk.storage.uploadDirect({
  file: new Uint8Array([1, 2, 3]),
  filename: "test.bin",
  mimeType: "application/octet-stream",
  entityType: "ORGANIZATION",
  tags: ["coa"],
});
const uploadReq = requests.at(-1);
assert.ok(uploadReq.body instanceof FormData);

// Test OAuth2 client credentials auto-token + caching
sdk.setAuth({
  type: "oauth2ClientCredentials",
  clientId: "cli_1",
  clientSecret: "sec_1",
  scope: "order:read",
});
await sdk.orders.listOrders();
await sdk.orders.listOrders();
const tokenCalls = requests.filter((r) =>
  r.url.endsWith("/api/v1/oauth/token"),
);
assert.equal(tokenCalls.length, 1, "Expected OAuth2 M2M token to be cached");
assert.equal(requests.at(-1).headers.authorization, "Bearer jwt.mock.token");

// Test CJS bundle parity
const cjsSdk = cjs.createScaceClient({
  baseUrl: "https://api.scace.test",
  fetch: mockFetch,
});
const cjsHealth = await cjsSdk.health.check();
assert.equal(cjsHealth.ok, true);

console.log(
  `[scace-sdk:verify] All ESM/CJS, auth, error envelope, multipart, binary, and OAuth2 tests passed (${esm.GENERATED_ENDPOINTS.length} endpoints).`,
);

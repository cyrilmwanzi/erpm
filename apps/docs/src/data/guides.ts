export interface GuideCodeSnippet {
  language: "json" | "typescript" | "bash" | "text";
  label?: string;
  code: string;
}

export interface GuideTable {
  headers: string[];
  rows: string[][];
}

export interface GuideDefinitionItem {
  term: string;
  description: string;
}

export interface GuideSection {
  id: string;
  heading: string;
  paragraphs?: string[];
  definitions?: GuideDefinitionItem[];
  bullets?: string[];
  codeBlocks?: GuideCodeSnippet[];
  table?: GuideTable;
  callout?: {
    title: string;
    body: string;
    tone?: "info" | "warning";
  };
}

export interface GuidePage {
  slug: string;
  groupId: string;
  groupTitle: string;
  title: string;
  subtitle: string;
  lead: string;
  sections: GuideSection[];
}

export interface GuideGroup {
  id: string;
  title: string;
  defaultOpen?: boolean;
  items: { slug: string; title: string }[];
}

export const GUIDE_GROUPS: GuideGroup[] = [
  {
    id: "getting-started",
    title: "Getting Started",
    defaultOpen: false,
    items: [
      { slug: "overview", title: "System Overview" },
      { slug: "quickstart", title: "Quickstart" },
      { slug: "architecture", title: "Monorepo Architecture" },
    ],
  },
  {
    id: "api-fundamentals",
    title: "API",
    defaultOpen: true,
    items: [
      { slug: "test-mode", title: "Test Mode" },
      { slug: "request-mode", title: "Request Mode" },
      { slug: "authentication", title: "Authentication" },
      { slug: "object-structure", title: "Object Structure" },
      { slug: "pagination", title: "Pagination" },
      { slug: "webhooks", title: "Webhooks" },
    ],
  },
  {
    id: "use-cases",
    title: "Use Cases",
    defaultOpen: false,
    items: [
      { slug: "organizations-rbac", title: "Organizations & RBAC" },
      { slug: "inventory-expiry", title: "Stock Expiry & FEFO" },
      { slug: "reporting-communications", title: "Reporting & Outbox" },
      { slug: "billing-governance", title: "Billing & Free Trials" },
    ],
  },
  {
    id: "payment",
    title: "Payment",
    defaultOpen: false,
    items: [
      { slug: "mpesa-daraja", title: "M-Pesa Daraja Setup" },
      { slug: "c2b-stk-flows", title: "STK Push & C2B Flows" },
    ],
  },
  {
    id: "error-codes",
    title: "Error Codes",
    defaultOpen: false,
    items: [
      { slug: "error-codes", title: "Error Envelope & Codes" },
    ],
  },
  {
    id: "security",
    title: "Security & Authentication",
    defaultOpen: false,
    items: [
      { slug: "security", title: "Isolation & Encryption" },
      { slug: "oauth-sso", title: "OAuth2, Devices & SSO" },
    ],
  },
  {
    id: "sdk",
    title: "TypeScript SDK",
    defaultOpen: false,
    items: [
      { slug: "sdk-guide", title: "Using @scace/sdk" },
    ],
  },
  {
    id: "changelog",
    title: "Changelog",
    defaultOpen: false,
    items: [
      { slug: "changelog", title: "Release History" },
    ],
  },
  {
    id: "support",
    title: "Support",
    defaultOpen: false,
    items: [
      { slug: "support", title: "Troubleshooting & Limits" },
    ],
  },
];

export const GUIDE_PAGES: GuidePage[] = [
  {
    slug: "overview",
    groupId: "getting-started",
    groupTitle: "Getting Started",
    title: "System Overview",
    subtitle: "Multi-organization ERP backend, TypeScript SDK, and automated workflows",
    lead: "Scace is a modular, multi-organization ERP platform built on NestJS (Fastify), Prisma 7, PostgreSQL 18, Redis 7, and Better Auth Organizations. Every endpoint enforces strict organization data isolation, role- and scope-based access control, and subscription entitlements.",
    sections: [
      {
        id: "platform-capabilities",
        heading: "Core Platform Capabilities",
        paragraphs: [
          "The Scace API exposes 442 typed endpoints across 43 NestJS controllers covering catalog management, multi-location inventory with automated FEFO expiry tracking, procurement and vendor bills, manufacturing batches, POS and B2B order fulfillment, M-Pesa Daraja payments, scheduled reporting, communication webhooks, and organization billing.",
        ],
        definitions: [
          {
            term: "Organization Isolation",
            description:
              "Every organization-scoped route binds AsyncLocalStorage OrganizationContext and filters all Prisma queries automatically by the verified active organizationId.",
          },
          {
            term: "Unified Auth & Tokens",
            description:
              "Supports Better Auth browser sessions, Personal Access Tokens (scace_pat_*), OAuth2 client credentials, PKCE, RFC 8628 Device Flow, and Enterprise SAML/OIDC SSO.",
          },
          {
            term: "Automated SDK & Docs",
            description:
              "Both @scace/sdk and this documentation portal extract route signatures, Zod schemas, and permissions directly from controller TypeScript ASTs so reference docs never drift.",
          },
        ],
      },
      {
        id: "base-urls",
        heading: "Service Entry Points",
        table: {
          headers: ["Surface", "Base Path / Port", "Purpose"],
          rows: [
            ["API Root & Discovery", "GET /api/v1/health", "PostgreSQL, Redis, and RustFS storage readiness checks"],
            ["Better Auth", "/api/auth/*", "Email sign-up/sign-in, email verification, and organization switching"],
            ["Domain REST API", "/api/v1/*", "Organization-scoped ERP, billing, M-Pesa, reporting, and storage APIs"],
            ["OIDC / OAuth2", "/.well-known/openid-configuration", "OpenID discovery, JWKS public keys, authorize, token, and device endpoints"],
          ],
        },
      },
    ],
  },
  {
    slug: "quickstart",
    groupId: "getting-started",
    groupTitle: "Getting Started",
    title: "Quickstart",
    subtitle: "Configure your environment and execute your first authenticated API call",
    lead: "Follow these steps to inspect live API health, create an organization workspace, and query resources using either cURL or the official @scace/sdk package.",
    sections: [
      {
        id: "verify-health",
        heading: "1. Initialize @scace/sdk & Verify Readiness",
        paragraphs: [
          "Install @scace/sdk and instantiate a shared client once with your base URL, authentication token, and organizationId. All remaining SDK examples in these guides assume this initialized sdk instance.",
        ],
        codeBlocks: [
          {
            language: "typescript",
            label: "TYPESCRIPT SDK",
            code: `import { createScaceClient } from "@scace/sdk";

export const sdk = createScaceClient({
  baseUrl: "http://localhost:3000",
  auth: { type: "pat", token: process.env.SCACE_PAT! },
  organizationId: "org_01J9XYZ",
});

const health = await sdk.health.check();`,
          },
          {
            language: "json",
            label: "JSON",
            code: `{
  "status": "ok",
  "timestamp": "2026-11-27T10:51:29.985Z",
  "services": {
    "postgres": "up",
    "redis": "up",
    "rustfs": "up"
  }
}`,
          },
        ],
      },
      {
        id: "authenticate-and-scope",
        heading: "2. Query Organization Resources",
        paragraphs: [
          "Once sdk is initialized, call any organization-scoped domain namespace directly without repeating client setup.",
        ],
        codeBlocks: [
          {
            language: "typescript",
            label: "TYPESCRIPT SDK",
            code: `const overview = await sdk.organizations.getCurrentOrganization();
const items = await sdk.items.listItems({ limit: 25 });
console.log(overview.organization.name, items.items.length);`,
          },
        ],
      },
    ],
  },
  {
    slug: "architecture",
    groupId: "getting-started",
    groupTitle: "Getting Started",
    title: "Monorepo Architecture",
    subtitle: "Workspace packages, runtime boundaries, and Prisma isolation model",
    lead: "Scace is structured as a pnpm + Turborepo monorepo separating NestJS API services, Prisma database isolation, typed SDK distribution, and this TanStack Start developer portal.",
    sections: [
      {
        id: "workspace-diagram",
        heading: "System Topology",
        paragraphs: [
          "All packages share TypeScript 7 compiler presets and coordinate builds via Turborepo.",
        ],
        codeBlocks: [
          {
            language: "text",
            label: "ARCHITECTURE",
            code: `┌────────────────────┐      ┌──────────────────────────┐
│  @scace/docs       │      │  @scace/sdk              │
│  TanStack Start    │      │  Typed ESM + CJS Client  │
│  Guides + Try-It   │      │  442 AST Endpoints       │
└─────────┬──────────┘      └────────────┬─────────────┘
          │ /api/* & /.well-known/*       │ HTTPS / Bearer
          └──────────────┬───────────────┘
                         ▼
          ┌──────────────────────────────┐
          │  @scace/api (NestJS/Fastify) │
          │  Auth · RBAC · Billing Guard │
          │  M-Pesa · Expiry · Reports   │
          └──────┬───────────────┬───────┘
                 │               │
                 ▼               ▼
       ┌─────────────────┐  ┌──────────┐
       │  @scace/db      │  │ Redis 7  │
       │  Prisma 7 + PG  │  │ + RustFS │
       └─────────────────┘  └──────────┘`,
          },
        ],
      },
      {
        id: "packages-table",
        heading: "Workspace Packages",
        table: {
          headers: ["Package", "Role", "Key Export / Runtime"],
          rows: [
            ["@scace/api", "Core NestJS + Fastify REST server", "43 controllers, Better Auth, billing enforcement, background schedulers"],
            ["@scace/db", "Prisma 7 schema, migrations, and isolation client", "OrganizationContext, withOrganizationIsolation, organizationPrisma"],
            ["@scace/sdk", "Zero-dependency typed client library", "createScaceClient, PAT/OAuth2/Bearer auth, sdk.safe()"],
            ["@scace/docs", "TanStack Start documentation & Try-It portal", "SSR guides, AST API catalog, interactive schema & request runner"],
          ],
        },
      },
      {
        id: "docker-deployment",
        heading: "Docker & Release Containers",
        paragraphs: [
          "Both @scace/api (root Dockerfile) and @scace/docs (apps/docs/Dockerfile) ship multi-stage Node 22 container builds and are published to GHCR during tagged releases. Use apps/docs/docker-compose.yml to launch the documentation portal alongside the API, PostgreSQL 18, Redis 7, and RustFS.",
        ],
        codeBlocks: [
          {
            language: "bash",
            label: "BASH",
            code: `docker compose -f apps/docs/docker-compose.yml up --build`,
          },
        ],
      },
    ],
  },
  {
    slug: "test-mode",
    groupId: "api-fundamentals",
    groupTitle: "API",
    title: "Test Mode",
    subtitle: "Local simulators, sandbox credentials, and safe non-production verification",
    lead: "Scace includes built-in local simulation modes so teams can test M-Pesa STK Push, C2B PayBill/Till settlements, subscription billing, and webhook delivery without live carrier credentials or external database infrastructure.",
    sections: [
      {
        id: "mpesa-local-simulator",
        heading: "M-Pesa Local Simulator",
        paragraphs: [
          "Both organization M-Pesa configurations and platform-level subscription M-Pesa settings support an explicit LOCAL_SIMULATOR environment alongside SANDBOX and PRODUCTION.",
        ],
        definitions: [
          {
            term: "LOCAL_SIMULATOR",
            description:
              "Generates deterministic CheckoutRequestIDs and allows authorized admins to trigger simulated STK/C2B callbacks directly via the simulate endpoint for end-to-end POS and billing verification.",
          },
          {
            term: "SANDBOX",
            description:
              "Connects to Safaricom Daraja sandbox endpoints using encrypted organization or platform credentials and verifies incoming callbacks with per-org tokens and optional IP allowlists.",
          },
          {
            term: "PRODUCTION",
            description:
              "Enforces HTTPS public callback URLs, Daraja OAuth token caching, and strict cryptographic callback token verification.",
          },
        ],
        codeBlocks: [
          {
            language: "json",
            label: "JSON",
            code: `{
  "environment": "LOCAL_SIMULATOR",
  "shortcode": "174379",
  "shortcodeType": "PAYBILL",
  "resultCode": 0,
  "mpesaReceiptNumber": "SIM9K42XYZ"
}`,
          },
        ],
      },
      {
        id: "offline-database-fallback",
        heading: "Database Mock Fallback for Unit Suites",
        paragraphs: [
          "When DATABASE_URL is unreachable during automated unit tests, @scace/db transparently falls back to an in-memory Prisma client mock so utility and contract test suites remain deterministic offline.",
        ],
      },
    ],
  },
  {
    slug: "request-mode",
    groupId: "api-fundamentals",
    groupTitle: "API",
    title: "Request Mode",
    subtitle: "Organization context headers, correlation IDs, and billing response metadata",
    lead: "Every HTTP request through the Scace Fastify pipeline receives correlation tracing, strict input validation, and real-time organization entitlement headers.",
    sections: [
      {
        id: "standard-headers",
        heading: "Request & Response Headers",
        table: {
          headers: ["Header", "Direction", "Behavior"],
          rows: [
            ["Authorization", "Request", "Bearer <session_token | pat | oauth_access_token>"],
            ["X-Organization-Id", "Request", "Selects active organization context for multi-org PATs or overrides session org"],
            ["X-Request-Id", "Both", "Propagated or auto-generated UUID for end-to-end log and Sentry correlation"],
            ["X-Scace-Billing-Status", "Response", "Current organization entitlement state (TRIALING, ACTIVE, GRACE_PERIOD, LOCKED)"],
            ["X-Scace-Plan-Code", "Response", "Active subscription plan code (e.g., STARTER, GROWTH, ENTERPRISE)"],
            ["X-Scace-Grace-Ends-At", "Response", "Present when an organization is inside its post-trial or past-due grace window"],
          ],
        },
      },
      {
        id: "billing-enforcement-modes",
        heading: "Billing Lockout & Recovery Exemptions",
        paragraphs: [
          "OrganizationGuard enforces subscription status system-wide. During GRACE_PERIOD, all API calls succeed with warning headers. Once locked out, operational routes return HTTP 402 Payment Required while billing recovery endpoints decorated with @AllowWhenBillingLocked() remain accessible so owners can settle invoices via M-Pesa.",
        ],
      },
    ],
  },
  {
    slug: "authentication",
    groupId: "api-fundamentals",
    groupTitle: "API",
    title: "Authentication",
    subtitle: "Four unified authentication channels with RBAC and scope intersection",
    lead: "Scace unifies interactive browser authentication, developer tokens, machine-to-machine OAuth2 clients, and hardware POS/kiosk devices under a single authorization pipeline.",
    sections: [
      {
        id: "auth-methods",
        heading: "Supported Authentication Channels",
        definitions: [
          {
            term: "Better Auth Sessions (Cookie or Bearer)",
            description:
              "Interactive user sign-in via email/password or social SSO. Requires emailVerified === true before accessing any organization resource.",
          },
          {
            term: "Personal Access Tokens (scace_pat_*)",
            description:
              "User-owned developer credentials hashed with SHA-256 at rest and optionally bound to an explicit organizationId and grantedScopes list.",
          },
          {
            term: "OAuth2 Access Tokens",
            description:
              "Issued via client_credentials, Authorization Code + PKCE, or Device Authorization Grant (RFC 8628) using RS256/HS256 JWTs verifiable against /.well-known/jwks.json.",
          },
          {
            term: "System Admin Governance",
            description:
              "Routes under /api/v1/system/billing require a verified human user with PlatformRole.SYSTEM_ADMIN (seeded via SYSTEM_ADMIN_EMAILS); service principals are blocked.",
          },
        ],
      },
      {
        id: "effective-permissions",
        heading: "Effective Permission Resolution",
        paragraphs: [
          "When authenticating with a PAT or OAuth2 token, effective permissions equal the intersection of the caller's organization role (owner, admin, manager, member, viewer) and the token's grantedScopes.",
        ],
        codeBlocks: [
          {
            language: "typescript",
            label: "TYPESCRIPT SDK",
            code: `const permissions = await sdk.organizations.getPermissions();
console.log(permissions.role, permissions.permissions);`,
          },
        ],
      },
    ],
  },
  {
    slug: "object-structure",
    groupId: "api-fundamentals",
    groupTitle: "API",
    title: "Object Structure",
    subtitle: "Consistent identifier formats, minor-unit monetary values, and timestamps",
    lead: "Scace API payloads adhere to strict conventions across every resource so financial math, audit trails, and serialization remain predictable across clients.",
    sections: [
      {
        id: "conventions",
        heading: "Data Representation Rules",
        definitions: [
          {
            term: "Minor-Unit Monetary Integers",
            description:
              "Financial totals, unit costs, tax amounts, and balances are stored and exchanged as exact integer minor units (e.g., amountCents: 25000 for 250.00 KES) to prevent floating-point rounding drift.",
          },
          {
            term: "ISO-8601 UTC Timestamps",
            description:
              "All createdAt, updatedAt, expiresAt, and billing window fields serialize as UTC ISO-8601 strings ending in Z.",
          },
          {
            term: "Masked Secrets",
            description:
              "Credential endpoints (M-Pesa Daraja secrets, webhook signing secrets, CRM keys) never return plaintext secrets after write; responses expose only masked tails such as ****4821.",
          },
        ],
        codeBlocks: [
          {
            language: "json",
            label: "JSON",
            code: `{
  "organization": {
    "id": "org_01J9XYZ",
    "name": "Acme Roasters Ltd",
    "slug": "acme-roasters",
    "createdAt": "2026-11-12T08:30:00.000Z"
  },
  "settings": {
    "defaultCurrency": "KES",
    "timezone": "Africa/Nairobi",
    "fiscalYearStartMonth": 1,
    "storageQuotaBytes": 1073741824
  }
}`,
          },
        ],
      },
    ],
  },
  {
    slug: "pagination",
    groupId: "api-fundamentals",
    groupTitle: "API",
    title: "Pagination",
    subtitle: "Cursor-based and offset-free traversal across high-volume endpoints",
    lead: "List endpoints across items, stock movements, audit logs, orders, and outbox events support deterministic pagination with bounded limits.",
    sections: [
      {
        id: "cursor-pagination",
        heading: "Cursor Pagination Pattern",
        paragraphs: [
          "Pass limit (typically 1–100, defaulting to 25) and an opaque cursor returned from the previous response. When nextCursor is null, you have reached the end of the collection.",
        ],
        codeBlocks: [
          {
            language: "typescript",
            label: "TYPESCRIPT SDK",
            code: `const page = await sdk.organizations.getAuditLogs({
  limit: 25,
  cursor: "aud_01J9ABC",
});`,
          },
          {
            language: "json",
            label: "JSON",
            code: `{
  "items": [
    {
      "id": "aud_01J9DEF",
      "action": "organization.settings.updated",
      "resourceType": "OrganizationSettings",
      "createdAt": "2026-11-27T09:14:22.000Z"
    }
  ],
  "nextCursor": "aud_01J9XYZ"
}`,
          },
        ],
      },
    ],
  },
  {
    slug: "webhooks",
    groupId: "api-fundamentals",
    groupTitle: "API",
    title: "Webhooks",
    subtitle: "Real-time event delivery via the Communication Outbox and inbound M-Pesa callbacks",
    lead: "Webhooks provide a reliable way for Scace to push signed HTTP POST notifications whenever operational events occur—such as stock expiry alerts, scheduled reports completing, or M-Pesa payments settling—instead of polling.",
    sections: [
      {
        id: "configuring-webhooks",
        heading: "Configuring Outbound Webhooks",
        paragraphs: [
          "To configure outbound webhook endpoints for your organization via the Communications module, follow these steps:",
        ],
        definitions: [
          {
            term: "Provide Webhook URL",
            description:
              "Register a publicly reachable HTTPS endpoint under /api/v1/communications/webhooks. Scace validates DNS resolution and blocks loopback, link-local, and private RFC1918 ranges against SSRF.",
          },
          {
            term: "Select Event Triggers",
            description:
              "Subscribe to STOCK_EXPIRING_WARNING, STOCK_EXPIRING_CRITICAL, STOCK_EXPIRED, STOCK_EXPIRY_WRITEOFF, ON_DEMAND_REPORT_DISPATCH, or SCHEDULED_REPORT_READY, and attach AlertRules with cooldown windows.",
          },
          {
            term: "Verify HMAC Signatures",
            description:
              "Each delivery includes an X-Scace-Signature header formatted as t=<unix_seconds>,v1=<hmac_sha256_hex> computed over `${timestamp}.${rawBody}` using your encrypted signing secret (whsec_*).",
          },
        ],
      },
      {
        id: "webhook-payload",
        heading: "Webhook Payload",
        paragraphs: [
          "The outbound Communication Outbox delivers a structured JSON envelope containing the event metadata, organization ID, severity, and domain payload. Below is an example of an expiry or settlement webhook payload:",
        ],
        codeBlocks: [
          {
            language: "json",
            label: "JSON",
            code: `{
  "eventId": "out_01J9WRK92",
  "organizationId": "org_01J9XYZ",
  "eventType": "STOCK_EXPIRED",
  "severity": "CRITICAL",
  "subject": "Expired Stock Detected: Whole Milk 1L (LOT-EXP-01)",
  "payload": {
    "itemId": "item_milk_1l",
    "lotNumber": "LOT-EXP-01",
    "expiredQty": 5,
    "autoQuarantined": true
  },
  "timestamp": "2026-11-27T06:00:00.000Z"
}`,
          },
        ],
      },
      {
        id: "verifying-signature",
        heading: "Signature Verification Example",
        codeBlocks: [
          {
            language: "typescript",
            label: "TYPESCRIPT",
            code: `import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyScaceWebhook(
  rawBody: string,
  signatureHeader: string,
  signingSecret: string,
): boolean {
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => kv.split("=")),
  );
  const expected = createHmac("sha256", signingSecret)
    .update(\`\${parts.t}.\${rawBody}\`)
    .digest("hex");
  return timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
}`,
          },
        ],
      },
    ],
  },
  {
    slug: "organizations-rbac",
    groupId: "use-cases",
    groupTitle: "Use Cases",
    title: "Organizations & RBAC",
    subtitle: "Multi-organization workspaces, role hierarchy, invitations, and audit trails",
    lead: "Every resource in Scace belongs to an Organization. Users can hold memberships across multiple organizations with distinct roles and granular resource permissions.",
    sections: [
      {
        id: "role-matrix",
        heading: "Organization Roles",
        table: {
          headers: ["Role", "Scope Summary", "Restricted Actions"],
          rows: [
            ["owner", "Full administrative, billing, SSO, payment, and ownership control", "Cannot demote or remove the last remaining owner"],
            ["admin", "Full operational, settings, billing, M-Pesa, and SSO configuration", "Cannot modify or remove organization owners"],
            ["manager", "Catalog, inventory, expiry write-offs, procurement, production, reports", "Cannot edit organization settings or SSO configuration"],
            ["member", "Day-to-day sales orders, POS checkouts, receiving, production logs", "Cannot manage billing, webhooks, or invite admins"],
            ["viewer", "Read-only access across ERP modules and reports", "All mutations, exports, and secrets blocked"],
          ],
        },
      },
      {
        id: "org-endpoints",
        heading: "Organization Management Flow",
        paragraphs: [
          "All organization settings, member lists, invitations, and audit trails live under /api/v1/organizations/*.",
        ],
        codeBlocks: [
          {
            language: "typescript",
            label: "TYPESCRIPT",
            code: `const settings = await sdk.organizations.updateSettings({
  companyLegalName: "Acme Roasters Ltd",
  defaultCurrency: "KES",
  timezone: "Africa/Nairobi",
});

await sdk.organizations.createInvitation({
  email: "procurement@acme.co.ke",
  role: "manager",
});`,
          },
        ],
      },
    ],
  },
  {
    slug: "inventory-expiry",
    groupId: "use-cases",
    groupTitle: "Use Cases",
    title: "Stock Expiry & FEFO",
    subtitle: "Automated First-Expired-First-Out allocation, scheduled scans, and quarantine",
    lead: "Perishable inventory and batch-tracked goods are protected by automated FEFO lot allocation, configurable warning/critical expiry windows, scheduled daily scanning, auto-quarantine holds, and write-off accounting.",
    sections: [
      {
        id: "fefo-rules",
        heading: "FEFO Enforcement Modes",
        definitions: [
          {
            term: "BLOCK_EXPIRED",
            description:
              "Prevents expired stock lots from being allocated during order fulfillment, POS checkout, or inter-location transfers while sorting eligible lots earliest-expiry-first.",
          },
          {
            term: "WARN_ONLY",
            description:
              "Allows operations to proceed while flagging near-expiry lots and recording expiry alert events.",
          },
          {
            term: "Auto-Quarantine & Write-Off",
            description:
              "When autoQuarantineExpired is enabled, expired on-hand quantities move automatically to quarantinedQty during daily scans until inspected, extended, or written off with loss calculation.",
          },
        ],
      },
      {
        id: "manual-scan-example",
        heading: "Triggering a Policy Update & Scan",
        codeBlocks: [
          {
            language: "typescript",
            label: "TYPESCRIPT SDK",
            code: `await sdk.expiry.updatePolicy({
  warningDays: 30,
  criticalDays: 7,
  enforcementMode: "BLOCK_EXPIRED",
  autoQuarantineExpired: true,
  isScannerActive: true,
});

const scanSummary = await sdk.expiry.runScan();
console.log(scanSummary.expiredLotsCount, scanSummary.autoQuarantinedQty);`,
          },
        ],
      },
    ],
  },
  {
    slug: "reporting-communications",
    groupId: "use-cases",
    groupTitle: "Use Cases",
    title: "Reporting & Outbox",
    subtitle: "Four operational report domains, CSV/JSON/PDF exports, and alert routing",
    lead: "Scace provides live multi-domain operational reports, artifact storage in RustFS, scheduled UTC report dispatches, and a resilient Communication Outbox with rule-based cooldowns.",
    sections: [
      {
        id: "report-domains",
        heading: "Operational Report Domains",
        table: {
          headers: ["Domain", "Metrics & Rows Included", "Export Formats"],
          rows: [
            ["INVENTORY_EXPIRY", "Stock balances, valuation, expiry bucket classification, write-off losses", "JSON · CSV · PDF"],
            ["SALES_MPESA", "Orders, sales invoices, POS receipts, M-Pesa STK & C2B settlement totals", "JSON · CSV · PDF"],
            ["PROCUREMENT_CLAIMS", "Purchase orders, goods receipts, accounts payable bills, open supplier claims", "JSON · CSV · PDF"],
            ["PRODUCTION_COSTING", "Manufacturing batches, yield percentages, BOM consumption, unit cost variances", "JSON · CSV · PDF"],
          ],
        },
      },
      {
        id: "csv-pdf-safety",
        heading: "Export Safety & Outbox Dispatch",
        paragraphs: [
          "CSV exports neutralize spreadsheet formula injection (=, +, -, @ prefixes). Scheduled and on-demand dispatches store artifacts in organization-isolated buckets and emit structured CommunicationOutboxEvents for email and HMAC webhook consumers.",
        ],
      },
    ],
  },
  {
    slug: "billing-governance",
    groupId: "use-cases",
    groupTitle: "Use Cases",
    title: "Billing & Free Trials",
    subtitle: "Auto-provisioned trials, grace windows, quotas, and system admin overrides",
    lead: "New organizations automatically start a configurable free trial. Past-due or expired trials enter a grace period before transitioning to system-wide lockout, with M-Pesa self-service recovery and full system-admin governance.",
    sections: [
      {
        id: "lifecycle",
        heading: "Subscription Lifecycle",
        definitions: [
          {
            term: "TRIALING",
            description:
              "Provisioned automatically on organization creation for BILLING_DEFAULT_TRIAL_DAYS with full plan features and quota limits.",
          },
          {
            term: "GRACE_PERIOD",
            description:
              "Triggered when a trial or paid period expires without settlement. Requests continue with X-Scace-Billing-Status: GRACE_PERIOD headers.",
          },
          {
            term: "LOCKED (HTTP 402)",
            description:
              "Once the grace period ends, operational endpoints return HTTP 402 until an invoice is settled via M-Pesa or a system admin applies an override or trial extension.",
          },
        ],
      },
    ],
  },
  {
    slug: "mpesa-daraja",
    groupId: "payment",
    groupTitle: "Payment",
    title: "M-Pesa Daraja Setup",
    subtitle: "Per-organization encrypted Daraja credentials, passkeys, and callback security",
    lead: "Organization administrators configure Safaricom Daraja credentials (consumer key/secret, STK passkey, PayBill or Till shortcode) encrypted at rest with AES-256-GCM using dedicated key separation.",
    sections: [
      {
        id: "security-controls",
        heading: "Callback Hardening & Org Isolation",
        definitions: [
          {
            term: "Per-Organization Callback Token",
            description:
              "Each MpesaConfiguration generates a high-entropy callbackToken (hashed with SHA-256) and embeds an organization-scoped txToken on callback URLs so callbacks cannot cross organization boundaries.",
          },
          {
            term: "Optional CIDR IP Allowlist",
            description:
              "Admins may restrict incoming Daraja STK and C2B webhooks to explicit Safaricom IPv4/CIDR blocks.",
          },
          {
            term: "Idempotent Ledger Settlement",
            description:
              "Duplicate Daraja callbacks or concurrent STK status queries are safely deduplicated via M-Pesa CheckoutRequestID / TransID checks before creating CustomerPayment and PaymentReceipt records.",
          },
        ],
      },
    ],
  },
  {
    slug: "c2b-stk-flows",
    groupId: "payment",
    groupTitle: "Payment",
    title: "STK Push & C2B Flows",
    subtitle: "Settling POS checkouts, B2B sales invoices, and order fulfillment deposits",
    lead: "Scace supports both synchronous customer-initiated M-Pesa STK Push (Lipa Na M-Pesa Online) and asynchronous C2B PayBill/Till webhooks.",
    sections: [
      {
        id: "stk-push",
        heading: "1. Initiating STK Push",
        paragraphs: [
          "Kenyan MSISDNs (07..., +254..., 254...) are normalized automatically to 2547XXXXXXXX / 2541XXXXXXXX and amounts are validated in whole KES shillings.",
        ],
        codeBlocks: [
          {
            language: "typescript",
            label: "TYPESCRIPT SDK",
            code: `const stk = await sdk.invoices.initiateInvoiceMpesaStkPush("inv_01J9XYZ", {
  phoneNumber: "0712345678",
});

// Reconcile manually if callback is delayed:
const status = await sdk.mpesa.queryStatus(stk.transaction.id);`,
          },
        ],
      },
      {
        id: "c2b-webhooks",
        heading: "2. C2B Validation & Confirmation",
        paragraphs: [
          "Register C2B URLs with Daraja via POST /api/v1/payments/mpesa/c2b/register-urls. When BillRefNumber matches an open sales invoice or order number, Scace settles the balance and issues a receipt; unmatched payments are safely captured in an unmatched queue for manual reconciliation.",
        ],
      },
    ],
  },
  {
    slug: "error-codes",
    groupId: "error-codes",
    groupTitle: "Error Codes",
    title: "Error Envelope & Codes",
    subtitle: "Uniform JSON error structure and HTTP status semantics",
    lead: "Every error response from Scace API uses a consistent envelope with correlation metadata so client integrations and @scace/sdk can handle failures deterministically.",
    sections: [
      {
        id: "envelope-example",
        heading: "Standard Error Envelope",
        codeBlocks: [
          {
            language: "json",
            label: "JSON",
            code: `{
  "statusCode": 403,
  "error": "Forbidden",
  "code": "FORBIDDEN",
  "message": "Insufficient organization permissions or token scope for the requested action.",
  "requestId": "c783a3c4-6f78-4f1f-b398-981c234bf970",
  "sentryEventId": null,
  "timestamp": "2026-11-27T10:51:30.008Z",
  "path": "/api/v1/organizations/settings"
}`,
          },
        ],
      },
      {
        id: "status-table",
        heading: "HTTP Status Reference",
        table: {
          headers: ["Status", "Code", "Typical Cause & Resolution"],
          rows: [
            ["400", "BAD_REQUEST", "Zod validation failed; inspect issues[] array on response"],
            ["401", "UNAUTHORIZED", "Missing, expired, or revoked session/PAT/OAuth token"],
            ["402", "PAYMENT_REQUIRED", "Organization trial/subscription is locked; settle invoice via /api/v1/billing/*"],
            ["403", "FORBIDDEN", "Unverified email, missing X-Organization-Id, or insufficient role/token scope"],
            ["404", "NOT_FOUND", "Resource ID does not exist in the active organization scope"],
            ["409", "CONFLICT", "Optimistic lock mismatch, duplicate SKU/slug, or invalid state transition"],
            ["413", "PAYLOAD_TOO_LARGE", "Upload or webhook body exceeded configured size limits"],
          ],
        },
      },
    ],
  },
  {
    slug: "security",
    groupId: "security",
    groupTitle: "Security & Authentication",
    title: "Isolation & Encryption",
    subtitle: "Defense-in-depth protections across database, storage, and external webhooks",
    lead: "Scace enforces multi-organization boundaries and secret hygiene at the database extension, storage, cryptographic, and network egress layers.",
    sections: [
      {
        id: "layered-safeguards",
        heading: "Verified Safeguards",
        definitions: [
          {
            term: "Prisma Organization Extension",
            description:
              "All 90 organization-scoped models inject organizationId into reads, creates, updates, and deletes via AsyncLocalStorage while stripping client-supplied organizationId overrides.",
          },
          {
            term: "Dedicated AES-256-GCM Key Domains",
            description:
              "Separate HKDF-derived encryption keys isolate SSO client secrets, M-Pesa Daraja credentials, Communication webhook secrets, CRM tokens, and platform billing secrets.",
          },
          {
            term: "SSRF Network Guards",
            description:
              "All outbound SSO metadata fetches, CRM syncs, and Communication webhooks resolve DNS and block loopback, private RFC1918, and cloud metadata IPs.",
          },
        ],
      },
    ],
  },
  {
    slug: "oauth-sso",
    groupId: "security",
    groupTitle: "Security & Authentication",
    title: "OAuth2, Devices & SSO",
    subtitle: "Machine-to-machine tokens, POS/Android device pairing, and Enterprise OIDC",
    lead: "In addition to browser sessions and PATs, Scace operates a built-in OAuth2 & OIDC authorization server alongside organization-level Enterprise SSO.",
    sections: [
      {
        id: "oauth-flows",
        heading: "OAuth2 & Device Grants",
        bullets: [
          "Client Credentials (M2M) with client_secret or asymmetric private_key_jwt assertions",
          "Authorization Code + PKCE (S256) for native mobile or external web apps",
          "RFC 8628 Device Authorization Grant with admin approval for POS terminals and warehouse scanners",
          "Token Introspection (/api/v1/oauth/introspect) and Revocation (/api/v1/oauth/revoke)",
        ],
      },
      {
        id: "enterprise-sso",
        heading: "Organization Enterprise SSO",
        paragraphs: [
          "Owners and admins can configure per-organization Google Workspace, Microsoft Entra ID, Okta, or generic OIDC providers under /api/v1/auth/sso/config with email domain restrictions and automatic role provisioning.",
        ],
      },
    ],
  },
  {
    slug: "sdk-guide",
    groupId: "sdk",
    groupTitle: "TypeScript SDK",
    title: "Using @scace/sdk",
    subtitle: "Zero-dependency ESM & CommonJS client generated from live API controllers",
    lead: "The @scace/sdk package ships complete TypeScript types, automatic OAuth2 token caching, binary PDF/stream downloads, multipart uploads, and discriminated error handling.",
    sections: [
      {
        id: "sdk-initialization",
        heading: "1. Install & Initialize Once",
        paragraphs: [
          "Create a single shared client instance during application startup. Every API endpoint snippet in this portal omits this initialization block by default and reuses the exported sdk instance.",
        ],
        codeBlocks: [
          {
            language: "bash",
            label: "INSTALL",
            code: `npm install @scace/sdk`,
          },
          {
            language: "typescript",
            label: "TYPESCRIPT SDK",
            code: `import { createScaceClient } from "@scace/sdk";

export const sdk = createScaceClient({
  baseUrl: "https://api.scace.example",
  auth: {
    type: "oauth2ClientCredentials",
    clientId: process.env.SCACE_CLIENT_ID!,
    clientSecret: process.env.SCACE_CLIENT_SECRET!,
    scope: "order:read invoice:read",
  },
  organizationId: "org_01J9XYZ",
});`,
          },
        ],
      },
      {
        id: "sdk-safe-wrapper",
        heading: "2. Calling Endpoints & sdk.safe()",
        paragraphs: [
          "Reuse your initialized sdk client across modules and wrap calls in sdk.safe() when you prefer typed result objects over thrown ScaceApiError exceptions.",
        ],
        codeBlocks: [
          {
            language: "typescript",
            label: "TYPESCRIPT SDK",
            code: `const result = await sdk.safe(sdk.orders.listOrders({ limit: 10 }));
if (!result.ok) {
  console.error(result.error.code, result.error.requestId);
}`,
          },
        ],
      },
    ],
  },
  {
    slug: "changelog",
    groupId: "changelog",
    groupTitle: "Changelog",
    title: "Release History",
    subtitle: "Platform milestones and API evolution",
    lead: "Track major additions and breaking-free improvements across Scace API, database isolation, SDK, and developer tooling.",
    sections: [
      {
        id: "releases",
        heading: "Recent Milestones",
        definitions: [
          {
            term: "Organization Unification & TanStack Start Docs Portal",
            description:
              "Unified tenant terminology into /api/v1/organizations/*, OrganizationContext, and OrganizationGuard; launched this interactive TanStack Start developer portal covering all 442 endpoints.",
          },
          {
            term: "Organization Billing, Free Trials & System Governance",
            description:
              "Added auto-provisioned free trials, grace period to lockout enforcement, M-Pesa subscription settlement, and system-admin override controls.",
          },
          {
            term: "Stock Expiry Tracking (FEFO) & Multi-Domain Reporting",
            description:
              "Added automated FEFO lot allocation, daily expiry scans with auto-quarantine, CSV/JSON/PDF report exports, and Communication Outbox dispatch rules.",
          },
          {
            term: "M-Pesa Daraja Payment Processing",
            description:
              "Added encrypted per-org Daraja credentials, STK Push, C2B PayBill/Till callbacks, status reconciliation, and local simulator testing.",
          },
        ],
      },
    ],
  },
  {
    slug: "support",
    groupId: "support",
    groupTitle: "Support",
    title: "Troubleshooting & Limits",
    subtitle: "Diagnostics, correlation IDs, and operational guidelines",
    lead: "Use X-Request-Id headers and organization audit logs to trace authorization, validation, or billing rejections quickly.",
    sections: [
      {
        id: "diagnostic-checklist",
        heading: "Quick Diagnostic Checklist",
        bullets: [
          "Verify /api/v1/health reports up for postgres, redis, and rustfs.",
          "Confirm X-Organization-Id matches an organization where the authenticated user holds an active membership.",
          "Inspect X-Scace-Billing-Status on responses if mutations unexpectedly return HTTP 402.",
          "Include the response requestId when escalating issues to platform administrators.",
        ],
      },
    ],
  },
];

export function getGuideBySlug(slug: string): GuidePage {
  return GUIDE_PAGES.find((g) => g.slug === slug) ?? GUIDE_PAGES[0]!;
}

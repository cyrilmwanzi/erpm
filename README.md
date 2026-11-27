# Scace Monorepo

Multi-organization backend monorepo powered by **Turborepo**, **pnpm**, **NestJS (Fastify)**, **Prisma 7 + PostgreSQL 18**, **Redis 7**, and **Better Auth Organizations**.

## Workspace Architecture

- `apps/api` (`@scace/api`): High-performance NestJS API running on Fastify with Better Auth authentication, organization RBAC, Redis caching/session storage, and organization-isolated endpoints.
- `packages/db` (`@scace/db`): Prisma 7 + `@prisma/adapter-pg` database package with an `AsyncLocalStorage` `OrganizationContext` and Prisma `$extends` client extension enforcing automatic `organizationId` isolation across organization-scoped models.
- `packages/typescript-config` (`@scace/typescript-config`): Shared TypeScript presets (`base.json`, `library.json`, `nestjs.json`) consumed by all workspace packages.
- `.github/workflows`: GitHub Actions CI (PostgreSQL 18 + Redis 7 validation, lint, typecheck, build, smoke check) and CD (multi-stage Docker image publish to GHCR).

## Quick Start

1. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   Set a strong random `BETTER_AUTH_SECRET` (32+ chars) in `.env` for production deployments.

2. **Start PostgreSQL 18 and Redis 7**
   ```bash
   docker compose up -d
   ```

3. **Install dependencies & generate Prisma Client**
   ```bash
   pnpm install
   pnpm db:generate
   pnpm db:push
   ```

4. **Run the API in development or production**
   ```bash
   pnpm dev
   # or
   pnpm build && pnpm start
   ```

## Key API Endpoints

- `GET /` — Public service info & endpoint discovery.
- `GET /api/v1/health` — Public PostgreSQL 18 & Redis 7 health probe.
- `/api/auth/*` — Better Auth endpoints (sign-up with Resend email verification, sign-in gated by `emailVerified`, organization creation, invitations, member role management, and `set-active` organization).
- `GET /api/v1/me` — Authenticated user profile and organization memberships.
- `GET /api/v1/organizations/current` — Active organization overview, resolved permissions, and settings.
- `GET /api/v1/organizations/permissions` — Effective Better Auth RBAC permissions for the active member (`owner`, `admin`, `manager`, `member`, `viewer`).
- `PATCH /api/v1/organizations/settings` — Update organization settings (`organizationSettings:update`), invalidates Redis cache and records an `AuditLog`.
- `GET /api/v1/organizations/members` — List organization members and resolved roles (`ac:read`).
- `PATCH /api/v1/organizations/members/:memberId/role` — Update a member's organization role (`member:update`).
- `DELETE /api/v1/organizations/members/:memberId` — Remove an organization member (`member:delete`).
- `GET /api/v1/organizations/invitations` — List organization invitations (`invitation:create`).
- `POST /api/v1/organizations/invitations` — Create or resend an organization invitation via Resend (`invitation:create`).
- `DELETE /api/v1/organizations/invitations/:invitationId` — Cancel a pending organization invitation (`invitation:cancel`).
- `POST /api/v1/organizations/invitations/:invitationId/accept` — Accept an organization invitation as a verified user.
- `GET /api/v1/organizations/audit-logs` — Paginated organization-scoped audit trail (`auditLog:read`).
- `POST /api/v1/items` — Create a catalog item or service (`SELLABLE`, `MERCH`, `RAW_MATERIAL`, `SERVICE`, `CONSUMABLE`) with initial revision v1 and audit log (`item:create`).
- `GET /api/v1/items` — Paginated, filterable catalog listing by type, status, inventory tracking, tag, or search (`item:read`).
- `GET /api/v1/items/:itemId` — Fetch an organization-scoped catalog item with Redis cache-aside (`item:read`).
- `PATCH /api/v1/items/:itemId` — Update an item with optimistic version checking, field-level `ItemRevision` diffing, and `AuditLog` (`item:update`).
- `POST /api/v1/items/:itemId/archive` — Soft-archive an item with status revision history and audit trail (`item:archive`).
- `POST /api/v1/items/:itemId/restore` — Restore an archived item to `ACTIVE` or `DRAFT` with revision history (`item:archive`).
- `GET /api/v1/items/:itemId/history` — Paginated field-level revision history (`ItemRevision`) ordered newest-first (`item:read`).
- `POST|GET|PATCH /api/v1/locations` — Manage `WAREHOUSE` and `RETAIL_STORE` locations, default location flag, and soft archive/restore (`location:*`).
- `GET /api/v1/inventory/balances` & `GET /api/v1/inventory/movements` — Query per-location stock balances, low-stock items, and immutable movement ledger (`inventory:read`).
- `POST /api/v1/inventory/adjustments` — Record per-location stock adjustments enforcing `trackInventory` & `allowNegativeStock` (`inventory:adjust`).
- `POST|GET /api/v1/inventory/transfers` (`dispatch`, `receive`, `cancel`) — Two-step inter-location stock transfers (`DRAFT` → `IN_TRANSIT` → `RECEIVED`) (`inventory:transfer`).
- `POST|GET|PATCH /api/v1/suppliers` & `PUT|DELETE /api/v1/suppliers/:supplierId/items` — Supplier directory, archival, and supplier-item cost/SKU mapping (`supplier:*`).
- `POST|GET|PATCH /api/v1/purchase-orders` (`submit`, `cancel`, `receive`) — Purchase order lifecycle and partial/full goods receiving into destination locations (`purchaseOrder:*`).
- `POST|GET /api/v1/vendor-bills` (`post`, `payments`, `void`) — Supplier bills matched to POs/receipts with payment recording and voiding (`vendorBill:*`).

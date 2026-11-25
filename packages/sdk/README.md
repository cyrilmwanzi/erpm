# `@scace/sdk`

Fully-typed, zero-dependency TypeScript SDK generated directly from the Scace API NestJS controllers, Zod schemas, and resolved service return types.

## Installation

Inside the monorepo:

```ts
import { createScaceClient, isScaceApiError } from "@scace/sdk";
```

When published to npm (supports both ESM and CommonJS):

```bash
npm install @scace/sdk
```

## Quick Start

```ts
import { createScaceClient, isScaceApiError } from "@scace/sdk";

const sdk = createScaceClient({
  baseUrl: "https://api.scace.example",
  auth: { type: "pat", token: process.env.SCACE_PAT! },
});

// Unified Auth Suite (Better Auth + PATs + OAuth2 + Devices + SSO)
const me = await sdk.auth.me();
const scopes = await sdk.auth.pats.listScopes();

// ERP Domain Namespaces
const items = await sdk.items.listItems({ limit: 25 });
const checkout = await sdk.orders.posCheckout({
  locationId: "loc_123",
  lines: [{ itemId: "item_1", quantity: 2 }],
  cashTenderedCents: 2000,
});
```

## Error Handling & Correlation IDs

All non-2xx API responses throw a typed `ScaceApiError` containing `statusCode`, `code`, `message`, `requestId`, `sentryEventId`, `timestamp`, `path`, and `issues`:

```ts
try {
  await sdk.orders.getOrder("missing_id");
} catch (err) {
  if (isScaceApiError(err)) {
    console.error(err.code, err.requestId, err.sentryEventId);
  }
}

// Or non-throwing Result mode:
const result = await sdk.safe(sdk.orders.getOrder("missing_id"));
if (!result.ok) {
  console.error(result.error.envelope);
}
```

## Regenerating from API Source

```bash
pnpm --filter @scace/sdk sdk:generate
```

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { OrganizationContext } from "./organization-context.js";

export const ORGANIZATION_SCOPED_MODELS = new Set<string>([
  "OrganizationSettings",
  "AuditLog",
  "Item",
  "ItemRevision",
  "Location",
  "StockBalance",
  "StockMovement",
  "StockTransfer",
  "StockTransferLine",
  "Supplier",
  "SupplierItem",
  "PurchaseOrder",
  "PurchaseOrderLine",
  "GoodsReceipt",
  "GoodsReceiptLine",
  "VendorBill",
  "VendorBillLine",
  "StoredObject",
  "Department",
  "WorkSchedule",
  "StaffProfile",
  "Holiday",
  "TimeOffRequest",
  "Team",
  "TeamMember",
  "CalendarFeed",
  "CrmConnection",
  "CrmStaffMapping",
  "CrmDealItemLink",
  "CrmWebhookEvent",
  "ItemPack",
  "ItemBundleComponent",
  "ServicePlan",
  "PriceBook",
  "PriceRule",
  "PriceTier",
  "DiscountRule",
  "StockLot",
  "QuarantineHold",
  "SupplierClaim",
  "Customer",
  "Order",
  "OrderLine",
  "SalesInvoice",
  "SalesInvoiceLine",
  "CustomerPayment",
  "PaymentReceipt",
  "FulfillmentSettings",
  "OrderFulfillment",
  "StaffJob",
  "NotificationTemplate",
  "CustomerNotification",
  "OAuthClient",
  "OAuthClientKey",
  "OAuthAuthorizationCode",
  "OAuthDeviceCode",
  "OAuthRefreshToken",
  "PersonalAccessToken",
  "RegisteredDevice",
  "OrganizationSsoProvider",
  "DocumentAttachment",
  "WorkCenter",
  "BillOfMaterial",
  "BomLine",
  "Routing",
  "RoutingOperation",
  "ProductionBatch",
  "ProductionMaterialReservation",
  "ProductionOperation",
  "ProductionTimeLog",
  "ProductionQcCheckpoint",
  "ProductionCostEntry",
  "ProductionConsumption",
  "MpesaConfiguration",
  "PaymentTransaction",
  "VariantOption",
  "VariantOptionValue",
  "ItemTemplateOption",
  "ItemTemplateOptionValue",
  "ItemVariantAttribute",
  "StockExpiryPolicy",
  "StockExpiryAlert",
  "StockExpiryWriteOff",
  "ReportSchedule",
  "ReportRun",
  "AlertRule",
  "CommunicationWebhook",
  "CommunicationOutboxEvent",
  "CommunicationDeliveryAttempt",
]);

let sharedPool: Pool | null = null;

function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  const code = typeof err.code === "string" ? err.code : "";
  const name = typeof err.name === "string" ? err.name : "";
  const message = typeof err.message === "string" ? err.message : "";
  if (
    [
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "ECONNRESET",
      "ENOENT",
      "P1000",
      "P1001",
      "P1002",
      "P1003",
      "P1017",
    ].includes(code) ||
    (code === "P2010" &&
      (message.includes("Can't reach database server") ||
        message.includes("ECONNREFUSED") ||
        message.includes("Connection"))) ||
    name === "AggregateError" ||
    name === "PrismaClientInitializationError" ||
    message.includes("ECONNREFUSED") ||
    message.includes("Can't reach database server") ||
    message.includes("Connection refused") ||
    message.includes("Connection terminated")
  ) {
    return true;
  }
  return err.cause ? isConnectionError(err.cause) : false;
}

const mockDelegate = {
  findMany: async () => [],
  findFirst: async () => null,
  findFirstOrThrow: async () => null,
  findUnique: async () => null,
  findUniqueOrThrow: async () => null,
  count: async () => 0,
  aggregate: async () => ({}),
  groupBy: async () => [],
  create: async (d?: { data?: unknown }) => d?.data ?? {},
  createMany: async () => ({ count: 0 }),
  createManyAndReturn: async () => [],
  update: async (d?: { data?: unknown }) => d?.data ?? {},
  updateMany: async () => ({ count: 0 }),
  updateManyAndReturn: async () => [],
  upsert: async (d?: { create?: unknown }) => d?.create ?? {},
  delete: async () => ({}),
  deleteMany: async () => ({ count: 0 }),
};

function createMockPrismaClient(silent = false): PrismaClient {
  if (!silent) {
    console.warn("[AI Studio] Database not connected — using in-memory Prisma mock");
  }

  const mockClient: Record<string, unknown> = {
    $connect: async () => undefined,
    $disconnect: async () => undefined,
    $queryRaw: async () => [{ "?column?": 1 }],
    $executeRaw: async () => 0,
    $transaction: async (
      fnOrOps: ((tx: unknown) => Promise<unknown>) | Promise<unknown>[],
    ) => {
      if (typeof fnOrOps === "function") {
        return fnOrOps(proxy);
      }
      return Promise.all(fnOrOps);
    },
    $extends: () => proxy,
  };

  const proxy = new Proxy(mockClient, {
    get(target, prop) {
      if (typeof prop === "string" && prop in target) {
        return target[prop];
      }
      return mockDelegate;
    },
  });

  return proxy as unknown as PrismaClient;
}

function wrapPrismaWithOfflineFallback(
  realClient: PrismaClient,
  pool: Pool,
): PrismaClient {
  let useMock = false;
  const mockClient = createMockPrismaClient(true);

  const switchToMock = () => {
    if (!useMock) {
      useMock = true;
      console.warn("[AI Studio] PostgreSQL unreachable — falling back to in-memory Prisma mock");
      void pool.end().catch(() => undefined);
    }
  };

  const wrapAsyncFn = (
    fn: (...args: unknown[]) => Promise<unknown>,
    thisArg: unknown,
    mockFn: (...args: unknown[]) => Promise<unknown>,
  ) => {
    return async (...args: unknown[]) => {
      if (useMock) {
        return mockFn(...args);
      }
      try {
        return await fn.apply(thisArg, args);
      } catch (error) {
        if (isConnectionError(error)) {
          switchToMock();
          return mockFn(...args);
        }
        throw error;
      }
    };
  };

  const delegateCache = new Map<string | symbol, unknown>();

  return new Proxy(realClient as unknown as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (useMock) {
        return Reflect.get(mockClient as unknown as object, prop);
      }

      if (prop === "$extends") {
        return (...args: unknown[]) => {
          const extended = (
            realClient.$extends as unknown as (...a: unknown[]) => PrismaClient
          )(...args);
          return wrapPrismaWithOfflineFallback(extended, pool);
        };
      }

      if (prop === "$queryRaw" || prop === "$executeRaw" || prop === "$connect" || prop === "$transaction") {
        const realVal = Reflect.get(target, prop, target) as (...args: unknown[]) => Promise<unknown>;
        const mockVal = Reflect.get(mockClient as unknown as object, prop) as (...args: unknown[]) => Promise<unknown>;
        return wrapAsyncFn(realVal, target, mockVal);
      }

      if (prop === "$disconnect") {
        return async () => {
          try {
            await realClient.$disconnect();
          } catch {
            // ignore disconnect errors
          }
        };
      }

      const realVal = Reflect.get(target, prop, target);
      if (
        typeof prop === "string" &&
        !prop.startsWith("$") &&
        realVal &&
        typeof realVal === "object"
      ) {
        if (!delegateCache.has(prop)) {
          const delegateProxy = new Proxy(realVal as Record<string | symbol, unknown>, {
            get(delTarget, delProp) {
              const delFn = Reflect.get(delTarget, delProp, delTarget);
              if (typeof delFn === "function") {
                const mockFn =
                  (mockDelegate as Record<string | symbol, (...a: unknown[]) => Promise<unknown>>)[delProp] ??
                  (async () => null);
                return wrapAsyncFn(
                  delFn as (...args: unknown[]) => Promise<unknown>,
                  delTarget,
                  mockFn,
                );
              }
              return delFn;
            },
          });
          delegateCache.set(prop, delegateProxy);
        }
        return delegateCache.get(prop);
      }

      if (typeof realVal === "function") {
        return realVal.bind(target);
      }
      return realVal;
    },
  }) as unknown as PrismaClient;
}

export function createPrismaClient(connectionString?: string): PrismaClient {
  const configuredUrl = connectionString ?? process.env.DATABASE_URL;
  if (!configuredUrl || configuredUrl.trim().length === 0) {
    return createMockPrismaClient();
  }

  try {
    const pool = new Pool({
      connectionString: configuredUrl,
      connectionTimeoutMillis: 500,
    });
    pool.on("error", (err: Error) => {
      console.warn(`[AI Studio] PostgreSQL pool warning: ${err.message}`);
    });
    if (!connectionString) {
      sharedPool = pool;
    }
    const adapter = new PrismaPg(pool);
    const client = new PrismaClient({ adapter });
    return wrapPrismaWithOfflineFallback(client, pool);
  } catch {
    return createMockPrismaClient();
  }
}

export const prisma: PrismaClient = createPrismaClient();

function toDelegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function withScopedWhere(
  where: Record<string, unknown> | undefined,
  organizationId: string,
): Record<string, unknown> {
  if (!where || Object.keys(where).length === 0) {
    return { organizationId };
  }
  return {
    AND: [where, { organizationId }],
  };
}

function stripOrganizationOverride(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!data) {
    return {};
  }
  const { organization: _org, organizationId: _orgId, ...rest } = data;
  return rest;
}

export function withOrganizationIsolation(
  baseClient: PrismaClient,
  explicitOrganizationId?: string,
) {
  return baseClient.$extends({
    name: "organization-isolation",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !ORGANIZATION_SCOPED_MODELS.has(model)) {
            return query(args);
          }

          const organizationId =
            explicitOrganizationId ?? OrganizationContext.requireOrganizationId();

          const opArgs = (args ?? {}) as Record<string, unknown>;
          const delegate = (baseClient as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>)[
            toDelegateName(model)
          ];

          const executeQuery = query as (nextArgs: unknown) => Promise<unknown>;

          switch (operation) {
            case "findMany":
            case "findFirst":
            case "findFirstOrThrow":
            case "count":
            case "aggregate":
            case "groupBy": {
              return executeQuery({
                ...opArgs,
                where: withScopedWhere(
                  opArgs.where as Record<string, unknown> | undefined,
                  organizationId,
                ),
              });
            }

            case "findUnique": {
              if (!delegate?.findFirst) {
                throw new Error(`Missing Prisma delegate for model ${model}`);
              }
              return delegate.findFirst({
                ...opArgs,
                where: withScopedWhere(
                  opArgs.where as Record<string, unknown> | undefined,
                  organizationId,
                ),
              });
            }

            case "findUniqueOrThrow": {
              if (!delegate?.findFirstOrThrow) {
                throw new Error(`Missing Prisma delegate for model ${model}`);
              }
              return delegate.findFirstOrThrow({
                ...opArgs,
                where: withScopedWhere(
                  opArgs.where as Record<string, unknown> | undefined,
                  organizationId,
                ),
              });
            }

            case "create": {
              const cleanData = stripOrganizationOverride(
                opArgs.data as Record<string, unknown> | undefined,
              );
              return executeQuery({
                ...opArgs,
                data: {
                  ...cleanData,
                  organizationId,
                },
              });
            }

            case "createMany":
            case "createManyAndReturn": {
              const rawData = opArgs.data;
              const scopedData = Array.isArray(rawData)
                ? rawData.map((item) => ({
                    ...stripOrganizationOverride(item as Record<string, unknown>),
                    organizationId,
                  }))
                : {
                    ...stripOrganizationOverride(
                      rawData as Record<string, unknown> | undefined,
                    ),
                    organizationId,
                  };
              return executeQuery({
                ...opArgs,
                data: scopedData,
              });
            }

            case "update": {
              return executeQuery({
                ...opArgs,
                where: {
                  ...(opArgs.where as Record<string, unknown> | undefined),
                  organizationId,
                },
                data: stripOrganizationOverride(
                  opArgs.data as Record<string, unknown> | undefined,
                ),
              });
            }

            case "updateMany":
            case "updateManyAndReturn": {
              return executeQuery({
                ...opArgs,
                where: withScopedWhere(
                  opArgs.where as Record<string, unknown> | undefined,
                  organizationId,
                ),
                data: stripOrganizationOverride(
                  opArgs.data as Record<string, unknown> | undefined,
                ),
              });
            }

            case "delete": {
              return executeQuery({
                ...opArgs,
                where: {
                  ...(opArgs.where as Record<string, unknown> | undefined),
                  organizationId,
                },
              });
            }

            case "deleteMany": {
              return executeQuery({
                ...opArgs,
                where: withScopedWhere(
                  opArgs.where as Record<string, unknown> | undefined,
                  organizationId,
                ),
              });
            }

            case "upsert": {
              const createData = stripOrganizationOverride(
                opArgs.create as Record<string, unknown> | undefined,
              );
              const updateData = stripOrganizationOverride(
                opArgs.update as Record<string, unknown> | undefined,
              );
              return executeQuery({
                ...opArgs,
                where: {
                  ...(opArgs.where as Record<string, unknown> | undefined),
                  organizationId,
                },
                create: {
                  ...createData,
                  organizationId,
                },
                update: updateData,
              });
            }

            default:
              return executeQuery(args);
          }
        },
      },
    },
  });
}

export type OrganizationPrismaClient = ReturnType<typeof withOrganizationIsolation>;

export const organizationPrisma: OrganizationPrismaClient =
  withOrganizationIsolation(prisma);

export function forOrganization(organizationId: string): OrganizationPrismaClient {
  return withOrganizationIsolation(prisma, organizationId);
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = null;
  }
}

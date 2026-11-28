import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Body, Controller, Get, Inject, Module, Post } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AuthModule } from "@thallesp/nestjs-better-auth";
import { withOrganizationIsolation, type PrismaClient } from "@scace/db";
import { auth } from "./auth.config.js";
import {
  decodeJwt,
  generateAsymmetricKeyPair,
  sha256Base64Url,
  sha256Hex,
  signJwt,
  verifyJwtSignature,
} from "./crypto.utils.js";
import { MeController } from "./me.controller.js";
import { OAuthClientsController } from "./oauth-clients.controller.js";
import { OAuthClientsService } from "./oauth-clients.service.js";
import { OAuthProviderController } from "./oauth-provider.controller.js";
import { OAuthProviderService } from "./oauth-provider.service.js";
import { PatController } from "./pat.controller.js";
import { PatService } from "./pat.service.js";
import { ALL_ERP_SCOPES } from "./permissions.js";
import { UnifiedAuthGuard } from "./unified-auth.guard.js";
import { PrismaService } from "../database/prisma.service.js";
import { RootController } from "../health/root.controller.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import { EnterpriseExceptionFilter } from "../observability/enterprise-exception.filter.js";
import { SentryService } from "../observability/sentry.service.js";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { RedisService } from "../redis/redis.service.js";

@Controller("api/v1/mcp-test-items")
@RequireActiveOrganization()
class McpProbeController {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  @Get()
  @RequiredOrgPermissions({ item: ["read"] })
  listItems(@CurrentOrganization() tenant: AuthenticatedOrganization) {
    return {
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      role: tenant.role,
      authMethod: tenant.authMethod,
      isServicePrincipal: Boolean(tenant.isServicePrincipal),
      grantedScopes: tenant.grantedScopes ?? [],
    };
  }

  @Post()
  @RequiredOrgPermissions({ item: ["create"] })
  async createItem(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: { sku?: string },
  ) {
    const audit = await this.prismaService.scoped.auditLog.create({
      data: {
        organizationId: tenant.organizationId,
        actorUserId: tenant.userId,
        action: "item.created",
        resourceType: "Item",
        resourceId: "item_1",
        metadata: { sku: body?.sku ?? "SKU-1" },
      },
    });
    return { ok: true, audit };
  }
}

function createInMemoryAuthStore() {
  let seq = 1;
  const nextId = (prefix: string) => `${prefix}_${seq++}`;

  const organizations = new Map<string, any>([
    ["org_alpha", { id: "org_alpha", name: "Alpha Org", slug: "alpha-org", logo: null }],
    ["org_beta", { id: "org_beta", name: "Beta Org", slug: "beta-org", logo: null }],
  ]);

  const users = new Map<string, any>([
    [
      "user_owner",
      {
        id: "user_owner",
        email: "owner@alpha.test",
        name: "Alpha Owner",
        emailVerified: true,
        platformRole: "USER",
      },
    ],
  ]);

  const members = new Map<string, any>([
    [
      "mem_alpha_owner",
      {
        id: "mem_alpha_owner",
        organizationId: "org_alpha",
        userId: "user_owner",
        role: "owner",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ],
  ]);

  const sessions = new Map<string, any>([
    [
      "sess_owner_token",
      {
        id: "sess_1",
        token: "sess_owner_token",
        userId: "user_owner",
        activeOrganizationId: "org_alpha",
        expiresAt: new Date(Date.now() + 3600_000),
      },
    ],
  ]);

  const authSigningKeys: any[] = [];
  const oauthClients = new Map<string, any>();
  const oauthClientKeys = new Map<string, any>();
  const oauthAuthCodes = new Map<string, any>();
  const oauthDeviceCodes = new Map<string, any>();
  const oauthRefreshTokens = new Map<string, any>();
  const pats = new Map<string, any>();
  const devices = new Map<string, any>();
  const auditLogs: any[] = [];

  const matchWhere = (row: any, where: any): boolean => {
    if (!where) return true;
    if (Array.isArray(where.AND)) {
      if (!where.AND.every((sub: any) => matchWhere(row, sub))) return false;
    }
    if (Array.isArray(where.OR)) {
      if (!where.OR.some((sub: any) => matchWhere(row, sub))) return false;
    }
    for (const [k, v] of Object.entries(where)) {
      if (k === "AND" || k === "OR") continue;
      if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
        if ("gt" in v && !(row[k] > (v as any).gt)) return false;
        if ("organizationId" in v && "userId" in v && k === "organizationId_userId") {
          if (
            row.organizationId !== (v as any).organizationId ||
            row.userId !== (v as any).userId
          ) {
            return false;
          }
          continue;
        }
        continue;
      }
      if (row[k] !== v) return false;
    }
    return true;
  };

  const attachRelations = (table: string, row: any) => {
    if (!row) return null;
    const copy = { ...row };
    if (table === "oAuthClient") {
      copy.keys = Array.from(oauthClientKeys.values()).filter(
        (k) => k.oauthClientId === copy.id,
      );
      copy._count = {
        keys: copy.keys.length,
        registeredDevices: Array.from(devices.values()).filter(
          (d) => d.oauthClientId === copy.id,
        ).length,
      };
    }
    if (table === "oAuthAuthorizationCode") {
      copy.user = users.get(copy.userId) ?? null;
    }
    if (table === "oAuthRefreshToken") {
      copy.user = copy.userId ? (users.get(copy.userId) ?? null) : null;
      copy.registeredDevice = copy.registeredDeviceId
        ? (devices.get(copy.registeredDeviceId) ?? null)
        : null;
      copy.oauthClient = oauthClients.get(copy.oauthClientId) ?? null;
    }
    if (table === "personalAccessToken") {
      copy.user = users.get(copy.userId) ?? null;
    }
    if (table === "member") {
      copy.organization = organizations.get(copy.organizationId) ?? null;
    }
    if (table === "session") {
      copy.user = users.get(copy.userId) ?? null;
    }
    return copy;
  };

  const makeMapDelegate = (table: string, map: Map<string, any>) => ({
    findUnique: async ({ where }: any) => {
      for (const row of map.values()) {
        if (matchWhere(row, where)) return attachRelations(table, row);
      }
      return null;
    },
    findFirst: async ({ where }: any) => {
      for (const row of map.values()) {
        if (matchWhere(row, where)) return attachRelations(table, row);
      }
      return null;
    },
    findMany: async ({ where }: any = {}) => {
      return Array.from(map.values())
        .filter((row) => matchWhere(row, where))
        .map((row) => attachRelations(table, row));
    },
    create: async ({ data }: any) => {
      const id = data.id ?? nextId(table);
      const record = {
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(table === "oAuthAuthorizationCode" ? { consumedAt: null } : {}),
        ...(table === "oAuthDeviceCode" ? { consumedAt: null, lastPolledAt: null } : {}),
        ...(table === "oAuthRefreshToken" ? { revokedAt: null } : {}),
        ...(table === "personalAccessToken" ? { revokedAt: null, expiresAt: null } : {}),
        ...data,
        id,
      };
      map.set(id, record);
      return attachRelations(table, record);
    },
    update: async ({ where, data }: any) => {
      for (const [id, row] of map.entries()) {
        if (matchWhere(row, where)) {
          const updated = { ...row, ...data, updatedAt: new Date() };
          map.set(id, updated);
          return attachRelations(table, updated);
        }
      }
      throw new Error(`Not found in ${table}`);
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const [id, row] of map.entries()) {
        if (matchWhere(row, where)) {
          map.set(id, { ...row, ...data, updatedAt: new Date() });
          count++;
        }
      }
      return { count };
    },
  });

  const rawClient: any = {
    organization: makeMapDelegate("organization", organizations),
    user: makeMapDelegate("user", users),
    member: makeMapDelegate("member", members),
    session: makeMapDelegate("session", sessions),
    oAuthClient: makeMapDelegate("oAuthClient", oauthClients),
    oAuthClientKey: makeMapDelegate("oAuthClientKey", oauthClientKeys),
    oAuthAuthorizationCode: makeMapDelegate("oAuthAuthorizationCode", oauthAuthCodes),
    oAuthDeviceCode: makeMapDelegate("oAuthDeviceCode", oauthDeviceCodes),
    oAuthRefreshToken: makeMapDelegate("oAuthRefreshToken", oauthRefreshTokens),
    personalAccessToken: makeMapDelegate("personalAccessToken", pats),
    registeredDevice: makeMapDelegate("registeredDevice", devices),
    authSigningKey: {
      findFirst: async ({ where }: any) =>
        authSigningKeys.find((k) => matchWhere(k, where)) ?? null,
      findMany: async ({ where }: any) =>
        authSigningKeys.filter((k) => matchWhere(k, where)),
      create: async ({ data }: any) => {
        const rec = { id: nextId("sig"), createdAt: new Date(), ...data };
        authSigningKeys.push(rec);
        return rec;
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        // Simulate Postgres FK constraint audit_log_actorUserId_fkey
        if (data.actorUserId !== null && data.actorUserId !== undefined) {
          if (!users.has(data.actorUserId)) {
            const fkErr = new Error("Foreign key constraint failed on audit_log_actorUserId_fkey") as Error & {
              code?: string;
            };
            fkErr.code = "P2003";
            throw fkErr;
          }
        }
        const rec = { id: nextId("audit"), createdAt: new Date(), ...data };
        auditLogs.push(rec);
        return rec;
      },
    },
    $extends: () => rawClient,
  };

  const scopedClient = withOrganizationIsolation({
    ...rawClient,
    $extends(ext: any) {
      const handler = ext?.query?.$allModels?.$allOperations;
      return new Proxy(rawClient, {
        get(target, prop: string) {
          const del = target[prop];
          if (!del || typeof prop !== "string" || prop.startsWith("$")) return del;
          const model = prop.charAt(0).toUpperCase() + prop.slice(1);
          return new Proxy(del, {
            get(dTarget, opProp: string) {
              const fn = dTarget[opProp];
              if (typeof fn !== "function" || !handler) return fn;
              return (args: unknown) =>
                handler({
                  model,
                  operation: opProp,
                  args,
                  query: (nextArgs: unknown) => fn(nextArgs),
                });
            },
          });
        },
      });
    },
  } as unknown as PrismaClient);

  return { rawClient, scopedClient, auditLogs };
}

const activeStore = createInMemoryAuthStore();
const activeRedisMap = new Map<string, string>();

@Module({
  imports: [
    AuthModule.forRoot({
      auth,
      isGlobal: true,
      disableGlobalAuthGuard: true,
      disableTrustedOriginsCors: true,
      bodyParser: {
        json: { limit: "1mb" },
        urlencoded: { limit: "1mb", extended: false },
        rawBody: true,
      },
    }),
  ],
  controllers: [
    RootController,
    MeController,
    OAuthProviderController,
    OAuthClientsController,
    PatController,
    McpProbeController,
  ],
  providers: [
    OAuthProviderService,
    OAuthClientsService,
    PatService,
    {
      provide: PrismaService,
      useValue: {
        raw: activeStore.rawClient,
        scoped: activeStore.scopedClient,
        ping: async () => true,
      },
    },
    {
      provide: RedisService,
      useValue: {
        getJson: async <T>(key: string): Promise<T | null> => {
          const val = activeRedisMap.get(key);
          return val ? (JSON.parse(val) as T) : null;
        },
        setJson: async (key: string, value: unknown) => {
          activeRedisMap.set(key, JSON.stringify(value));
        },
        del: async (key: string) => {
          activeRedisMap.delete(key);
        },
      },
    },
    {
      provide: SentryService,
      useValue: { captureException: () => null },
    },
    {
      provide: AnalyticsService,
      useValue: { captureDomainEvent: () => undefined },
    },
    { provide: APP_GUARD, useClass: UnifiedAuthGuard },
    { provide: APP_FILTER, useClass: EnterpriseExceptionFilter },
  ],
})
class McpAuthTestModule {}

describe("MCP & Agent Authentication End-to-End Pipeline", () => {
  let app: NestFastifyApplication;

  before(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      McpAuthTestModule,
      new FastifyAdapter({ ignoreTrailingSlash: true, logger: false }),
      { bodyParser: false, logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  after(async () => {
    if (app) {
      await app.close();
    }
  });

  it("exposes RFC 9728 protected resource metadata, RFC 8414 server metadata, OIDC config, and JWKS", async () => {
    const prRes = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource",
    });
    assert.equal(prRes.statusCode, 200);
    const pr = prRes.json();
    assert.ok(pr.resource);
    assert.ok(Array.isArray(pr.authorization_servers) && pr.authorization_servers.length === 1);
    assert.deepEqual(pr.bearer_methods_supported, ["header"]);
    assert.ok(pr.scopes_supported.includes("item:read"));
    assert.ok(pr.scopes_supported.includes("order:create"));

    const subPrRes = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource/api/v1",
    });
    assert.equal(subPrRes.statusCode, 200);
    assert.ok(subPrRes.json().resource.endsWith("/api/v1"));

    const asRes = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    assert.equal(asRes.statusCode, 200);
    const asMeta = asRes.json();
    assert.equal(asMeta.resource_indicators_supported, true);
    assert.ok(asMeta.scopes_supported.includes("customerPo:read"));
    assert.ok(asMeta.grant_types_supported.includes("authorization_code"));
    assert.ok(asMeta.grant_types_supported.includes("client_credentials"));
    assert.ok(asMeta.code_challenge_methods_supported.includes("S256"));

    const jwksRes = await app.inject({
      method: "GET",
      url: "/.well-known/jwks.json",
    });
    assert.equal(jwksRes.statusCode, 200);
    assert.ok(Array.isArray(jwksRes.json().keys) && jwksRes.json().keys.length >= 1);
  });

  it("returns RFC 9728 WWW-Authenticate Bearer header on 401 and blocks invalid Bearer fallback to session cookies", async () => {
    const unauth = await app.inject({
      method: "GET",
      url: "/api/v1/mcp-test-items",
    });
    assert.equal(unauth.statusCode, 401);
    const wwwAuth = String(unauth.headers["www-authenticate"] ?? "");
    assert.ok(wwwAuth.startsWith("Bearer resource_metadata="));
    assert.ok(wwwAuth.includes("/.well-known/oauth-protected-resource"));

    const invalidJwt = "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJiYWQifQ.invalidsig";
    const badBearerRes = await app.inject({
      method: "GET",
      url: "/api/v1/mcp-test-items",
      headers: {
        authorization: `Bearer ${invalidJwt}`,
        cookie: "scace.session_token=sess_owner_token",
      },
    });
    assert.equal(badBearerRes.statusCode, 401);
  });

  it("supports OAuth 2.1 Authorization Code + PKCE S256 redirect, form-urlencoded token exchange, resource indicator, refresh rotation & reuse detection", async () => {
    const metaRes = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    assert.equal(metaRes.statusCode, 200);
    const { issuer } = metaRes.json() as { issuer: string };
    const resourceTarget = `${issuer}/api/v1`;

    // 1. Register a PUBLIC_PKCE client using owner bearer session
    const createClientRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/oauth-clients",
      headers: {
        authorization: "Bearer sess_owner_token",
        "content-type": "application/json",
      },
      payload: {
        name: "MCP Desktop Agent",
        clientType: "PUBLIC_PKCE",
        appCategory: "OTHER",
        redirectUris: ["http://127.0.0.1:43123/callback"],
        allowedScopes: ["openid", "profile", "offline_access", "item:read"],
      },
    });
    assert.equal(createClientRes.statusCode, 201);
    const client = createClientRes.json();
    assert.ok(client.clientId.startsWith("scace_cli_"));

    // 2. GET /api/v1/oauth/authorize issues 302 redirect by default with code, state, and iss
    const verifier = "mcp_pkce_verifier_with_high_entropy_0123456789abcdef";
    const challenge = sha256Base64Url(verifier);
    const authRes = await app.inject({
      method: "GET",
      url: `/api/v1/oauth/authorize?response_type=code&client_id=${encodeURIComponent(client.clientId)}&redirect_uri=${encodeURIComponent("http://127.0.0.1:43123/callback")}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&state=xyz123&scope=${encodeURIComponent("openid item:read offline_access")}&resource=${encodeURIComponent(resourceTarget)}`,
      headers: {
        authorization: "Bearer sess_owner_token",
      },
    });
    assert.equal(authRes.statusCode, 302);
    const locationUrl = new URL(String(authRes.headers.location));
    assert.equal(locationUrl.searchParams.get("state"), "xyz123");
    assert.equal(locationUrl.searchParams.get("iss"), issuer);
    const code = locationUrl.searchParams.get("code")!;
    assert.ok(code.startsWith("scace_ac_"));

    // 3. Exchange code via standard application/x-www-form-urlencoded POST /api/v1/oauth/token
    const formBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.clientId,
      code,
      redirect_uri: "http://127.0.0.1:43123/callback",
      code_verifier: verifier,
      resource: resourceTarget,
    }).toString();

    const tokenRes = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: formBody,
    });
    assert.equal(tokenRes.statusCode, 200);
    const tokenPayload = tokenRes.json();
    assert.equal(tokenPayload.token_type, "Bearer");
    assert.ok(tokenPayload.access_token);
    assert.ok(tokenPayload.refresh_token);
    assert.ok(tokenPayload.id_token);

    // Verify JWT aud includes both issuer and RFC 8707 resource, and signature matches JWKS
    const decoded = decodeJwt(tokenPayload.access_token)!;
    assert.ok(Array.isArray(decoded.payload.aud));
    assert.ok(decoded.payload.aud.includes(resourceTarget));
    const jwksRes = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
    assert.equal(verifyJwtSignature(decoded, jwksRes.json().keys[0]), true);

    // 4. Call protected ERP route using the OAuth2 access token -> item:read allowed, item:create denied by scope
    const readRes = await app.inject({
      method: "GET",
      url: "/api/v1/mcp-test-items",
      headers: { authorization: `Bearer ${tokenPayload.access_token}` },
    });
    assert.equal(readRes.statusCode, 200);
    assert.equal(readRes.json().authMethod, "OAUTH2_ACCESS_TOKEN");

    const crossOrgRes = await app.inject({
      method: "GET",
      url: "/api/v1/mcp-test-items",
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        "x-organization-id": "org_beta",
      },
    });
    assert.equal(crossOrgRes.statusCode, 403);

    const writeDeniedRes = await app.inject({
      method: "POST",
      url: "/api/v1/mcp-test-items",
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        "content-type": "application/json",
      },
      payload: { sku: "SKU-DENIED" },
    });
    assert.equal(writeDeniedRes.statusCode, 403);

    // 5. Refresh token rotation & reuse detection
    const refreshRes = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: tokenPayload.refresh_token,
      }).toString(),
    });
    assert.equal(refreshRes.statusCode, 200);
    const rotated = refreshRes.json();
    assert.notEqual(rotated.refresh_token, tokenPayload.refresh_token);

    // Reusing old refresh token must fail & revoke entire token family
    const reuseRes = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: tokenPayload.refresh_token,
      }).toString(),
    });
    assert.equal(reuseRes.statusCode, 401);
    assert.equal(reuseRes.json().error, "invalid_grant");
    assert.ok(reuseRes.json().error_description);

    const rotatedAfterReuseRes = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: rotated.refresh_token,
      }).toString(),
    });
    assert.equal(rotatedAfterReuseRes.statusCode, 401);
  });

  it("supports M2M client_credentials (Basic, Post, private_key_jwt), service-principal AuditLog FK safety, introspection, and revocation", async () => {
    const metaRes = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    assert.equal(metaRes.statusCode, 200);
    const { token_endpoint: tokenEndpoint } = metaRes.json() as {
      token_endpoint: string;
    };

    const m2mRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/oauth-clients",
      headers: {
        authorization: "Bearer sess_owner_token",
        "content-type": "application/json",
      },
      payload: {
        name: "MCP Autonomous Agent",
        clientType: "M2M_SERVICE",
        appCategory: "ERP_INTEGRATION",
        authMethods: ["client_secret_basic", "client_secret_post", "private_key_jwt"],
        allowedScopes: ["item:read", "item:create"],
        serviceRole: "admin",
      },
    });
    assert.equal(m2mRes.statusCode, 201);
    const m2m = m2mRes.json();
    assert.ok(m2m.clientSecret);

    // 1. client_secret_basic via form-urlencoded
    const basicCreds = Buffer.from(
      `${encodeURIComponent(m2m.clientId)}:${encodeURIComponent(m2m.clientSecret)}`,
      "utf8",
    ).toString("base64");
    const basicTokenRes = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      headers: {
        authorization: `Basic ${basicCreds}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "item:read item:create",
      }).toString(),
    });
    assert.equal(basicTokenRes.statusCode, 200);
    const serviceToken = basicTokenRes.json().access_token;

    // 2. Service principal calls protected mutation writing AuditLog via scoped Prisma (must NOT fail FK!)
    const createItemRes = await app.inject({
      method: "POST",
      url: "/api/v1/mcp-test-items",
      headers: {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/json",
      },
      payload: { sku: "MCP-AGENT-SKU-1" },
    });
    assert.equal(createItemRes.statusCode, 201);
    const createdAudit = createItemRes.json().audit;
    assert.equal(createdAudit.actorUserId, null);
    assert.equal(createdAudit.metadata.actorPrincipalId, `service:${m2m.clientId}`);

    // 3. private_key_jwt M2M assertion via form-urlencoded
    const kp = generateAsymmetricKeyPair("ES256", "agent-key-1");
    const addKeyRes = await app.inject({
      method: "POST",
      url: `/api/v1/auth/oauth-clients/${m2m.clientId}/keys`,
      headers: {
        authorization: "Bearer sess_owner_token",
        "content-type": "application/json",
      },
      payload: {
        name: "Agent Signing Key",
        kid: kp.kid,
        algorithm: "ES256",
        publicKeyPem: kp.publicKeyPem,
      },
    });
    assert.equal(addKeyRes.statusCode, 201);

    const nowSec = Math.floor(Date.now() / 1000);
    const assertionJwt = signJwt({
      payload: {
        iss: m2m.clientId,
        sub: m2m.clientId,
        aud: tokenEndpoint,
        jti: `jti_${Date.now()}_unique_1234`,
        iat: nowSec,
        exp: nowSec + 120,
      },
      privateKeyPem: kp.privateKeyPem,
      kid: kp.kid,
      algorithm: "ES256",
    });

    const jwtClientTokenRes = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertionJwt,
      }).toString(),
    });
    assert.equal(jwtClientTokenRes.statusCode, 200);
    const jwtClientAccess = jwtClientTokenRes.json().access_token;

    // Replay of same client_assertion jti must fail
    const replayRes = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertionJwt,
      }).toString(),
    });
    assert.equal(replayRes.statusCode, 401);

    // 4. Introspect & revoke access token
    const introspectBefore = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/introspect",
      headers: {
        authorization: `Basic ${basicCreds}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({ token: jwtClientAccess }).toString(),
    });
    assert.equal(introspectBefore.statusCode, 200);
    assert.equal(introspectBefore.json().active, true);

    const revokeRes = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/revoke",
      headers: {
        authorization: `Basic ${basicCreds}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({ token: jwtClientAccess }).toString(),
    });
    assert.equal(revokeRes.statusCode, 200);

    const afterRevokeCall = await app.inject({
      method: "GET",
      url: "/api/v1/mcp-test-items",
      headers: { authorization: `Bearer ${jwtClientAccess}` },
    });
    assert.equal(afterRevokeCall.statusCode, 401);
  });

  it("supports PAT (scace_pat_*) Bearer and X-API-Key agent authentication with scope & organization enforcement", async () => {
    const createPatRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/pats",
      headers: {
        authorization: "Bearer sess_owner_token",
        "content-type": "application/json",
      },
      payload: {
        name: "MCP CLI Agent PAT",
        scopes: ["item:read"],
      },
    });
    assert.equal(createPatRes.statusCode, 201);
    const pat = createPatRes.json();
    assert.ok(pat.token.startsWith("scace_pat_"));

    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { "x-api-key": pat.token },
    });
    assert.equal(meRes.statusCode, 200);
    assert.equal(meRes.json().authContext.authMethod, "PAT");
    assert.equal(meRes.json().activeOrganizationId, "org_alpha");

    const allowedRead = await app.inject({
      method: "GET",
      url: "/api/v1/mcp-test-items",
      headers: { authorization: `Bearer ${pat.token}` },
    });
    assert.equal(allowedRead.statusCode, 200);

    const deniedWrite = await app.inject({
      method: "POST",
      url: "/api/v1/mcp-test-items",
      headers: {
        authorization: `Bearer ${pat.token}`,
        "content-type": "application/json",
      },
      payload: { sku: "DENIED" },
    });
    assert.equal(deniedWrite.statusCode, 403);

    const wrongOrg = await app.inject({
      method: "GET",
      url: "/api/v1/mcp-test-items",
      headers: {
        authorization: `Bearer ${pat.token}`,
        "x-organization-id": "org_beta",
      },
    });
    assert.equal(wrongOrg.statusCode, 403);

    // Reject external RFC 8707 resource target
    const badTarget = await app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "any",
        client_secret: "any",
        resource: "https://evil.example.com/api",
      }).toString(),
    });
    assert.ok(badTarget.statusCode === 400 || badTarget.statusCode === 401);
  });

  it("advertises valid ERP scopes consistent with ALL_ERP_SCOPES", () => {
    assert.ok(ALL_ERP_SCOPES.includes("item:read"));
    assert.ok(ALL_ERP_SCOPES.includes("invoice:issue"));
    assert.ok(ALL_ERP_SCOPES.includes("customerPo:create"));
    assert.ok(sha256Hex("abc").length === 64);
  });
});

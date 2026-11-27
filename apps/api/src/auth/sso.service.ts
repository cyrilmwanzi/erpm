import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { type Prisma } from "@scace/db";
import { getEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { RedisService } from "../redis/redis.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { auth } from "./auth.config.js";
import {
  decodeJwt,
  decryptAuthSecret,
  encryptAuthSecret,
  generateRandomToken,
  sha256Base64Url,
  sha256Hex,
  validateSafeExternalEndpoint,
} from "./crypto.utils.js";
import { isValidOrganizationRole, normalizeScopesInput } from "./permissions.js";

export type SsoProviderTypeValue = "GOOGLE" | "MICROSOFT_ENTRA" | "OKTA" | "OIDC";

interface PendingSsoState {
  providerKey: string;
  organizationId: string | null;
  codeVerifier: string;
  nonce: string;
  mode: "popup" | "redirect" | "android_pkce";
  redirectAfter?: string;
  androidClientId?: string;
  androidRedirectUri?: string;
  androidCodeChallenge?: string;
  androidState?: string;
  androidScope?: string;
  androidDeviceIdentifier?: string;
  androidDeviceName?: string;
  createdAt: number;
}

interface ResolvedProviderConfig {
  providerKey: string;
  providerType: SsoProviderTypeValue;
  displayName: string;
  organizationId: string | null;
  clientId: string;
  clientSecret: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
  scopes: string[];
  allowedDomains: string[];
  autoProvisionRole: string;
}

export interface UpsertSsoProviderInput {
  providerKey: string;
  providerType: SsoProviderTypeValue;
  displayName: string;
  issuerUrl?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  jwksUri?: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
  allowedDomains?: string[];
  autoProvisionRole?: string;
  enforceSsoOnly?: boolean;
  enabled?: boolean;
}

@Injectable()
export class SsoService {
  private readonly fallbackStateStore = new Map<string, PendingSsoState>();

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redisService: RedisService,
  ) {}

  private async recordAudit(params: {
    organizationId: string;
    actorUserId?: string | null;
    action: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    try {
      await this.prismaService.raw.auditLog.create({
        data: {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId ?? null,
          action: params.action,
          resourceType: "OrganizationSsoProvider",
          resourceId: params.resourceId ?? null,
          metadata: (params.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch {
      // non-fatal
    }
  }

  private getPlatformProviders(): ResolvedProviderConfig[] {
    const env = getEnv();
    const list: ResolvedProviderConfig[] = [];

    if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) {
      list.push({
        providerKey: "google",
        providerType: "GOOGLE",
        displayName: "Google Workspace",
        organizationId: null,
        clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
        scopes: ["openid", "profile", "email"],
        allowedDomains: [],
        autoProvisionRole: "member",
      });
    }

    if (env.MICROSOFT_OAUTH_CLIENT_ID && env.MICROSOFT_OAUTH_CLIENT_SECRET) {
      const tenantSeg = encodeURIComponent(env.MICROSOFT_OAUTH_TENANT_ID || "common");
      list.push({
        providerKey: "microsoft",
        providerType: "MICROSOFT_ENTRA",
        displayName: "Microsoft Entra ID",
        organizationId: null,
        clientId: env.MICROSOFT_OAUTH_CLIENT_ID,
        clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET,
        authorizationEndpoint: `https://login.microsoftonline.com/${tenantSeg}/oauth2/v2.0/authorize`,
        tokenEndpoint: `https://login.microsoftonline.com/${tenantSeg}/oauth2/v2.0/token`,
        userinfoEndpoint: "https://graph.microsoft.com/oidc/userinfo",
        scopes: ["openid", "profile", "email"],
        allowedDomains: [],
        autoProvisionRole: "member",
      });
    }

    if (env.OIDC_SSO_CLIENT_ID && env.OIDC_SSO_CLIENT_SECRET && env.OIDC_SSO_ISSUER_URL) {
      const base = env.OIDC_SSO_ISSUER_URL.replace(/\/+$/, "");
      list.push({
        providerKey: "enterprise-oidc",
        providerType: "OIDC",
        displayName: "Enterprise OIDC",
        organizationId: null,
        clientId: env.OIDC_SSO_CLIENT_ID,
        clientSecret: env.OIDC_SSO_CLIENT_SECRET,
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
        userinfoEndpoint: `${base}/userinfo`,
        scopes: ["openid", "profile", "email"],
        allowedDomains: [],
        autoProvisionRole: "member",
      });
    }

    return list;
  }

  private getDefaultEndpointsForType(
    type: SsoProviderTypeValue,
    issuerUrl?: string | null,
  ): {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userinfoEndpoint: string | null;
  } {
    if (type === "GOOGLE") {
      return {
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
      };
    }
    if (type === "MICROSOFT_ENTRA") {
      const base = (issuerUrl || "https://login.microsoftonline.com/common/v2.0").replace(
        /\/v2\.0\/?$/,
        "",
      );
      return {
        authorizationEndpoint: `${base}/oauth2/v2.0/authorize`,
        tokenEndpoint: `${base}/oauth2/v2.0/token`,
        userinfoEndpoint: "https://graph.microsoft.com/oidc/userinfo",
      };
    }
    const cleanIssuer = (issuerUrl || "").replace(/\/+$/, "");
    if (type === "OKTA" && cleanIssuer) {
      return {
        authorizationEndpoint: `${cleanIssuer}/v1/authorize`,
        tokenEndpoint: `${cleanIssuer}/v1/token`,
        userinfoEndpoint: `${cleanIssuer}/v1/userinfo`,
      };
    }
    return {
      authorizationEndpoint: cleanIssuer ? `${cleanIssuer}/authorize` : "",
      tokenEndpoint: cleanIssuer ? `${cleanIssuer}/token` : "",
      userinfoEndpoint: cleanIssuer ? `${cleanIssuer}/userinfo` : null,
    };
  }

  async listOrganizationProviders(tenant: AuthenticatedOrganization) {
    const items = await this.prismaService.scoped.organizationSsoProvider.findMany({
      where: { organizationId: tenant.organizationId },
      select: {
        id: true,
        providerKey: true,
        providerType: true,
        displayName: true,
        issuerUrl: true,
        authorizationEndpoint: true,
        tokenEndpoint: true,
        userinfoEndpoint: true,
        jwksUri: true,
        clientId: true,
        clientSecretLast4: true,
        scopes: true,
        allowedDomains: true,
        autoProvisionRole: true,
        enforceSsoOnly: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const env = getEnv();
    return {
      items: items.map((item: (typeof items)[number]) => ({
        ...item,
        callbackUrl: `${env.APP_URL}/api/v1/auth/sso/callback/${encodeURIComponent(item.providerKey)}`,
      })),
    };
  }

  async createOrganizationProvider(tenant: AuthenticatedOrganization, input: UpsertSsoProviderInput) {
    const normalizedKey = input.providerKey.trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(normalizedKey)) {
      throw new BadRequestException(
        "providerKey must contain only lowercase letters, numbers, and hyphens.",
      );
    }

    const role = input.autoProvisionRole ?? "member";
    if (!isValidOrganizationRole(role) || role === "owner") {
      throw new BadRequestException(
        "autoProvisionRole must be one of admin, manager, member, or viewer.",
      );
    }

    const existing = await this.prismaService.scoped.organizationSsoProvider.findFirst({
      where: { organizationId: tenant.organizationId, providerKey: normalizedKey },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`SSO provider "${normalizedKey}" already exists for this organization.`);
    }

    const issuerUrl = input.issuerUrl
      ? await validateSafeExternalEndpoint(input.issuerUrl)
      : null;
    const authorizationEndpoint = input.authorizationEndpoint
      ? await validateSafeExternalEndpoint(input.authorizationEndpoint)
      : null;
    const tokenEndpoint = input.tokenEndpoint
      ? await validateSafeExternalEndpoint(input.tokenEndpoint)
      : null;
    const userinfoEndpoint = input.userinfoEndpoint
      ? await validateSafeExternalEndpoint(input.userinfoEndpoint)
      : null;
    const jwksUri = input.jwksUri ? await validateSafeExternalEndpoint(input.jwksUri) : null;

    if (
      (input.providerType === "OIDC" || input.providerType === "OKTA") &&
      !issuerUrl &&
      (!authorizationEndpoint || !tokenEndpoint)
    ) {
      throw new BadRequestException(
        "OIDC/Okta providers require issuerUrl or explicit authorizationEndpoint and tokenEndpoint.",
      );
    }

    const created = await this.prismaService.scoped.organizationSsoProvider.create({
      data: {
        organizationId: tenant.organizationId,
        providerKey: normalizedKey,
        providerType: input.providerType,
        displayName: input.displayName,
        issuerUrl,
        authorizationEndpoint,
        tokenEndpoint,
        userinfoEndpoint,
        jwksUri,
        clientId: input.clientId,
        encryptedClientSecret: input.clientSecret
          ? encryptAuthSecret(input.clientSecret)
          : null,
        clientSecretLast4: input.clientSecret ? input.clientSecret.slice(-4) : null,
        scopes:
          input.scopes && input.scopes.length > 0
            ? normalizeScopesInput(input.scopes)
            : ["openid", "profile", "email"],
        allowedDomains: (input.allowedDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean),
        autoProvisionRole: role,
        enforceSsoOnly: input.enforceSsoOnly ?? false,
        enabled: input.enabled ?? true,
        createdByUserId: tenant.userId,
      },
      select: {
        id: true,
        providerKey: true,
        providerType: true,
        displayName: true,
        issuerUrl: true,
        authorizationEndpoint: true,
        tokenEndpoint: true,
        userinfoEndpoint: true,
        jwksUri: true,
        clientId: true,
        clientSecretLast4: true,
        scopes: true,
        allowedDomains: true,
        autoProvisionRole: true,
        enforceSsoOnly: true,
        enabled: true,
        createdAt: true,
      },
    });

    await this.recordAudit({
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
      action: "sso_provider.created",
      resourceId: created.id,
      metadata: {
        providerKey: created.providerKey,
        providerType: created.providerType,
        allowedDomains: created.allowedDomains,
      },
    });

    const env = getEnv();
    return {
      ...created,
      callbackUrl: `${env.APP_URL}/api/v1/auth/sso/callback/${encodeURIComponent(created.providerKey)}`,
    };
  }

  async updateOrganizationProvider(
    tenant: AuthenticatedOrganization,
    idOrKey: string,
    input: Partial<UpsertSsoProviderInput>,
  ) {
    const existing = await this.prismaService.scoped.organizationSsoProvider.findFirst({
      where: {
        organizationId: tenant.organizationId,
        OR: [{ id: idOrKey }, { providerKey: idOrKey.toLowerCase() }],
      },
    });
    if (!existing) {
      throw new NotFoundException("SSO provider configuration not found.");
    }

    if (input.autoProvisionRole) {
      if (!isValidOrganizationRole(input.autoProvisionRole) || input.autoProvisionRole === "owner") {
        throw new BadRequestException(
          "autoProvisionRole must be one of admin, manager, member, or viewer.",
        );
      }
    }

    const updated = await this.prismaService.scoped.organizationSsoProvider.update({
      where: { id: existing.id },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.issuerUrl !== undefined
          ? { issuerUrl: input.issuerUrl ? await validateSafeExternalEndpoint(input.issuerUrl) : null }
          : {}),
        ...(input.authorizationEndpoint !== undefined
          ? {
              authorizationEndpoint: input.authorizationEndpoint
                ? await validateSafeExternalEndpoint(input.authorizationEndpoint)
                : null,
            }
          : {}),
        ...(input.tokenEndpoint !== undefined
          ? {
              tokenEndpoint: input.tokenEndpoint
                ? await validateSafeExternalEndpoint(input.tokenEndpoint)
                : null,
            }
          : {}),
        ...(input.userinfoEndpoint !== undefined
          ? {
              userinfoEndpoint: input.userinfoEndpoint
                ? await validateSafeExternalEndpoint(input.userinfoEndpoint)
                : null,
            }
          : {}),
        ...(input.jwksUri !== undefined
          ? { jwksUri: input.jwksUri ? await validateSafeExternalEndpoint(input.jwksUri) : null }
          : {}),
        ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
        ...(input.clientSecret !== undefined
          ? {
              encryptedClientSecret: input.clientSecret
                ? encryptAuthSecret(input.clientSecret)
                : null,
              clientSecretLast4: input.clientSecret ? input.clientSecret.slice(-4) : null,
            }
          : {}),
        ...(input.scopes !== undefined ? { scopes: normalizeScopesInput(input.scopes) } : {}),
        ...(input.allowedDomains !== undefined
          ? {
              allowedDomains: input.allowedDomains
                .map((d) => d.trim().toLowerCase())
                .filter(Boolean),
            }
          : {}),
        ...(input.autoProvisionRole !== undefined
          ? { autoProvisionRole: input.autoProvisionRole }
          : {}),
        ...(input.enforceSsoOnly !== undefined ? { enforceSsoOnly: input.enforceSsoOnly } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
      select: {
        id: true,
        providerKey: true,
        providerType: true,
        displayName: true,
        issuerUrl: true,
        clientId: true,
        clientSecretLast4: true,
        scopes: true,
        allowedDomains: true,
        autoProvisionRole: true,
        enforceSsoOnly: true,
        enabled: true,
        updatedAt: true,
      },
    });

    await this.recordAudit({
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
      action: "sso_provider.updated",
      resourceId: existing.id,
      metadata: { providerKey: updated.providerKey, enabled: updated.enabled },
    });

    return updated;
  }

  async deleteOrganizationProvider(tenant: AuthenticatedOrganization, idOrKey: string) {
    const existing = await this.prismaService.scoped.organizationSsoProvider.findFirst({
      where: {
        organizationId: tenant.organizationId,
        OR: [{ id: idOrKey }, { providerKey: idOrKey.toLowerCase() }],
      },
    });
    if (!existing) {
      throw new NotFoundException("SSO provider configuration not found.");
    }

    await this.prismaService.scoped.organizationSsoProvider.delete({
      where: { id: existing.id },
    });

    await this.recordAudit({
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
      action: "sso_provider.deleted",
      resourceId: existing.id,
      metadata: { providerKey: existing.providerKey },
    });

    return { id: existing.id, deleted: true };
  }

  async listPublicProviders(query: { orgSlug?: string; emailDomain?: string }) {
    const env = getEnv();
    const platform = this.getPlatformProviders().map((p) => ({
      providerKey: p.providerKey,
      providerType: p.providerType,
      displayName: p.displayName,
      scope: "platform",
      organizationId: null as string | null,
      authUrlEndpoint: `${env.APP_URL}/api/v1/auth/sso/url/${encodeURIComponent(p.providerKey)}`,
      callbackUrl: `${env.APP_URL}/api/v1/auth/sso/callback/${encodeURIComponent(p.providerKey)}`,
    }));

    let orgProviders: Array<{
      providerKey: string;
      providerType: string;
      displayName: string;
      scope: string;
      organizationId: string | null;
      authUrlEndpoint: string;
      callbackUrl: string;
    }> = [];

    if (query.orgSlug || query.emailDomain) {
      let orgId: string | undefined;
      if (query.orgSlug) {
        const org = await this.prismaService.raw.organization.findUnique({
          where: { slug: query.orgSlug.trim() },
          select: { id: true },
        });
        orgId = org?.id;
      }

      const dbList = await this.prismaService.raw.organizationSsoProvider.findMany({
        where: {
          enabled: true,
          ...(orgId ? { organizationId: orgId } : {}),
          ...(query.emailDomain
            ? { allowedDomains: { has: query.emailDomain.trim().toLowerCase() } }
            : {}),
        },
        select: {
          organizationId: true,
          providerKey: true,
          providerType: true,
          displayName: true,
        },
      });

      orgProviders = dbList.map((p) => ({
        providerKey: p.providerKey,
        providerType: p.providerType,
        displayName: p.displayName,
        scope: "organization",
        organizationId: p.organizationId,
        authUrlEndpoint: `${env.APP_URL}/api/v1/auth/sso/url/${encodeURIComponent(
          p.providerKey,
        )}?organizationId=${encodeURIComponent(p.organizationId)}`,
        callbackUrl: `${env.APP_URL}/api/v1/auth/sso/callback/${encodeURIComponent(p.providerKey)}`,
      }));
    }

    return {
      providers: [...orgProviders, ...platform],
    };
  }

  private async resolveProviderConfig(
    providerKey: string,
    organizationId?: string | null,
  ): Promise<ResolvedProviderConfig> {
    const cleanKey = providerKey.trim().toLowerCase();

    if (organizationId) {
      const orgProvider = await this.prismaService.raw.organizationSsoProvider.findUnique({
        where: {
          organizationId_providerKey: {
            organizationId,
            providerKey: cleanKey,
          },
        },
      });
      if (orgProvider && orgProvider.enabled) {
        const defaults = this.getDefaultEndpointsForType(
          orgProvider.providerType,
          orgProvider.issuerUrl,
        );
        const authorizationEndpoint =
          orgProvider.authorizationEndpoint || defaults.authorizationEndpoint;
        const tokenEndpoint = orgProvider.tokenEndpoint || defaults.tokenEndpoint;
        if (!authorizationEndpoint || !tokenEndpoint) {
          throw new BadRequestException(
            `SSO provider "${cleanKey}" is missing authorization/token endpoints.`,
          );
        }
        return {
          providerKey: orgProvider.providerKey,
          providerType: orgProvider.providerType,
          displayName: orgProvider.displayName,
          organizationId: orgProvider.organizationId,
          clientId: orgProvider.clientId,
          clientSecret: orgProvider.encryptedClientSecret
            ? decryptAuthSecret(orgProvider.encryptedClientSecret)
            : null,
          authorizationEndpoint,
          tokenEndpoint,
          userinfoEndpoint: orgProvider.userinfoEndpoint || defaults.userinfoEndpoint,
          scopes: orgProvider.scopes,
          allowedDomains: orgProvider.allowedDomains,
          autoProvisionRole: orgProvider.autoProvisionRole,
        };
      }
    }

    const platform = this.getPlatformProviders().find((p) => p.providerKey === cleanKey);
    if (!platform) {
      throw new NotFoundException(`SSO provider "${providerKey}" is not configured.`);
    }
    return platform;
  }

  private async saveState(state: string, data: PendingSsoState) {
    try {
      await this.redisService.setJson(`sso:state:${state}`, data, 600);
    } catch {
      this.fallbackStateStore.set(state, data);
    }
  }

  private async consumeState(state: string): Promise<PendingSsoState | null> {
    try {
      const fromRedis = await this.redisService.getJson<PendingSsoState>(`sso:state:${state}`);
      if (fromRedis) {
        await this.redisService.del(`sso:state:${state}`);
        return fromRedis;
      }
    } catch {
      // fall back to memory
    }
    const local = this.fallbackStateStore.get(state) ?? null;
    if (local) {
      this.fallbackStateStore.delete(state);
      if (Date.now() - local.createdAt > 600_000) {
        return null;
      }
    }
    return local;
  }

  async buildAuthorizationUrl(params: {
    providerKey: string;
    organizationId?: string;
    orgSlug?: string;
    mode?: "popup" | "redirect" | "android_pkce";
    redirectAfter?: string;
    androidClientId?: string;
    androidRedirectUri?: string;
    androidCodeChallenge?: string;
    androidState?: string;
    androidScope?: string;
    androidDeviceIdentifier?: string;
    androidDeviceName?: string;
  }) {
    let resolvedOrgId = params.organizationId ?? null;
    if (!resolvedOrgId && params.orgSlug) {
      const org = await this.prismaService.raw.organization.findUnique({
        where: { slug: params.orgSlug.trim() },
        select: { id: true },
      });
      resolvedOrgId = org?.id ?? null;
    }

    if (params.mode === "android_pkce") {
      if (!params.androidClientId || !params.androidRedirectUri || !params.androidCodeChallenge) {
        throw new BadRequestException(
          "android_pkce mode requires androidClientId, androidRedirectUri, and androidCodeChallenge.",
        );
      }
      const androidClient = await this.prismaService.raw.oAuthClient.findUnique({
        where: { clientId: params.androidClientId },
        select: { status: true, redirectUris: true, allowedGrantTypes: true, organizationId: true },
      });
      if (
        !androidClient ||
        androidClient.status !== "ACTIVE" ||
        !androidClient.allowedGrantTypes.includes("authorization_code") ||
        !androidClient.redirectUris.includes(params.androidRedirectUri)
      ) {
        throw new BadRequestException("Invalid Android OAuth2 client or unregistered redirect URI.");
      }
      resolvedOrgId = resolvedOrgId ?? androidClient.organizationId;
    }

    const config = await this.resolveProviderConfig(params.providerKey, resolvedOrgId);
    const env = getEnv();
    const callbackUri = `${env.APP_URL}/api/v1/auth/sso/callback/${encodeURIComponent(
      config.providerKey,
    )}`;

    const state = generateRandomToken(24);
    const nonce = generateRandomToken(16);
    const codeVerifier = generateRandomToken(32);
    const codeChallenge = sha256Base64Url(codeVerifier);

    await this.saveState(state, {
      providerKey: config.providerKey,
      organizationId: config.organizationId ?? resolvedOrgId,
      codeVerifier,
      nonce,
      mode: params.mode ?? "popup",
      redirectAfter: params.redirectAfter,
      androidClientId: params.androidClientId,
      androidRedirectUri: params.androidRedirectUri,
      androidCodeChallenge: params.androidCodeChallenge,
      androidState: params.androidState,
      androidScope: params.androidScope,
      androidDeviceIdentifier: params.androidDeviceIdentifier,
      androidDeviceName: params.androidDeviceName,
      createdAt: Date.now(),
    });

    const url = new URL(config.authorizationEndpoint);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", callbackUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", config.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");

    return {
      url: url.toString(),
      providerKey: config.providerKey,
      providerType: config.providerType,
      displayName: config.displayName,
      callbackUrl: callbackUri,
      state,
    };
  }

  async handleCallback(params: {
    providerKey: string;
    code?: string;
    state?: string;
    error?: string;
    errorDescription?: string;
    clientIp?: string;
    userAgent?: string;
  }) {
    if (params.error) {
      throw new UnauthorizedException(
        params.errorDescription || `SSO provider returned error: ${params.error}`,
      );
    }
    if (!params.code || !params.state) {
      throw new BadRequestException("Missing SSO authorization code or state.");
    }

    const pending = await this.consumeState(params.state);
    if (!pending || pending.providerKey !== params.providerKey.trim().toLowerCase()) {
      throw new UnauthorizedException("Invalid or expired SSO state.");
    }

    const config = await this.resolveProviderConfig(
      pending.providerKey,
      pending.organizationId,
    );
    const env = getEnv();
    const callbackUri = `${env.APP_URL}/api/v1/auth/sso/callback/${encodeURIComponent(
      config.providerKey,
    )}`;

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: callbackUri,
      client_id: config.clientId,
      code_verifier: pending.codeVerifier,
    });
    if (config.clientSecret) {
      tokenBody.set("client_secret", config.clientSecret);
    }

    await validateSafeExternalEndpoint(config.tokenEndpoint);
    const tokenResp = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: tokenBody.toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (!tokenResp.ok) {
      const errText = await tokenResp.text().catch(() => "");
      throw new UnauthorizedException(
        `SSO token exchange failed (${tokenResp.status}): ${errText.slice(0, 200)}`,
      );
    }

    const tokenJson = (await tokenResp.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
      scope?: string;
    };

    let sub = "";
    let email = "";
    let name = "";
    let emailVerified = false;
    let picture: string | undefined;

    if (tokenJson.id_token) {
      const decodedId = decodeJwt(tokenJson.id_token);
      if (decodedId) {
        if (typeof decodedId.payload.sub === "string") sub = decodedId.payload.sub;
        if (typeof decodedId.payload.email === "string") email = decodedId.payload.email;
        if (typeof decodedId.payload.name === "string") name = decodedId.payload.name;
        if (typeof decodedId.payload.email_verified === "boolean") {
          emailVerified = decodedId.payload.email_verified;
        }
        if (typeof decodedId.payload.picture === "string") picture = decodedId.payload.picture;
      }
    }

    if ((!email || !sub) && config.userinfoEndpoint && tokenJson.access_token) {
      await validateSafeExternalEndpoint(config.userinfoEndpoint);
      const userinfoResp = await fetch(config.userinfoEndpoint, {
        headers: {
          Authorization: `Bearer ${tokenJson.access_token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (userinfoResp.ok) {
        const info = (await userinfoResp.json()) as Record<string, unknown>;
        if (!sub && typeof info.sub === "string") sub = info.sub;
        if (!email && typeof info.email === "string") email = info.email;
        if (!name && typeof info.name === "string") name = info.name;
        if (!emailVerified && info.email_verified === true) emailVerified = true;
        if (!picture && typeof info.picture === "string") picture = info.picture;
      }
    }

    if (!sub || !email) {
      throw new UnauthorizedException("SSO provider response did not include required user email/sub.");
    }

    const normalizedEmail = email.trim().toLowerCase();
    const emailDomain = normalizedEmail.split("@")[1] ?? "";
    if (
      config.allowedDomains.length > 0 &&
      !config.allowedDomains.includes(emailDomain)
    ) {
      throw new ForbiddenException(
        `Email domain "${emailDomain}" is not permitted for this organization's SSO configuration.`,
      );
    }

    let user = await this.prismaService.raw.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      user = await this.prismaService.raw.user.create({
        data: {
          id: `usr_${generateRandomToken(12).replace(/[^a-zA-Z0-9]/g, "").slice(0, 20)}`,
          email: normalizedEmail,
          name: name.trim() || normalizedEmail.split("@")[0] || "SSO User",
          emailVerified: true,
          image: picture ?? null,
        },
      });
    } else if (!user.emailVerified && emailVerified) {
      user = await this.prismaService.raw.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
    }

    const existingAccount = await this.prismaService.raw.account.findFirst({
      where: {
        providerId: config.providerKey,
        accountId: sub,
      },
    });

    if (!existingAccount) {
      await this.prismaService.raw.account.create({
        data: {
          id: `acc_${generateRandomToken(12).replace(/[^a-zA-Z0-9]/g, "").slice(0, 20)}`,
          accountId: sub,
          providerId: config.providerKey,
          userId: user.id,
          accessToken: tokenJson.access_token ?? null,
          refreshToken: tokenJson.refresh_token ?? null,
          idToken: tokenJson.id_token ?? null,
          scope: tokenJson.scope ?? config.scopes.join(" "),
        },
      });
    }

    let activeOrganizationId = pending.organizationId ?? config.organizationId ?? null;
    if (activeOrganizationId) {
      const existingMember = await this.prismaService.raw.member.findUnique({
        where: {
          organizationId_userId: {
            organizationId: activeOrganizationId,
            userId: user.id,
          },
        },
      });
      if (!existingMember) {
        await this.prismaService.raw.member.create({
          data: {
            id: `mem_${generateRandomToken(12).replace(/[^a-zA-Z0-9]/g, "").slice(0, 20)}`,
            organizationId: activeOrganizationId,
            userId: user.id,
            role: config.autoProvisionRole || "member",
          },
        });
      }
    } else {
      const firstMember = await this.prismaService.raw.member.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
        select: { organizationId: true },
      });
      activeOrganizationId = firstMember?.organizationId ?? null;
    }

    // Handle chained Android PKCE login over SSO
    if (
      pending.mode === "android_pkce" &&
      pending.androidClientId &&
      pending.androidRedirectUri &&
      pending.androidCodeChallenge &&
      activeOrganizationId
    ) {
      const client = await this.prismaService.raw.oAuthClient.findUnique({
        where: { clientId: pending.androidClientId },
      });
      if (
        client &&
        client.status === "ACTIVE" &&
        client.organizationId === activeOrganizationId &&
        client.redirectUris.includes(pending.androidRedirectUri)
      ) {
        const scopes = pending.androidScope
          ? normalizeScopesInput(pending.androidScope).filter((s) =>
              client.allowedScopes.includes(s),
            )
          : client.allowedScopes;
        const rawCode = `scace_ac_${generateRandomToken(32)}`;
        await this.prismaService.raw.oAuthAuthorizationCode.create({
          data: {
            organizationId: client.organizationId,
            oauthClientId: client.id,
            userId: user.id,
            codeHash: sha256Hex(rawCode),
            redirectUri: pending.androidRedirectUri,
            scopes,
            codeChallenge: pending.androidCodeChallenge,
            codeChallengeMethod: "S256",
            deviceIdentifier: pending.androidDeviceIdentifier ?? null,
            deviceName: pending.androidDeviceName ?? null,
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          },
        });
        const redirectTarget = new URL(pending.androidRedirectUri);
        redirectTarget.searchParams.set("code", rawCode);
        if (pending.androidState) {
          redirectTarget.searchParams.set("state", pending.androidState);
        }
        return {
          mode: "android_pkce" as const,
          redirectUrl: redirectTarget.toString(),
          user: { id: user.id, email: user.email, name: user.name },
          organizationId: activeOrganizationId,
        };
      }
    }

    // Issue Better Auth session
    const sessionToken = generateRandomToken(32);
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    await this.prismaService.raw.session.create({
      data: {
        id: `ses_${generateRandomToken(12).replace(/[^a-zA-Z0-9]/g, "").slice(0, 20)}`,
        token: sessionToken,
        userId: user.id,
        expiresAt,
        ipAddress: params.clientIp ?? null,
        userAgent: params.userAgent ?? null,
        activeOrganizationId,
      },
    });

    if (activeOrganizationId) {
      await this.recordAudit({
        organizationId: activeOrganizationId,
        actorUserId: user.id,
        action: "sso.login.succeeded",
        metadata: { providerKey: config.providerKey, email: user.email },
      });
    }

    // Also inspect Better Auth cookie signing if possible; return bearer session token + cookie metadata
    void auth;
    return {
      mode: pending.mode,
      sessionToken,
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
      },
      organizationId: activeOrganizationId,
      redirectAfter: pending.redirectAfter ?? "/",
    };
  }
}

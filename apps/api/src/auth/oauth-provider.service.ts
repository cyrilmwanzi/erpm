import {
  BadRequestException,
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
import {
  decodeJwt,
  decryptAuthSecret,
  encryptAuthSecret,
  generateAsymmetricKeyPair,
  generateRandomToken,
  generateRfc8628UserCode,
  matchesIpAllowlist,
  safeEqualStrings,
  sha256Hex,
  signJwt,
  toJwtAlg,
  validateSafeExternalEndpoint,
  verifyJwtSignature,
  verifyPkceS256,
} from "./crypto.utils.js";
import {
  ALL_SUPPORTED_OAUTH_SCOPES,
  isValidOAuthScope,
  normalizeScopesInput,
} from "./permissions.js";

export interface VerifiedOAuthAccessToken {
  jti: string;
  organizationId: string;
  oauthClientId: string;
  clientId: string;
  sub: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  principalType: "USER" | "SERVICE_PRINCIPAL" | "DEVICE_TERMINAL";
  serviceRole: string;
  scopes: string[];
  deviceId: string | null;
  locationId: string | null;
  exp: number;
}

interface ClientAuthResult {
  client: {
    id: string;
    organizationId: string;
    clientId: string;
    name: string;
    clientType: string;
    appCategory: string;
    status: string;
    clientSecretHash: string | null;
    authMethods: string[];
    allowedGrantTypes: string[];
    redirectUris: string[];
    allowedScopes: string[];
    serviceRole: string;
    locationId: string | null;
    ipAllowlist: string[];
    jwksUri: string | null;
    isFirstParty: boolean;
    requireConsent: boolean;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  };
  authMethod: "none" | "client_secret_basic" | "client_secret_post" | "private_key_jwt";
}

interface EphemeralSigningKey {
  kid: string;
  algorithm: "ES256" | "RS256" | "EDDSA";
  publicJwk: Record<string, unknown>;
  privateKeyPem: string;
  publicKeyPem: string;
}

@Injectable()
export class OAuthProviderService {
  private fallbackSigningKey: EphemeralSigningKey | null = null;
  private readonly fallbackJtiReplay = new Map<string, number>();
  private readonly fallbackRevokedJti = new Map<string, number>();

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redisService: RedisService,
  ) {}

  private oauthError(
    error: string,
    description: string,
    status: "bad_request" | "unauthorized" = "bad_request",
  ): never {
    const payload = { error, error_description: description, message: description };
    if (status === "unauthorized") {
      throw new UnauthorizedException(payload);
    }
    throw new BadRequestException(payload);
  }

  private async recordAudit(params: {
    organizationId: string;
    actorUserId?: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    try {
      await this.prismaService.raw.auditLog.create({
        data: {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId ?? null,
          action: params.action,
          resourceType: params.resourceType,
          resourceId: params.resourceId ?? null,
          metadata: (params.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch {
      // non-fatal
    }
  }

  private async getOrCreatePrimarySigningKey(): Promise<{
    kid: string;
    algorithm: "ES256" | "RS256" | "EDDSA";
    privateKeyPem: string;
    publicJwk: Record<string, unknown>;
  }> {
    try {
      const existing = await this.prismaService.raw.authSigningKey.findFirst({
        where: { isActive: true, isPrimary: true },
        orderBy: { createdAt: "desc" },
      });

      if (existing?.kid && existing.encryptedPrivateKeyPem) {
        return {
          kid: existing.kid,
          algorithm: existing.algorithm,
          privateKeyPem: decryptAuthSecret(existing.encryptedPrivateKeyPem),
          publicJwk: existing.publicJwk as Record<string, unknown>,
        };
      }

      const kid = `scace-sig-${generateRandomToken(8).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12)}`;
      const generated = generateAsymmetricKeyPair("ES256", kid);
      const encryptedPrivateKeyPem = encryptAuthSecret(generated.privateKeyPem);

      const created = await this.prismaService.raw.authSigningKey.create({
        data: {
          kid: generated.kid,
          algorithm: generated.algorithm,
          publicJwk: generated.publicJwk as Prisma.InputJsonValue,
          encryptedPrivateKeyPem,
          isPrimary: true,
          isActive: true,
        },
      });

      if (created?.kid) {
        return {
          kid: generated.kid,
          algorithm: generated.algorithm,
          privateKeyPem: generated.privateKeyPem,
          publicJwk: generated.publicJwk,
        };
      }
    } catch {
      // Fall back to process-local ephemeral key if DB unavailable
    }

    if (!this.fallbackSigningKey) {
      const kid = `scace-ephem-${generateRandomToken(6).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 10)}`;
      this.fallbackSigningKey = generateAsymmetricKeyPair("ES256", kid);
    }
    return this.fallbackSigningKey;
  }

  async getJwks(): Promise<{ keys: Record<string, unknown>[] }> {
    try {
      const keys = await this.prismaService.raw.authSigningKey.findMany({
        where: {
          isActive: true,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { publicJwk: true },
        orderBy: { createdAt: "desc" },
      });
      if (keys.length > 0) {
        return { keys: keys.map((k) => k.publicJwk as Record<string, unknown>) };
      }
    } catch {
      // ignore and fall back
    }
    const primary = await this.getOrCreatePrimarySigningKey();
    return { keys: [primary.publicJwk] };
  }

  getOpenIdConfiguration() {
    const env = getEnv();
    const issuer = env.OAUTH_ISSUER_URL;
    return {
      issuer,
      authorization_endpoint: `${issuer}/api/v1/oauth/authorize`,
      token_endpoint: `${issuer}/api/v1/oauth/token`,
      device_authorization_endpoint: `${issuer}/api/v1/oauth/device/code`,
      introspection_endpoint: `${issuer}/api/v1/oauth/introspect`,
      revocation_endpoint: `${issuer}/api/v1/oauth/revoke`,
      userinfo_endpoint: `${issuer}/api/v1/me`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: [
        "authorization_code",
        "client_credentials",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["ES256", "RS256", "EdDSA"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_basic",
        "client_secret_post",
        "private_key_jwt",
      ],
      token_endpoint_auth_signing_alg_values_supported: ["ES256", "RS256", "EdDSA"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      resource_indicators_supported: true,
      scopes_supported: [...ALL_SUPPORTED_OAUTH_SCOPES],
    };
  }

  getProtectedResourceMetadata(resourcePath?: string) {
    const env = getEnv();
    const issuer = env.OAUTH_ISSUER_URL;
    const trimmedPath = resourcePath?.replace(/^\/+|\/+$/g, "") ?? "";
    if (
      trimmedPath &&
      (trimmedPath.includes("..") || !/^[a-zA-Z0-9._/-]+$/.test(trimmedPath))
    ) {
      throw new BadRequestException("Invalid protected resource metadata path.");
    }
    const resource = trimmedPath ? `${issuer}/${trimmedPath}` : issuer;
    return {
      resource,
      authorization_servers: [issuer],
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      scopes_supported: [...ALL_SUPPORTED_OAUTH_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Scace ERP API",
    };
  }

  private validateResourceIndicator(rawResource: unknown): string | undefined {
    if (rawResource === undefined || rawResource === null || rawResource === "") {
      return undefined;
    }
    if (typeof rawResource !== "string") {
      this.oauthError("invalid_target", "resource parameter must be a valid URI string.");
    }
    let parsed: URL;
    try {
      parsed = new URL(rawResource.trim());
    } catch {
      this.oauthError("invalid_target", "resource parameter must be a valid absolute URI.");
    }
    if (parsed.hash) {
      this.oauthError("invalid_target", "resource parameter must not include a fragment.");
    }
    const env = getEnv();
    const allowedOrigins = new Set<string>();
    try {
      allowedOrigins.add(new URL(env.OAUTH_ISSUER_URL).origin);
    } catch {
      // ignore
    }
    try {
      allowedOrigins.add(new URL(env.APP_URL).origin);
    } catch {
      // ignore
    }
    if (!allowedOrigins.has(parsed.origin)) {
      this.oauthError(
        "invalid_target",
        "Requested resource indicator does not match this API server.",
      );
    }
    return parsed.toString().replace(/\/+$/, "");
  }

  private async markJtiUsed(jti: string, ttlSeconds: number): Promise<boolean> {
    const key = `oauth:assertion:jti:${jti}`;
    try {
      const existing = await this.redisService.getJson<string>(key);
      if (existing) {
        return false;
      }
      await this.redisService.setJson(key, "1", Math.max(60, ttlSeconds));
      return true;
    } catch {
      const now = Date.now();
      for (const [k, exp] of this.fallbackJtiReplay.entries()) {
        if (exp <= now) {
          this.fallbackJtiReplay.delete(k);
        }
      }
      if (this.fallbackJtiReplay.has(jti)) {
        return false;
      }
      this.fallbackJtiReplay.set(jti, now + Math.max(60, ttlSeconds) * 1000);
      return true;
    }
  }

  private async markTokenJtiRevoked(jti: string, ttlSeconds: number): Promise<void> {
    const ttl = Math.max(60, ttlSeconds);
    try {
      await this.redisService.setJson(`oauth:revoked:jti:${jti}`, "1", ttl);
    } catch {
      this.fallbackRevokedJti.set(jti, Date.now() + ttl * 1000);
    }
  }

  private async isTokenJtiRevoked(jti: string): Promise<boolean> {
    try {
      const flag = await this.redisService.getJson<string>(`oauth:revoked:jti:${jti}`);
      if (flag) {
        return true;
      }
    } catch {
      // ignore
    }
    const exp = this.fallbackRevokedJti.get(jti);
    if (!exp) {
      return false;
    }
    if (exp <= Date.now()) {
      this.fallbackRevokedJti.delete(jti);
      return false;
    }
    return true;
  }

  private async authenticateClient(
    body: Record<string, unknown>,
    authorizationHeader?: string,
    clientIp?: string,
  ): Promise<ClientAuthResult> {
    let basicClientId: string | undefined;
    let basicClientSecret: string | undefined;

    if (authorizationHeader && authorizationHeader.startsWith("Basic ")) {
      const encoded = authorizationHeader.slice(6).trim();
      const decodedStr = Buffer.from(encoded, "base64").toString("utf8");
      const sep = decodedStr.indexOf(":");
      if (sep > 0) {
        basicClientId = decodeURIComponent(decodedStr.slice(0, sep));
        basicClientSecret = decodeURIComponent(decodedStr.slice(sep + 1));
      }
    }

    const assertionType =
      typeof body.client_assertion_type === "string" ? body.client_assertion_type : undefined;
    const assertionJwt =
      typeof body.client_assertion === "string" ? body.client_assertion : undefined;
    const bodyClientId = typeof body.client_id === "string" ? body.client_id : undefined;
    const bodyClientSecret =
      typeof body.client_secret === "string" ? body.client_secret : undefined;

    if (assertionType || assertionJwt) {
      if (
        assertionType !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" ||
        !assertionJwt
      ) {
        this.oauthError("invalid_client", "Unsupported client_assertion_type.", "unauthorized");
      }

      const decoded = decodeJwt(assertionJwt);
      if (!decoded) {
        this.oauthError("invalid_client", "Malformed client_assertion JWT.", "unauthorized");
      }

      const iss = typeof decoded.payload.iss === "string" ? decoded.payload.iss : "";
      const sub = typeof decoded.payload.sub === "string" ? decoded.payload.sub : "";
      const jti = typeof decoded.payload.jti === "string" ? decoded.payload.jti : "";
      const exp = typeof decoded.payload.exp === "number" ? decoded.payload.exp : 0;
      const iat = typeof decoded.payload.iat === "number" ? decoded.payload.iat : undefined;
      const aud = decoded.payload.aud;

      if (!iss || !sub || iss !== sub) {
        this.oauthError(
          "invalid_client",
          "client_assertion iss and sub must match the client_id.",
          "unauthorized",
        );
      }
      if (bodyClientId && bodyClientId !== sub) {
        this.oauthError(
          "invalid_client",
          "client_id does not match client_assertion subject.",
          "unauthorized",
        );
      }
      if (!jti || jti.length < 8) {
        this.oauthError(
          "invalid_client",
          "client_assertion must include a unique jti claim.",
          "unauthorized",
        );
      }

      const nowSec = Math.floor(Date.now() / 1000);
      if (!exp || exp <= nowSec) {
        this.oauthError("invalid_client", "client_assertion has expired.", "unauthorized");
      }
      if (exp - nowSec > 600 || (iat !== undefined && (iat > nowSec + 60 || exp - iat > 600))) {
        this.oauthError(
          "invalid_client",
          "client_assertion lifetime exceeds maximum 10 minutes.",
          "unauthorized",
        );
      }

      const env = getEnv();
      const validAudiences = new Set([
        env.OAUTH_ISSUER_URL,
        `${env.OAUTH_ISSUER_URL}/api/v1/oauth/token`,
        `${env.APP_URL}/api/v1/oauth/token`,
        env.APP_URL,
      ]);
      const audList = Array.isArray(aud) ? aud : typeof aud === "string" ? [aud] : [];
      if (!audList.some((a) => typeof a === "string" && validAudiences.has(a.replace(/\/+$/, "")))) {
        this.oauthError("invalid_client", "client_assertion audience mismatch.", "unauthorized");
      }

      const client = await this.prismaService.raw.oAuthClient.findUnique({
        where: { clientId: sub },
        include: {
          keys: {
            where: {
              isActive: true,
              revokedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
          },
        },
      });

      if (!client || client.status !== "ACTIVE") {
        this.oauthError("invalid_client", "Unknown or inactive OAuth2 client.", "unauthorized");
      }
      if (!client.authMethods.includes("private_key_jwt")) {
        this.oauthError(
          "unauthorized_client",
          "private_key_jwt is not enabled for this client.",
          "unauthorized",
        );
      }
      if (!matchesIpAllowlist(clientIp, client.ipAllowlist)) {
        this.oauthError("invalid_client", "Client IP is not in allowlist.", "unauthorized");
      }

      const headerKid = typeof decoded.header.kid === "string" ? decoded.header.kid : undefined;
      const candidateKeys = headerKid
        ? client.keys.filter((k) => k.kid === headerKid)
        : client.keys;

      let verified = candidateKeys.some((k) =>
        verifyJwtSignature(decoded, k.publicKeyPem, toJwtAlg(k.algorithm)),
      );

      if (!verified && client.jwksUri) {
        try {
          const safeUrl = await validateSafeExternalEndpoint(client.jwksUri);
          const resp = await fetch(safeUrl, { signal: AbortSignal.timeout(5000) });
          if (resp.ok) {
            const jwks = (await resp.json()) as { keys?: Record<string, unknown>[] };
            const remoteKeys = Array.isArray(jwks.keys) ? jwks.keys : [];
            const matching = headerKid
              ? remoteKeys.filter((k) => k.kid === headerKid)
              : remoteKeys;
            verified = matching.some((jwk) => verifyJwtSignature(decoded, jwk));
          }
        } catch {
          verified = false;
        }
      }

      if (!verified) {
        this.oauthError(
          "invalid_client",
          "client_assertion signature verification failed.",
          "unauthorized",
        );
      }

      const jtiFresh = await this.markJtiUsed(`${client.id}:${jti}`, exp - nowSec + 30);
      if (!jtiFresh) {
        this.oauthError(
          "invalid_client",
          "client_assertion jti has already been used.",
          "unauthorized",
        );
      }

      return { client, authMethod: "private_key_jwt" };
    }

    const clientId = basicClientId ?? bodyClientId;
    if (!clientId) {
      this.oauthError("invalid_client", "client_id is required.", "unauthorized");
    }

    const client = await this.prismaService.raw.oAuthClient.findUnique({
      where: { clientId },
    });
    if (!client || client.status !== "ACTIVE") {
      this.oauthError("invalid_client", "Unknown or inactive OAuth2 client.", "unauthorized");
    }
    if (!matchesIpAllowlist(clientIp, client.ipAllowlist)) {
      this.oauthError("invalid_client", "Client IP is not in allowlist.", "unauthorized");
    }

    if (basicClientSecret !== undefined) {
      if (!client.authMethods.includes("client_secret_basic") || !client.clientSecretHash) {
        this.oauthError(
          "unauthorized_client",
          "client_secret_basic is not enabled for this client.",
          "unauthorized",
        );
      }
      if (!safeEqualStrings(sha256Hex(basicClientSecret), client.clientSecretHash)) {
        this.oauthError("invalid_client", "Invalid client credentials.", "unauthorized");
      }
      return { client, authMethod: "client_secret_basic" };
    }

    if (bodyClientSecret !== undefined) {
      if (!client.authMethods.includes("client_secret_post") || !client.clientSecretHash) {
        this.oauthError(
          "unauthorized_client",
          "client_secret_post is not enabled for this client.",
          "unauthorized",
        );
      }
      if (!safeEqualStrings(sha256Hex(bodyClientSecret), client.clientSecretHash)) {
        this.oauthError("invalid_client", "Invalid client credentials.", "unauthorized");
      }
      return { client, authMethod: "client_secret_post" };
    }

    if (!client.authMethods.includes("none")) {
      this.oauthError(
        "invalid_client",
        "Client authentication is required for this OAuth2 client.",
        "unauthorized",
      );
    }

    return { client, authMethod: "none" };
  }

  private resolveRequestedScopes(
    requestedRaw: string | string[] | undefined,
    allowedScopes: string[],
  ): string[] {
    if (!requestedRaw || (Array.isArray(requestedRaw) && requestedRaw.length === 0)) {
      return [...allowedScopes];
    }
    const requested = normalizeScopesInput(requestedRaw);
    for (const scope of requested) {
      if (!isValidOAuthScope(scope)) {
        this.oauthError("invalid_scope", `Unsupported scope "${scope}".`);
      }
      if (!allowedScopes.includes(scope)) {
        this.oauthError(
          "invalid_scope",
          `Client is not authorized to request scope "${scope}".`,
        );
      }
    }
    return requested;
  }

  private async mintTokens(params: {
    client: ClientAuthResult["client"];
    sub: string;
    principalType: "USER" | "SERVICE_PRINCIPAL" | "DEVICE_TERMINAL";
    userId?: string | null;
    userEmail?: string | null;
    userName?: string | null;
    scopes: string[];
    resource?: string;
    registeredDeviceId?: string | null;
    existingFamilyId?: string;
    issueRefreshToken: boolean;
  }) {
    const env = getEnv();
    const signingKey = await this.getOrCreatePrimarySigningKey();
    const nowSec = Math.floor(Date.now() / 1000);
    const accessTtl = params.client.accessTokenTtlSeconds || env.OAUTH_ACCESS_TOKEN_TTL_SECONDS;
    const jti = `scace_at_${generateRandomToken(18)}`;
    const audience =
      params.resource && params.resource !== env.OAUTH_ISSUER_URL
        ? [env.OAUTH_ISSUER_URL, params.resource]
        : env.OAUTH_ISSUER_URL;

    const accessPayload: Record<string, unknown> = {
      iss: env.OAUTH_ISSUER_URL,
      sub: params.sub,
      aud: audience,
      iat: nowSec,
      exp: nowSec + accessTtl,
      jti,
      org_id: params.client.organizationId,
      client_id: params.client.clientId,
      principal_type: params.principalType,
      service_role: params.client.serviceRole,
      scope: params.scopes.join(" "),
      ...(params.userId ? { uid: params.userId } : {}),
      ...(params.userEmail ? { email: params.userEmail } : {}),
      ...(params.userName ? { name: params.userName } : {}),
      ...(params.registeredDeviceId ? { device_id: params.registeredDeviceId } : {}),
      ...(params.client.locationId ? { location_id: params.client.locationId } : {}),
    };

    const accessToken = signJwt({
      payload: accessPayload,
      privateKeyPem: signingKey.privateKeyPem,
      kid: signingKey.kid,
      algorithm: signingKey.algorithm,
      typ: "at+jwt",
    });

    let refreshToken: string | undefined;
    if (params.issueRefreshToken && params.client.allowedGrantTypes.includes("refresh_token")) {
      const rawRefresh = `scace_rt_${generateRandomToken(36)}`;
      const refreshTtl =
        params.client.refreshTokenTtlSeconds || env.OAUTH_REFRESH_TOKEN_TTL_SECONDS;
      const familyId = params.existingFamilyId ?? `fam_${generateRandomToken(16)}`;
      await this.prismaService.raw.oAuthRefreshToken.create({
        data: {
          organizationId: params.client.organizationId,
          oauthClientId: params.client.id,
          userId: params.userId ?? null,
          registeredDeviceId: params.registeredDeviceId ?? null,
          familyId,
          tokenHash: sha256Hex(rawRefresh),
          scopes: params.scopes,
          expiresAt: new Date(Date.now() + refreshTtl * 1000),
        },
      });
      refreshToken = rawRefresh;
    }

    let idToken: string | undefined;
    if (params.principalType === "USER" && params.scopes.includes("openid")) {
      idToken = signJwt({
        payload: {
          iss: env.OAUTH_ISSUER_URL,
          sub: params.sub,
          aud: params.client.clientId,
          iat: nowSec,
          exp: nowSec + accessTtl,
          org_id: params.client.organizationId,
          ...(params.scopes.includes("email") && params.userEmail
            ? { email: params.userEmail, email_verified: true }
            : {}),
          ...(params.scopes.includes("profile") && params.userName
            ? { name: params.userName }
            : {}),
        },
        privateKeyPem: signingKey.privateKeyPem,
        kid: signingKey.kid,
        algorithm: signingKey.algorithm,
        typ: "JWT",
      });
    }

    return {
      token_type: "Bearer",
      access_token: accessToken,
      expires_in: accessTtl,
      scope: params.scopes.join(" "),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      ...(idToken ? { id_token: idToken } : {}),
      ...(params.registeredDeviceId ? { device_id: params.registeredDeviceId } : {}),
    };
  }

  async authorizePkce(
    tenant: AuthenticatedOrganization,
    input: {
      clientId: string;
      redirectUri: string;
      scope?: string;
      state?: string;
      resource?: string;
      codeChallenge: string;
      codeChallengeMethod: "S256";
      nonce?: string;
      deviceIdentifier?: string;
      deviceName?: string;
      deviceOsVersion?: string;
      deviceAppVersion?: string;
    },
  ) {
    if (tenant.isServicePrincipal) {
      throw new ForbiddenException("Service principals cannot authorize interactive PKCE flows.");
    }

    this.validateResourceIndicator(input.resource);

    const client = await this.prismaService.raw.oAuthClient.findUnique({
      where: { clientId: input.clientId },
    });
    if (!client || client.status !== "ACTIVE" || client.organizationId !== tenant.organizationId) {
      this.oauthError("unauthorized_client", "OAuth2 client not found in the active organization.");
    }
    if (!client.allowedGrantTypes.includes("authorization_code")) {
      this.oauthError("unauthorized_client", "authorization_code grant is not enabled for this client.");
    }
    if (!client.redirectUris.includes(input.redirectUri)) {
      this.oauthError("invalid_request", "redirect_uri is not registered for this client.");
    }
    if (input.codeChallengeMethod !== "S256" || input.codeChallenge.length < 43) {
      this.oauthError("invalid_request", "PKCE S256 code_challenge is required.");
    }

    const scopes = this.resolveRequestedScopes(input.scope, client.allowedScopes);
    const rawCode = `scace_ac_${generateRandomToken(32)}`;

    await this.prismaService.raw.oAuthAuthorizationCode.create({
      data: {
        organizationId: client.organizationId,
        oauthClientId: client.id,
        userId: tenant.userId,
        codeHash: sha256Hex(rawCode),
        redirectUri: input.redirectUri,
        scopes,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: "S256",
        nonce: input.nonce ?? null,
        deviceIdentifier: input.deviceIdentifier ?? null,
        deviceName: input.deviceName ?? null,
        deviceOsVersion: input.deviceOsVersion ?? null,
        deviceAppVersion: input.deviceAppVersion ?? null,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    const env = getEnv();
    const redirectUrl = new URL(input.redirectUri);
    redirectUrl.searchParams.set("code", rawCode);
    if (input.state) {
      redirectUrl.searchParams.set("state", input.state);
    }
    redirectUrl.searchParams.set("iss", env.OAUTH_ISSUER_URL);

    await this.recordAudit({
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
      action: "oauth.authorization_code.issued",
      resourceType: "OAuthClient",
      resourceId: client.id,
      metadata: {
        clientId: client.clientId,
        scopes,
        deviceIdentifier: input.deviceIdentifier ?? null,
      },
    });

    return {
      code: rawCode,
      state: input.state ?? null,
      iss: env.OAUTH_ISSUER_URL,
      scopes,
      redirectTo: redirectUrl.toString(),
      expiresIn: 300,
    };
  }

  async requestDeviceCode(
    body: Record<string, unknown>,
    authorizationHeader?: string,
    clientIp?: string,
  ) {
    const authResult = await this.authenticateClient(body, authorizationHeader, clientIp);
    const { client } = authResult;

    if (!client.allowedGrantTypes.includes("urn:ietf:params:oauth:grant-type:device_code")) {
      this.oauthError(
        "unauthorized_client",
        "RFC 8628 device authorization grant is not enabled for this client.",
      );
    }

    const scopes = this.resolveRequestedScopes(
      typeof body.scope === "string" ? body.scope : undefined,
      client.allowedScopes,
    );

    const rawDeviceCode = `scace_dc_${generateRandomToken(32)}`;
    const userCode = generateRfc8628UserCode();
    const expiresIn = 600;
    const interval = 5;

    const requestedType =
      typeof body.device_type === "string" &&
      ["ANDROID", "POS_TERMINAL", "PRODUCTION_KIOSK", "SCANNER", "SYSTEM_AGENT"].includes(
        body.device_type,
      )
        ? (body.device_type as
            | "ANDROID"
            | "POS_TERMINAL"
            | "PRODUCTION_KIOSK"
            | "SCANNER"
            | "SYSTEM_AGENT")
        : client.appCategory === "PRODUCTION_SYSTEM"
          ? "PRODUCTION_KIOSK"
          : "POS_TERMINAL";

    await this.prismaService.raw.oAuthDeviceCode.create({
      data: {
        organizationId: client.organizationId,
        oauthClientId: client.id,
        locationId: client.locationId,
        deviceCodeHash: sha256Hex(rawDeviceCode),
        userCode,
        scopes,
        status: "PENDING",
        deviceName:
          typeof body.device_name === "string" ? body.device_name.slice(0, 120) : client.name,
        deviceIdentifier:
          typeof body.device_identifier === "string"
            ? body.device_identifier.slice(0, 160)
            : `term_${generateRandomToken(8)}`,
        deviceType: requestedType,
        intervalSeconds: interval,
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      },
    });

    const env = getEnv();
    const verificationUri = `${env.APP_URL}/api/v1/oauth/device/verify`;
    return {
      device_code: rawDeviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
      expires_in: expiresIn,
      interval,
    };
  }

  async verifyDeviceCode(
    tenant: AuthenticatedOrganization,
    input: {
      userCode: string;
      decision: "APPROVE" | "DENY";
      locationId?: string;
      deviceName?: string;
    },
  ) {
    const normalizedCode = input.userCode.trim().toUpperCase();
    const record = await this.prismaService.scoped.oAuthDeviceCode.findUnique({
      where: { userCode: normalizedCode },
      include: { oauthClient: true },
    });

    if (!record || record.organizationId !== tenant.organizationId) {
      throw new NotFoundException("Device pairing code not found.");
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      await this.prismaService.scoped.oAuthDeviceCode.update({
        where: { id: record.id },
        data: { status: "EXPIRED" },
      });
      throw new BadRequestException("Device pairing code has expired.");
    }
    if (record.status !== "PENDING") {
      throw new BadRequestException(`Device pairing code is already ${record.status}.`);
    }

    if (input.locationId) {
      const loc = await this.prismaService.scoped.location.findUnique({
        where: { id: input.locationId },
        select: { id: true, organizationId: true },
      });
      if (!loc || loc.organizationId !== tenant.organizationId) {
        throw new BadRequestException("locationId does not belong to the active organization.");
      }
    }

    const now = new Date();
    if (input.decision === "DENY") {
      const denied = await this.prismaService.scoped.oAuthDeviceCode.update({
        where: { id: record.id },
        data: {
          status: "DENIED",
          deniedByUserId: tenant.userId,
          deniedAt: now,
        },
      });
      await this.recordAudit({
        organizationId: tenant.organizationId,
        actorUserId: tenant.userId,
        action: "oauth.device_code.denied",
        resourceType: "OAuthDeviceCode",
        resourceId: record.id,
        metadata: { userCode: normalizedCode, clientId: record.oauthClient.clientId },
      });
      return { id: denied.id, userCode: denied.userCode, status: denied.status };
    }

    const approved = await this.prismaService.scoped.oAuthDeviceCode.update({
      where: { id: record.id },
      data: {
        status: "APPROVED",
        approvedByUserId: tenant.userId,
        approvedAt: now,
        ...(input.locationId ? { locationId: input.locationId } : {}),
        ...(input.deviceName ? { deviceName: input.deviceName } : {}),
      },
    });

    await this.recordAudit({
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
      action: "oauth.device_code.approved",
      resourceType: "OAuthDeviceCode",
      resourceId: record.id,
      metadata: {
        userCode: normalizedCode,
        clientId: record.oauthClient.clientId,
        locationId: approved.locationId,
        deviceName: approved.deviceName,
      },
    });

    return {
      id: approved.id,
      userCode: approved.userCode,
      status: approved.status,
      deviceType: approved.deviceType,
      deviceName: approved.deviceName,
      locationId: approved.locationId,
    };
  }

  private async upsertRegisteredDevice(params: {
    organizationId: string;
    oauthClientId: string;
    userId?: string | null;
    locationId?: string | null;
    deviceType: "ANDROID" | "POS_TERMINAL" | "PRODUCTION_KIOSK" | "SCANNER" | "SYSTEM_AGENT";
    deviceIdentifier: string;
    name: string;
    osVersion?: string | null;
    appVersion?: string | null;
    clientIp?: string;
  }) {
    const existing = await this.prismaService.raw.registeredDevice.findUnique({
      where: {
        organizationId_deviceIdentifier_deviceType: {
          organizationId: params.organizationId,
          deviceIdentifier: params.deviceIdentifier,
          deviceType: params.deviceType,
        },
      },
    });

    if (existing) {
      if (existing.status === "REVOKED" || existing.status === "SUSPENDED") {
        this.oauthError(
          "access_denied",
          `Device is ${existing.status.toLowerCase()} and cannot obtain tokens.`,
          "unauthorized",
        );
      }
      if (!matchesIpAllowlist(params.clientIp, existing.ipAllowlist)) {
        this.oauthError("access_denied", "Device IP is outside allowlist.", "unauthorized");
      }
      return this.prismaService.raw.registeredDevice.update({
        where: { id: existing.id },
        data: {
          oauthClientId: params.oauthClientId,
          ...(params.userId !== undefined ? { userId: params.userId } : {}),
          ...(params.locationId !== undefined ? { locationId: params.locationId } : {}),
          name: params.name,
          ...(params.osVersion ? { osVersion: params.osVersion } : {}),
          ...(params.appVersion ? { appVersion: params.appVersion } : {}),
          lastSeenAt: new Date(),
          lastIp: params.clientIp ?? existing.lastIp,
        },
      });
    }

    return this.prismaService.raw.registeredDevice.create({
      data: {
        organizationId: params.organizationId,
        oauthClientId: params.oauthClientId,
        userId: params.userId ?? null,
        locationId: params.locationId ?? null,
        deviceType: params.deviceType,
        deviceIdentifier: params.deviceIdentifier,
        name: params.name,
        osVersion: params.osVersion ?? null,
        appVersion: params.appVersion ?? null,
        status: "ACTIVE",
        trusted: true,
        lastSeenAt: new Date(),
        lastIp: params.clientIp ?? null,
      },
    });
  }

  async exchangeToken(
    body: Record<string, unknown>,
    authorizationHeader?: string,
    clientIp?: string,
  ) {
    const grantType = typeof body.grant_type === "string" ? body.grant_type : "";
    if (!grantType) {
      this.oauthError("invalid_request", "grant_type is required.");
    }

    const authResult = await this.authenticateClient(body, authorizationHeader, clientIp);
    const { client, authMethod } = authResult;

    if (!client.allowedGrantTypes.includes(grantType)) {
      this.oauthError(
        "unauthorized_client",
        `Grant type "${grantType}" is not enabled for this client.`,
      );
    }

    const validatedResource = this.validateResourceIndicator(body.resource);

    if (grantType === "client_credentials") {
      if (authMethod === "none") {
        this.oauthError(
          "unauthorized_client",
          "client_credentials requires confidential client authentication.",
          "unauthorized",
        );
      }
      const scopes = this.resolveRequestedScopes(
        typeof body.scope === "string" ? body.scope : undefined,
        client.allowedScopes,
      );
      const tokens = await this.mintTokens({
        client,
        sub: `service:${client.clientId}`,
        principalType: "SERVICE_PRINCIPAL",
        scopes,
        resource: validatedResource,
        issueRefreshToken: false,
      });

      await this.recordAudit({
        organizationId: client.organizationId,
        action: "oauth.token.client_credentials",
        resourceType: "OAuthClient",
        resourceId: client.id,
        metadata: { clientId: client.clientId, authMethod, scopes },
      });

      return tokens;
    }

    if (grantType === "authorization_code") {
      const code = typeof body.code === "string" ? body.code : "";
      const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
      const codeVerifier = typeof body.code_verifier === "string" ? body.code_verifier : "";

      if (!code || !redirectUri || !codeVerifier) {
        this.oauthError(
          "invalid_request",
          "code, redirect_uri, and code_verifier are required.",
        );
      }

      const authCode = await this.prismaService.raw.oAuthAuthorizationCode.findUnique({
        where: { codeHash: sha256Hex(code) },
        include: {
          user: { select: { id: true, email: true, name: true, emailVerified: true } },
        },
      });

      if (
        !authCode ||
        authCode.oauthClientId !== client.id ||
        authCode.consumedAt != null ||
        authCode.expiresAt.getTime() <= Date.now()
      ) {
        this.oauthError("invalid_grant", "Invalid, consumed, or expired authorization code.");
      }

      if (authCode.redirectUri !== redirectUri) {
        this.oauthError("invalid_grant", "redirect_uri mismatch.");
      }

      if (!verifyPkceS256(codeVerifier, authCode.codeChallenge)) {
        this.oauthError("invalid_grant", "PKCE code_verifier verification failed.");
      }

      await this.prismaService.raw.oAuthAuthorizationCode.update({
        where: { id: authCode.id },
        data: { consumedAt: new Date() },
      });

      const deviceIdentifier =
        (typeof body.device_identifier === "string" && body.device_identifier.trim()) ||
        authCode.deviceIdentifier;

      let registeredDeviceId: string | null = null;
      if (deviceIdentifier || client.appCategory === "ANDROID_MOBILE") {
        const device = await this.upsertRegisteredDevice({
          organizationId: client.organizationId,
          oauthClientId: client.id,
          userId: authCode.userId,
          locationId: client.locationId,
          deviceType: client.appCategory === "ANDROID_MOBILE" ? "ANDROID" : "SCANNER",
          deviceIdentifier: deviceIdentifier || `android_${authCode.userId}`,
          name:
            (typeof body.device_name === "string" && body.device_name.trim()) ||
            authCode.deviceName ||
            `${authCode.user.name} Android Device`,
          osVersion:
            (typeof body.device_os_version === "string" && body.device_os_version.trim()) ||
            authCode.deviceOsVersion,
          appVersion:
            (typeof body.device_app_version === "string" && body.device_app_version.trim()) ||
            authCode.deviceAppVersion,
          clientIp,
        });
        registeredDeviceId = device.id;
      }

      const tokens = await this.mintTokens({
        client,
        sub: authCode.userId,
        principalType: "USER",
        userId: authCode.userId,
        userEmail: authCode.user.email,
        userName: authCode.user.name,
        scopes: authCode.scopes,
        resource: validatedResource,
        registeredDeviceId,
        issueRefreshToken: true,
      });

      await this.recordAudit({
        organizationId: client.organizationId,
        actorUserId: authCode.userId,
        action: "oauth.token.authorization_code",
        resourceType: "OAuthClient",
        resourceId: client.id,
        metadata: {
          clientId: client.clientId,
          registeredDeviceId,
          scopes: authCode.scopes,
        },
      });

      return tokens;
    }

    if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
      if (!deviceCode) {
        this.oauthError("invalid_request", "device_code is required.");
      }

      const record = await this.prismaService.raw.oAuthDeviceCode.findUnique({
        where: { deviceCodeHash: sha256Hex(deviceCode) },
      });
      if (!record || record.oauthClientId !== client.id) {
        this.oauthError("invalid_grant", "Unknown device_code.");
      }
      if (record.expiresAt.getTime() <= Date.now() || record.status === "EXPIRED") {
        this.oauthError("expired_token", "The device_code has expired.");
      }
      if (record.status === "DENIED") {
        this.oauthError("access_denied", "The device pairing request was denied.");
      }
      if (record.status === "CONSUMED" || record.consumedAt) {
        this.oauthError("invalid_grant", "The device_code has already been consumed.");
      }

      if (record.lastPolledAt) {
        const elapsedMs = Date.now() - record.lastPolledAt.getTime();
        if (elapsedMs < record.intervalSeconds * 1000) {
          await this.prismaService.raw.oAuthDeviceCode.update({
            where: { id: record.id },
            data: { lastPolledAt: new Date() },
          });
          this.oauthError("slow_down", "Polling too frequently; slow down.");
        }
      }

      await this.prismaService.raw.oAuthDeviceCode.update({
        where: { id: record.id },
        data: { lastPolledAt: new Date() },
      });

      if (record.status === "PENDING") {
        this.oauthError("authorization_pending", "Waiting for administrator approval.");
      }

      await this.prismaService.raw.oAuthDeviceCode.update({
        where: { id: record.id },
        data: { status: "CONSUMED", consumedAt: new Date() },
      });

      const device = await this.upsertRegisteredDevice({
        organizationId: client.organizationId,
        oauthClientId: client.id,
        userId: null,
        locationId: record.locationId ?? client.locationId,
        deviceType: record.deviceType,
        deviceIdentifier: record.deviceIdentifier || `device_${record.id}`,
        name: record.deviceName || client.name,
        clientIp,
      });

      const tokens = await this.mintTokens({
        client,
        sub: `device:${device.id}`,
        principalType: "DEVICE_TERMINAL",
        scopes: record.scopes,
        resource: validatedResource,
        registeredDeviceId: device.id,
        issueRefreshToken: true,
      });

      await this.recordAudit({
        organizationId: client.organizationId,
        actorUserId: record.approvedByUserId,
        action: "oauth.token.device_code",
        resourceType: "RegisteredDevice",
        resourceId: device.id,
        metadata: {
          clientId: client.clientId,
          deviceType: device.deviceType,
          locationId: device.locationId,
          scopes: record.scopes,
        },
      });

      return tokens;
    }

    if (grantType === "refresh_token") {
      const rawRefresh = typeof body.refresh_token === "string" ? body.refresh_token : "";
      if (!rawRefresh) {
        this.oauthError("invalid_request", "refresh_token is required.");
      }

      const existingToken = await this.prismaService.raw.oAuthRefreshToken.findUnique({
        where: { tokenHash: sha256Hex(rawRefresh) },
        include: {
          user: { select: { id: true, email: true, name: true, emailVerified: true } },
          registeredDevice: true,
        },
      });

      if (!existingToken || existingToken.oauthClientId !== client.id) {
        this.oauthError("invalid_grant", "Invalid refresh_token.");
      }

      if (existingToken.revokedAt) {
        // Refresh token reuse detection: revoke the entire family
        await this.prismaService.raw.oAuthRefreshToken.updateMany({
          where: { familyId: existingToken.familyId, revokedAt: null },
          data: {
            revokedAt: new Date(),
            revocationReason: "refresh_token_reuse_detected",
          },
        });
        await this.recordAudit({
          organizationId: existingToken.organizationId,
          actorUserId: existingToken.userId,
          action: "oauth.refresh_token.reuse_detected",
          resourceType: "OAuthRefreshToken",
          resourceId: existingToken.id,
          metadata: { familyId: existingToken.familyId, clientId: client.clientId },
        });
        this.oauthError(
          "invalid_grant",
          "Refresh token reuse detected; token family revoked.",
          "unauthorized",
        );
      }

      if (existingToken.expiresAt.getTime() <= Date.now()) {
        this.oauthError("invalid_grant", "Refresh token has expired.");
      }

      if (
        existingToken.registeredDevice &&
        existingToken.registeredDevice.status !== "ACTIVE"
      ) {
        this.oauthError(
          "invalid_grant",
          `Associated device is ${existingToken.registeredDevice.status.toLowerCase()}.`,
          "unauthorized",
        );
      }

      await this.prismaService.raw.oAuthRefreshToken.update({
        where: { id: existingToken.id },
        data: {
          revokedAt: new Date(),
          revocationReason: "rotated",
        },
      });

      if (existingToken.registeredDeviceId) {
        void this.prismaService.raw.registeredDevice
          .update({
            where: { id: existingToken.registeredDeviceId },
            data: { lastSeenAt: new Date(), lastIp: clientIp ?? undefined },
          })
          .catch(() => undefined);
      }

      const principalType: "USER" | "DEVICE_TERMINAL" = existingToken.userId
        ? "USER"
        : "DEVICE_TERMINAL";
      const sub = existingToken.userId
        ? existingToken.userId
        : `device:${existingToken.registeredDeviceId ?? client.clientId}`;

      return this.mintTokens({
        client,
        sub,
        principalType,
        userId: existingToken.userId,
        userEmail: existingToken.user?.email ?? null,
        userName: existingToken.user?.name ?? null,
        scopes: existingToken.scopes,
        resource: validatedResource,
        registeredDeviceId: existingToken.registeredDeviceId,
        existingFamilyId: existingToken.familyId,
        issueRefreshToken: true,
      });
    }

    this.oauthError("unsupported_grant_type", `Unsupported grant_type "${grantType}".`);
  }

  async verifyAccessToken(
    rawToken: string,
    clientIp?: string,
  ): Promise<VerifiedOAuthAccessToken | null> {
    const decoded = decodeJwt(rawToken);
    if (!decoded) {
      return null;
    }

    const env = getEnv();
    if (decoded.payload.iss !== env.OAUTH_ISSUER_URL) {
      return null;
    }

    const audClaim = decoded.payload.aud;
    const audList = Array.isArray(audClaim)
      ? audClaim
      : typeof audClaim === "string"
        ? [audClaim]
        : [];
    if (
      !audList.some(
        (a) =>
          typeof a === "string" &&
          a.replace(/\/+$/, "") === env.OAUTH_ISSUER_URL,
      )
    ) {
      return null;
    }

    const kid = typeof decoded.header.kid === "string" ? decoded.header.kid : "";
    const jwks = await this.getJwks();
    const matchingKey =
      (kid ? jwks.keys.find((k) => k.kid === kid) : jwks.keys[0]) ?? null;
    if (!matchingKey || !verifyJwtSignature(decoded, matchingKey)) {
      return null;
    }

    const exp = typeof decoded.payload.exp === "number" ? decoded.payload.exp : 0;
    const nbf = typeof decoded.payload.nbf === "number" ? decoded.payload.nbf : undefined;
    const nowSec = Math.floor(Date.now() / 1000);
    if (!exp || exp <= nowSec) {
      return null;
    }
    if (nbf !== undefined && nbf > nowSec + 30) {
      return null;
    }

    const jti = typeof decoded.payload.jti === "string" ? decoded.payload.jti : "";
    if (jti && (await this.isTokenJtiRevoked(jti))) {
      return null;
    }

    const organizationId =
      typeof decoded.payload.org_id === "string" ? decoded.payload.org_id : "";
    const clientId =
      typeof decoded.payload.client_id === "string" ? decoded.payload.client_id : "";
    const sub = typeof decoded.payload.sub === "string" ? decoded.payload.sub : "";
    if (!organizationId || !clientId || !sub) {
      return null;
    }

    const client = await this.prismaService.raw.oAuthClient.findUnique({
      where: { clientId },
      select: {
        id: true,
        organizationId: true,
        status: true,
        serviceRole: true,
        ipAllowlist: true,
        locationId: true,
      },
    });
    if (!client || client.status !== "ACTIVE" || client.organizationId !== organizationId) {
      return null;
    }
    if (!matchesIpAllowlist(clientIp, client.ipAllowlist)) {
      return null;
    }

    const deviceId =
      typeof decoded.payload.device_id === "string" ? decoded.payload.device_id : null;
    if (deviceId) {
      let cachedStatus: string | null = null;
      try {
        cachedStatus = await this.redisService.getJson<string>(`device:status:${deviceId}`);
      } catch {
        cachedStatus = null;
      }
      if (cachedStatus === "REVOKED" || cachedStatus === "SUSPENDED") {
        return null;
      }
      const device = await this.prismaService.raw.registeredDevice.findUnique({
        where: { id: deviceId },
        select: { status: true, ipAllowlist: true, organizationId: true },
      });
      if (
        !device ||
        device.organizationId !== organizationId ||
        device.status !== "ACTIVE" ||
        !matchesIpAllowlist(clientIp, device.ipAllowlist)
      ) {
        return null;
      }
    }

    const principalType =
      decoded.payload.principal_type === "SERVICE_PRINCIPAL" ||
      decoded.payload.principal_type === "DEVICE_TERMINAL"
        ? decoded.payload.principal_type
        : "USER";

    const scopeStr = typeof decoded.payload.scope === "string" ? decoded.payload.scope : "";
    const scopes = normalizeScopesInput(scopeStr);

    return {
      jti,
      organizationId,
      oauthClientId: client.id,
      clientId,
      sub,
      userId:
        typeof decoded.payload.uid === "string"
          ? decoded.payload.uid
          : sub,
      userEmail: typeof decoded.payload.email === "string" ? decoded.payload.email : null,
      userName: typeof decoded.payload.name === "string" ? decoded.payload.name : null,
      principalType,
      serviceRole: client.serviceRole,
      scopes,
      deviceId,
      locationId: client.locationId,
      exp,
    };
  }

  async introspectToken(
    body: Record<string, unknown>,
    authorizationHeader?: string,
    clientIp?: string,
  ) {
    await this.authenticateClient(body, authorizationHeader, clientIp);
    const token = typeof body.token === "string" ? body.token : "";
    if (!token) {
      return { active: false };
    }

    const verifiedJwt = await this.verifyAccessToken(token, clientIp);
    if (verifiedJwt) {
      return {
        active: true,
        token_type: "Bearer",
        scope: verifiedJwt.scopes.join(" "),
        client_id: verifiedJwt.clientId,
        sub: verifiedJwt.sub,
        org_id: verifiedJwt.organizationId,
        principal_type: verifiedJwt.principalType,
        device_id: verifiedJwt.deviceId,
        location_id: verifiedJwt.locationId,
        exp: verifiedJwt.exp,
        jti: verifiedJwt.jti,
      };
    }

    const refresh = await this.prismaService.raw.oAuthRefreshToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { oauthClient: { select: { clientId: true } } },
    });
    if (refresh && !refresh.revokedAt && refresh.expiresAt.getTime() > Date.now()) {
      return {
        active: true,
        token_type: "refresh_token",
        scope: refresh.scopes.join(" "),
        client_id: refresh.oauthClient.clientId,
        sub: refresh.userId ?? `device:${refresh.registeredDeviceId ?? refresh.oauthClient.clientId}`,
        org_id: refresh.organizationId,
        device_id: refresh.registeredDeviceId,
        exp: Math.floor(refresh.expiresAt.getTime() / 1000),
      };
    }

    return { active: false };
  }

  async revokeToken(
    body: Record<string, unknown>,
    authorizationHeader?: string,
    clientIp?: string,
  ) {
    const authResult = await this.authenticateClient(body, authorizationHeader, clientIp);
    const token = typeof body.token === "string" ? body.token : "";
    if (!token) {
      return { revoked: true };
    }

    const decoded = decodeJwt(token);
    if (decoded && typeof decoded.payload.jti === "string" && typeof decoded.payload.exp === "number") {
      if (decoded.payload.client_id === authResult.client.clientId) {
        const remaining = decoded.payload.exp - Math.floor(Date.now() / 1000);
        if (remaining > 0) {
          await this.markTokenJtiRevoked(decoded.payload.jti, remaining);
        }
      }
      return { revoked: true };
    }

    const refresh = await this.prismaService.raw.oAuthRefreshToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
    });
    if (refresh && refresh.oauthClientId === authResult.client.id && !refresh.revokedAt) {
      await this.prismaService.raw.oAuthRefreshToken.updateMany({
        where: { familyId: refresh.familyId, revokedAt: null },
        data: { revokedAt: new Date(), revocationReason: "revoked_by_client" },
      });
    }

    return { revoked: true };
  }
}

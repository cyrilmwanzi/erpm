import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { type Prisma } from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import { RedisService } from "../redis/redis.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import {
  generateRandomToken,
  parseClientPublicKey,
  sha256Hex,
  validateSafeExternalEndpoint,
} from "./crypto.utils.js";
import {
  isValidOAuthScope,
  isValidOrganizationRole,
  normalizeScopesInput,
  parseRoleNames,
} from "./permissions.js";

export type OAuthClientTypeValue =
  | "PUBLIC_PKCE"
  | "CONFIDENTIAL"
  | "M2M_SERVICE"
  | "DEVICE_TERMINAL";

export type OAuthAppCategoryValue =
  | "ANDROID_MOBILE"
  | "POS_TERMINAL"
  | "PRODUCTION_SYSTEM"
  | "ERP_INTEGRATION"
  | "WEB_APP"
  | "OTHER";

export type OAuthAuthMethodValue =
  | "none"
  | "client_secret_basic"
  | "client_secret_post"
  | "private_key_jwt";

export type OAuthGrantTypeValue =
  | "authorization_code"
  | "client_credentials"
  | "refresh_token"
  | "urn:ietf:params:oauth:grant-type:device_code";

export interface CreateOAuthClientInput {
  name: string;
  description?: string;
  clientType: OAuthClientTypeValue;
  appCategory: OAuthAppCategoryValue;
  authMethods?: OAuthAuthMethodValue[];
  allowedGrantTypes?: OAuthGrantTypeValue[];
  redirectUris?: string[];
  allowedScopes: string[];
  serviceRole?: string;
  locationId?: string;
  ipAllowlist?: string[];
  jwksUri?: string;
  isFirstParty?: boolean;
  requireConsent?: boolean;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
}

export interface UpdateOAuthClientInput {
  name?: string;
  description?: string | null;
  status?: "ACTIVE" | "SUSPENDED" | "REVOKED";
  authMethods?: OAuthAuthMethodValue[];
  allowedGrantTypes?: OAuthGrantTypeValue[];
  redirectUris?: string[];
  allowedScopes?: string[];
  serviceRole?: string;
  locationId?: string | null;
  ipAllowlist?: string[];
  jwksUri?: string | null;
  isFirstParty?: boolean;
  requireConsent?: boolean;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
}

export interface AddClientPublicKeyInput {
  name: string;
  kid?: string;
  algorithm: "RS256" | "ES256" | "EDDSA";
  publicKeyPem?: string;
  publicJwk?: Record<string, unknown>;
  expiresAt?: string;
}

const DEFAULT_GRANTS_BY_TYPE: Record<OAuthClientTypeValue, OAuthGrantTypeValue[]> = {
  PUBLIC_PKCE: ["authorization_code", "refresh_token"],
  CONFIDENTIAL: ["authorization_code", "refresh_token", "client_credentials"],
  M2M_SERVICE: ["client_credentials"],
  DEVICE_TERMINAL: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
};

const DEFAULT_AUTH_METHODS_BY_TYPE: Record<OAuthClientTypeValue, OAuthAuthMethodValue[]> = {
  PUBLIC_PKCE: ["none"],
  CONFIDENTIAL: ["client_secret_basic", "client_secret_post"],
  M2M_SERVICE: ["client_secret_basic", "private_key_jwt"],
  DEVICE_TERMINAL: ["none", "client_secret_post", "private_key_jwt"],
};

@Injectable()
export class OAuthClientsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redisService: RedisService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  private async recordAudit(params: {
    organizationId: string;
    actorUserId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }) {
    try {
      await this.prismaService.raw.auditLog.create({
        data: {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          action: params.action,
          resourceType: params.resourceType,
          resourceId: params.resourceId,
          metadata: (params.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch {
      // non-fatal
    }
  }

  private validateRedirectUris(uris: string[]) {
    for (const uri of uris) {
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        throw new BadRequestException(`Invalid redirectUri: "${uri}".`);
      }
      if (parsed.hash) {
        throw new BadRequestException(`redirectUri must not include fragments: "${uri}".`);
      }
      const isHttp = parsed.protocol === "http:";
      const isLocalhost =
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]";
      if (isHttp && !isLocalhost) {
        throw new BadRequestException(
          `Non-localhost HTTP redirectUri is not allowed (use https:// or a native app scheme): "${uri}".`,
        );
      }
    }
  }

  private validateScopes(rawScopes: string[]): string[] {
    const scopes = normalizeScopesInput(rawScopes);
    if (scopes.length === 0) {
      throw new BadRequestException("At least one allowed scope must be specified.");
    }
    for (const scope of scopes) {
      if (!isValidOAuthScope(scope)) {
        throw new BadRequestException(`Unsupported OAuth2 scope: "${scope}".`);
      }
    }
    return scopes;
  }

  async createClient(tenant: AuthenticatedOrganization, input: CreateOAuthClientInput) {
    const scopes = this.validateScopes(input.allowedScopes);
    const serviceRole = input.serviceRole ?? "member";
    if (!isValidOrganizationRole(serviceRole)) {
      throw new BadRequestException(`Invalid serviceRole: "${serviceRole}".`);
    }
    if (serviceRole === "owner" && !parseRoleNames(tenant.role).includes("owner")) {
      throw new ForbiddenException("Only an organization owner can bind a client to the owner role.");
    }

    const authMethods =
      input.authMethods && input.authMethods.length > 0
        ? Array.from(new Set(input.authMethods))
        : DEFAULT_AUTH_METHODS_BY_TYPE[input.clientType];
    const allowedGrantTypes =
      input.allowedGrantTypes && input.allowedGrantTypes.length > 0
        ? Array.from(new Set(input.allowedGrantTypes))
        : DEFAULT_GRANTS_BY_TYPE[input.clientType];

    if (input.clientType === "PUBLIC_PKCE" && authMethods.some((m) => m !== "none")) {
      throw new BadRequestException("PUBLIC_PKCE clients must use authMethod 'none'.");
    }

    const redirectUris = input.redirectUris ?? [];
    if (allowedGrantTypes.includes("authorization_code") && redirectUris.length === 0) {
      throw new BadRequestException(
        "authorization_code grant requires at least one registered redirectUri.",
      );
    }
    this.validateRedirectUris(redirectUris);

    let validatedJwksUri: string | null = null;
    if (input.jwksUri) {
      validatedJwksUri = await validateSafeExternalEndpoint(input.jwksUri);
    }

    if (input.locationId) {
      const loc = await this.prismaService.scoped.location.findUnique({
        where: { id: input.locationId },
        select: { id: true, organizationId: true },
      });
      if (!loc || loc.organizationId !== tenant.organizationId) {
        throw new BadRequestException("Specified locationId does not belong to the active organization.");
      }
    }

    const needsSecret =
      authMethods.includes("client_secret_basic") ||
      authMethods.includes("client_secret_post");
    const rawSecret = needsSecret ? `scace_sec_${generateRandomToken(32)}` : null;
    const clientSecretHash = rawSecret ? sha256Hex(rawSecret) : null;
    const clientSecretLast4 = rawSecret ? rawSecret.slice(-4) : null;
    const clientId = `scace_cli_${generateRandomToken(12).replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}`;

    const created = await this.prismaService.scoped.oAuthClient.create({
      data: {
        organizationId: tenant.organizationId,
        clientId,
        name: input.name,
        description: input.description ?? null,
        clientType: input.clientType,
        appCategory: input.appCategory,
        status: "ACTIVE",
        clientSecretHash,
        clientSecretLast4,
        authMethods,
        allowedGrantTypes,
        redirectUris,
        allowedScopes: scopes,
        serviceRole,
        locationId: input.locationId ?? null,
        ipAllowlist: input.ipAllowlist ?? [],
        jwksUri: validatedJwksUri,
        isFirstParty: input.isFirstParty ?? input.appCategory === "ANDROID_MOBILE",
        requireConsent: input.requireConsent ?? input.appCategory !== "ANDROID_MOBILE",
        accessTokenTtlSeconds: input.accessTokenTtlSeconds ?? 900,
        refreshTokenTtlSeconds: input.refreshTokenTtlSeconds ?? 2592000,
        createdByUserId: tenant.userId,
      },
      select: {
        id: true,
        organizationId: true,
        clientId: true,
        name: true,
        description: true,
        clientType: true,
        appCategory: true,
        status: true,
        clientSecretLast4: true,
        authMethods: true,
        allowedGrantTypes: true,
        redirectUris: true,
        allowedScopes: true,
        serviceRole: true,
        locationId: true,
        ipAllowlist: true,
        jwksUri: true,
        isFirstParty: true,
        requireConsent: true,
        accessTokenTtlSeconds: true,
        refreshTokenTtlSeconds: true,
        createdAt: true,
      },
    });

    await this.recordAudit({
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
      action: "oauth_client.created",
      resourceType: "OAuthClient",
      resourceId: created.id,
      metadata: {
        clientId: created.clientId,
        clientType: created.clientType,
        appCategory: created.appCategory,
        authMethods: created.authMethods,
        allowedGrantTypes: created.allowedGrantTypes,
      },
    });

    this.analyticsService.captureDomainEvent({
      event: "auth.oauth_client_created",
      distinctId: tenant.userId,
      organizationId: tenant.organizationId,
      properties: {
        oauth_client_id: created.id,
        client_type: created.clientType,
        app_category: created.appCategory,
        scope_count: created.allowedScopes.length,
        service_role: created.serviceRole,
      },
    });

    return {
      ...created,
      ...(rawSecret
        ? {
            clientSecret: rawSecret,
            warning:
              "Store this clientSecret securely now. It will not be shown again.",
          }
        : {}),
    };
  }

  async listClients(
    tenant: AuthenticatedOrganization,
    filters?: { appCategory?: OAuthAppCategoryValue; status?: "ACTIVE" | "SUSPENDED" | "REVOKED" },
  ) {
    const items = await this.prismaService.scoped.oAuthClient.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(filters?.appCategory ? { appCategory: filters.appCategory } : {}),
        ...(filters?.status ? { status: filters.status } : {}),
      },
      select: {
        id: true,
        clientId: true,
        name: true,
        description: true,
        clientType: true,
        appCategory: true,
        status: true,
        clientSecretLast4: true,
        authMethods: true,
        allowedGrantTypes: true,
        redirectUris: true,
        allowedScopes: true,
        serviceRole: true,
        locationId: true,
        ipAllowlist: true,
        jwksUri: true,
        isFirstParty: true,
        requireConsent: true,
        accessTokenTtlSeconds: true,
        refreshTokenTtlSeconds: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            keys: true,
            registeredDevices: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return { items };
  }

  async findClientForTenant(tenant: AuthenticatedOrganization, idOrClientId: string) {
    const client = await this.prismaService.scoped.oAuthClient.findFirst({
      where: {
        organizationId: tenant.organizationId,
        OR: [{ id: idOrClientId }, { clientId: idOrClientId }],
      },
      include: {
        keys: {
          select: {
            id: true,
            kid: true,
            name: true,
            algorithm: true,
            publicJwk: true,
            isActive: true,
            expiresAt: true,
            revokedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!client) {
      throw new NotFoundException("OAuth2 client not found.");
    }
    const { clientSecretHash: _hidden, ...safeClient } = client;
    return safeClient;
  }

  async updateClient(
    tenant: AuthenticatedOrganization,
    idOrClientId: string,
    input: UpdateOAuthClientInput,
  ) {
    const existing = await this.prismaService.scoped.oAuthClient.findFirst({
      where: {
        organizationId: tenant.organizationId,
        OR: [{ id: idOrClientId }, { clientId: idOrClientId }],
      },
    });
    if (!existing) {
      throw new NotFoundException("OAuth2 client not found.");
    }

    if (input.allowedScopes) {
      this.validateScopes(input.allowedScopes);
    }
    if (input.redirectUris) {
      this.validateRedirectUris(input.redirectUris);
    }
    if (input.serviceRole) {
      if (!isValidOrganizationRole(input.serviceRole)) {
        throw new BadRequestException(`Invalid serviceRole: "${input.serviceRole}".`);
      }
      if (input.serviceRole === "owner" && !parseRoleNames(tenant.role).includes("owner")) {
        throw new ForbiddenException("Only an organization owner can bind a client to the owner role.");
      }
    }

    let jwksUriUpdate: string | null | undefined = undefined;
    if (input.jwksUri !== undefined) {
      jwksUriUpdate = input.jwksUri ? await validateSafeExternalEndpoint(input.jwksUri) : null;
    }

    const updated = await this.prismaService.scoped.oAuthClient.update({
      where: { id: existing.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status !== undefined
          ? {
              status: input.status,
              revokedAt: input.status === "REVOKED" ? new Date() : null,
            }
          : {}),
        ...(input.authMethods !== undefined ? { authMethods: input.authMethods } : {}),
        ...(input.allowedGrantTypes !== undefined
          ? { allowedGrantTypes: input.allowedGrantTypes }
          : {}),
        ...(input.redirectUris !== undefined ? { redirectUris: input.redirectUris } : {}),
        ...(input.allowedScopes !== undefined
          ? { allowedScopes: this.validateScopes(input.allowedScopes) }
          : {}),
        ...(input.serviceRole !== undefined ? { serviceRole: input.serviceRole } : {}),
        ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
        ...(input.ipAllowlist !== undefined ? { ipAllowlist: input.ipAllowlist } : {}),
        ...(jwksUriUpdate !== undefined ? { jwksUri: jwksUriUpdate } : {}),
        ...(input.isFirstParty !== undefined ? { isFirstParty: input.isFirstParty } : {}),
        ...(input.requireConsent !== undefined ? { requireConsent: input.requireConsent } : {}),
        ...(input.accessTokenTtlSeconds !== undefined
          ? { accessTokenTtlSeconds: input.accessTokenTtlSeconds }
          : {}),
        ...(input.refreshTokenTtlSeconds !== undefined
          ? { refreshTokenTtlSeconds: input.refreshTokenTtlSeconds }
          : {}),
      },
      select: {
        id: true,
        clientId: true,
        name: true,
        description: true,
        clientType: true,
        appCategory: true,
        status: true,
        clientSecretLast4: true,
        authMethods: true,
        allowedGrantTypes: true,
        redirectUris: true,
        allowedScopes: true,
        serviceRole: true,
        locationId: true,
        ipAllowlist: true,
        jwksUri: true,
        isFirstParty: true,
        requireConsent: true,
        accessTokenTtlSeconds: true,
        refreshTokenTtlSeconds: true,
        updatedAt: true,
      },
    });

    if (input.status === "REVOKED" || input.status === "SUSPENDED") {
      await this.prismaService.raw.oAuthRefreshToken.updateMany({
        where: {
          organizationId: tenant.organizationId,
          oauthClientId: existing.id,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
          revocationReason: `client_${input.status.toLowerCase()}`,
        },
      });
    }

    await this.recordAudit({
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
      action: "oauth_client.updated",
      resourceType: "OAuthClient",
      resourceId: existing.id,
      metadata: { status: updated.status, clientId: updated.clientId },
    });

    return updated;
  }

  async rotateClientSecret(tenant: AuthenticatedOrganization, idOrClientId: string) {
    const existing = await this.prismaService.scoped.oAuthClient.findFirst({
      where: {
        organizationId: tenant.organizationId,
        OR: [{ id: idOrClientId }, { clientId: idOrClientId }],
      },
    });
    if (!existing) {
      throw new NotFoundException("OAuth2 client not found.");
    }
    if (existing.clientType === "PUBLIC_PKCE") {
      throw new BadRequestException("PUBLIC_PKCE clients do not use client secrets.");
    }

    const rawSecret = `scace_sec_${generateRandomToken(32)}`;
    const updated = await this.prismaService.scoped.oAuthClient.update({
      where: { id: existing.id },
      data: {
        clientSecretHash: sha256Hex(rawSecret),
        clientSecretLast4: rawSecret.slice(-4),
      },
      select: {
        id: true,
        clientId: true,
        name: true,
        clientSecretLast4: true,
      },
    });

    await this.recordAudit({
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
      action: "oauth_client.secret_rotated",
      resourceType: "OAuthClient",
      resourceId: existing.id,
      metadata: { clientId: existing.clientId, last4: updated.clientSecretLast4 },
    });

    return {
      ...updated,
      clientSecret: rawSecret,
      warning: "Store the rotated clientSecret securely now. It will not be shown again.",
    };
  }

  async addClientPublicKey(
    tenant: AuthenticatedOrganization,
    idOrClientId: string,
    input: AddClientPublicKeyInput,
  ) {
    const client = await this.prismaService.scoped.oAuthClient.findFirst({
      where: {
        organizationId: tenant.organizationId,
        OR: [{ id: idOrClientId }, { clientId: idOrClientId }],
      },
    });
    if (!client) {
      throw new NotFoundException("OAuth2 client not found.");
    }

    const kid =
      input.kid?.trim() ||
      `key_${generateRandomToken(8).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12)}`;

    const parsedKey = parseClientPublicKey({
      publicKeyPem: input.publicKeyPem,
      publicJwk: input.publicJwk,
      algorithm: input.algorithm,
      kid,
    });

    let expiresAt: Date | null = null;
    if (input.expiresAt) {
      const parsedDate = new Date(input.expiresAt);
      if (Number.isNaN(parsedDate.getTime()) || parsedDate.getTime() <= Date.now()) {
        throw new BadRequestException("expiresAt must be a valid future ISO timestamp.");
      }
      expiresAt = parsedDate;
    }

    const duplicate = await this.prismaService.scoped.oAuthClientKey.findFirst({
      where: { oauthClientId: client.id, kid },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(`A key with kid "${kid}" is already registered for this client.`);
    }

    const created = await this.prismaService.scoped.oAuthClientKey.create({
      data: {
        organizationId: tenant.organizationId,
        oauthClientId: client.id,
        kid,
        name: input.name,
        algorithm: input.algorithm,
        publicKeyPem: parsedKey.publicKeyPem,
        publicJwk: parsedKey.publicJwk as Prisma.InputJsonValue,
        isActive: true,
        expiresAt,
        createdByUserId: tenant.userId,
      },
      select: {
        id: true,
        kid: true,
        name: true,
        algorithm: true,
        publicJwk: true,
        isActive: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    await this.recordAudit({
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
      action: "oauth_client_key.added",
      resourceType: "OAuthClientKey",
      resourceId: created.id,
      metadata: { clientId: client.clientId, kid: created.kid, algorithm: created.algorithm },
    });

    return created;
  }

  async listClientPublicKeys(tenant: AuthenticatedOrganization, idOrClientId: string) {
    const client = await this.prismaService.scoped.oAuthClient.findFirst({
      where: {
        organizationId: tenant.organizationId,
        OR: [{ id: idOrClientId }, { clientId: idOrClientId }],
      },
      select: { id: true, clientId: true },
    });
    if (!client) {
      throw new NotFoundException("OAuth2 client not found.");
    }

    const items = await this.prismaService.scoped.oAuthClientKey.findMany({
      where: {
        organizationId: tenant.organizationId,
        oauthClientId: client.id,
      },
      select: {
        id: true,
        kid: true,
        name: true,
        algorithm: true,
        publicJwk: true,
        isActive: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return { items };
  }

  async revokeClientPublicKey(
    tenant: AuthenticatedOrganization,
    idOrClientId: string,
    keyId: string,
  ) {
    const client = await this.prismaService.scoped.oAuthClient.findFirst({
      where: {
        organizationId: tenant.organizationId,
        OR: [{ id: idOrClientId }, { clientId: idOrClientId }],
      },
      select: { id: true, clientId: true },
    });
    if (!client) {
      throw new NotFoundException("OAuth2 client not found.");
    }

    const existing = await this.prismaService.scoped.oAuthClientKey.findFirst({
      where: {
        organizationId: tenant.organizationId,
        oauthClientId: client.id,
        OR: [{ id: keyId }, { kid: keyId }],
      },
    });
    if (!existing) {
      throw new NotFoundException("OAuth2 client public key not found.");
    }

    const now = new Date();
    await this.prismaService.scoped.oAuthClientKey.update({
      where: { id: existing.id },
      data: { isActive: false, revokedAt: now },
    });

    await this.recordAudit({
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
      action: "oauth_client_key.revoked",
      resourceType: "OAuthClientKey",
      resourceId: existing.id,
      metadata: { clientId: client.clientId, kid: existing.kid },
    });

    return { id: existing.id, kid: existing.kid, revoked: true, revokedAt: now };
  }

  async listDevices(
    tenant: AuthenticatedOrganization,
    filters?: {
      deviceType?: "ANDROID" | "POS_TERMINAL" | "PRODUCTION_KIOSK" | "SCANNER" | "SYSTEM_AGENT";
      status?: "ACTIVE" | "SUSPENDED" | "REVOKED";
      locationId?: string;
      userId?: string;
    },
  ) {
    const roles = parseRoleNames(tenant.role);
    const canManageAll =
      roles.includes("owner") || roles.includes("admin") || roles.includes("manager");

    const where: Prisma.RegisteredDeviceWhereInput = {
      organizationId: tenant.organizationId,
      ...(filters?.deviceType ? { deviceType: filters.deviceType } : {}),
      ...(filters?.status ? { status: filters.status } : {}),
      ...(filters?.locationId ? { locationId: filters.locationId } : {}),
      ...(canManageAll
        ? filters?.userId
          ? { userId: filters.userId }
          : {}
        : { userId: tenant.userId }),
    };

    const items = await this.prismaService.scoped.registeredDevice.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true } },
        location: { select: { id: true, code: true, name: true, type: true } },
        oauthClient: { select: { id: true, clientId: true, name: true, appCategory: true } },
      },
      orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
    });

    return { items };
  }

  async updateDevice(
    tenant: AuthenticatedOrganization,
    deviceId: string,
    input: {
      name?: string;
      status?: "ACTIVE" | "SUSPENDED";
      trusted?: boolean;
      locationId?: string | null;
      ipAllowlist?: string[];
    },
  ) {
    const existing = await this.prismaService.scoped.registeredDevice.findUnique({
      where: { id: deviceId },
    });
    if (!existing || existing.organizationId !== tenant.organizationId) {
      throw new NotFoundException("Registered device not found.");
    }
    if (existing.status === "REVOKED") {
      throw new BadRequestException("Revoked devices cannot be reactivated; re-enroll the device.");
    }

    const updated = await this.prismaService.scoped.registeredDevice.update({
      where: { id: existing.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.trusted !== undefined ? { trusted: input.trusted } : {}),
        ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
        ...(input.ipAllowlist !== undefined ? { ipAllowlist: input.ipAllowlist } : {}),
      },
    });

    if (input.status === "SUSPENDED") {
      try {
        await this.redisService.setJson(`device:status:${existing.id}`, "SUSPENDED", 300);
      } catch {
        // non-fatal
      }
    } else if (input.status === "ACTIVE") {
      try {
        await this.redisService.del(`device:status:${existing.id}`);
      } catch {
        // non-fatal
      }
    }

    await this.recordAudit({
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
      action: "device.updated",
      resourceType: "RegisteredDevice",
      resourceId: existing.id,
      metadata: { status: updated.status, trusted: updated.trusted, name: updated.name },
    });

    return updated;
  }

  async revokeDevice(
    tenant: AuthenticatedOrganization,
    deviceId: string,
    reason?: string,
  ) {
    const existing = await this.prismaService.scoped.registeredDevice.findUnique({
      where: { id: deviceId },
    });
    if (!existing || existing.organizationId !== tenant.organizationId) {
      throw new NotFoundException("Registered device not found.");
    }

    const roles = parseRoleNames(tenant.role);
    const canManageAll =
      roles.includes("owner") || roles.includes("admin") || roles.includes("manager");
    if (!canManageAll && existing.userId !== tenant.userId) {
      throw new ForbiddenException("You can only revoke your own registered devices.");
    }

    const now = new Date();
    const updated = await this.prismaService.scoped.registeredDevice.update({
      where: { id: existing.id },
      data: {
        status: "REVOKED",
        trusted: false,
        revokedAt: now,
        revokedByUserId: tenant.userId,
        revokeReason: reason ?? "Revoked by administrator",
      },
    });

    await this.prismaService.raw.oAuthRefreshToken.updateMany({
      where: {
        organizationId: tenant.organizationId,
        registeredDeviceId: existing.id,
        revokedAt: null,
      },
      data: {
        revokedAt: now,
        revocationReason: "device_revoked",
      },
    });

    try {
      await this.redisService.setJson(`device:status:${existing.id}`, "REVOKED", 86400);
    } catch {
      // non-fatal
    }

    await this.recordAudit({
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
      action: "device.revoked",
      resourceType: "RegisteredDevice",
      resourceId: existing.id,
      metadata: {
        deviceType: existing.deviceType,
        deviceIdentifier: existing.deviceIdentifier,
        reason: updated.revokeReason,
      },
    });

    return { id: updated.id, status: updated.status, revokedAt: now };
  }
}

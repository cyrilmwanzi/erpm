import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { OAuthClientsService } from "./oauth-clients.service.js";
import { ORGANIZATION_ROLE_NAMES } from "./permissions.js";

const clientTypeEnum = z.enum([
  "PUBLIC_PKCE",
  "CONFIDENTIAL",
  "M2M_SERVICE",
  "DEVICE_TERMINAL",
]);
const appCategoryEnum = z.enum([
  "ANDROID_MOBILE",
  "POS_TERMINAL",
  "PRODUCTION_SYSTEM",
  "ERP_INTEGRATION",
  "WEB_APP",
  "OTHER",
]);
const authMethodEnum = z.enum([
  "none",
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
]);
const grantTypeEnum = z.enum([
  "authorization_code",
  "client_credentials",
  "refresh_token",
  "urn:ietf:params:oauth:grant-type:device_code",
]);

const createOAuthClientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  clientType: clientTypeEnum,
  appCategory: appCategoryEnum.default("OTHER"),
  authMethods: z.array(authMethodEnum).min(1).max(4).optional(),
  allowedGrantTypes: z.array(grantTypeEnum).min(1).max(4).optional(),
  redirectUris: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  allowedScopes: z.array(z.string().trim().min(1)).min(1).max(120),
  serviceRole: z.enum(ORGANIZATION_ROLE_NAMES).optional(),
  locationId: z.string().trim().min(1).optional(),
  ipAllowlist: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  jwksUri: z.string().url().optional(),
  isFirstParty: z.boolean().optional(),
  requireConsent: z.boolean().optional(),
  accessTokenTtlSeconds: z.number().int().min(60).max(86400).optional(),
  refreshTokenTtlSeconds: z.number().int().min(300).max(31536000).optional(),
});

const updateOAuthClientSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED"]).optional(),
  authMethods: z.array(authMethodEnum).min(1).max(4).optional(),
  allowedGrantTypes: z.array(grantTypeEnum).min(1).max(4).optional(),
  redirectUris: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  allowedScopes: z.array(z.string().trim().min(1)).min(1).max(120).optional(),
  serviceRole: z.enum(ORGANIZATION_ROLE_NAMES).optional(),
  locationId: z.string().trim().min(1).nullable().optional(),
  ipAllowlist: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  jwksUri: z.string().url().nullable().optional(),
  isFirstParty: z.boolean().optional(),
  requireConsent: z.boolean().optional(),
  accessTokenTtlSeconds: z.number().int().min(60).max(86400).optional(),
  refreshTokenTtlSeconds: z.number().int().min(300).max(31536000).optional(),
});

const addPublicKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  kid: z.string().trim().min(1).max(80).optional(),
  algorithm: z.enum(["RS256", "ES256", "EDDSA"]).default("ES256"),
  publicKeyPem: z.string().trim().min(20).optional(),
  publicJwk: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().datetime().optional(),
});

const listClientsQuerySchema = z.object({
  appCategory: appCategoryEnum.optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED"]).optional(),
});

const listDevicesQuerySchema = z.object({
  deviceType: z
    .enum(["ANDROID", "POS_TERMINAL", "PRODUCTION_KIOSK", "SCANNER", "SYSTEM_AGENT"])
    .optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED"]).optional(),
  locationId: z.string().trim().min(1).optional(),
  userId: z.string().trim().min(1).optional(),
});

const updateDeviceSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  trusted: z.boolean().optional(),
  locationId: z.string().trim().min(1).nullable().optional(),
  ipAllowlist: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
});

const revokeDeviceSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

@Controller("api/v1/auth")
@RequireActiveOrganization()
export class OAuthClientsController {
  constructor(
    @Inject(OAuthClientsService)
    private readonly oauthClientsService: OAuthClientsService,
  ) {}

  @Post("oauth-clients")
  @RequiredOrgPermissions({ oauthClient: ["create"] })
  async createClient(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
  ) {
    const parsed = createOAuthClientSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid OAuth2 client payload.",
        issues: parsed.error.issues,
      });
    }
    return this.oauthClientsService.createClient(tenant, parsed.data);
  }

  @Get("oauth-clients")
  @RequiredOrgPermissions({ oauthClient: ["read"] })
  async listClients(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listClientsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid OAuth2 client query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.oauthClientsService.listClients(tenant, parsed.data);
  }

  @Get("oauth-clients/:idOrClientId")
  @RequiredOrgPermissions({ oauthClient: ["read"] })
  async getClient(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("idOrClientId") idOrClientId: string,
  ) {
    return this.oauthClientsService.findClientForTenant(tenant, idOrClientId);
  }

  @Patch("oauth-clients/:idOrClientId")
  @RequiredOrgPermissions({ oauthClient: ["update"] })
  async updateClient(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("idOrClientId") idOrClientId: string,
    @Body() body: unknown,
  ) {
    const parsed = updateOAuthClientSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid OAuth2 client update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.oauthClientsService.updateClient(tenant, idOrClientId, parsed.data);
  }

  @Post("oauth-clients/:idOrClientId/rotate-secret")
  @RequiredOrgPermissions({ oauthClient: ["update"] })
  async rotateSecret(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("idOrClientId") idOrClientId: string,
  ) {
    return this.oauthClientsService.rotateClientSecret(tenant, idOrClientId);
  }

  @Post("oauth-clients/:idOrClientId/keys")
  @RequiredOrgPermissions({ oauthClient: ["manageKeys"] })
  async addPublicKey(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("idOrClientId") idOrClientId: string,
    @Body() body: unknown,
  ) {
    const parsed = addPublicKeySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid OAuth2 client public key payload.",
        issues: parsed.error.issues,
      });
    }
    return this.oauthClientsService.addClientPublicKey(
      tenant,
      idOrClientId,
      parsed.data,
    );
  }

  @Get("oauth-clients/:idOrClientId/keys")
  @RequiredOrgPermissions({ oauthClient: ["read"] })
  async listPublicKeys(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("idOrClientId") idOrClientId: string,
  ) {
    return this.oauthClientsService.listClientPublicKeys(tenant, idOrClientId);
  }

  @Delete("oauth-clients/:idOrClientId/keys/:keyId")
  @RequiredOrgPermissions({ oauthClient: ["manageKeys"] })
  async revokePublicKey(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("idOrClientId") idOrClientId: string,
    @Param("keyId") keyId: string,
  ) {
    return this.oauthClientsService.revokeClientPublicKey(
      tenant,
      idOrClientId,
      keyId,
    );
  }

  @Get("devices")
  @RequiredOrgPermissions({ device: ["read"] })
  async listDevices(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listDevicesQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid registered devices query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.oauthClientsService.listDevices(tenant, parsed.data);
  }

  @Patch("devices/:deviceId")
  @RequiredOrgPermissions({ device: ["update"] })
  async updateDevice(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("deviceId") deviceId: string,
    @Body() body: unknown,
  ) {
    const parsed = updateDeviceSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid device update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.oauthClientsService.updateDevice(tenant, deviceId, parsed.data);
  }

  @Post("devices/:deviceId/revoke")
  @RequiredOrgPermissions({ device: ["revoke"] })
  async revokeDevicePost(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("deviceId") deviceId: string,
    @Body() body: unknown,
  ) {
    const parsed = revokeDeviceSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid device revocation payload.",
        issues: parsed.error.issues,
      });
    }
    return this.oauthClientsService.revokeDevice(
      tenant,
      deviceId,
      parsed.data.reason,
    );
  }

  @Delete("devices/:deviceId")
  @RequiredOrgPermissions({ device: ["revoke"] })
  async revokeDeviceDelete(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("deviceId") deviceId: string,
  ) {
    return this.oauthClientsService.revokeDevice(tenant, deviceId);
  }
}

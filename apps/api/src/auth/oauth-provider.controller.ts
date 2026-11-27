import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { OAuthProviderService } from "./oauth-provider.service.js";

const authorizeSchema = z.object({
  clientId: z.string().trim().min(1).optional(),
  client_id: z.string().trim().min(1).optional(),
  redirectUri: z.string().trim().min(1).optional(),
  redirect_uri: z.string().trim().min(1).optional(),
  scope: z.string().trim().optional(),
  state: z.string().trim().max(500).optional(),
  codeChallenge: z.string().trim().min(43).max(128).optional(),
  code_challenge: z.string().trim().min(43).max(128).optional(),
  codeChallengeMethod: z.enum(["S256"]).optional(),
  code_challenge_method: z.enum(["S256"]).optional(),
  nonce: z.string().trim().max(200).optional(),
  deviceIdentifier: z.string().trim().max(160).optional(),
  deviceName: z.string().trim().max(120).optional(),
  deviceOsVersion: z.string().trim().max(64).optional(),
  deviceAppVersion: z.string().trim().max(64).optional(),
  responseMode: z.enum(["json", "redirect"]).optional(),
});

const verifyDeviceCodeSchema = z.object({
  userCode: z.string().trim().min(4).max(32).optional(),
  user_code: z.string().trim().min(4).max(32).optional(),
  decision: z.enum(["APPROVE", "DENY"]).default("APPROVE"),
  locationId: z.string().trim().min(1).optional(),
  deviceName: z.string().trim().min(1).max(120).optional(),
});

@Controller()
export class OAuthProviderController {
  constructor(
    @Inject(OAuthProviderService)
    private readonly oauthProviderService: OAuthProviderService,
  ) {}

  @Get(".well-known/openid-configuration")
  @AllowAnonymous()
  getOpenIdConfig() {
    return this.oauthProviderService.getOpenIdConfiguration();
  }

  @Get(".well-known/oauth-authorization-server")
  @AllowAnonymous()
  getOAuthServerMetadata() {
    return this.oauthProviderService.getOpenIdConfiguration();
  }

  @Get(".well-known/jwks.json")
  @AllowAnonymous()
  async getJwks() {
    return this.oauthProviderService.getJwks();
  }

  @Get("api/v1/oauth/authorize")
  @RequireActiveOrganization()
  async authorizeGet(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.handleAuthorize(tenant, query, reply);
  }

  @Post("api/v1/oauth/authorize")
  @RequireActiveOrganization()
  async authorizePost(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.handleAuthorize(tenant, body, reply);
  }

  private async handleAuthorize(
    tenant: AuthenticatedOrganization,
    rawInput: unknown,
    reply: FastifyReply,
  ) {
    const parsed = authorizeSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid OAuth2 authorization request.",
        issues: parsed.error.issues,
      });
    }

    const d = parsed.data;
    const clientId = d.clientId ?? d.client_id;
    const redirectUri = d.redirectUri ?? d.redirect_uri;
    const codeChallenge = d.codeChallenge ?? d.code_challenge;
    const codeChallengeMethod = d.codeChallengeMethod ?? d.code_challenge_method ?? "S256";

    if (!clientId || !redirectUri || !codeChallenge) {
      throw new BadRequestException(
        "client_id, redirect_uri, and S256 code_challenge are required.",
      );
    }

    const result = await this.oauthProviderService.authorizePkce(tenant, {
      clientId,
      redirectUri,
      scope: d.scope,
      state: d.state,
      codeChallenge,
      codeChallengeMethod,
      nonce: d.nonce,
      deviceIdentifier: d.deviceIdentifier,
      deviceName: d.deviceName,
      deviceOsVersion: d.deviceOsVersion,
      deviceAppVersion: d.deviceAppVersion,
    });

    if (d.responseMode === "redirect") {
      reply.redirect(result.redirectTo, 302);
      return;
    }

    return result;
  }

  @Post("api/v1/oauth/device/code")
  @AllowAnonymous()
  @HttpCode(200)
  async requestDeviceCode(
    @Body() body: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ) {
    return this.oauthProviderService.requestDeviceCode(
      body ?? {},
      req.headers.authorization,
      req.ip,
    );
  }

  @Post("api/v1/oauth/device/verify")
  @RequireActiveOrganization()
  @RequiredOrgPermissions({ device: ["approve"] })
  async verifyDeviceCode(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
  ) {
    const parsed = verifyDeviceCodeSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid device verification payload.",
        issues: parsed.error.issues,
      });
    }
    const userCode = parsed.data.userCode ?? parsed.data.user_code;
    if (!userCode) {
      throw new BadRequestException("userCode (or user_code) is required.");
    }
    return this.oauthProviderService.verifyDeviceCode(tenant, {
      userCode,
      decision: parsed.data.decision,
      locationId: parsed.data.locationId,
      deviceName: parsed.data.deviceName,
    });
  }

  @Post("api/v1/oauth/token")
  @AllowAnonymous()
  @HttpCode(200)
  async exchangeToken(
    @Body() body: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ) {
    return this.oauthProviderService.exchangeToken(
      body ?? {},
      req.headers.authorization,
      req.ip,
    );
  }

  @Post("api/v1/oauth/introspect")
  @AllowAnonymous()
  @HttpCode(200)
  async introspectToken(
    @Body() body: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ) {
    return this.oauthProviderService.introspectToken(
      body ?? {},
      req.headers.authorization,
      req.ip,
    );
  }

  @Post("api/v1/oauth/revoke")
  @AllowAnonymous()
  @HttpCode(200)
  async revokeToken(
    @Body() body: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ) {
    return this.oauthProviderService.revokeToken(
      body ?? {},
      req.headers.authorization,
      req.ip,
    );
  }
}

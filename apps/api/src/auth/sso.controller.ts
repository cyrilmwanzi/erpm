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
  Req,
  Res,
} from "@nestjs/common";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getEnv } from "../config/env.js";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { ORGANIZATION_ROLE_NAMES } from "./permissions.js";
import { SsoService } from "./sso.service.js";

const createSsoSchema = z.object({
  providerKey: z.string().trim().min(2).max(60),
  providerType: z.enum(["GOOGLE", "MICROSOFT_ENTRA", "OKTA", "OIDC"]),
  displayName: z.string().trim().min(1).max(120),
  issuerUrl: z.string().url().optional(),
  authorizationEndpoint: z.string().url().optional(),
  tokenEndpoint: z.string().url().optional(),
  userinfoEndpoint: z.string().url().optional(),
  jwksUri: z.string().url().optional(),
  clientId: z.string().trim().min(1).max(300),
  clientSecret: z.string().trim().min(1).max(500).optional(),
  scopes: z.array(z.string().trim().min(1)).max(20).optional(),
  allowedDomains: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  autoProvisionRole: z.enum(ORGANIZATION_ROLE_NAMES).optional(),
  enforceSsoOnly: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const updateSsoSchema = createSsoSchema.omit({ providerKey: true, providerType: true }).partial();

const ssoUrlQuerySchema = z.object({
  organizationId: z.string().trim().min(1).optional(),
  orgSlug: z.string().trim().min(1).optional(),
  mode: z.enum(["popup", "redirect", "android_pkce"]).optional(),
  redirectAfter: z.string().trim().max(500).optional(),
  androidClientId: z.string().trim().min(1).optional(),
  androidRedirectUri: z.string().trim().min(1).optional(),
  androidCodeChallenge: z.string().trim().min(43).max(128).optional(),
  androidState: z.string().trim().max(500).optional(),
  androidScope: z.string().trim().max(500).optional(),
  androidDeviceIdentifier: z.string().trim().max(160).optional(),
  androidDeviceName: z.string().trim().max(120).optional(),
});

const ssoCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  format: z.enum(["html", "json"]).optional(),
});

@Controller("api/v1/auth/sso")
export class SsoController {
  constructor(@Inject(SsoService) private readonly ssoService: SsoService) {}

  @Get("providers")
  @AllowAnonymous()
  async listPublicProviders(
    @Query("orgSlug") orgSlug?: string,
    @Query("emailDomain") emailDomain?: string,
  ) {
    return this.ssoService.listPublicProviders({ orgSlug, emailDomain });
  }

  @Get("url/:providerKey")
  @AllowAnonymous()
  async getAuthorizationUrl(
    @Param("providerKey") providerKey: string,
    @Query() query: unknown,
  ) {
    const parsed = ssoUrlQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid SSO authorization URL parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.ssoService.buildAuthorizationUrl({
      providerKey,
      ...parsed.data,
    });
  }

  @Get("callback/:providerKey")
  @AllowAnonymous()
  async handleCallback(
    @Param("providerKey") providerKey: string,
    @Query() query: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.handleSsoCallback(providerKey, query, req, reply);
  }

  private async handleSsoCallback(
    providerKey: string,
    rawQuery: unknown,
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    const parsed = ssoCallbackQuerySchema.safeParse(rawQuery ?? {});
    if (!parsed.success) {
      throw new BadRequestException("Invalid SSO callback parameters.");
    }

    const result = await this.ssoService.handleCallback({
      providerKey,
      code: parsed.data.code,
      state: parsed.data.state,
      error: parsed.data.error,
      errorDescription: parsed.data.error_description,
      clientIp: req.ip,
      userAgent: req.headers["user-agent"],
    });

    if (
      result.mode === "android_pkce" &&
      "redirectUrl" in result &&
      typeof result.redirectUrl === "string"
    ) {
      if (parsed.data.format === "json") {
        return result;
      }
      reply.redirect(result.redirectUrl, 302);
      return;
    }

    const env = getEnv();
    const isHttps = env.APP_URL.startsWith("https://");
    const sessionToken =
      "sessionToken" in result && typeof result.sessionToken === "string"
        ? result.sessionToken
        : "";
    if (sessionToken) {
      const cookieParts = [
        `scace.session_token=${encodeURIComponent(sessionToken)}`,
        "Path=/",
        "HttpOnly",
        `Max-Age=${60 * 60 * 24 * 7}`,
        isHttps ? "SameSite=None; Secure; Partitioned" : "SameSite=Lax",
      ];
      reply.header("Set-Cookie", cookieParts.join("; "));
    }

    if (parsed.data.format === "json") {
      return result;
    }

    const safeJsonForScript = (val: unknown) =>
      JSON.stringify(val)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026");

    const rawRedirect = result.redirectAfter || "/";
    const safeRedirect =
      rawRedirect.startsWith("/") && !rawRedirect.startsWith("//")
        ? rawRedirect
        : rawRedirect.startsWith(env.APP_URL)
          ? rawRedirect
          : "/";

    const payloadJson = safeJsonForScript({
      type: "OAUTH_AUTH_SUCCESS",
      user: result.user,
      organizationId: result.organizationId,
    });

    reply.header("Content-Type", "text/html; charset=utf-8");
    return `<!doctype html>
<html>
  <head><title>Authentication Complete</title></head>
  <body>
    <p>Authentication successful. This window should close automatically.</p>
    <script>
      (function () {
        var payload = ${payloadJson};
        if (window.opener) {
          window.opener.postMessage(payload, "*");
          window.close();
        } else {
          window.location.href = ${safeJsonForScript(safeRedirect)};
        }
      })();
    </script>
  </body>
</html>`;
  }

  @Get("config")
  @RequireActiveOrganization()
  @RequiredOrgPermissions({ ssoConfig: ["read"] })
  async listOrganizationConfig(
    @CurrentOrganization() org: AuthenticatedOrganization,
  ) {
    return this.ssoService.listOrganizationProviders(org);
  }

  @Post("config")
  @RequireActiveOrganization()
  @RequiredOrgPermissions({ ssoConfig: ["configure"] })
  async createOrganizationConfig(
    @CurrentOrganization() org: AuthenticatedOrganization,
    @Body() body: unknown,
  ) {
    const parsed = createSsoSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid SSO provider configuration payload.",
        issues: parsed.error.issues,
      });
    }
    return this.ssoService.createOrganizationProvider(org, parsed.data);
  }

  @Patch("config/:idOrKey")
  @RequireActiveOrganization()
  @RequiredOrgPermissions({ ssoConfig: ["configure"] })
  async updateOrganizationConfig(
    @CurrentOrganization() org: AuthenticatedOrganization,
    @Param("idOrKey") idOrKey: string,
    @Body() body: unknown,
  ) {
    const parsed = updateSsoSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid SSO provider update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.ssoService.updateOrganizationProvider(org, idOrKey, parsed.data);
  }

  @Delete("config/:idOrKey")
  @RequireActiveOrganization()
  @RequiredOrgPermissions({ ssoConfig: ["configure"] })
  async deleteOrganizationConfig(
    @CurrentOrganization() org: AuthenticatedOrganization,
    @Param("idOrKey") idOrKey: string,
  ) {
    return this.ssoService.deleteOrganizationProvider(org, idOrKey);
  }
}

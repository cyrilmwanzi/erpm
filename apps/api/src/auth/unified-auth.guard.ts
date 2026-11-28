import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import { PrismaService } from "../database/prisma.service.js";
import type { OrganizationScopedRequest } from "../organizations/organization.decorators.js";
import { auth } from "./auth.config.js";
import { OAuthProviderService } from "./oauth-provider.service.js";
import { PatService } from "./pat.service.js";

export type AuthMethodType =
  | "COOKIE_SESSION"
  | "BEARER_SESSION"
  | "PAT"
  | "OAUTH2_ACCESS_TOKEN";

function extractBearerOrApiKey(req: FastifyRequest): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token.length > 0) {
      return token;
    }
  }
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim().length > 0) {
    return apiKeyHeader.trim();
  }
  return null;
}

function extractRequestedOrganizationId(req: FastifyRequest): string | null {
  const raw = req.headers["x-organization-id"];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0]?.trim();
    return first && first.length > 0 ? first : null;
  }
  return null;
}

function buildBearerOnlyHeaders(req: FastifyRequest): Headers {
  const headers = fromNodeHeaders(req.headers);
  headers.delete("cookie");
  return headers;
}

@Injectable()
export class UnifiedAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PatService) private readonly patService: PatService,
    @Inject(OAuthProviderService)
    private readonly oauthProviderService: OAuthProviderService,
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OrganizationScopedRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>("PUBLIC", [
      context.getHandler(),
      context.getClass(),
    ]);
    const isOptional = this.reflector.getAllAndOverride<boolean>("OPTIONAL", [
      context.getHandler(),
      context.getClass(),
    ]);

    const bearer = extractBearerOrApiKey(request);
    const requestedOrgId = extractRequestedOrganizationId(request);

    if (bearer) {
      if (bearer.startsWith("scace_pat_")) {
        const pat = await this.patService.verifyToken(bearer, request.ip);
        if (pat) {
          if (requestedOrgId && requestedOrgId !== pat.organizationId) {
            throw new ForbiddenException(
              "Personal Access Token is not authorized for the requested organization.",
            );
          }
          request.session = {
            user: {
              id: pat.userId,
              email: pat.userEmail,
              name: pat.userName,
              emailVerified: true,
            },
            session: {
              id: `pat:${pat.patId}`,
              activeOrganizationId: pat.organizationId,
            },
          };
          request.authContext = {
            authMethod: "PAT",
            organizationId: pat.organizationId,
            grantedScopes: pat.scopes,
            patId: pat.patId,
            isServicePrincipal: false,
          };
          (request as unknown as { user?: unknown }).user = request.session.user;
          return true;
        }
        if (!isPublic && !isOptional) {
          throw new UnauthorizedException("Invalid, expired, or revoked Personal Access Token.");
        }
        return true;
      }

      if (bearer.split(".").length === 3) {
        const oauthToken = await this.oauthProviderService.verifyAccessToken(
          bearer,
          request.ip,
        );
        if (oauthToken) {
          if (requestedOrgId && requestedOrgId !== oauthToken.organizationId) {
            throw new ForbiddenException(
              "OAuth2 access token is not authorized for the requested organization.",
            );
          }
          const isServicePrincipal = oauthToken.principalType !== "USER";
          request.session = {
            user: {
              id: oauthToken.userId,
              email: oauthToken.userEmail ?? `${oauthToken.clientId}@service.scace.local`,
              name: oauthToken.userName ?? `Service (${oauthToken.clientId})`,
              emailVerified: true,
            },
            session: {
              id: `oauth:${oauthToken.jti || oauthToken.oauthClientId}`,
              activeOrganizationId: oauthToken.organizationId,
            },
          };
          request.authContext = {
            authMethod: "OAUTH2_ACCESS_TOKEN",
            organizationId: oauthToken.organizationId,
            grantedScopes: oauthToken.scopes,
            oauthClientId: oauthToken.oauthClientId,
            clientId: oauthToken.clientId,
            deviceId: oauthToken.deviceId,
            principalType: oauthToken.principalType,
            serviceRole: oauthToken.serviceRole,
            isServicePrincipal,
          };
          (request as unknown as { user?: unknown }).user = request.session.user;
          return true;
        }
        if (!isPublic && !isOptional) {
          throw new UnauthorizedException("Invalid, expired, or revoked OAuth2 access token.");
        }
        return true;
      }

      // Explicit Bearer/API-key token that is neither a PAT nor a 3-part JWT:
      // validate as Better Auth bearer session or SSO DB session WITHOUT falling back to cookies.
      let bearerSession = await auth.api.getSession({
        headers: buildBearerOnlyHeaders(request),
      });

      if (!bearerSession) {
        const dbSession = await this.prismaService.raw.session.findUnique({
          where: { token: bearer },
          include: { user: true },
        });
        if (dbSession && dbSession.expiresAt.getTime() > Date.now()) {
          bearerSession = {
            user: dbSession.user,
            session: dbSession,
          } as unknown as typeof bearerSession;
        }
      }

      if (bearerSession?.user?.id) {
        const sessionOrgId =
          (bearerSession.session as { activeOrganizationId?: string | null })
            ?.activeOrganizationId ?? null;
        request.session = bearerSession as OrganizationScopedRequest["session"];
        request.authContext = {
          authMethod: "BEARER_SESSION",
          organizationId: requestedOrgId ?? sessionOrgId,
          isServicePrincipal: false,
        };
        (request as unknown as { user?: unknown }).user = bearerSession.user;
        return true;
      }

      if (!isPublic && !isOptional) {
        throw new UnauthorizedException("Invalid or expired bearer token.");
      }
      return true;
    }

    // Cookie-based Better Auth session when no explicit Bearer/API-Key header was provided
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });

    if (session?.user?.id) {
      const sessionOrgId =
        (session.session as { activeOrganizationId?: string | null })
          ?.activeOrganizationId ?? null;
      request.session = session as OrganizationScopedRequest["session"];
      request.authContext = {
        authMethod: "COOKIE_SESSION",
        organizationId: requestedOrgId ?? sessionOrgId,
        isServicePrincipal: false,
      };
      (request as unknown as { user?: unknown }).user = session.user;
      return true;
    }

    if (isPublic || isOptional) {
      return true;
    }

    throw new UnauthorizedException("Authentication required.");
  }
}

export function assertHumanUserSession(request: OrganizationScopedRequest): void {
  if (request.authContext?.isServicePrincipal) {
    throw new ForbiddenException("This endpoint requires a human user identity.");
  }
}

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

    if (bearer) {
      if (bearer.startsWith("scace_pat_")) {
        const pat = await this.patService.verifyToken(bearer, request.ip);
        if (pat) {
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
      }
    }

    // Try Better Auth session (cookies or Better Auth bearer session token)
    let session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });

    // Also support direct DB session tokens issued by SSO popup callbacks when passed as Bearer
    if (!session && bearer && !bearer.startsWith("scace_pat_")) {
      const dbSession = await this.prismaService.raw.session.findUnique({
        where: { token: bearer },
        include: { user: true },
      });
      if (dbSession && dbSession.expiresAt.getTime() > Date.now()) {
        session = {
          user: dbSession.user,
          session: dbSession,
        } as unknown as typeof session;
      }
    }

    if (session?.user?.id) {
      request.session = session as OrganizationScopedRequest["session"];
      request.authContext = {
        authMethod: bearer ? "BEARER_SESSION" : "COOKIE_SESSION",
        organizationId:
          (session.session as { activeOrganizationId?: string | null })
            ?.activeOrganizationId ?? null,
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

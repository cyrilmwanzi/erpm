import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply } from "fastify";
import {
  hasOrganizationPermission,
  type OrgPermissionRequirement,
} from "../auth/permissions.js";
import { BillingEnforcementService } from "../billing/billing-enforcement.service.js";
import { PrismaService } from "../database/prisma.service.js";
import { RedisService } from "../redis/redis.service.js";
import {
  BILLING_FEATURE_KEY,
  BILLING_LOCK_EXEMPT_KEY,
  ORG_PERMISSIONS_KEY,
  ORG_ROLES_KEY,
  type AuthenticatedOrganization,
  type OrganizationScopedRequest,
} from "./organization.decorators.js";

interface CachedMembership {
  memberId: string;
  role: string;
}

@Injectable()
export class OrganizationGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redisService: RedisService,
    @Optional()
    @Inject(BillingEnforcementService)
    private readonly billingEnforcement?: BillingEnforcementService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<OrganizationScopedRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const userSession = request.session;
    const authContext = request.authContext;

    if (!userSession?.user?.id) {
      throw new UnauthorizedException("Authentication required.");
    }

    if (
      !authContext?.isServicePrincipal &&
      userSession.user.emailVerified === false
    ) {
      throw new ForbiddenException(
        "Email verification is required before accessing organization resources.",
      );
    }

    const organizationId =
      authContext?.organizationId ?? userSession.session?.activeOrganizationId;
    if (!organizationId) {
      throw new ForbiddenException(
        "No active organization selected. Call /api/auth/organization/set-active before accessing organization resources.",
      );
    }

    const userId = userSession.user.id;
    let membership: CachedMembership | null = null;

    if (authContext?.isServicePrincipal) {
      membership = {
        memberId: `service:${authContext.oauthClientId ?? authContext.clientId ?? "client"}`,
        role: authContext.serviceRole ?? "member",
      };
    } else {
      const cacheKey = `membership:${organizationId}:${userId}`;
      try {
        membership = await this.redisService.getJson<CachedMembership>(cacheKey);
      } catch {
        membership = null;
      }

      if (!membership) {
        const dbMember = await this.prismaService.raw.member.findUnique({
          where: {
            organizationId_userId: {
              organizationId,
              userId,
            },
          },
          select: {
            id: true,
            role: true,
          },
        });

        if (!dbMember) {
          throw new ForbiddenException(
            "You are not a member of the active organization.",
          );
        }

        membership = {
          memberId: dbMember.id,
          role: dbMember.role,
        };

        try {
          await this.redisService.setJson(cacheKey, membership, 60);
        } catch {
          // Non-fatal if Redis cache write is temporarily unavailable
        }
      }
    }

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ORG_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredRoles && requiredRoles.length > 0) {
      const userRoles = membership.role
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
      const hasRole = requiredRoles.some((role) => userRoles.includes(role));
      if (!hasRole) {
        throw new ForbiddenException(
          `Insufficient organization permissions. Required role: ${requiredRoles.join(" or ")}.`,
        );
      }
    }

    const requiredPermissions =
      this.reflector.getAllAndOverride<OrgPermissionRequirement>(
        ORG_PERMISSIONS_KEY,
        [context.getHandler(), context.getClass()],
      );

    if (
      requiredPermissions &&
      !hasOrganizationPermission(
        membership.role,
        requiredPermissions,
        authContext?.grantedScopes,
      )
    ) {
      throw new ForbiddenException(
        "Insufficient organization permissions or token scope for the requested action.",
      );
    }

    if (this.billingEnforcement) {
      const entitlement =
        await this.billingEnforcement.evaluateOrganizationEntitlement(
          organizationId,
        );
      request.billing = {
        status: entitlement.status,
        planCode: entitlement.planCode,
        planId: entitlement.planId,
        isLockedOut: entitlement.isLockedOut,
        inGracePeriod: entitlement.inGracePeriod,
        isExempt: entitlement.isExempt,
        trialEndsAt: entitlement.trialEndsAt,
        gracePeriodEndsAt: entitlement.gracePeriodEndsAt,
        currentPeriodEnd: entitlement.currentPeriodEnd,
        features: entitlement.features,
      };

      if (typeof reply?.header === "function") {
        reply.header("X-Scace-Billing-Status", entitlement.status);
        reply.header("X-Scace-Plan-Code", entitlement.planCode);
        if (entitlement.inGracePeriod && entitlement.gracePeriodEndsAt) {
          reply.header("X-Scace-Grace-Ends-At", entitlement.gracePeriodEndsAt);
        }
      }

      const isBillingLockExempt =
        this.reflector.getAllAndOverride<boolean>(BILLING_LOCK_EXEMPT_KEY, [
          context.getHandler(),
          context.getClass(),
        ]) ?? false;

      if (!isBillingLockExempt) {
        this.billingEnforcement.assertNotLocked(entitlement);

        const requiredFeature = this.reflector.getAllAndOverride<string>(
          BILLING_FEATURE_KEY,
          [context.getHandler(), context.getClass()],
        );
        if (requiredFeature) {
          this.billingEnforcement.assertFeatureEnabled(
            entitlement,
            requiredFeature,
          );
        }
      }
    }

    const organization: AuthenticatedOrganization = {
      organizationId,
      memberId: membership.memberId,
      role: membership.role,
      userId,
      authMethod: authContext?.authMethod ?? "COOKIE_SESSION",
      grantedScopes: authContext?.grantedScopes,
      patId: authContext?.patId,
      oauthClientId: authContext?.oauthClientId,
      clientId: authContext?.clientId,
      deviceId: authContext?.deviceId,
      isServicePrincipal: authContext?.isServicePrincipal ?? false,
    };
    request.organization = organization;

    return true;
  }
}

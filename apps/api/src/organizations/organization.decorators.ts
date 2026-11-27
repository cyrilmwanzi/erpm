import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { OrgPermissionRequirement } from "../auth/permissions.js";
import { OrganizationGuard } from "./organization.guard.js";
import { OrganizationInterceptor } from "./organization.interceptor.js";

export const ORG_ROLES_KEY = "scace:org_roles";
export const ORG_PERMISSIONS_KEY = "scace:org_permissions";
export const BILLING_LOCK_EXEMPT_KEY = "scace:billing_lock_exempt";
export const BILLING_FEATURE_KEY = "scace:billing_feature";

export interface AuthContextMetadata {
  authMethod: "COOKIE_SESSION" | "BEARER_SESSION" | "PAT" | "OAUTH2_ACCESS_TOKEN";
  organizationId: string | null;
  grantedScopes?: string[];
  patId?: string;
  oauthClientId?: string;
  clientId?: string;
  deviceId?: string | null;
  principalType?: "USER" | "SERVICE_PRINCIPAL" | "DEVICE_TERMINAL";
  serviceRole?: string;
  isServicePrincipal?: boolean;
}

export interface AuthenticatedOrganization {
  organizationId: string;
  memberId: string;
  role: string;
  userId: string;
  authMethod?: AuthContextMetadata["authMethod"];
  grantedScopes?: string[];
  patId?: string;
  oauthClientId?: string;
  clientId?: string;
  deviceId?: string | null;
  isServicePrincipal?: boolean;
}

export type OrganizationScopedRequest = FastifyRequest & {
  session?: {
    user: {
      id: string;
      email: string;
      name: string;
      emailVerified?: boolean;
    };
    session: { id: string; activeOrganizationId?: string | null };
  };
  authContext?: AuthContextMetadata;
  organization?: AuthenticatedOrganization;
  billing?: {
    status: string;
    planCode: string;
    planId: string;
    isLockedOut: boolean;
    inGracePeriod: boolean;
    isExempt: boolean;
    trialEndsAt: string | null;
    gracePeriodEndsAt: string | null;
    currentPeriodEnd: string | null;
    features: Record<string, boolean>;
  };
};

export const RequiredOrgRoles = (...roles: string[]) =>
  SetMetadata(ORG_ROLES_KEY, roles);

export const RequiredOrgPermissions = (
  permissions: OrgPermissionRequirement,
) => SetMetadata(ORG_PERMISSIONS_KEY, permissions);

export const AllowWhenBillingLocked = () =>
  SetMetadata(BILLING_LOCK_EXEMPT_KEY, true);

export const RequiredBillingFeature = (feature: string) =>
  SetMetadata(BILLING_FEATURE_KEY, feature);

export const RequireActiveOrganization = () =>
  applyDecorators(
    UseGuards(OrganizationGuard),
    UseInterceptors(OrganizationInterceptor),
  );

export const CurrentOrganization = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedOrganization => {
    const request = ctx.switchToHttp().getRequest<OrganizationScopedRequest>();
    if (!request.organization) {
      throw new Error(
        "CurrentOrganization decorator requires @RequireActiveOrganization() on the route or controller.",
      );
    }
    return request.organization;
  },
);

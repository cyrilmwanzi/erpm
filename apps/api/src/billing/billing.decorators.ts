import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  UseGuards,
} from "@nestjs/common";
import type { PlatformRole } from "@scace/db";
import type { OrganizationScopedRequest } from "../organizations/organization.decorators.js";
import { SystemAdminGuard } from "./system-admin.guard.js";

export interface AuthenticatedSystemAdmin {
  userId: string;
  email: string;
  name: string;
  platformRole: PlatformRole;
}

export type SystemAdminRequest = OrganizationScopedRequest & {
  systemAdmin?: AuthenticatedSystemAdmin;
};

export const RequireSystemAdmin = () =>
  applyDecorators(UseGuards(SystemAdminGuard));

export const CurrentSystemAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedSystemAdmin => {
    const request = ctx.switchToHttp().getRequest<SystemAdminRequest>();
    if (!request.systemAdmin) {
      throw new Error(
        "CurrentSystemAdmin decorator requires @RequireSystemAdmin() on the route or controller.",
      );
    }
    return request.systemAdmin;
  },
);

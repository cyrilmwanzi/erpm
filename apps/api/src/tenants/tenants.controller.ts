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
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { ORGANIZATION_ROLE_NAMES } from "../auth/permissions.js";
import {
  AllowWhenBillingLocked,
  CurrentTenant,
  RequireActiveTenant,
  RequiredOrgPermissions,
  type AuthenticatedTenant,
} from "../tenancy/tenant.decorators.js";
import { TenantsService } from "./tenants.service.js";

const organizationRoleEnum = z.enum(ORGANIZATION_ROLE_NAMES);

const updateTenantSettingsSchema = z.object({
  companyLegalName: z.string().trim().min(1).max(200).nullable().optional(),
  defaultCurrency: z
    .string()
    .trim()
    .length(3)
    .transform((val) => val.toUpperCase())
    .optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  features: z.record(z.string(), z.boolean()).optional(),
});

const updateMemberRoleSchema = z.object({
  role: organizationRoleEnum,
});

const createInvitationSchema = z.object({
  email: z.string().trim().email().max(320),
  role: organizationRoleEnum.default("member"),
  resend: z.boolean().optional(),
});

const listInvitationsQuerySchema = z.object({
  status: z.enum(["pending", "accepted", "rejected", "canceled"]).optional(),
});

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

@Controller("api/v1/tenants")
@RequireActiveTenant()
export class TenantsController {
  constructor(
    @Inject(TenantsService) private readonly tenantsService: TenantsService,
  ) {}

  @Get("current")
  @AllowWhenBillingLocked()
  @RequiredOrgPermissions({ tenantSettings: ["read"] })
  async getCurrentTenant(@CurrentTenant() tenant: AuthenticatedTenant) {
    return this.tenantsService.getCurrentTenantOverview(tenant);
  }

  @Get("permissions")
  @AllowWhenBillingLocked()
  getPermissions(@CurrentTenant() tenant: AuthenticatedTenant) {
    return this.tenantsService.getEffectivePermissions(tenant);
  }

  @Patch("settings")
  @RequiredOrgPermissions({ tenantSettings: ["update"] })
  async updateSettings(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateTenantSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid tenant settings payload.",
        issues: parsed.error.issues,
      });
    }

    return this.tenantsService.updateSettings(tenant, parsed.data, req.ip);
  }

  @Get("members")
  @RequiredOrgPermissions({ ac: ["read"] })
  async listMembers(@CurrentTenant() tenant: AuthenticatedTenant) {
    return this.tenantsService.listMembers(tenant);
  }

  @Patch("members/:memberId/role")
  @RequiredOrgPermissions({ member: ["update"] })
  async updateMemberRole(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("memberId") memberId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateMemberRoleSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid member role payload.",
        issues: parsed.error.issues,
      });
    }

    return this.tenantsService.updateMemberRole(
      tenant,
      memberId,
      parsed.data.role,
      req.headers,
    );
  }

  @Delete("members/:memberId")
  @RequiredOrgPermissions({ member: ["delete"] })
  async removeMember(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("memberId") memberId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantsService.removeMember(tenant, memberId, req.headers);
  }

  @Get("invitations")
  @RequiredOrgPermissions({ invitation: ["create"] })
  async listInvitations(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listInvitationsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid invitation query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.tenantsService.listInvitations(tenant, parsed.data.status);
  }

  @Post("invitations")
  @RequiredOrgPermissions({ invitation: ["create"] })
  async createInvitation(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createInvitationSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid invitation payload.",
        issues: parsed.error.issues,
      });
    }

    return this.tenantsService.createInvitation(tenant, parsed.data, req.headers);
  }

  @Delete("invitations/:invitationId")
  @RequiredOrgPermissions({ invitation: ["cancel"] })
  async cancelInvitation(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("invitationId") invitationId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.tenantsService.cancelInvitation(
      tenant,
      invitationId,
      req.headers,
    );
  }

  @Get("audit-logs")
  @RequiredOrgPermissions({ auditLog: ["read"] })
  async getAuditLogs(@Query() query: unknown) {
    const parsed = auditQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid audit log query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.tenantsService.listAuditLogs(
      parsed.data.limit,
      parsed.data.cursor,
    );
  }
}

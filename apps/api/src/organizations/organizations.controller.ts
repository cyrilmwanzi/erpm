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
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "./organization.decorators.js";
import { OrganizationsService } from "./organizations.service.js";

const organizationRoleEnum = z.enum(ORGANIZATION_ROLE_NAMES);

const updateOrganizationSettingsSchema = z.object({
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

@Controller("api/v1/organizations")
@RequireActiveOrganization()
export class OrganizationsController {
  constructor(
    @Inject(OrganizationsService)
    private readonly organizationsService: OrganizationsService,
  ) {}

  @Get("current")
  @AllowWhenBillingLocked()
  @RequiredOrgPermissions({ organizationSettings: ["read"] })
  async getCurrentOrganization(
    @CurrentOrganization() org: AuthenticatedOrganization,
  ) {
    return this.organizationsService.getCurrentOrganizationOverview(org);
  }

  @Get("permissions")
  @AllowWhenBillingLocked()
  getPermissions(@CurrentOrganization() org: AuthenticatedOrganization) {
    return this.organizationsService.getEffectivePermissions(org);
  }

  @Patch("settings")
  @RequiredOrgPermissions({ organizationSettings: ["update"] })
  async updateSettings(
    @CurrentOrganization() org: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateOrganizationSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid organization settings payload.",
        issues: parsed.error.issues,
      });
    }

    return this.organizationsService.updateSettings(org, parsed.data, req.ip);
  }

  @Get("members")
  @RequiredOrgPermissions({ ac: ["read"] })
  async listMembers(@CurrentOrganization() org: AuthenticatedOrganization) {
    return this.organizationsService.listMembers(org);
  }

  @Patch("members/:memberId/role")
  @RequiredOrgPermissions({ member: ["update"] })
  async updateMemberRole(
    @CurrentOrganization() org: AuthenticatedOrganization,
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

    return this.organizationsService.updateMemberRole(
      org,
      memberId,
      parsed.data.role,
      req.headers,
    );
  }

  @Delete("members/:memberId")
  @RequiredOrgPermissions({ member: ["delete"] })
  async removeMember(
    @CurrentOrganization() org: AuthenticatedOrganization,
    @Param("memberId") memberId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.organizationsService.removeMember(org, memberId, req.headers);
  }

  @Get("invitations")
  @RequiredOrgPermissions({ invitation: ["create"] })
  async listInvitations(
    @CurrentOrganization() org: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listInvitationsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid invitation query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.organizationsService.listInvitations(org, parsed.data.status);
  }

  @Post("invitations")
  @RequiredOrgPermissions({ invitation: ["create"] })
  async createInvitation(
    @CurrentOrganization() org: AuthenticatedOrganization,
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

    return this.organizationsService.createInvitation(
      org,
      parsed.data,
      req.headers,
    );
  }

  @Delete("invitations/:invitationId")
  @RequiredOrgPermissions({ invitation: ["cancel"] })
  async cancelInvitation(
    @CurrentOrganization() org: AuthenticatedOrganization,
    @Param("invitationId") invitationId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.organizationsService.cancelInvitation(
      org,
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

    return this.organizationsService.listAuditLogs(
      parsed.data.limit,
      parsed.data.cursor,
    );
  }
}

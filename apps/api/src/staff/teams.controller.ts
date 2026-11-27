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
import { TeamKind, TeamStatus } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { TeamsService } from "./teams.service.js";

const teamKindEnum = z.enum([
  TeamKind.PROJECT,
  TeamKind.RESOURCE_POOL,
  TeamKind.DEPARTMENT,
]);

const teamStatusEnum = z.enum([TeamStatus.ACTIVE, TeamStatus.ARCHIVED]);
const metadataSchema = z.record(z.string(), z.unknown()).nullable();

const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(2).max(80),
  description: z.string().trim().max(1000).nullable().optional(),
  kind: teamKindEnum.optional(),
  departmentId: z.string().trim().min(1).nullable().optional(),
  leadStaffId: z.string().trim().min(1).nullable().optional(),
  defaultAllocationPct: z.number().int().min(1).max(100).optional(),
  metadata: metadataSchema.optional(),
});

const updateTeamSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  kind: teamKindEnum.optional(),
  departmentId: z.string().trim().min(1).nullable().optional(),
  leadStaffId: z.string().trim().min(1).nullable().optional(),
  defaultAllocationPct: z.number().int().min(1).max(100).optional(),
  metadata: metadataSchema.optional(),
});

const listTeamsQuerySchema = z.object({
  kind: teamKindEnum.optional(),
  status: teamStatusEnum.optional(),
  departmentId: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const upsertTeamMemberSchema = z.object({
  staffId: z.string().trim().min(1),
  roleInTeam: z.string().trim().min(1).max(80).optional(),
  allocationPct: z.number().int().min(1).max(100).optional(),
  startDate: z.string().trim().min(1).nullable().optional(),
  endDate: z.string().trim().min(1).nullable().optional(),
  isActive: z.boolean().optional(),
});

@Controller("api/v1/teams")
@RequireActiveOrganization()
export class TeamsController {
  constructor(
    @Inject(TeamsService) private readonly teamsService: TeamsService,
  ) {}

  @Post()
  @RequiredOrgPermissions({ team: ["create"] })
  async createTeam(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createTeamSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid team payload.",
        issues: parsed.error.issues,
      });
    }
    return this.teamsService.createTeam(tenant, parsed.data, req.ip);
  }

  @Get()
  @RequiredOrgPermissions({ team: ["read"] })
  async listTeams(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listTeamsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid team query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.teamsService.listTeams(tenant, parsed.data);
  }

  @Get(":teamId")
  @RequiredOrgPermissions({ team: ["read"] })
  async getTeam(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("teamId") teamId: string,
  ) {
    return this.teamsService.getTeam(tenant, teamId);
  }

  @Patch(":teamId")
  @RequiredOrgPermissions({ team: ["update"] })
  async updateTeam(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("teamId") teamId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateTeamSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid team update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.teamsService.updateTeam(tenant, teamId, parsed.data, req.ip);
  }

  @Post(":teamId/archive")
  @RequiredOrgPermissions({ team: ["archive"] })
  async archiveTeam(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("teamId") teamId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.teamsService.archiveTeam(tenant, teamId, req.ip);
  }

  @Post(":teamId/members")
  @RequiredOrgPermissions({ team: ["update"] })
  async upsertTeamMember(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("teamId") teamId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = upsertTeamMemberSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid team member payload.",
        issues: parsed.error.issues,
      });
    }
    return this.teamsService.upsertTeamMember(
      tenant,
      teamId,
      parsed.data,
      req.ip,
    );
  }

  @Delete(":teamId/members/:staffId")
  @RequiredOrgPermissions({ team: ["update"] })
  async removeTeamMember(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("teamId") teamId: string,
    @Param("staffId") staffId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.teamsService.removeTeamMember(tenant, teamId, staffId, req.ip);
  }
}

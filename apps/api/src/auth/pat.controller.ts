import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { PatService } from "./pat.service.js";
import { ALL_ERP_SCOPES } from "./permissions.js";

const createPatSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.string().trim().min(1)).min(1).max(100),
  expiresAt: z.string().datetime().optional(),
  expiresInDays: z.number().int().min(1).max(730).optional(),
  ipAllowlist: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
});

const listPatQuerySchema = z.object({
  includeAll: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

@Controller("api/v1/auth/pats")
@RequireActiveOrganization()
export class PatController {
  constructor(@Inject(PatService) private readonly patService: PatService) {}

  @Get("scopes")
  @RequiredOrgPermissions({ apiToken: ["read"] })
  listAvailableScopes() {
    return { scopes: ALL_ERP_SCOPES };
  }

  @Post()
  @RequiredOrgPermissions({ apiToken: ["create"] })
  async createPat(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
  ) {
    const parsed = createPatSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid Personal Access Token payload.",
        issues: parsed.error.issues,
      });
    }
    return this.patService.createPat(tenant, parsed.data);
  }

  @Get()
  @RequiredOrgPermissions({ apiToken: ["read"] })
  async listPats(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listPatQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid PAT query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.patService.listPats(tenant, parsed.data.includeAll ?? false);
  }

  @Post(":patId/revoke")
  @RequiredOrgPermissions({ apiToken: ["revoke"] })
  async revokePatPost(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("patId") patId: string,
  ) {
    return this.patService.revokePat(tenant, patId);
  }

  @Delete(":patId")
  @RequiredOrgPermissions({ apiToken: ["revoke"] })
  async revokePatDelete(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("patId") patId: string,
  ) {
    return this.patService.revokePat(tenant, patId);
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { DepartmentStatus } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { DepartmentsService } from "./departments.service.js";

const departmentCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._-]+$/);

const createDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: departmentCodeSchema,
  description: z.string().trim().max(1000).nullable().optional(),
  parentDepartmentId: z.string().trim().min(1).nullable().optional(),
  leadStaffId: z.string().trim().min(1).nullable().optional(),
});

const updateDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  code: departmentCodeSchema.optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  parentDepartmentId: z.string().trim().min(1).nullable().optional(),
  leadStaffId: z.string().trim().min(1).nullable().optional(),
});

const listDepartmentsQuerySchema = z.object({
  status: z.enum([DepartmentStatus.ACTIVE, DepartmentStatus.ARCHIVED]).optional(),
  parentDepartmentId: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

@Controller("api/v1/departments")
@RequireActiveOrganization()
export class DepartmentsController {
  constructor(
    @Inject(DepartmentsService)
    private readonly departmentsService: DepartmentsService,
  ) {}

  @Post()
  @RequiredOrgPermissions({ department: ["create"] })
  async createDepartment(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createDepartmentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid department payload.",
        issues: parsed.error.issues,
      });
    }
    return this.departmentsService.createDepartment(tenant, parsed.data, req.ip);
  }

  @Get()
  @RequiredOrgPermissions({ department: ["read"] })
  async listDepartments(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listDepartmentsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid department query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.departmentsService.listDepartments(tenant, parsed.data);
  }

  @Get("tree")
  @RequiredOrgPermissions({ department: ["read"] })
  async getDepartmentTree(@CurrentOrganization() tenant: AuthenticatedOrganization) {
    return this.departmentsService.getDepartmentTree(tenant);
  }

  @Get(":departmentId")
  @RequiredOrgPermissions({ department: ["read"] })
  async getDepartment(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("departmentId") departmentId: string,
  ) {
    return this.departmentsService.getDepartment(tenant, departmentId);
  }

  @Patch(":departmentId")
  @RequiredOrgPermissions({ department: ["update"] })
  async updateDepartment(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("departmentId") departmentId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateDepartmentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid department update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.departmentsService.updateDepartment(
      tenant,
      departmentId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":departmentId/archive")
  @RequiredOrgPermissions({ department: ["archive"] })
  async archiveDepartment(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("departmentId") departmentId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.departmentsService.archiveDepartment(
      tenant,
      departmentId,
      req.ip,
    );
  }
}

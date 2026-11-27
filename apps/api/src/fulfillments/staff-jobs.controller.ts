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
import { StaffJobStatus } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { StaffJobsService } from "./staff-jobs.service.js";

const dateStringSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), {
    message: "Must be a valid ISO date or datetime string.",
  });

const createStaffJobSchema = z.object({
  fulfillmentId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(4000).nullable().optional(),
  priority: z.number().int().min(1).max(3).optional(),
  assignedStaffId: z.string().trim().min(1).nullable().optional(),
  assignedDepartmentId: z.string().trim().min(1).nullable().optional(),
  assignedTeamId: z.string().trim().min(1).nullable().optional(),
  assignedRole: z.string().trim().min(1).max(64).nullable().optional(),
  targetDueAt: dateStringSchema.nullable().optional(),
  syncToCrm: z.boolean().optional(),
});

const assignStaffJobSchema = z.object({
  assignedStaffId: z.string().trim().min(1).nullable().optional(),
  assignedDepartmentId: z.string().trim().min(1).nullable().optional(),
  assignedTeamId: z.string().trim().min(1).nullable().optional(),
  assignedRole: z.string().trim().min(1).max(64).nullable().optional(),
  priority: z.number().int().min(1).max(3).optional(),
  targetDueAt: dateStringSchema.nullable().optional(),
  instructions: z.string().trim().max(4000).nullable().optional(),
});

const updateJobStatusSchema = z.object({
  status: z.enum([
    StaffJobStatus.ASSIGNED,
    StaffJobStatus.IN_PROGRESS,
    StaffJobStatus.COMPLETED,
    StaffJobStatus.CANCELLED,
  ]),
  notes: z.string().trim().max(2000).nullable().optional(),
  notifyCustomerOnComplete: z.boolean().optional(),
});

const listStaffJobsQuerySchema = z.object({
  fulfillmentId: z.string().trim().min(1).optional(),
  orderId: z.string().trim().min(1).optional(),
  status: z
    .enum([
      StaffJobStatus.ASSIGNED,
      StaffJobStatus.IN_PROGRESS,
      StaffJobStatus.COMPLETED,
      StaffJobStatus.CANCELLED,
    ])
    .optional(),
  assignedStaffId: z.string().trim().min(1).optional(),
  assignedDepartmentId: z.string().trim().min(1).optional(),
  assignedTeamId: z.string().trim().min(1).optional(),
  assignedRole: z.string().trim().min(1).max(64).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

@Controller("api/v1/staff-jobs")
@RequireActiveOrganization()
export class StaffJobsController {
  constructor(
    @Inject(StaffJobsService)
    private readonly staffJobsService: StaffJobsService,
  ) {}

  @Post()
  @RequiredOrgPermissions({ staffJob: ["create"] })
  async createStaffJob(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createStaffJobSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid staff job payload.",
        issues: parsed.error.issues,
      });
    }
    return this.staffJobsService.createStaffJob(tenant, parsed.data, req.ip);
  }

  @Get()
  @RequiredOrgPermissions({ staffJob: ["read"] })
  async listStaffJobs(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listStaffJobsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid staff job query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.staffJobsService.listStaffJobs(tenant, parsed.data);
  }

  @Get(":jobId")
  @RequiredOrgPermissions({ staffJob: ["read"] })
  async getStaffJob(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("jobId") jobId: string,
  ) {
    return this.staffJobsService.getStaffJob(tenant, jobId);
  }

  @Patch(":jobId/assign")
  @RequiredOrgPermissions({ staffJob: ["assign"] })
  async assignStaffJob(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("jobId") jobId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = assignStaffJobSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid staff job assignment payload.",
        issues: parsed.error.issues,
      });
    }
    return this.staffJobsService.assignStaffJob(
      tenant,
      jobId,
      parsed.data,
      req.ip,
    );
  }

  @Patch(":jobId/status")
  @RequiredOrgPermissions({ staffJob: ["update"] })
  async updateStaffJobStatus(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("jobId") jobId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateJobStatusSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid staff job status payload.",
        issues: parsed.error.issues,
      });
    }
    return this.staffJobsService.updateStaffJobStatus(
      tenant,
      jobId,
      parsed.data,
      req.ip,
    );
  }
}

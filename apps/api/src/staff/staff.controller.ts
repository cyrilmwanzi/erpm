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
import { EmploymentType, StaffStatus } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { ScheduleLeaveService } from "./schedule-leave.service.js";
import { StaffService } from "./staff.service.js";

const employmentTypeEnum = z.enum([
  EmploymentType.FULL_TIME,
  EmploymentType.PART_TIME,
  EmploymentType.CONTRACTOR,
  EmploymentType.INTERN,
]);

const staffStatusEnum = z.enum([
  StaffStatus.PREBOARDING,
  StaffStatus.ACTIVE,
  StaffStatus.ON_LEAVE,
  StaffStatus.OFFBOARDED,
]);

const skillsSchema = z.array(z.string().trim().min(1).max(64)).max(50);
const metadataSchema = z.record(z.string(), z.unknown()).nullable();

const createStaffSchema = z.object({
  memberId: z.string().trim().min(1).nullable().optional(),
  employeeCode: z.string().trim().min(1).max(32).nullable().optional(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(1).max(120).optional(),
  workEmail: z.string().trim().email().max(320),
  phone: z.string().trim().max(40).nullable().optional(),
  jobTitle: z.string().trim().max(120).nullable().optional(),
  departmentId: z.string().trim().min(1).nullable().optional(),
  managerStaffId: z.string().trim().min(1).nullable().optional(),
  locationId: z.string().trim().min(1).nullable().optional(),
  workScheduleId: z.string().trim().min(1).nullable().optional(),
  employmentType: employmentTypeEnum.optional(),
  status: staffStatusEnum.optional(),
  startDate: z.string().trim().min(1).nullable().optional(),
  endDate: z.string().trim().min(1).nullable().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  weeklyCapacityMinutes: z.number().int().min(0).max(10080).optional(),
  skills: skillsSchema.optional(),
  bio: z.string().trim().max(2000).nullable().optional(),
  metadata: metadataSchema.optional(),
});

const updateStaffSchema = z.object({
  memberId: z.string().trim().min(1).nullable().optional(),
  employeeCode: z.string().trim().min(1).max(32).nullable().optional(),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  workEmail: z.string().trim().email().max(320).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  jobTitle: z.string().trim().max(120).nullable().optional(),
  departmentId: z.string().trim().min(1).nullable().optional(),
  managerStaffId: z.string().trim().min(1).nullable().optional(),
  locationId: z.string().trim().min(1).nullable().optional(),
  workScheduleId: z.string().trim().min(1).nullable().optional(),
  employmentType: employmentTypeEnum.optional(),
  status: staffStatusEnum.optional(),
  startDate: z.string().trim().min(1).nullable().optional(),
  endDate: z.string().trim().min(1).nullable().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  weeklyCapacityMinutes: z.number().int().min(0).max(10080).optional(),
  skills: skillsSchema.optional(),
  bio: z.string().trim().max(2000).nullable().optional(),
  metadata: metadataSchema.optional(),
});

const selfUpdateStaffSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  skills: skillsSchema.optional(),
  bio: z.string().trim().max(2000).nullable().optional(),
  metadata: metadataSchema.optional(),
});

const listStaffQuerySchema = z.object({
  status: staffStatusEnum.optional(),
  departmentId: z.string().trim().min(1).optional(),
  managerStaffId: z.string().trim().min(1).optional(),
  employmentType: employmentTypeEnum.optional(),
  skill: z.string().trim().min(1).max(64).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const offboardSchema = z.object({
  endDate: z.string().trim().min(1).optional(),
  reason: z.string().trim().max(500).optional(),
});

const assignScheduleSchema = z.object({
  workScheduleId: z.string().trim().min(1),
});

@Controller("api/v1/staff")
@RequireActiveOrganization()
export class StaffController {
  constructor(
    @Inject(StaffService) private readonly staffService: StaffService,
    @Inject(ScheduleLeaveService)
    private readonly scheduleLeaveService: ScheduleLeaveService,
  ) {}

  @Get("me")
  @RequiredOrgPermissions({ staff: ["read"] })
  async getMyProfile(@CurrentOrganization() tenant: AuthenticatedOrganization) {
    return this.staffService.getOrCreateMyProfile(tenant);
  }

  @Patch("me")
  @RequiredOrgPermissions({ staff: ["selfUpdate"] })
  async updateMyProfile(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = selfUpdateStaffSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid self-service staff profile payload.",
        issues: parsed.error.issues,
      });
    }
    return this.staffService.updateMyProfile(tenant, parsed.data, req.ip);
  }

  @Get("org-chart")
  @RequiredOrgPermissions({ staff: ["read"] })
  async getOrgChart(@CurrentOrganization() tenant: AuthenticatedOrganization) {
    return this.staffService.getOrgChart(tenant);
  }

  @Post("sync-members")
  @RequiredOrgPermissions({ staff: ["create"] })
  async syncMembersToStaff(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Req() req: FastifyRequest,
  ) {
    return this.staffService.syncMembersToStaff(tenant, req.ip);
  }

  @Post()
  @RequiredOrgPermissions({ staff: ["create"] })
  async createStaff(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createStaffSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid staff profile payload.",
        issues: parsed.error.issues,
      });
    }
    return this.staffService.createStaff(tenant, parsed.data, req.ip);
  }

  @Get()
  @RequiredOrgPermissions({ staff: ["read"] })
  async listStaff(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listStaffQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid staff query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.staffService.listStaff(tenant, parsed.data);
  }

  @Get(":staffId")
  @RequiredOrgPermissions({ staff: ["read"] })
  async getStaff(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("staffId") staffId: string,
  ) {
    return this.staffService.getStaffById(tenant, staffId);
  }

  @Patch(":staffId")
  @RequiredOrgPermissions({ staff: ["update"] })
  async updateStaff(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("staffId") staffId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateStaffSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid staff update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.staffService.updateStaff(tenant, staffId, parsed.data, req.ip);
  }

  @Post(":staffId/offboard")
  @RequiredOrgPermissions({ staff: ["archive"] })
  async offboardStaff(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("staffId") staffId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = offboardSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid offboard payload.",
        issues: parsed.error.issues,
      });
    }
    return this.staffService.offboardStaff(
      tenant,
      staffId,
      parsed.data.endDate,
      parsed.data.reason,
      req.ip,
    );
  }

  @Post(":staffId/schedule")
  @RequiredOrgPermissions({ staff: ["update"] })
  async assignSchedule(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("staffId") staffId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = assignScheduleSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid schedule assignment payload.",
        issues: parsed.error.issues,
      });
    }
    return this.scheduleLeaveService.assignScheduleToStaff(
      tenant,
      staffId,
      parsed.data.workScheduleId,
      req.ip,
    );
  }
}

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
import { LeaveType, TimeOffStatus } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { ScheduleLeaveService } from "./schedule-leave.service.js";

const workingDaySchema = z.object({
  enabled: z.boolean(),
  start: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  end: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  breakMinutes: z.number().int().min(0).max(720).default(0),
});

const workingDaysSchema = z
  .object({
    monday: workingDaySchema.optional(),
    tuesday: workingDaySchema.optional(),
    wednesday: workingDaySchema.optional(),
    thursday: workingDaySchema.optional(),
    friday: workingDaySchema.optional(),
    saturday: workingDaySchema.optional(),
    sunday: workingDaySchema.optional(),
  })
  .optional();

const createScheduleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(100).optional(),
  workingDays: workingDaysSchema,
  isDefault: z.boolean().optional(),
});

const updateScheduleSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  workingDays: workingDaysSchema,
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const listSchedulesQuerySchema = z.object({
  includeInactive: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

const createHolidaySchema = z.object({
  name: z.string().trim().min(1).max(120),
  date: z.string().trim().min(1),
  isRecurringAnnual: z.boolean().optional(),
  isHalfDay: z.boolean().optional(),
  locationId: z.string().trim().min(1).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

const listHolidaysQuerySchema = z.object({
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  locationId: z.string().trim().min(1).optional(),
});

const leaveTypeEnum = z.enum([
  LeaveType.VACATION,
  LeaveType.SICK,
  LeaveType.PERSONAL,
  LeaveType.PARENTAL,
  LeaveType.UNPAID,
  LeaveType.OTHER,
]);

const timeOffStatusEnum = z.enum([
  TimeOffStatus.PENDING,
  TimeOffStatus.APPROVED,
  TimeOffStatus.REJECTED,
  TimeOffStatus.CANCELLED,
]);

const createTimeOffSchema = z.object({
  staffId: z.string().trim().min(1).optional(),
  leaveType: leaveTypeEnum,
  startDate: z.string().trim().min(1),
  endDate: z.string().trim().min(1),
  totalMinutes: z.number().int().positive().max(262_080).optional(),
  reason: z.string().trim().max(1000).nullable().optional(),
});

const listTimeOffQuerySchema = z.object({
  staffId: z.string().trim().min(1).optional(),
  status: timeOffStatusEnum.optional(),
  leaveType: leaveTypeEnum.optional(),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const reviewTimeOffSchema = z.object({
  reviewNote: z.string().trim().max(500).nullable().optional(),
});

@Controller("api/v1/schedules")
@RequireActiveOrganization()
export class SchedulesController {
  constructor(
    @Inject(ScheduleLeaveService)
    private readonly scheduleLeaveService: ScheduleLeaveService,
  ) {}

  @Post()
  @RequiredOrgPermissions({ staff: ["update"] })
  async createSchedule(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createScheduleSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid work schedule payload.",
        issues: parsed.error.issues,
      });
    }
    return this.scheduleLeaveService.createSchedule(tenant, parsed.data, req.ip);
  }

  @Get()
  @RequiredOrgPermissions({ staff: ["read"] })
  async listSchedules(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listSchedulesQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid work schedule query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.scheduleLeaveService.listSchedules(
      tenant,
      parsed.data.includeInactive ?? false,
    );
  }

  @Patch(":scheduleId")
  @RequiredOrgPermissions({ staff: ["update"] })
  async updateSchedule(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("scheduleId") scheduleId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateScheduleSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid work schedule update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.scheduleLeaveService.updateSchedule(
      tenant,
      scheduleId,
      parsed.data,
      req.ip,
    );
  }
}

@Controller("api/v1/holidays")
@RequireActiveOrganization()
export class HolidaysController {
  constructor(
    @Inject(ScheduleLeaveService)
    private readonly scheduleLeaveService: ScheduleLeaveService,
  ) {}

  @Post()
  @RequiredOrgPermissions({ calendar: ["manage"] })
  async createHoliday(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createHolidaySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid holiday payload.",
        issues: parsed.error.issues,
      });
    }
    return this.scheduleLeaveService.createHoliday(tenant, parsed.data, req.ip);
  }

  @Get()
  @RequiredOrgPermissions({ calendar: ["read"] })
  async listHolidays(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listHolidaysQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid holiday query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.scheduleLeaveService.listHolidays(tenant, parsed.data);
  }

  @Delete(":holidayId")
  @RequiredOrgPermissions({ calendar: ["manage"] })
  async deleteHoliday(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("holidayId") holidayId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.scheduleLeaveService.deleteHoliday(tenant, holidayId, req.ip);
  }
}

@Controller("api/v1/time-off")
@RequireActiveOrganization()
export class TimeOffController {
  constructor(
    @Inject(ScheduleLeaveService)
    private readonly scheduleLeaveService: ScheduleLeaveService,
  ) {}

  @Post()
  @RequiredOrgPermissions({ timeOff: ["request"] })
  async requestTimeOff(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createTimeOffSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid time-off request payload.",
        issues: parsed.error.issues,
      });
    }
    return this.scheduleLeaveService.requestTimeOff(tenant, parsed.data, req.ip);
  }

  @Get("mine")
  @RequiredOrgPermissions({ timeOff: ["read"] })
  async listMyTimeOff(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listTimeOffQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid time-off query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.scheduleLeaveService.listMyTimeOff(tenant, parsed.data);
  }

  @Get()
  @RequiredOrgPermissions({ timeOff: ["read"] })
  async listTimeOff(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listTimeOffQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid time-off query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.scheduleLeaveService.listTimeOff(tenant, parsed.data);
  }

  @Post(":requestId/approve")
  @RequiredOrgPermissions({ timeOff: ["approve"] })
  async approveTimeOff(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("requestId") requestId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = reviewTimeOffSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid time-off approval payload.",
        issues: parsed.error.issues,
      });
    }
    return this.scheduleLeaveService.reviewTimeOff(
      tenant,
      requestId,
      "APPROVED",
      parsed.data.reviewNote,
      req.ip,
    );
  }

  @Post(":requestId/reject")
  @RequiredOrgPermissions({ timeOff: ["approve"] })
  async rejectTimeOff(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("requestId") requestId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = reviewTimeOffSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid time-off rejection payload.",
        issues: parsed.error.issues,
      });
    }
    return this.scheduleLeaveService.reviewTimeOff(
      tenant,
      requestId,
      "REJECTED",
      parsed.data.reviewNote,
      req.ip,
    );
  }

  @Post(":requestId/cancel")
  @RequiredOrgPermissions({ timeOff: ["request"] })
  async cancelTimeOff(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("requestId") requestId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.scheduleLeaveService.cancelTimeOff(tenant, requestId, req.ip);
  }
}

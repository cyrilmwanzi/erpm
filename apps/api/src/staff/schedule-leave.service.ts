import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  LeaveType,
  LocationStatus,
  Prisma,
  StaffStatus,
  TimeOffStatus,
} from "@scace/db";
import { hasOrganizationPermission } from "../auth/permissions.js";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { StaffService } from "./staff.service.js";
import {
  computeDailyShiftMinutes,
  computeWeeklyCapacityMinutes,
  DEFAULT_WORKING_DAYS,
  enumerateUtcDates,
  formatUtcDateString,
  isValidTimeZone,
  normalizeUtcDate,
  normalizeWorkingDays,
  WEEKDAY_KEYS,
  type WorkingDaysMap,
} from "./staff.utils.js";

export interface CreateWorkScheduleInput {
  name: string;
  timezone?: string;
  workingDays?: unknown;
  isDefault?: boolean;
}

export interface UpdateWorkScheduleInput {
  name?: string;
  timezone?: string;
  workingDays?: unknown;
  isDefault?: boolean;
  isActive?: boolean;
}

export interface CreateHolidayInput {
  name: string;
  date: string;
  isRecurringAnnual?: boolean;
  isHalfDay?: boolean;
  locationId?: string | null;
  notes?: string | null;
}

export interface ListHolidaysQuery {
  from?: string;
  to?: string;
  locationId?: string;
}

export interface CreateTimeOffInput {
  staffId?: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  totalMinutes?: number;
  reason?: string | null;
}

export interface ListTimeOffQuery {
  staffId?: string;
  status?: TimeOffStatus;
  leaveType?: LeaveType;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

@Injectable()
export class ScheduleLeaveService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(StaffService) private readonly staffService: StaffService,
  ) {}

  async createSchedule(
    tenant: AuthenticatedOrganization,
    input: CreateWorkScheduleInput,
    ipAddress?: string,
  ) {
    const timezone = input.timezone?.trim() || "UTC";
    if (!isValidTimeZone(timezone)) {
      throw new BadRequestException(`Invalid IANA timezone: ${timezone}`);
    }

    const workingDays = normalizeWorkingDays(
      input.workingDays ?? DEFAULT_WORKING_DAYS,
    );
    const weeklyCapacityMinutes = computeWeeklyCapacityMinutes(workingDays);
    const name = input.name.trim();

    return this.prismaService.raw.$transaction(async (tx) => {
      const dup = await tx.workSchedule.findFirst({
        where: { organizationId: tenant.organizationId, name },
        select: { id: true },
      });
      if (dup) {
        throw new ConflictException(
          `Work schedule "${name}" already exists in this organization.`,
        );
      }

      if (input.isDefault) {
        await tx.workSchedule.updateMany({
          where: { organizationId: tenant.organizationId, isDefault: true },
          data: { isDefault: false },
        });
      }

      const created = await tx.workSchedule.create({
        data: {
          organizationId: tenant.organizationId,
          name,
          timezone,
          weeklyCapacityMinutes,
          workingDays: workingDays as unknown as Prisma.InputJsonValue,
          isDefault: Boolean(input.isDefault),
          isActive: true,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "schedule.created",
          resourceType: "WorkSchedule",
          resourceId: created.id,
          metadata: {
            name: created.name,
            timezone: created.timezone,
            weeklyCapacityMinutes,
            isDefault: created.isDefault,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return created;
    });
  }

  async listSchedules(tenant: AuthenticatedOrganization, includeInactive = false) {
    const items = await this.prismaService.scoped.workSchedule.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      include: {
        _count: { select: { staffProfiles: true } },
      },
    });

    return {
      organizationId: tenant.organizationId,
      items,
    };
  }

  async updateSchedule(
    tenant: AuthenticatedOrganization,
    scheduleId: string,
    input: UpdateWorkScheduleInput,
    ipAddress?: string,
  ) {
    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
      throw new BadRequestException(`Invalid IANA timezone: ${input.timezone}`);
    }

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.workSchedule.findFirst({
        where: { id: scheduleId, organizationId: tenant.organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Work schedule not found.");
      }

      const nextName = input.name?.trim();
      if (nextName && nextName !== existing.name) {
        const dup = await tx.workSchedule.findFirst({
          where: {
            organizationId: tenant.organizationId,
            name: nextName,
            id: { not: existing.id },
          },
          select: { id: true },
        });
        if (dup) {
          throw new ConflictException(
            `Work schedule "${nextName}" already exists.`,
          );
        }
      }

      const workingDays =
        input.workingDays !== undefined
          ? normalizeWorkingDays(input.workingDays)
          : undefined;
      const weeklyCapacityMinutes = workingDays
        ? computeWeeklyCapacityMinutes(workingDays)
        : undefined;

      if (input.isDefault === true) {
        await tx.workSchedule.updateMany({
          where: {
            organizationId: tenant.organizationId,
            isDefault: true,
            id: { not: existing.id },
          },
          data: { isDefault: false },
        });
      }

      const updated = await tx.workSchedule.update({
        where: { id: existing.id },
        data: {
          ...(nextName !== undefined ? { name: nextName } : {}),
          ...(input.timezone !== undefined
            ? { timezone: input.timezone.trim() }
            : {}),
          ...(workingDays
            ? {
                workingDays: workingDays as unknown as Prisma.InputJsonValue,
                weeklyCapacityMinutes,
              }
            : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "schedule.updated",
          resourceType: "WorkSchedule",
          resourceId: updated.id,
          metadata: {
            name: updated.name,
            weeklyCapacityMinutes: updated.weeklyCapacityMinutes,
            isDefault: updated.isDefault,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async assignScheduleToStaff(
    tenant: AuthenticatedOrganization,
    staffId: string,
    workScheduleId: string,
    ipAddress?: string,
  ) {
    return this.prismaService.raw.$transaction(async (tx) => {
      const [staff, schedule] = await Promise.all([
        tx.staffProfile.findFirst({
          where: { id: staffId, organizationId: tenant.organizationId },
        }),
        tx.workSchedule.findFirst({
          where: {
            id: workScheduleId,
            organizationId: tenant.organizationId,
            isActive: true,
          },
        }),
      ]);

      if (!staff) {
        throw new NotFoundException("Staff profile not found.");
      }
      if (!schedule) {
        throw new NotFoundException("Active work schedule not found.");
      }

      const updated = await tx.staffProfile.update({
        where: { id: staff.id },
        data: {
          workScheduleId: schedule.id,
          weeklyCapacityMinutes: schedule.weeklyCapacityMinutes,
          timezone: schedule.timezone,
          updatedByUserId: tenant.userId,
        },
        include: { workSchedule: true },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "staff.schedule.assigned",
          resourceType: "StaffProfile",
          resourceId: staff.id,
          metadata: {
            workScheduleId: schedule.id,
            scheduleName: schedule.name,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async createHoliday(
    tenant: AuthenticatedOrganization,
    input: CreateHolidayInput,
    ipAddress?: string,
  ) {
    const date = normalizeUtcDate(input.date);

    return this.prismaService.raw.$transaction(async (tx) => {
      if (input.locationId) {
        const loc = await tx.location.findFirst({
          where: { id: input.locationId, organizationId: tenant.organizationId },
          select: { id: true, status: true },
        });
        if (!loc) {
          throw new NotFoundException(
            `Location (${input.locationId}) was not found in the active organization.`,
          );
        }
        if (loc.status === LocationStatus.ARCHIVED) {
          throw new BadRequestException(
            "Cannot attach a holiday to an archived location.",
          );
        }
      }

      const created = await tx.holiday.create({
        data: {
          organizationId: tenant.organizationId,
          name: input.name.trim(),
          date,
          isRecurringAnnual: Boolean(input.isRecurringAnnual),
          isHalfDay: Boolean(input.isHalfDay),
          locationId: input.locationId ?? null,
          notes: input.notes ?? null,
          createdByUserId: tenant.userId,
        },
        include: {
          location: { select: { id: true, code: true, name: true } },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "holiday.created",
          resourceType: "Holiday",
          resourceId: created.id,
          metadata: {
            name: created.name,
            date: formatUtcDateString(created.date),
            locationId: created.locationId,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return created;
    });
  }

  async listHolidays(tenant: AuthenticatedOrganization, query: ListHolidaysQuery) {
    const fromDate = query.from ? normalizeUtcDate(query.from) : undefined;
    const toDate = query.to ? normalizeUtcDate(query.to) : undefined;

    if (fromDate && toDate && toDate.getTime() < fromDate.getTime()) {
      throw new BadRequestException("to date cannot precede from date.");
    }

    const items = await this.prismaService.scoped.holiday.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(fromDate || toDate
          ? {
              OR: [
                {
                  date: {
                    ...(fromDate ? { gte: fromDate } : {}),
                    ...(toDate ? { lte: toDate } : {}),
                  },
                },
                { isRecurringAnnual: true },
              ],
            }
          : {}),
      },
      orderBy: [{ date: "asc" }, { name: "asc" }],
      include: {
        location: { select: { id: true, code: true, name: true } },
      },
    });

    return {
      organizationId: tenant.organizationId,
      items,
    };
  }

  async deleteHoliday(
    tenant: AuthenticatedOrganization,
    holidayId: string,
    ipAddress?: string,
  ) {
    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.holiday.findFirst({
        where: { id: holidayId, organizationId: tenant.organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Holiday not found.");
      }

      await tx.holiday.delete({ where: { id: existing.id } });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "holiday.deleted",
          resourceType: "Holiday",
          resourceId: existing.id,
          metadata: {
            name: existing.name,
            date: formatUtcDateString(existing.date),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return { deleted: true, id: existing.id };
    });
  }

  private resolveDayMinutesForSchedule(
    workingDays: WorkingDaysMap,
    date: Date,
  ): number {
    const key = WEEKDAY_KEYS[date.getUTCDay()] ?? "monday";
    return computeDailyShiftMinutes(workingDays[key]);
  }

  async requestTimeOff(
    tenant: AuthenticatedOrganization,
    input: CreateTimeOffInput,
    ipAddress?: string,
  ) {
    const startDate = normalizeUtcDate(input.startDate);
    const endDate = normalizeUtcDate(input.endDate);
    const dates = enumerateUtcDates(startDate, endDate, 180);

    const canApproveAny = hasOrganizationPermission(tenant.role, {
      timeOff: ["approve"],
    });

    let targetStaffId = input.staffId;
    if (!targetStaffId || targetStaffId === "me") {
      const mine = await this.staffService.getOrCreateMyProfile(tenant);
      targetStaffId = mine.id;
    } else if (!canApproveAny) {
      const mine = await this.staffService.getOrCreateMyProfile(tenant);
      if (mine.id !== targetStaffId) {
        throw new ForbiddenException(
          "Members may only submit time-off requests for their own staff profile.",
        );
      }
    }

    return this.prismaService.raw.$transaction(async (tx) => {
      const staff = await tx.staffProfile.findFirst({
        where: { id: targetStaffId, organizationId: tenant.organizationId },
        include: { workSchedule: true },
      });
      if (!staff) {
        throw new NotFoundException("Staff profile not found.");
      }
      if (staff.status === StaffStatus.OFFBOARDED) {
        throw new BadRequestException(
          "Cannot submit time off for an offboarded staff profile.",
        );
      }

      const overlapping = await tx.timeOffRequest.findFirst({
        where: {
          organizationId: tenant.organizationId,
          staffId: staff.id,
          status: { in: [TimeOffStatus.PENDING, TimeOffStatus.APPROVED] },
          startDate: { lte: endDate },
          endDate: { gte: startDate },
        },
        select: { id: true, startDate: true, endDate: true, status: true },
      });

      if (overlapping) {
        throw new ConflictException(
          `Time-off request overlaps with an existing ${overlapping.status.toLowerCase()} request (${formatUtcDateString(
            overlapping.startDate,
          )} to ${formatUtcDateString(overlapping.endDate)}).`,
        );
      }

      let computedMinutes = input.totalMinutes;
      if (computedMinutes === undefined) {
        const workingDays = normalizeWorkingDays(
          staff.workSchedule?.workingDays ?? DEFAULT_WORKING_DAYS,
        );
        const holidays = await tx.holiday.findMany({
          where: {
            organizationId: tenant.organizationId,
            OR: [
              { locationId: null },
              ...(staff.locationId ? [{ locationId: staff.locationId }] : []),
            ],
          },
          select: { date: true, isRecurringAnnual: true, isHalfDay: true },
        });

        let sum = 0;
        for (const day of dates) {
          let dayMin = this.resolveDayMinutesForSchedule(workingDays, day);
          if (dayMin === 0) {
            continue;
          }
          const matchingHoliday = holidays.find((h) => {
            if (formatUtcDateString(h.date) === formatUtcDateString(day)) {
              return true;
            }
            return (
              h.isRecurringAnnual &&
              h.date.getUTCMonth() === day.getUTCMonth() &&
              h.date.getUTCDate() === day.getUTCDate()
            );
          });
          if (matchingHoliday) {
            dayMin = matchingHoliday.isHalfDay ? Math.floor(dayMin / 2) : 0;
          }
          sum += dayMin;
        }
        computedMinutes = sum > 0 ? sum : dates.length * 480;
      }

      const created = await tx.timeOffRequest.create({
        data: {
          organizationId: tenant.organizationId,
          staffId: staff.id,
          leaveType: input.leaveType,
          startDate,
          endDate,
          totalMinutes: Math.max(1, Math.floor(computedMinutes)),
          status: TimeOffStatus.PENDING,
          reason: input.reason ?? null,
          createdByUserId: tenant.userId,
        },
        include: {
          staff: {
            select: { id: true, displayName: true, workEmail: true, jobTitle: true },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "time_off.requested",
          resourceType: "TimeOffRequest",
          resourceId: created.id,
          metadata: {
            staffId: staff.id,
            leaveType: created.leaveType,
            startDate: formatUtcDateString(startDate),
            endDate: formatUtcDateString(endDate),
            totalMinutes: created.totalMinutes,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return created;
    });
  }

  async listTimeOff(tenant: AuthenticatedOrganization, query: ListTimeOffQuery) {
    const take = Math.min(Math.max(query.limit, 1), 100);
    const fromDate = query.from ? normalizeUtcDate(query.from) : undefined;
    const toDate = query.to ? normalizeUtcDate(query.to) : undefined;

    const where: Prisma.TimeOffRequestWhereInput = {
      organizationId: tenant.organizationId,
      ...(query.staffId ? { staffId: query.staffId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.leaveType ? { leaveType: query.leaveType } : {}),
      ...(fromDate ? { endDate: { gte: fromDate } } : {}),
      ...(toDate ? { startDate: { lte: toDate } } : {}),
    };

    const records = await this.prismaService.scoped.timeOffRequest.findMany({
      where,
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      include: {
        staff: {
          select: {
            id: true,
            displayName: true,
            jobTitle: true,
            departmentId: true,
          },
        },
        reviewedByStaff: {
          select: { id: true, displayName: true },
        },
      },
    });

    const hasMore = records.length > take;
    const items = hasMore ? records.slice(0, take) : records;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return {
      organizationId: tenant.organizationId,
      items,
      nextCursor,
    };
  }

  async listMyTimeOff(
    tenant: AuthenticatedOrganization,
    query: Omit<ListTimeOffQuery, "staffId">,
  ) {
    const mine = await this.staffService.getOrCreateMyProfile(tenant);
    return this.listTimeOff(tenant, { ...query, staffId: mine.id });
  }

  async reviewTimeOff(
    tenant: AuthenticatedOrganization,
    requestId: string,
    decision: "APPROVED" | "REJECTED",
    reviewNote?: string | null,
    ipAddress?: string,
  ) {
    const reviewer = await this.staffService.getOrCreateMyProfile(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.timeOffRequest.findFirst({
        where: { id: requestId, organizationId: tenant.organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Time-off request not found.");
      }
      if (existing.status !== TimeOffStatus.PENDING) {
        throw new ConflictException(
          `Only pending requests can be reviewed (current status: ${existing.status}).`,
        );
      }

      const nextStatus =
        decision === "APPROVED"
          ? TimeOffStatus.APPROVED
          : TimeOffStatus.REJECTED;

      const updated = await tx.timeOffRequest.update({
        where: { id: existing.id },
        data: {
          status: nextStatus,
          reviewedByStaffId: reviewer.id,
          reviewedAt: new Date(),
          reviewNote: reviewNote ?? null,
        },
        include: {
          staff: {
            select: { id: true, displayName: true, workEmail: true },
          },
          reviewedByStaff: {
            select: { id: true, displayName: true },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action:
            decision === "APPROVED" ? "time_off.approved" : "time_off.rejected",
          resourceType: "TimeOffRequest",
          resourceId: updated.id,
          metadata: {
            staffId: updated.staffId,
            reviewedByStaffId: reviewer.id,
            reviewNote: updated.reviewNote,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async cancelTimeOff(
    tenant: AuthenticatedOrganization,
    requestId: string,
    ipAddress?: string,
  ) {
    const canApproveAny = hasOrganizationPermission(tenant.role, {
      timeOff: ["approve"],
    });
    const mine = await this.staffService.getOrCreateMyProfile(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.timeOffRequest.findFirst({
        where: { id: requestId, organizationId: tenant.organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Time-off request not found.");
      }

      if (!canApproveAny) {
        if (existing.staffId !== mine.id) {
          throw new ForbiddenException(
            "You can only cancel your own time-off requests.",
          );
        }
        if (existing.status !== TimeOffStatus.PENDING) {
          throw new ConflictException(
            "Only pending time-off requests can be cancelled by the requester.",
          );
        }
      } else if (
        existing.status !== TimeOffStatus.PENDING &&
        existing.status !== TimeOffStatus.APPROVED
      ) {
        throw new ConflictException(
          `Cannot cancel a time-off request in status ${existing.status}.`,
        );
      }

      const cancelled = await tx.timeOffRequest.update({
        where: { id: existing.id },
        data: {
          status: TimeOffStatus.CANCELLED,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "time_off.cancelled",
          resourceType: "TimeOffRequest",
          resourceId: cancelled.id,
          metadata: { staffId: cancelled.staffId } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return cancelled;
    });
  }
}

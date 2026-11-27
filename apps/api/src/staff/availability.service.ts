import { Inject, Injectable } from "@nestjs/common";
import { CalendarFeedScope, StaffStatus, TimeOffStatus } from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import {
  computeDailyShiftMinutes,
  DEFAULT_WORKING_DAYS,
  enumerateUtcDates,
  formatUtcDateString,
  normalizeUtcDate,
  normalizeWorkingDays,
  WEEKDAY_KEYS,
} from "./staff.utils.js";

export interface QueryAvailabilityInput {
  from: string;
  to: string;
  departmentId?: string;
  teamId?: string;
  staffIds?: string[];
  skills?: string[];
  minTotalFreeMinutes?: number;
  includeBreakdown?: boolean;
}

export interface QueryCalendarEventsInput {
  from: string;
  to: string;
  scope?: CalendarFeedScope;
  staffId?: string;
  teamId?: string;
  includeTimeOff?: boolean;
  includeHolidays?: boolean;
  includeShifts?: boolean;
}

export interface DailyCapacitySlot {
  date: string;
  scheduledMinutes: number;
  holidayMinutesDeducted: number;
  timeOffMinutesDeducted: number;
  allocatedMinutes: number;
  netAvailableMinutes: number;
  isWorkingDay: boolean;
}

export interface CalendarEventDto {
  id: string;
  kind: "HOLIDAY" | "TIME_OFF" | "WORK_SHIFT";
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string;
  staffId?: string | null;
  staffName?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AvailabilityService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  async queryAvailability(
    tenant: AuthenticatedOrganization,
    input: QueryAvailabilityInput,
  ) {
    const fromDate = normalizeUtcDate(input.from);
    const toDate = normalizeUtcDate(input.to);
    const dates = enumerateUtcDates(fromDate, toDate, 93);

    const staffList = await this.prismaService.scoped.staffProfile.findMany({
      where: {
        organizationId: tenant.organizationId,
        status: { in: [StaffStatus.ACTIVE, StaffStatus.ON_LEAVE] },
        ...(input.departmentId ? { departmentId: input.departmentId } : {}),
        ...(input.staffIds && input.staffIds.length > 0
          ? { id: { in: input.staffIds } }
          : {}),
        ...(input.skills && input.skills.length > 0
          ? { skills: { hasEvery: input.skills } }
          : {}),
        ...(input.teamId
          ? {
              teamMemberships: {
                some: {
                  teamId: input.teamId,
                  isActive: true,
                },
              },
            }
          : {}),
      },
      include: {
        department: { select: { id: true, name: true, code: true } },
        workSchedule: true,
        teamMemberships: {
          where: { isActive: true },
          include: {
            team: { select: { id: true, name: true, slug: true, kind: true } },
          },
        },
      },
      orderBy: { displayName: "asc" },
    });

    const staffIds = staffList.map((s) => s.id);
    const [holidays, approvedTimeOff, defaultSchedule] = await Promise.all([
      this.prismaService.scoped.holiday.findMany({
        where: { organizationId: tenant.organizationId },
      }),
      staffIds.length > 0
        ? this.prismaService.scoped.timeOffRequest.findMany({
            where: {
              organizationId: tenant.organizationId,
              staffId: { in: staffIds },
              status: TimeOffStatus.APPROVED,
              startDate: { lte: toDate },
              endDate: { gte: fromDate },
            },
          })
        : Promise.resolve([]),
      this.prismaService.scoped.workSchedule.findFirst({
        where: {
          organizationId: tenant.organizationId,
          isDefault: true,
          isActive: true,
        },
      }),
    ]);

    const fallbackDays = normalizeWorkingDays(
      defaultSchedule?.workingDays ?? DEFAULT_WORKING_DAYS,
    );

    const results = [];
    let poolScheduledMinutes = 0;
    let poolHolidayDeducted = 0;
    let poolTimeOffDeducted = 0;
    let poolAllocatedMinutes = 0;
    let poolNetAvailableMinutes = 0;

    for (const staff of staffList) {
      const workingDays = staff.workSchedule
        ? normalizeWorkingDays(staff.workSchedule.workingDays)
        : fallbackDays;

      const staffTimeOff = approvedTimeOff.filter((r) => r.staffId === staff.id);

      let scheduledTotal = 0;
      let holidayDeductedTotal = 0;
      let timeOffDeductedTotal = 0;
      let allocatedTotal = 0;
      let netAvailableTotal = 0;
      const daily: DailyCapacitySlot[] = [];

      for (const day of dates) {
        const dayStr = formatUtcDateString(day);
        const weekdayKey = WEEKDAY_KEYS[day.getUTCDay()] ?? "monday";
        const baseMinutes = computeDailyShiftMinutes(workingDays[weekdayKey]);

        const holiday = holidays.find((h) => {
          if (h.locationId && h.locationId !== staff.locationId) {
            return false;
          }
          if (formatUtcDateString(h.date) === dayStr) {
            return true;
          }
          return (
            h.isRecurringAnnual &&
            h.date.getUTCMonth() === day.getUTCMonth() &&
            h.date.getUTCDate() === day.getUTCDate()
          );
        });

        let holidayDeducted = 0;
        if (holiday && baseMinutes > 0) {
          holidayDeducted = holiday.isHalfDay
            ? Math.floor(baseMinutes / 2)
            : baseMinutes;
        }

        const afterHoliday = Math.max(0, baseMinutes - holidayDeducted);

        const hasApprovedLeave = staffTimeOff.some(
          (req) =>
            day.getTime() >= normalizeUtcDate(req.startDate).getTime() &&
            day.getTime() <= normalizeUtcDate(req.endDate).getTime(),
        );
        const timeOffDeducted = hasApprovedLeave ? afterHoliday : 0;
        const workingCapacityAfterLeave = Math.max(0, afterHoliday - timeOffDeducted);

        const activeDayAllocPct = staff.teamMemberships.reduce((acc, tm) => {
          if (tm.startDate && day.getTime() < normalizeUtcDate(tm.startDate).getTime()) {
            return acc;
          }
          if (tm.endDate && day.getTime() > normalizeUtcDate(tm.endDate).getTime()) {
            return acc;
          }
          return acc + tm.allocationPct;
        }, 0);

        const effectiveAllocPct = Math.min(100, Math.max(0, activeDayAllocPct));
        const allocatedMinutes = Math.round(
          (workingCapacityAfterLeave * effectiveAllocPct) / 100,
        );
        const netAvailableMinutes = Math.max(
          0,
          workingCapacityAfterLeave - allocatedMinutes,
        );

        scheduledTotal += baseMinutes;
        holidayDeductedTotal += holidayDeducted;
        timeOffDeductedTotal += timeOffDeducted;
        allocatedTotal += allocatedMinutes;
        netAvailableTotal += netAvailableMinutes;

        if (input.includeBreakdown) {
          daily.push({
            date: dayStr,
            scheduledMinutes: baseMinutes,
            holidayMinutesDeducted: holidayDeducted,
            timeOffMinutesDeducted: timeOffDeducted,
            allocatedMinutes,
            netAvailableMinutes,
            isWorkingDay: afterHoliday > 0 && timeOffDeducted === 0,
          });
        }
      }

      if (
        input.minTotalFreeMinutes !== undefined &&
        netAvailableTotal < input.minTotalFreeMinutes
      ) {
        continue;
      }

      poolScheduledMinutes += scheduledTotal;
      poolHolidayDeducted += holidayDeductedTotal;
      poolTimeOffDeducted += timeOffDeductedTotal;
      poolAllocatedMinutes += allocatedTotal;
      poolNetAvailableMinutes += netAvailableTotal;

      results.push({
        staffId: staff.id,
        displayName: staff.displayName,
        jobTitle: staff.jobTitle,
        workEmail: staff.workEmail,
        status: staff.status,
        timezone: staff.timezone,
        skills: staff.skills,
        department: staff.department,
        teams: staff.teamMemberships.map((tm) => ({
          teamId: tm.team.id,
          teamName: tm.team.name,
          teamSlug: tm.team.slug,
          kind: tm.team.kind,
          roleInTeam: tm.roleInTeam,
          allocationPct: tm.allocationPct,
        })),
        summary: {
          scheduledMinutes: scheduledTotal,
          holidayMinutesDeducted: holidayDeductedTotal,
          timeOffMinutesDeducted: timeOffDeductedTotal,
          allocatedMinutes: allocatedTotal,
          netAvailableMinutes: netAvailableTotal,
          netAvailableHours: Number((netAvailableTotal / 60).toFixed(2)),
        },
        ...(input.includeBreakdown ? { daily } : {}),
      });
    }

    results.sort(
      (a, b) => b.summary.netAvailableMinutes - a.summary.netAvailableMinutes,
    );

    return {
      organizationId: tenant.organizationId,
      window: {
        from: formatUtcDateString(fromDate),
        to: formatUtcDateString(toDate),
        days: dates.length,
      },
      totals: {
        staffCount: results.length,
        scheduledMinutes: poolScheduledMinutes,
        holidayMinutesDeducted: poolHolidayDeducted,
        timeOffMinutesDeducted: poolTimeOffDeducted,
        allocatedMinutes: poolAllocatedMinutes,
        netAvailableMinutes: poolNetAvailableMinutes,
        netAvailableHours: Number((poolNetAvailableMinutes / 60).toFixed(2)),
      },
      staff: results,
    };
  }

  async getCalendarEventsForOrganization(
    organizationId: string,
    input: QueryCalendarEventsInput,
  ): Promise<CalendarEventDto[]> {
    const fromDate = normalizeUtcDate(input.from);
    const toDate = normalizeUtcDate(input.to);
    const dates = enumerateUtcDates(fromDate, toDate, 220);

    const includeHolidays = input.includeHolidays ?? true;
    const includeTimeOff = input.includeTimeOff ?? true;
    const includeShifts = input.includeShifts ?? false;

    const events: CalendarEventDto[] = [];

    const staffWhere = {
      organizationId,
      status: { in: [StaffStatus.ACTIVE, StaffStatus.ON_LEAVE] },
      ...(input.scope === CalendarFeedScope.STAFF && input.staffId
        ? { id: input.staffId }
        : {}),
      ...(input.scope === CalendarFeedScope.TEAM && input.teamId
        ? {
            teamMemberships: {
              some: {
                teamId: input.teamId,
                isActive: true,
              },
            },
          }
        : {}),
    };

    const staffMembers = await this.prismaService.raw.staffProfile.findMany({
      where: staffWhere,
      include: { workSchedule: true },
      orderBy: { displayName: "asc" },
    });

    const staffIds = staffMembers.map((s) => s.id);
    const locationIds = Array.from(
      new Set(
        staffMembers
          .map((s) => s.locationId)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    if (includeHolidays) {
      const holidays = await this.prismaService.raw.holiday.findMany({
        where: {
          organizationId,
          ...(input.scope === CalendarFeedScope.STAFF && staffMembers.length === 1
            ? {
                OR: [
                  { locationId: null },
                  ...(locationIds.length > 0
                    ? [{ locationId: { in: locationIds } }]
                    : []),
                ],
              }
            : {}),
        },
        orderBy: { date: "asc" },
      });

      for (const h of holidays) {
        if (!h.isRecurringAnnual) {
          const d = normalizeUtcDate(h.date);
          if (d.getTime() >= fromDate.getTime() && d.getTime() <= toDate.getTime()) {
            const nextDay = new Date(d.getTime() + 24 * 60 * 60 * 1000);
            events.push({
              id: `holiday-${h.id}-${formatUtcDateString(d)}`,
              kind: "HOLIDAY",
              title: h.isHalfDay ? `${h.name} (Half Day)` : h.name,
              start: formatUtcDateString(d),
              end: formatUtcDateString(nextDay),
              allDay: true,
              timezone: "UTC",
              metadata: {
                holidayId: h.id,
                locationId: h.locationId,
                isHalfDay: h.isHalfDay,
              },
            });
          }
        } else {
          for (const d of dates) {
            if (
              d.getUTCMonth() === h.date.getUTCMonth() &&
              d.getUTCDate() === h.date.getUTCDate()
            ) {
              const nextDay = new Date(d.getTime() + 24 * 60 * 60 * 1000);
              events.push({
                id: `holiday-${h.id}-${formatUtcDateString(d)}`,
                kind: "HOLIDAY",
                title: h.isHalfDay ? `${h.name} (Half Day)` : h.name,
                start: formatUtcDateString(d),
                end: formatUtcDateString(nextDay),
                allDay: true,
                timezone: "UTC",
                metadata: {
                  holidayId: h.id,
                  locationId: h.locationId,
                  isHalfDay: h.isHalfDay,
                },
              });
            }
          }
        }
      }
    }

    if (includeTimeOff && staffIds.length > 0) {
      const leaves = await this.prismaService.raw.timeOffRequest.findMany({
        where: {
          organizationId,
          staffId: { in: staffIds },
          status: TimeOffStatus.APPROVED,
          startDate: { lte: toDate },
          endDate: { gte: fromDate },
        },
        include: {
          staff: { select: { id: true, displayName: true, timezone: true } },
        },
        orderBy: { startDate: "asc" },
      });

      for (const req of leaves) {
        const sDate = normalizeUtcDate(req.startDate);
        const eDateExclusive = new Date(
          normalizeUtcDate(req.endDate).getTime() + 24 * 60 * 60 * 1000,
        );
        events.push({
          id: `timeoff-${req.id}`,
          kind: "TIME_OFF",
          title: `${req.staff.displayName} - ${req.leaveType}`,
          start: formatUtcDateString(sDate),
          end: formatUtcDateString(eDateExclusive),
          allDay: true,
          timezone: req.staff.timezone,
          staffId: req.staffId,
          staffName: req.staff.displayName,
          metadata: {
            requestId: req.id,
            leaveType: req.leaveType,
            totalMinutes: req.totalMinutes,
          },
        });
      }
    }

    if (includeShifts && staffMembers.length > 0) {
      const defaultSched = await this.prismaService.raw.workSchedule.findFirst({
        where: { organizationId, isDefault: true, isActive: true },
      });
      const fallbackDays = normalizeWorkingDays(
        defaultSched?.workingDays ?? DEFAULT_WORKING_DAYS,
      );

      for (const staff of staffMembers) {
        const daysMap = staff.workSchedule
          ? normalizeWorkingDays(staff.workSchedule.workingDays)
          : fallbackDays;

        for (const d of dates) {
          const weekdayKey = WEEKDAY_KEYS[d.getUTCDay()] ?? "monday";
          const dayCfg = daysMap[weekdayKey];
          if (!dayCfg.enabled) {
            continue;
          }
          const dayStr = formatUtcDateString(d);
          events.push({
            id: `shift-${staff.id}-${dayStr}`,
            kind: "WORK_SHIFT",
            title: `${staff.displayName} (${dayCfg.start}-${dayCfg.end})`,
            start: `${dayStr}T${dayCfg.start}:00`,
            end: `${dayStr}T${dayCfg.end}:00`,
            allDay: false,
            timezone: staff.timezone,
            staffId: staff.id,
            staffName: staff.displayName,
            metadata: {
              breakMinutes: dayCfg.breakMinutes,
            },
          });
        }
      }
    }

    return events;
  }

  async getCalendarEvents(
    tenant: AuthenticatedOrganization,
    input: QueryCalendarEventsInput,
  ) {
    const events = await this.getCalendarEventsForOrganization(
      tenant.organizationId,
      input,
    );

    return {
      organizationId: tenant.organizationId,
      from: input.from,
      to: input.to,
      count: events.length,
      events,
    };
  }
}

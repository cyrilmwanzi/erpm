import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { CalendarFeedScope, type Prisma } from "@scace/db";
import { hasOrganizationPermission } from "../auth/permissions.js";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { AvailabilityService } from "./availability.service.js";
import { StaffService } from "./staff.service.js";
import {
  escapeIcalText,
  foldIcalLine,
  formatIcalDate,
  formatIcalDateTimeUtc,
  formatUtcDateString,
  generateCalendarToken,
  hashCalendarToken,
} from "./staff.utils.js";

export interface CreateCalendarFeedInput {
  name: string;
  scope: CalendarFeedScope;
  staffId?: string | null;
  teamId?: string | null;
  includeTimeOff?: boolean;
  includeHolidays?: boolean;
  includeShifts?: boolean;
}

@Injectable()
export class CalendarFeedService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(StaffService) private readonly staffService: StaffService,
    @Inject(AvailabilityService)
    private readonly availabilityService: AvailabilityService,
  ) {}

  private serializeFeed(feed: {
    id: string;
    organizationId: string;
    name: string;
    scope: CalendarFeedScope;
    staffId: string | null;
    teamId: string | null;
    includeTimeOff: boolean;
    includeHolidays: boolean;
    includeShifts: boolean;
    revokedAt: Date | null;
    lastAccessedAt: Date | null;
    createdByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: feed.id,
      organizationId: feed.organizationId,
      name: feed.name,
      scope: feed.scope,
      staffId: feed.staffId,
      teamId: feed.teamId,
      includeTimeOff: feed.includeTimeOff,
      includeHolidays: feed.includeHolidays,
      includeShifts: feed.includeShifts,
      revokedAt: feed.revokedAt,
      lastAccessedAt: feed.lastAccessedAt,
      createdByUserId: feed.createdByUserId,
      createdAt: feed.createdAt,
      updatedAt: feed.updatedAt,
    };
  }

  async createFeed(
    tenant: AuthenticatedOrganization,
    input: CreateCalendarFeedInput,
    ipAddress?: string,
  ) {
    const canManageAll = hasOrganizationPermission(tenant.role, {
      calendar: ["manage"],
    });

    let resolvedStaffId: string | null = null;
    let resolvedTeamId: string | null = null;

    if (input.scope === CalendarFeedScope.STAFF) {
      if (!input.staffId || input.staffId === "me") {
        const mine = await this.staffService.getOrCreateMyProfile(tenant);
        resolvedStaffId = mine.id;
      } else {
        if (!canManageAll) {
          const mine = await this.staffService.getOrCreateMyProfile(tenant);
          if (mine.id !== input.staffId) {
            throw new ForbiddenException(
              "Members can only create personal calendar feeds for their own staff profile.",
            );
          }
        }
        resolvedStaffId = input.staffId;
      }
    } else {
      if (!canManageAll) {
        throw new ForbiddenException(
          "Only managers, admins, or owners can create team or organization calendar feeds.",
        );
      }
      if (input.scope === CalendarFeedScope.TEAM) {
        if (!input.teamId) {
          throw new BadRequestException(
            "teamId is required when calendar feed scope is TEAM.",
          );
        }
        resolvedTeamId = input.teamId;
      }
    }

    const { rawToken, tokenHash } = generateCalendarToken();

    const created = await this.prismaService.raw.$transaction(async (tx) => {
      if (resolvedStaffId) {
        const staff = await tx.staffProfile.findFirst({
          where: { id: resolvedStaffId, organizationId: tenant.organizationId },
          select: { id: true },
        });
        if (!staff) {
          throw new NotFoundException("Staff profile not found.");
        }
      }

      if (resolvedTeamId) {
        const team = await tx.team.findFirst({
          where: { id: resolvedTeamId, organizationId: tenant.organizationId },
          select: { id: true },
        });
        if (!team) {
          throw new NotFoundException("Team not found.");
        }
      }

      const feed = await tx.calendarFeed.create({
        data: {
          organizationId: tenant.organizationId,
          name: input.name.trim(),
          scope: input.scope,
          staffId: resolvedStaffId,
          teamId: resolvedTeamId,
          tokenHash,
          includeTimeOff: input.includeTimeOff ?? true,
          includeHolidays: input.includeHolidays ?? true,
          includeShifts: input.includeShifts ?? false,
          createdByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "calendar.feed.created",
          resourceType: "CalendarFeed",
          resourceId: feed.id,
          metadata: {
            scope: feed.scope,
            staffId: feed.staffId,
            teamId: feed.teamId,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return feed;
    });

    return {
      feed: this.serializeFeed(created),
      token: rawToken,
      icalPath: `/api/v1/calendar/ical?token=${encodeURIComponent(rawToken)}`,
    };
  }

  async listFeeds(tenant: AuthenticatedOrganization) {
    const canManageAll = hasOrganizationPermission(tenant.role, {
      calendar: ["manage"],
    });

    const mine = canManageAll
      ? null
      : await this.staffService.getOrCreateMyProfile(tenant);

    const rows = await this.prismaService.scoped.calendarFeed.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(canManageAll ? {} : { staffId: mine?.id ?? "__none__" }),
      },
      orderBy: { createdAt: "desc" },
    });

    return {
      organizationId: tenant.organizationId,
      items: rows.map((row) => this.serializeFeed(row)),
    };
  }

  async rotateFeedToken(
    tenant: AuthenticatedOrganization,
    feedId: string,
    ipAddress?: string,
  ) {
    const canManageAll = hasOrganizationPermission(tenant.role, {
      calendar: ["manage"],
    });
    const mine = canManageAll
      ? null
      : await this.staffService.getOrCreateMyProfile(tenant);

    const { rawToken, tokenHash } = generateCalendarToken();

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.calendarFeed.findFirst({
        where: { id: feedId, organizationId: tenant.organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Calendar feed not found.");
      }
      if (!canManageAll && existing.staffId !== mine?.id) {
        throw new ForbiddenException(
          "You can only rotate tokens for your own calendar feeds.",
        );
      }

      const saved = await tx.calendarFeed.update({
        where: { id: existing.id },
        data: {
          tokenHash,
          revokedAt: null,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "calendar.feed.rotated",
          resourceType: "CalendarFeed",
          resourceId: saved.id,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });

    return {
      feed: this.serializeFeed(updated),
      token: rawToken,
      icalPath: `/api/v1/calendar/ical?token=${encodeURIComponent(rawToken)}`,
    };
  }

  async revokeFeed(
    tenant: AuthenticatedOrganization,
    feedId: string,
    ipAddress?: string,
  ) {
    const canManageAll = hasOrganizationPermission(tenant.role, {
      calendar: ["manage"],
    });
    const mine = canManageAll
      ? null
      : await this.staffService.getOrCreateMyProfile(tenant);

    const revoked = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.calendarFeed.findFirst({
        where: { id: feedId, organizationId: tenant.organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Calendar feed not found.");
      }
      if (!canManageAll && existing.staffId !== mine?.id) {
        throw new ForbiddenException(
          "You can only revoke your own calendar feeds.",
        );
      }

      const saved = await tx.calendarFeed.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "calendar.feed.revoked",
          resourceType: "CalendarFeed",
          resourceId: saved.id,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });

    return this.serializeFeed(revoked);
  }

  async renderIcalByToken(rawToken: string): Promise<string> {
    const cleanedToken = rawToken.trim();
    if (cleanedToken.length < 16) {
      throw new NotFoundException("Calendar feed not found.");
    }

    const tokenHash = hashCalendarToken(cleanedToken);
    const feed = await this.prismaService.raw.calendarFeed.findUnique({
      where: { tokenHash },
      include: {
        organization: { select: { name: true } },
      },
    });

    if (!feed || feed.revokedAt !== null) {
      throw new NotFoundException("Calendar feed not found or revoked.");
    }

    await this.prismaService.raw.calendarFeed
      .update({
        where: { id: feed.id },
        data: { lastAccessedAt: new Date() },
      })
      .catch(() => undefined);

    const now = new Date();
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const to = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);

    const events = await this.availabilityService.getCalendarEventsForOrganization(
      feed.organizationId,
      {
        from: formatUtcDateString(from),
        to: formatUtcDateString(to),
        scope: feed.scope,
        staffId: feed.staffId ?? undefined,
        teamId: feed.teamId ?? undefined,
        includeTimeOff: feed.includeTimeOff,
        includeHolidays: feed.includeHolidays,
        includeShifts: feed.includeShifts,
      },
    );

    const calName = `${feed.organization?.name ?? "Scace"} - ${feed.name}`;
    const dtStamp = formatIcalDateTimeUtc(now);

    const lines: string[] = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Scace//Staff Calendar 1.0//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      foldIcalLine(`X-WR-CALNAME:${escapeIcalText(calName)}`),
    ];

    for (const ev of events) {
      lines.push("BEGIN:VEVENT");
      lines.push(foldIcalLine(`UID:${escapeIcalText(ev.id)}@scace.local`));
      lines.push(`DTSTAMP:${dtStamp}`);

      if (ev.allDay) {
        lines.push(`DTSTART;VALUE=DATE:${formatIcalDate(new Date(`${ev.start}T00:00:00Z`))}`);
        lines.push(`DTEND;VALUE=DATE:${formatIcalDate(new Date(`${ev.end}T00:00:00Z`))}`);
      } else {
        const startCompact = ev.start.replace(/[-:]/g, "");
        const endCompact = ev.end.replace(/[-:]/g, "");
        lines.push(foldIcalLine(`DTSTART;TZID=${escapeIcalText(ev.timezone)}:${startCompact}`));
        lines.push(foldIcalLine(`DTEND;TZID=${escapeIcalText(ev.timezone)}:${endCompact}`));
      }

      lines.push(foldIcalLine(`SUMMARY:${escapeIcalText(ev.title)}`));
      lines.push(foldIcalLine(`CATEGORIES:${escapeIcalText(ev.kind)}`));
      lines.push("END:VEVENT");
    }

    lines.push("END:VCALENDAR", "");
    return lines.join("\r\n");
  }
}

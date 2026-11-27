import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  DepartmentStatus,
  EmploymentType,
  LocationStatus,
  Prisma,
  StaffStatus,
} from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import {
  assertNoHierarchyCycle,
  DEFAULT_WORKING_DAYS,
  isValidTimeZone,
  normalizeUtcDate,
} from "./staff.utils.js";

export interface CreateStaffInput {
  memberId?: string | null;
  employeeCode?: string | null;
  firstName: string;
  lastName: string;
  displayName?: string;
  workEmail: string;
  phone?: string | null;
  jobTitle?: string | null;
  departmentId?: string | null;
  managerStaffId?: string | null;
  locationId?: string | null;
  workScheduleId?: string | null;
  employmentType?: EmploymentType;
  status?: StaffStatus;
  startDate?: string | null;
  endDate?: string | null;
  timezone?: string;
  weeklyCapacityMinutes?: number;
  skills?: string[];
  bio?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateStaffInput {
  memberId?: string | null;
  employeeCode?: string | null;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  workEmail?: string;
  phone?: string | null;
  jobTitle?: string | null;
  departmentId?: string | null;
  managerStaffId?: string | null;
  locationId?: string | null;
  workScheduleId?: string | null;
  employmentType?: EmploymentType;
  status?: StaffStatus;
  startDate?: string | null;
  endDate?: string | null;
  timezone?: string;
  weeklyCapacityMinutes?: number;
  skills?: string[];
  bio?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface SelfUpdateStaffInput {
  displayName?: string;
  phone?: string | null;
  timezone?: string;
  skills?: string[];
  bio?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ListStaffQuery {
  status?: StaffStatus;
  departmentId?: string;
  managerStaffId?: string;
  employmentType?: EmploymentType;
  skill?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface OrgChartNode {
  id: string;
  displayName: string;
  jobTitle: string | null;
  workEmail: string;
  status: StaffStatus;
  departmentId: string | null;
  managerStaffId: string | null;
  directReports: OrgChartNode[];
}

function normalizeSkills(skills: string[] | undefined): string[] {
  if (!skills) {
    return [];
  }
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const s of skills) {
    const trimmed = s.trim();
    if (trimmed.length > 0 && !seen.has(trimmed.toLowerCase())) {
      seen.add(trimmed.toLowerCase());
      clean.push(trimmed.slice(0, 64));
    }
  }
  return clean;
}

function toNullableJson(
  value: Record<string, unknown> | null | undefined,
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return Prisma.DbNull;
  }
  return value as Prisma.InputJsonValue;
}

@Injectable()
export class StaffService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private async ensureDefaultWorkSchedule(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<{ id: string; weeklyCapacityMinutes: number; timezone: string }> {
    const existing = await tx.workSchedule.findFirst({
      where: { organizationId, isDefault: true, isActive: true },
      select: { id: true, weeklyCapacityMinutes: true, timezone: true },
    });
    if (existing) {
      return existing;
    }

    const created = await tx.workSchedule.create({
      data: {
        organizationId,
        name: "Standard 40h Week",
        timezone: "UTC",
        weeklyCapacityMinutes: 2400,
        workingDays: DEFAULT_WORKING_DAYS as unknown as Prisma.InputJsonValue,
        isDefault: true,
        isActive: true,
      },
      select: { id: true, weeklyCapacityMinutes: true, timezone: true },
    });

    return created;
  }

  private async verifyReferences(
    tx: Prisma.TransactionClient,
    organizationId: string,
    refs: {
      memberId?: string | null;
      departmentId?: string | null;
      managerStaffId?: string | null;
      locationId?: string | null;
      workScheduleId?: string | null;
      excludeStaffId?: string;
    },
  ): Promise<{ scheduleCapacityMinutes?: number }> {
    if (refs.memberId) {
      const member = await tx.member.findFirst({
        where: { id: refs.memberId, organizationId },
        select: { id: true },
      });
      if (!member) {
        throw new NotFoundException(
          `Organization member (${refs.memberId}) was not found in the active organization.`,
        );
      }
      const existingLinked = await tx.staffProfile.findFirst({
        where: {
          organizationId,
          memberId: refs.memberId,
          ...(refs.excludeStaffId ? { id: { not: refs.excludeStaffId } } : {}),
        },
        select: { id: true },
      });
      if (existingLinked) {
        throw new ConflictException(
          "This organization member is already linked to another staff profile.",
        );
      }
    }

    if (refs.departmentId) {
      const dept = await tx.department.findFirst({
        where: { id: refs.departmentId, organizationId },
        select: { id: true, status: true },
      });
      if (!dept) {
        throw new NotFoundException(
          `Department (${refs.departmentId}) was not found in the active organization.`,
        );
      }
      if (dept.status === DepartmentStatus.ARCHIVED) {
        throw new BadRequestException(
          "Cannot assign staff to an archived department.",
        );
      }
    }

    if (refs.managerStaffId) {
      const manager = await tx.staffProfile.findFirst({
        where: { id: refs.managerStaffId, organizationId },
        select: { id: true, status: true },
      });
      if (!manager) {
        throw new NotFoundException(
          `Manager staff profile (${refs.managerStaffId}) was not found in the active organization.`,
        );
      }
      if (manager.status === StaffStatus.OFFBOARDED) {
        throw new BadRequestException(
          "Cannot assign an offboarded staff member as manager.",
        );
      }
    }

    if (refs.locationId) {
      const loc = await tx.location.findFirst({
        where: { id: refs.locationId, organizationId },
        select: { id: true, status: true },
      });
      if (!loc) {
        throw new NotFoundException(
          `Location (${refs.locationId}) was not found in the active organization.`,
        );
      }
      if (loc.status === LocationStatus.ARCHIVED) {
        throw new BadRequestException(
          "Cannot assign staff to an archived location.",
        );
      }
    }

    if (refs.workScheduleId) {
      const schedule = await tx.workSchedule.findFirst({
        where: { id: refs.workScheduleId, organizationId, isActive: true },
        select: { id: true, weeklyCapacityMinutes: true },
      });
      if (!schedule) {
        throw new NotFoundException(
          `Active work schedule (${refs.workScheduleId}) was not found in the active organization.`,
        );
      }
      return { scheduleCapacityMinutes: schedule.weeklyCapacityMinutes };
    }

    return {};
  }

  async createStaff(
    tenant: AuthenticatedOrganization,
    input: CreateStaffInput,
    ipAddress?: string,
  ) {
    const workEmail = input.workEmail.trim().toLowerCase();
    const timezone = input.timezone?.trim() || "UTC";
    if (!isValidTimeZone(timezone)) {
      throw new BadRequestException(`Invalid IANA timezone: ${timezone}`);
    }

    const employeeCode = input.employeeCode?.trim().toUpperCase() || null;
    const startDate = input.startDate ? normalizeUtcDate(input.startDate) : null;
    const endDate = input.endDate ? normalizeUtcDate(input.endDate) : null;
    if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
      throw new BadRequestException("endDate cannot precede startDate.");
    }

    return this.prismaService.raw.$transaction(async (tx) => {
      const dupEmail = await tx.staffProfile.findFirst({
        where: { organizationId: tenant.organizationId, workEmail },
        select: { id: true },
      });
      if (dupEmail) {
        throw new ConflictException(
          `A staff profile with email "${workEmail}" already exists in this organization.`,
        );
      }

      if (employeeCode) {
        const dupCode = await tx.staffProfile.findFirst({
          where: { organizationId: tenant.organizationId, employeeCode },
          select: { id: true },
        });
        if (dupCode) {
          throw new ConflictException(
            `Employee code "${employeeCode}" already exists in this organization.`,
          );
        }
      }

      const refMeta = await this.verifyReferences(tx, tenant.organizationId, {
        memberId: input.memberId,
        departmentId: input.departmentId,
        managerStaffId: input.managerStaffId,
        locationId: input.locationId,
        workScheduleId: input.workScheduleId,
      });

      const defaultSchedule = input.workScheduleId
        ? null
        : await this.ensureDefaultWorkSchedule(tx, tenant.organizationId);

      const resolvedStatus =
        input.status ??
        (input.memberId ? StaffStatus.ACTIVE : StaffStatus.PREBOARDING);

      const firstName = input.firstName.trim();
      const lastName = input.lastName.trim();
      const displayName =
        input.displayName?.trim() || `${firstName} ${lastName}`.trim();

      const created = await tx.staffProfile.create({
        data: {
          organizationId: tenant.organizationId,
          memberId: input.memberId ?? null,
          employeeCode,
          firstName,
          lastName,
          displayName,
          workEmail,
          phone: input.phone ?? null,
          jobTitle: input.jobTitle ?? null,
          departmentId: input.departmentId ?? null,
          managerStaffId: input.managerStaffId ?? null,
          locationId: input.locationId ?? null,
          workScheduleId: input.workScheduleId ?? defaultSchedule?.id ?? null,
          employmentType: input.employmentType ?? EmploymentType.FULL_TIME,
          status: resolvedStatus,
          startDate,
          endDate,
          timezone,
          weeklyCapacityMinutes:
            input.weeklyCapacityMinutes ??
            refMeta.scheduleCapacityMinutes ??
            defaultSchedule?.weeklyCapacityMinutes ??
            2400,
          skills: normalizeSkills(input.skills),
          bio: input.bio ?? null,
          metadata: toNullableJson(input.metadata),
          createdByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
        },
        include: {
          department: { select: { id: true, name: true, code: true } },
          manager: {
            select: { id: true, displayName: true, jobTitle: true, workEmail: true },
          },
          workSchedule: {
            select: { id: true, name: true, timezone: true, weeklyCapacityMinutes: true },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "staff.created",
          resourceType: "StaffProfile",
          resourceId: created.id,
          metadata: {
            workEmail: created.workEmail,
            status: created.status,
            memberId: created.memberId,
            departmentId: created.departmentId,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return created;
    });
  }

  async syncMembersToStaff(tenant: AuthenticatedOrganization, ipAddress?: string) {
    return this.prismaService.raw.$transaction(async (tx) => {
      const members = await tx.member.findMany({
        where: { organizationId: tenant.organizationId },
        include: {
          user: { select: { id: true, name: true, email: true } },
          staffProfile: { select: { id: true } },
        },
      });

      const defaultSchedule = await this.ensureDefaultWorkSchedule(
        tx,
        tenant.organizationId,
      );

      let linkedCount = 0;
      let createdCount = 0;

      for (const m of members) {
        if (m.staffProfile) {
          continue;
        }
        const email = m.user.email.trim().toLowerCase();
        const existingByEmail = await tx.staffProfile.findFirst({
          where: { organizationId: tenant.organizationId, workEmail: email },
          select: { id: true, memberId: true, status: true },
        });

        if (existingByEmail) {
          if (!existingByEmail.memberId) {
            await tx.staffProfile.update({
              where: { id: existingByEmail.id },
              data: {
                memberId: m.id,
                status:
                  existingByEmail.status === StaffStatus.PREBOARDING
                    ? StaffStatus.ACTIVE
                    : existingByEmail.status,
                updatedByUserId: tenant.userId,
              },
            });
            linkedCount += 1;
          }
          continue;
        }

        const parts = (m.user.name || email.split("@")[0] || "Staff")
          .trim()
          .split(/\s+/);
        const firstName = parts[0] ?? "Staff";
        const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "-";

        await tx.staffProfile.create({
          data: {
            organizationId: tenant.organizationId,
            memberId: m.id,
            firstName,
            lastName,
            displayName: m.user.name?.trim() || firstName,
            workEmail: email,
            workScheduleId: defaultSchedule.id,
            weeklyCapacityMinutes: defaultSchedule.weeklyCapacityMinutes,
            timezone: defaultSchedule.timezone,
            status: StaffStatus.ACTIVE,
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
          },
        });
        createdCount += 1;
      }

      if (linkedCount > 0 || createdCount > 0) {
        await tx.auditLog.create({
          data: {
            organizationId: tenant.organizationId,
            actorUserId: tenant.userId,
            action: "staff.members.synced",
            resourceType: "StaffProfile",
            metadata: { linkedCount, createdCount } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });
      }

      return {
        organizationId: tenant.organizationId,
        totalMembers: members.length,
        linkedCount,
        createdCount,
      };
    });
  }

  async listStaff(tenant: AuthenticatedOrganization, query: ListStaffQuery) {
    const take = Math.min(Math.max(query.limit, 1), 100);
    const where: Prisma.StaffProfileWhereInput = {
      organizationId: tenant.organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.managerStaffId ? { managerStaffId: query.managerStaffId } : {}),
      ...(query.employmentType ? { employmentType: query.employmentType } : {}),
      ...(query.skill ? { skills: { has: query.skill } } : {}),
      ...(query.search
        ? {
            OR: [
              { displayName: { contains: query.search, mode: "insensitive" } },
              { workEmail: { contains: query.search, mode: "insensitive" } },
              { jobTitle: { contains: query.search, mode: "insensitive" } },
              { employeeCode: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const records = await this.prismaService.scoped.staffProfile.findMany({
      where,
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      include: {
        department: { select: { id: true, name: true, code: true } },
        manager: {
          select: { id: true, displayName: true, jobTitle: true },
        },
        workSchedule: {
          select: { id: true, name: true, timezone: true, weeklyCapacityMinutes: true },
        },
        member: {
          select: { id: true, role: true, userId: true },
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

  async getStaffById(tenant: AuthenticatedOrganization, staffId: string) {
    const staff = await this.prismaService.scoped.staffProfile.findFirst({
      where: { id: staffId, organizationId: tenant.organizationId },
      include: {
        department: { select: { id: true, name: true, code: true } },
        manager: {
          select: { id: true, displayName: true, jobTitle: true, workEmail: true },
        },
        directReports: {
          where: { status: { not: StaffStatus.OFFBOARDED } },
          select: { id: true, displayName: true, jobTitle: true, status: true },
        },
        location: { select: { id: true, code: true, name: true, timezone: true } },
        workSchedule: true,
        member: { select: { id: true, role: true, userId: true } },
        teamMemberships: {
          where: { isActive: true },
          include: {
            team: { select: { id: true, name: true, slug: true, kind: true } },
          },
        },
      },
    });

    if (!staff) {
      throw new NotFoundException("Staff profile not found.");
    }

    return staff;
  }

  async getOrCreateMyProfile(tenant: AuthenticatedOrganization) {
    const existing = await this.prismaService.scoped.staffProfile.findFirst({
      where: {
        organizationId: tenant.organizationId,
        memberId: tenant.memberId,
      },
      include: {
        department: { select: { id: true, name: true, code: true } },
        manager: {
          select: { id: true, displayName: true, jobTitle: true, workEmail: true },
        },
        workSchedule: true,
        teamMemberships: {
          where: { isActive: true },
          include: {
            team: { select: { id: true, name: true, slug: true, kind: true } },
          },
        },
      },
    });

    if (existing) {
      return existing;
    }

    return this.prismaService.raw.$transaction(async (tx) => {
      const member = await tx.member.findFirst({
        where: { id: tenant.memberId, organizationId: tenant.organizationId },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      if (!member) {
        throw new NotFoundException("Active organization membership not found.");
      }

      const email = member.user.email.trim().toLowerCase();
      const byEmail = await tx.staffProfile.findFirst({
        where: { organizationId: tenant.organizationId, workEmail: email },
      });

      if (byEmail) {
        return tx.staffProfile.update({
          where: { id: byEmail.id },
          data: {
            memberId: member.id,
            status:
              byEmail.status === StaffStatus.PREBOARDING
                ? StaffStatus.ACTIVE
                : byEmail.status,
          },
          include: {
            department: { select: { id: true, name: true, code: true } },
            manager: {
              select: { id: true, displayName: true, jobTitle: true, workEmail: true },
            },
            workSchedule: true,
          },
        });
      }

      const defaultSchedule = await this.ensureDefaultWorkSchedule(
        tx,
        tenant.organizationId,
      );
      const parts = (member.user.name || email.split("@")[0] || "Staff")
        .trim()
        .split(/\s+/);
      const firstName = parts[0] ?? "Staff";
      const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "-";

      return tx.staffProfile.create({
        data: {
          organizationId: tenant.organizationId,
          memberId: member.id,
          firstName,
          lastName,
          displayName: member.user.name?.trim() || firstName,
          workEmail: email,
          workScheduleId: defaultSchedule.id,
          weeklyCapacityMinutes: defaultSchedule.weeklyCapacityMinutes,
          timezone: defaultSchedule.timezone,
          status: StaffStatus.ACTIVE,
          createdByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
        },
        include: {
          department: { select: { id: true, name: true, code: true } },
          manager: {
            select: { id: true, displayName: true, jobTitle: true, workEmail: true },
          },
          workSchedule: true,
        },
      });
    });
  }

  async updateMyProfile(
    tenant: AuthenticatedOrganization,
    input: SelfUpdateStaffInput,
    ipAddress?: string,
  ) {
    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
      throw new BadRequestException(`Invalid IANA timezone: ${input.timezone}`);
    }

    const mine = await this.getOrCreateMyProfile(tenant);

    return this.prismaService.raw.$transaction(async (tx) => {
      const updated = await tx.staffProfile.update({
        where: { id: mine.id },
        data: {
          ...(input.displayName !== undefined
            ? { displayName: input.displayName.trim() }
            : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.timezone !== undefined
            ? { timezone: input.timezone.trim() }
            : {}),
          ...(input.skills !== undefined
            ? { skills: normalizeSkills(input.skills) }
            : {}),
          ...(input.bio !== undefined ? { bio: input.bio } : {}),
          ...(input.metadata !== undefined
            ? { metadata: toNullableJson(input.metadata) }
            : {}),
          updatedByUserId: tenant.userId,
        },
        include: {
          department: { select: { id: true, name: true, code: true } },
          manager: {
            select: { id: true, displayName: true, jobTitle: true, workEmail: true },
          },
          workSchedule: true,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "staff.self.updated",
          resourceType: "StaffProfile",
          resourceId: updated.id,
          metadata: {
            fields: Object.keys(input),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async updateStaff(
    tenant: AuthenticatedOrganization,
    staffId: string,
    input: UpdateStaffInput,
    ipAddress?: string,
  ) {
    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
      throw new BadRequestException(`Invalid IANA timezone: ${input.timezone}`);
    }

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.staffProfile.findFirst({
        where: { id: staffId, organizationId: tenant.organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Staff profile not found.");
      }

      const nextEmail = input.workEmail?.trim().toLowerCase();
      if (nextEmail && nextEmail !== existing.workEmail) {
        const dup = await tx.staffProfile.findFirst({
          where: {
            organizationId: tenant.organizationId,
            workEmail: nextEmail,
            id: { not: existing.id },
          },
          select: { id: true },
        });
        if (dup) {
          throw new ConflictException(
            `Work email "${nextEmail}" is already assigned to another staff profile.`,
          );
        }
      }

      const nextCode =
        input.employeeCode !== undefined
          ? input.employeeCode?.trim().toUpperCase() || null
          : undefined;
      if (nextCode && nextCode !== existing.employeeCode) {
        const dupCode = await tx.staffProfile.findFirst({
          where: {
            organizationId: tenant.organizationId,
            employeeCode: nextCode,
            id: { not: existing.id },
          },
          select: { id: true },
        });
        if (dupCode) {
          throw new ConflictException(
            `Employee code "${nextCode}" is already assigned to another staff profile.`,
          );
        }
      }

      await this.verifyReferences(tx, tenant.organizationId, {
        memberId: input.memberId ?? undefined,
        departmentId: input.departmentId ?? undefined,
        managerStaffId: input.managerStaffId ?? undefined,
        locationId: input.locationId ?? undefined,
        workScheduleId: input.workScheduleId ?? undefined,
        excludeStaffId: existing.id,
      });

      if (input.managerStaffId !== undefined && input.managerStaffId !== null) {
        await assertNoHierarchyCycle(
          existing.id,
          input.managerStaffId,
          async (id) => {
            const node = await tx.staffProfile.findFirst({
              where: { id, organizationId: tenant.organizationId },
              select: { managerStaffId: true },
            });
            return node?.managerStaffId ?? null;
          },
          "Staff reporting",
        );
      }

      const nextStartDate =
        input.startDate !== undefined
          ? input.startDate
            ? normalizeUtcDate(input.startDate)
            : null
          : existing.startDate;
      const nextEndDate =
        input.endDate !== undefined
          ? input.endDate
            ? normalizeUtcDate(input.endDate)
            : null
          : existing.endDate;

      if (
        nextStartDate &&
        nextEndDate &&
        nextEndDate.getTime() < nextStartDate.getTime()
      ) {
        throw new BadRequestException("endDate cannot precede startDate.");
      }

      const updated = await tx.staffProfile.update({
        where: { id: existing.id },
        data: {
          ...(input.memberId !== undefined ? { memberId: input.memberId } : {}),
          ...(nextCode !== undefined ? { employeeCode: nextCode } : {}),
          ...(input.firstName !== undefined
            ? { firstName: input.firstName.trim() }
            : {}),
          ...(input.lastName !== undefined
            ? { lastName: input.lastName.trim() }
            : {}),
          ...(input.displayName !== undefined
            ? { displayName: input.displayName.trim() }
            : {}),
          ...(nextEmail !== undefined ? { workEmail: nextEmail } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.jobTitle !== undefined ? { jobTitle: input.jobTitle } : {}),
          ...(input.departmentId !== undefined
            ? { departmentId: input.departmentId }
            : {}),
          ...(input.managerStaffId !== undefined
            ? { managerStaffId: input.managerStaffId }
            : {}),
          ...(input.locationId !== undefined
            ? { locationId: input.locationId }
            : {}),
          ...(input.workScheduleId !== undefined
            ? { workScheduleId: input.workScheduleId }
            : {}),
          ...(input.employmentType !== undefined
            ? { employmentType: input.employmentType }
            : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.startDate !== undefined ? { startDate: nextStartDate } : {}),
          ...(input.endDate !== undefined ? { endDate: nextEndDate } : {}),
          ...(input.timezone !== undefined
            ? { timezone: input.timezone.trim() }
            : {}),
          ...(input.weeklyCapacityMinutes !== undefined
            ? { weeklyCapacityMinutes: input.weeklyCapacityMinutes }
            : {}),
          ...(input.skills !== undefined
            ? { skills: normalizeSkills(input.skills) }
            : {}),
          ...(input.bio !== undefined ? { bio: input.bio } : {}),
          ...(input.metadata !== undefined
            ? { metadata: toNullableJson(input.metadata) }
            : {}),
          updatedByUserId: tenant.userId,
        },
        include: {
          department: { select: { id: true, name: true, code: true } },
          manager: {
            select: { id: true, displayName: true, jobTitle: true, workEmail: true },
          },
          workSchedule: {
            select: { id: true, name: true, timezone: true, weeklyCapacityMinutes: true },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "staff.updated",
          resourceType: "StaffProfile",
          resourceId: updated.id,
          metadata: {
            status: updated.status,
            departmentId: updated.departmentId,
            managerStaffId: updated.managerStaffId,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async offboardStaff(
    tenant: AuthenticatedOrganization,
    staffId: string,
    endDate?: string,
    reason?: string,
    ipAddress?: string,
  ) {
    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.staffProfile.findFirst({
        where: { id: staffId, organizationId: tenant.organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Staff profile not found.");
      }

      const offboarded = await tx.staffProfile.update({
        where: { id: existing.id },
        data: {
          status: StaffStatus.OFFBOARDED,
          offboardedAt: new Date(),
          ...(endDate ? { endDate: normalizeUtcDate(endDate) } : {}),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.teamMember.updateMany({
        where: {
          organizationId: tenant.organizationId,
          staffId: existing.id,
          isActive: true,
        },
        data: {
          isActive: false,
          endDate: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "staff.offboarded",
          resourceType: "StaffProfile",
          resourceId: offboarded.id,
          metadata: {
            reason: reason ?? null,
            endDate: offboarded.endDate?.toISOString() ?? null,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return offboarded;
    });
  }

  async getOrgChart(tenant: AuthenticatedOrganization) {
    const rows = await this.prismaService.scoped.staffProfile.findMany({
      where: {
        organizationId: tenant.organizationId,
        status: { not: StaffStatus.OFFBOARDED },
      },
      orderBy: { displayName: "asc" },
      select: {
        id: true,
        displayName: true,
        jobTitle: true,
        workEmail: true,
        status: true,
        departmentId: true,
        managerStaffId: true,
      },
    });

    const map = new Map<string, OrgChartNode>();
    for (const row of rows) {
      map.set(row.id, { ...row, directReports: [] });
    }

    const roots: OrgChartNode[] = [];
    for (const node of map.values()) {
      if (node.managerStaffId && map.has(node.managerStaffId)) {
        map.get(node.managerStaffId)?.directReports.push(node);
      } else {
        roots.push(node);
      }
    }

    return {
      organizationId: tenant.organizationId,
      roots,
    };
  }
}

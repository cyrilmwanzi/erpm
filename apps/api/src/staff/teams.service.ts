import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  DepartmentStatus,
  Prisma,
  StaffStatus,
  TeamKind,
  TeamStatus,
} from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { normalizeUtcDate } from "./staff.utils.js";

export interface CreateTeamInput {
  name: string;
  slug: string;
  description?: string | null;
  kind?: TeamKind;
  departmentId?: string | null;
  leadStaffId?: string | null;
  defaultAllocationPct?: number;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateTeamInput {
  name?: string;
  slug?: string;
  description?: string | null;
  kind?: TeamKind;
  departmentId?: string | null;
  leadStaffId?: string | null;
  defaultAllocationPct?: number;
  metadata?: Record<string, unknown> | null;
}

export interface ListTeamsQuery {
  kind?: TeamKind;
  status?: TeamStatus;
  departmentId?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface UpsertTeamMemberInput {
  staffId: string;
  roleInTeam?: string;
  allocationPct?: number;
  startDate?: string | null;
  endDate?: string | null;
  isActive?: boolean;
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
export class TeamsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private normalizeSlug(slug: string): string {
    return slug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private async verifyTeamRefs(
    tx: Prisma.TransactionClient,
    organizationId: string,
    departmentId?: string | null,
    leadStaffId?: string | null,
  ): Promise<void> {
    if (departmentId) {
      const dept = await tx.department.findFirst({
        where: { id: departmentId, organizationId },
        select: { id: true, status: true },
      });
      if (!dept) {
        throw new NotFoundException(
          `Department (${departmentId}) was not found in the active organization.`,
        );
      }
      if (dept.status === DepartmentStatus.ARCHIVED) {
        throw new BadRequestException("Cannot link team to an archived department.");
      }
    }

    if (leadStaffId) {
      const staff = await tx.staffProfile.findFirst({
        where: { id: leadStaffId, organizationId },
        select: { id: true, status: true },
      });
      if (!staff) {
        throw new NotFoundException(
          `Lead staff profile (${leadStaffId}) was not found in the active organization.`,
        );
      }
      if (staff.status === StaffStatus.OFFBOARDED) {
        throw new BadRequestException("Cannot assign an offboarded staff member as team lead.");
      }
    }
  }

  async createTeam(
    tenant: AuthenticatedOrganization,
    input: CreateTeamInput,
    ipAddress?: string,
  ) {
    const slug = this.normalizeSlug(input.slug);
    if (slug.length < 2) {
      throw new BadRequestException("Team slug must contain at least 2 alphanumeric characters.");
    }

    return this.prismaService.raw.$transaction(async (tx) => {
      const dup = await tx.team.findFirst({
        where: { organizationId: tenant.organizationId, slug },
        select: { id: true },
      });
      if (dup) {
        throw new ConflictException(`Team slug "${slug}" already exists in this organization.`);
      }

      await this.verifyTeamRefs(
        tx,
        tenant.organizationId,
        input.departmentId,
        input.leadStaffId,
      );

      const created = await tx.team.create({
        data: {
          organizationId: tenant.organizationId,
          name: input.name.trim(),
          slug,
          description: input.description ?? null,
          kind: input.kind ?? TeamKind.PROJECT,
          status: TeamStatus.ACTIVE,
          departmentId: input.departmentId ?? null,
          leadStaffId: input.leadStaffId ?? null,
          defaultAllocationPct: input.defaultAllocationPct ?? 100,
          metadata: toNullableJson(input.metadata),
          createdByUserId: tenant.userId,
        },
        include: {
          department: { select: { id: true, name: true, code: true } },
          leadStaff: { select: { id: true, displayName: true, jobTitle: true } },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "team.created",
          resourceType: "Team",
          resourceId: created.id,
          metadata: {
            slug: created.slug,
            kind: created.kind,
            departmentId: created.departmentId,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return created;
    });
  }

  async listTeams(tenant: AuthenticatedOrganization, query: ListTeamsQuery) {
    const take = Math.min(Math.max(query.limit, 1), 100);
    const where: Prisma.TeamWhereInput = {
      organizationId: tenant.organizationId,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" } },
              { slug: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const records = await this.prismaService.scoped.team.findMany({
      where,
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ name: "asc" }, { id: "asc" }],
      include: {
        department: { select: { id: true, name: true, code: true } },
        leadStaff: { select: { id: true, displayName: true, jobTitle: true } },
        _count: { select: { members: true } },
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

  async getTeam(tenant: AuthenticatedOrganization, teamId: string) {
    const team = await this.prismaService.scoped.team.findFirst({
      where: { id: teamId, organizationId: tenant.organizationId },
      include: {
        department: { select: { id: true, name: true, code: true } },
        leadStaff: {
          select: { id: true, displayName: true, jobTitle: true, workEmail: true },
        },
        members: {
          orderBy: { createdAt: "asc" },
          include: {
            staff: {
              select: {
                id: true,
                displayName: true,
                jobTitle: true,
                workEmail: true,
                status: true,
                timezone: true,
                weeklyCapacityMinutes: true,
                skills: true,
              },
            },
          },
        },
      },
    });

    if (!team) {
      throw new NotFoundException("Team not found.");
    }

    return team;
  }

  async updateTeam(
    tenant: AuthenticatedOrganization,
    teamId: string,
    input: UpdateTeamInput,
    ipAddress?: string,
  ) {
    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.team.findFirst({
        where: { id: teamId, organizationId: tenant.organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Team not found.");
      }

      const nextSlug =
        input.slug !== undefined ? this.normalizeSlug(input.slug) : undefined;
      if (nextSlug !== undefined) {
        if (nextSlug.length < 2) {
          throw new BadRequestException("Team slug must contain at least 2 characters.");
        }
        if (nextSlug !== existing.slug) {
          const dup = await tx.team.findFirst({
            where: {
              organizationId: tenant.organizationId,
              slug: nextSlug,
              id: { not: existing.id },
            },
            select: { id: true },
          });
          if (dup) {
            throw new ConflictException(`Team slug "${nextSlug}" already exists.`);
          }
        }
      }

      await this.verifyTeamRefs(
        tx,
        tenant.organizationId,
        input.departmentId ?? undefined,
        input.leadStaffId ?? undefined,
      );

      const updated = await tx.team.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(nextSlug !== undefined ? { slug: nextSlug } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.departmentId !== undefined
            ? { departmentId: input.departmentId }
            : {}),
          ...(input.leadStaffId !== undefined
            ? { leadStaffId: input.leadStaffId }
            : {}),
          ...(input.defaultAllocationPct !== undefined
            ? { defaultAllocationPct: input.defaultAllocationPct }
            : {}),
          ...(input.metadata !== undefined
            ? { metadata: toNullableJson(input.metadata) }
            : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "team.updated",
          resourceType: "Team",
          resourceId: updated.id,
          metadata: { slug: updated.slug, kind: updated.kind } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async archiveTeam(
    tenant: AuthenticatedOrganization,
    teamId: string,
    ipAddress?: string,
  ) {
    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.team.findFirst({
        where: { id: teamId, organizationId: tenant.organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Team not found.");
      }

      if (existing.status === TeamStatus.ARCHIVED) {
        return existing;
      }

      const archived = await tx.team.update({
        where: { id: existing.id },
        data: {
          status: TeamStatus.ARCHIVED,
          archivedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "team.archived",
          resourceType: "Team",
          resourceId: archived.id,
          ipAddress: ipAddress ?? null,
        },
      });

      return archived;
    });
  }

  async upsertTeamMember(
    tenant: AuthenticatedOrganization,
    teamId: string,
    input: UpsertTeamMemberInput,
    ipAddress?: string,
  ) {
    const startDate = input.startDate ? normalizeUtcDate(input.startDate) : null;
    const endDate = input.endDate ? normalizeUtcDate(input.endDate) : null;
    if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
      throw new BadRequestException("endDate cannot precede startDate.");
    }

    return this.prismaService.raw.$transaction(async (tx) => {
      const team = await tx.team.findFirst({
        where: { id: teamId, organizationId: tenant.organizationId },
      });
      if (!team) {
        throw new NotFoundException("Team not found.");
      }
      if (team.status === TeamStatus.ARCHIVED) {
        throw new BadRequestException("Cannot assign members to an archived team.");
      }

      const staff = await tx.staffProfile.findFirst({
        where: { id: input.staffId, organizationId: tenant.organizationId },
        select: { id: true, status: true, displayName: true },
      });
      if (!staff) {
        throw new NotFoundException(
          `Staff profile (${input.staffId}) was not found in the active organization.`,
        );
      }
      if (staff.status === StaffStatus.OFFBOARDED) {
        throw new BadRequestException("Cannot add an offboarded staff member to a team.");
      }

      const allocationPct = input.allocationPct ?? team.defaultAllocationPct;

      const existing = await tx.teamMember.findFirst({
        where: {
          organizationId: tenant.organizationId,
          teamId: team.id,
          staffId: staff.id,
        },
      });

      const saved = existing
        ? await tx.teamMember.update({
            where: { id: existing.id },
            data: {
              roleInTeam: input.roleInTeam?.trim() || existing.roleInTeam,
              allocationPct,
              ...(input.startDate !== undefined ? { startDate } : {}),
              ...(input.endDate !== undefined ? { endDate } : {}),
              isActive: input.isActive ?? true,
            },
            include: {
              staff: {
                select: {
                  id: true,
                  displayName: true,
                  jobTitle: true,
                  workEmail: true,
                },
              },
            },
          })
        : await tx.teamMember.create({
            data: {
              organizationId: tenant.organizationId,
              teamId: team.id,
              staffId: staff.id,
              roleInTeam: input.roleInTeam?.trim() || "member",
              allocationPct,
              startDate,
              endDate,
              isActive: input.isActive ?? true,
            },
            include: {
              staff: {
                select: {
                  id: true,
                  displayName: true,
                  jobTitle: true,
                  workEmail: true,
                },
              },
            },
          });

      const activeMemberships = await tx.teamMember.findMany({
        where: {
          organizationId: tenant.organizationId,
          staffId: staff.id,
          isActive: true,
        },
        select: { allocationPct: true },
      });
      const totalActiveAllocationPct = activeMemberships.reduce(
        (sum, row) => sum + row.allocationPct,
        0,
      );

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "team.member.upserted",
          resourceType: "TeamMember",
          resourceId: saved.id,
          metadata: {
            teamId: team.id,
            staffId: staff.id,
            allocationPct,
            totalActiveAllocationPct,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        member: saved,
        totalActiveAllocationPct,
        isOverallocated: totalActiveAllocationPct > 100,
      };
    });
  }

  async removeTeamMember(
    tenant: AuthenticatedOrganization,
    teamId: string,
    staffId: string,
    ipAddress?: string,
  ) {
    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.teamMember.findFirst({
        where: {
          organizationId: tenant.organizationId,
          teamId,
          staffId,
        },
      });
      if (!existing) {
        throw new NotFoundException("Team member assignment not found.");
      }

      await tx.teamMember.delete({ where: { id: existing.id } });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "team.member.removed",
          resourceType: "TeamMember",
          resourceId: existing.id,
          metadata: { teamId, staffId } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return { removed: true, teamId, staffId };
    });
  }
}

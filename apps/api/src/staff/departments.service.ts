import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DepartmentStatus, type Prisma } from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { assertNoHierarchyCycle } from "./staff.utils.js";

export interface CreateDepartmentInput {
  name: string;
  code: string;
  description?: string | null;
  parentDepartmentId?: string | null;
  leadStaffId?: string | null;
}

export interface UpdateDepartmentInput {
  name?: string;
  code?: string;
  description?: string | null;
  parentDepartmentId?: string | null;
  leadStaffId?: string | null;
}

export interface ListDepartmentsQuery {
  status?: DepartmentStatus;
  parentDepartmentId?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface DepartmentTreeNode {
  id: string;
  name: string;
  code: string;
  status: DepartmentStatus;
  parentDepartmentId: string | null;
  leadStaffId: string | null;
  children: DepartmentTreeNode[];
}

@Injectable()
export class DepartmentsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private normalizeCode(code: string): string {
    return code.trim().toUpperCase();
  }

  private async verifyParentDepartment(
    tx: Prisma.TransactionClient,
    organizationId: string,
    parentDepartmentId: string,
  ): Promise<void> {
    const parent = await tx.department.findFirst({
      where: { id: parentDepartmentId, organizationId },
      select: { id: true, status: true },
    });
    if (!parent) {
      throw new NotFoundException(
        `Parent department (${parentDepartmentId}) was not found in the active organization.`,
      );
    }
    if (parent.status === DepartmentStatus.ARCHIVED) {
      throw new BadRequestException(
        "Cannot assign an archived parent department.",
      );
    }
  }

  private async verifyLeadStaff(
    tx: Prisma.TransactionClient,
    organizationId: string,
    leadStaffId: string,
  ): Promise<void> {
    const lead = await tx.staffProfile.findFirst({
      where: { id: leadStaffId, organizationId },
      select: { id: true, status: true },
    });
    if (!lead) {
      throw new NotFoundException(
        `Lead staff profile (${leadStaffId}) was not found in the active organization.`,
      );
    }
  }

  async createDepartment(
    tenant: AuthenticatedOrganization,
    input: CreateDepartmentInput,
    ipAddress?: string,
  ) {
    const normalizedCode = this.normalizeCode(input.code);

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.department.findFirst({
        where: { organizationId: tenant.organizationId, code: normalizedCode },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException(
          `Department code "${normalizedCode}" already exists in this organization.`,
        );
      }

      if (input.parentDepartmentId) {
        await this.verifyParentDepartment(
          tx,
          tenant.organizationId,
          input.parentDepartmentId,
        );
      }
      if (input.leadStaffId) {
        await this.verifyLeadStaff(
          tx,
          tenant.organizationId,
          input.leadStaffId,
        );
      }

      const created = await tx.department.create({
        data: {
          organizationId: tenant.organizationId,
          name: input.name.trim(),
          code: normalizedCode,
          description: input.description ?? null,
          parentDepartmentId: input.parentDepartmentId ?? null,
          leadStaffId: input.leadStaffId ?? null,
          status: DepartmentStatus.ACTIVE,
        },
        include: {
          leadStaff: {
            select: { id: true, displayName: true, jobTitle: true, workEmail: true },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "department.created",
          resourceType: "Department",
          resourceId: created.id,
          metadata: {
            code: created.code,
            name: created.name,
            parentDepartmentId: created.parentDepartmentId,
            leadStaffId: created.leadStaffId,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return created;
    });
  }

  async listDepartments(
    tenant: AuthenticatedOrganization,
    query: ListDepartmentsQuery,
  ) {
    const take = Math.min(Math.max(query.limit, 1), 100);
    const where: Prisma.DepartmentWhereInput = {
      organizationId: tenant.organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.parentDepartmentId
        ? { parentDepartmentId: query.parentDepartmentId }
        : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" } },
              { code: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const records = await this.prismaService.scoped.department.findMany({
      where,
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ name: "asc" }, { id: "asc" }],
      include: {
        leadStaff: {
          select: { id: true, displayName: true, jobTitle: true, workEmail: true },
        },
        _count: {
          select: { staffMembers: true, childDepartments: true },
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

  async getDepartment(tenant: AuthenticatedOrganization, departmentId: string) {
    const dept = await this.prismaService.scoped.department.findFirst({
      where: { id: departmentId, organizationId: tenant.organizationId },
      include: {
        parentDepartment: { select: { id: true, name: true, code: true } },
        childDepartments: {
          select: { id: true, name: true, code: true, status: true },
        },
        leadStaff: {
          select: { id: true, displayName: true, jobTitle: true, workEmail: true },
        },
        _count: { select: { staffMembers: true, teams: true } },
      },
    });

    if (!dept) {
      throw new NotFoundException("Department not found.");
    }

    return dept;
  }

  async updateDepartment(
    tenant: AuthenticatedOrganization,
    departmentId: string,
    input: UpdateDepartmentInput,
    ipAddress?: string,
  ) {
    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.department.findFirst({
        where: { id: departmentId, organizationId: tenant.organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Department not found.");
      }

      const nextCode =
        input.code !== undefined ? this.normalizeCode(input.code) : undefined;
      if (nextCode && nextCode !== existing.code) {
        const dup = await tx.department.findFirst({
          where: {
            organizationId: tenant.organizationId,
            code: nextCode,
            id: { not: existing.id },
          },
          select: { id: true },
        });
        if (dup) {
          throw new ConflictException(
            `Department code "${nextCode}" already exists in this organization.`,
          );
        }
      }

      if (input.parentDepartmentId !== undefined && input.parentDepartmentId !== null) {
        await this.verifyParentDepartment(
          tx,
          tenant.organizationId,
          input.parentDepartmentId,
        );
        await assertNoHierarchyCycle(
          existing.id,
          input.parentDepartmentId,
          async (id) => {
            const node = await tx.department.findFirst({
              where: { id, organizationId: tenant.organizationId },
              select: { parentDepartmentId: true },
            });
            return node?.parentDepartmentId ?? null;
          },
          "Department",
        );
      }

      if (input.leadStaffId !== undefined && input.leadStaffId !== null) {
        await this.verifyLeadStaff(
          tx,
          tenant.organizationId,
          input.leadStaffId,
        );
      }

      const updated = await tx.department.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(nextCode !== undefined ? { code: nextCode } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.parentDepartmentId !== undefined
            ? { parentDepartmentId: input.parentDepartmentId }
            : {}),
          ...(input.leadStaffId !== undefined
            ? { leadStaffId: input.leadStaffId }
            : {}),
        },
        include: {
          leadStaff: {
            select: { id: true, displayName: true, jobTitle: true, workEmail: true },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "department.updated",
          resourceType: "Department",
          resourceId: updated.id,
          metadata: {
            code: updated.code,
            name: updated.name,
            parentDepartmentId: updated.parentDepartmentId,
            leadStaffId: updated.leadStaffId,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });
  }

  async archiveDepartment(
    tenant: AuthenticatedOrganization,
    departmentId: string,
    ipAddress?: string,
  ) {
    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.department.findFirst({
        where: { id: departmentId, organizationId: tenant.organizationId },
      });
      if (!existing) {
        throw new NotFoundException("Department not found.");
      }

      if (existing.status === DepartmentStatus.ARCHIVED) {
        return existing;
      }

      const archived = await tx.department.update({
        where: { id: existing.id },
        data: {
          status: DepartmentStatus.ARCHIVED,
          archivedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "department.archived",
          resourceType: "Department",
          resourceId: archived.id,
          metadata: {
            code: archived.code,
            name: archived.name,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return archived;
    });
  }

  async getDepartmentTree(tenant: AuthenticatedOrganization) {
    const rows = await this.prismaService.scoped.department.findMany({
      where: {
        organizationId: tenant.organizationId,
        status: DepartmentStatus.ACTIVE,
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        code: true,
        status: true,
        parentDepartmentId: true,
        leadStaffId: true,
      },
    });

    const nodeMap = new Map<string, DepartmentTreeNode>();
    for (const row of rows) {
      nodeMap.set(row.id, {
        ...row,
        children: [],
      });
    }

    const roots: DepartmentTreeNode[] = [];
    for (const node of nodeMap.values()) {
      if (node.parentDepartmentId && nodeMap.has(node.parentDepartmentId)) {
        nodeMap.get(node.parentDepartmentId)?.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return {
      organizationId: tenant.organizationId,
      tree: roots,
    };
  }
}

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  FulfillmentStatus,
  FulfillmentType,
  NotificationEventType,
  Prisma,
  StaffJobStatus,
  StaffStatus,
  OrganizationContext,
} from "@scace/db";
import {
  hasOrganizationPermission,
  isValidOrganizationRole,
} from "../auth/permissions.js";
import { CrmBridgeService } from "../crm/crm-bridge.service.js";
import { CrmConnectionService } from "../crm/crm-connection.service.js";
import { CustomerMatesClient } from "../crm/customermates.client.js";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { FulfillmentNotificationsService } from "./fulfillment-notifications.service.js";

export interface ConvertFulfillmentToJobInput {
  title?: string;
  instructions?: string | null;
  priority?: number;
  assignedStaffId?: string | null;
  assignedDepartmentId?: string | null;
  assignedTeamId?: string | null;
  assignedRole?: string | null;
  targetDueAt?: string | null;
  syncToCrm?: boolean;
  allowMultiple?: boolean;
}

export interface CreateStaffJobInput {
  fulfillmentId: string;
  title: string;
  instructions?: string | null;
  priority?: number;
  assignedStaffId?: string | null;
  assignedDepartmentId?: string | null;
  assignedTeamId?: string | null;
  assignedRole?: string | null;
  targetDueAt?: string | null;
  syncToCrm?: boolean;
}

export interface AssignStaffJobInput {
  assignedStaffId?: string | null;
  assignedDepartmentId?: string | null;
  assignedTeamId?: string | null;
  assignedRole?: string | null;
  priority?: number;
  targetDueAt?: string | null;
  instructions?: string | null;
}

export interface UpdateStaffJobStatusInput {
  status: StaffJobStatus;
  notes?: string | null;
  notifyCustomerOnComplete?: boolean;
}

export interface ListStaffJobsQuery {
  fulfillmentId?: string;
  orderId?: string;
  status?: StaffJobStatus;
  assignedStaffId?: string;
  assignedDepartmentId?: string;
  assignedTeamId?: string;
  assignedRole?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

function generateJobNumber(): string {
  return `JOB-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
}

@Injectable()
export class StaffJobsService {
  private readonly logger = new Logger(StaffJobsService.name);

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(CrmConnectionService)
    private readonly crmConnectionService: CrmConnectionService,
    @Inject(CrmBridgeService)
    private readonly crmBridgeService: CrmBridgeService,
    @Inject(CustomerMatesClient)
    private readonly customerMatesClient: CustomerMatesClient,
    @Inject(FulfillmentNotificationsService)
    private readonly notificationsService: FulfillmentNotificationsService,
  ) {}

  async convertFulfillmentToJob(
    tenant: AuthenticatedOrganization,
    fulfillmentId: string,
    input: ConvertFulfillmentToJobInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const [fulfillment, settings] = await Promise.all([
      this.prismaService.raw.orderFulfillment.findFirst({
        where: { id: fulfillmentId, organizationId },
        include: {
          order: {
            include: {
              lines: true,
              customer: { select: { id: true, name: true, companyName: true } },
            },
          },
          staffJobs: {
            where: { status: { not: StaffJobStatus.CANCELLED } },
            select: { id: true, jobNumber: true, status: true },
          },
        },
      }),
      this.prismaService.raw.fulfillmentSettings.findUnique({
        where: { organizationId },
      }),
    ]);

    if (!fulfillment) {
      throw new NotFoundException("Order fulfillment was not found.");
    }
    if (
      fulfillment.status === FulfillmentStatus.COMPLETED ||
      fulfillment.status === FulfillmentStatus.CANCELLED
    ) {
      throw new BadRequestException(
        `Cannot create a staff job for a ${fulfillment.status} fulfillment.`,
      );
    }
    if (fulfillment.staffJobs.length > 0 && !input.allowMultiple) {
      throw new BadRequestException(
        `Fulfillment "${fulfillment.fulfillmentNumber}" already has an active staff job (${fulfillment.staffJobs[0]?.jobNumber}). Pass allowMultiple: true to add another job.`,
      );
    }

    const linesSummary = fulfillment.order.lines
      .map((l) => `- ${l.quantity}x ${l.name} (${l.sku})`)
      .join("\n");
    const specialNotes = fulfillment.preparationNotes
      ? `\n\nPreparation Notes:\n${fulfillment.preparationNotes}`
      : "";
    const defaultInstructions = `Items:\n${linesSummary || "- See order lines"}${specialNotes}`;

    const scheduledAnchor =
      fulfillment.scheduledFulfillmentAt ??
      fulfillment.pickupWindowStart ??
      fulfillment.deliveryWindowStart ??
      null;
    const leadMinutes = settings?.defaultJobLeadMinutes ?? 120;
    const computedDueAt = input.targetDueAt
      ? new Date(input.targetDueAt)
      : scheduledAnchor
        ? new Date(scheduledAnchor.getTime() - leadMinutes * 60_000)
        : null;

    const assignedStaffId =
      input.assignedStaffId !== undefined
        ? input.assignedStaffId
        : settings?.defaultJobAssigneeStaffId ?? null;
    const assignedRole =
      input.assignedRole !== undefined
        ? input.assignedRole
        : settings?.defaultJobAssigneeRole ?? null;
    const syncToCrm = input.syncToCrm ?? settings?.syncJobsToCrm ?? false;

    return this.createStaffJob(
      tenant,
      {
        fulfillmentId: fulfillment.id,
        title:
          input.title?.trim() ||
          `Prepare ${fulfillment.type} ${fulfillment.order.orderNumber}`,
        instructions:
          input.instructions !== undefined
            ? input.instructions
            : defaultInstructions,
        priority: input.priority ?? 2,
        assignedStaffId,
        assignedDepartmentId: input.assignedDepartmentId ?? null,
        assignedTeamId: input.assignedTeamId ?? null,
        assignedRole,
        targetDueAt: computedDueAt ? computedDueAt.toISOString() : null,
        syncToCrm,
      },
      ipAddress,
    );
  }

  async createStaffJob(
    tenant: AuthenticatedOrganization,
    input: CreateStaffJobInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const fulfillment = await this.prismaService.raw.orderFulfillment.findFirst({
      where: { id: input.fulfillmentId, organizationId },
      include: {
        order: {
          include: {
            lines: true,
            customer: true,
          },
        },
      },
    });
    if (!fulfillment) {
      throw new NotFoundException("Order fulfillment was not found.");
    }
    if (
      fulfillment.status === FulfillmentStatus.COMPLETED ||
      fulfillment.status === FulfillmentStatus.CANCELLED
    ) {
      throw new BadRequestException(
        `Cannot create a staff job for a ${fulfillment.status} fulfillment.`,
      );
    }

    await this.validateAssignmentTargets(organizationId, {
      assignedStaffId: input.assignedStaffId,
      assignedDepartmentId: input.assignedDepartmentId,
      assignedTeamId: input.assignedTeamId,
      assignedRole: input.assignedRole,
    });

    const jobNumber = generateJobNumber();
    const targetDueAt = input.targetDueAt ? new Date(input.targetDueAt) : null;
    const syncToCrm = input.syncToCrm ?? false;

    const created = await this.prismaService.raw.$transaction(async (tx) => {
      const job = await tx.staffJob.create({
        data: {
          organizationId,
          jobNumber,
          fulfillmentId: fulfillment.id,
          orderId: fulfillment.orderId,
          title: input.title.trim(),
          instructions: input.instructions?.trim() || null,
          status: StaffJobStatus.ASSIGNED,
          priority: input.priority ?? 2,
          assignedStaffId: input.assignedStaffId ?? null,
          assignedDepartmentId: input.assignedDepartmentId ?? null,
          assignedTeamId: input.assignedTeamId ?? null,
          assignedRole: input.assignedRole?.trim() || null,
          targetDueAt,
          syncToCrm,
          createdByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
        },
        include: this.staffJobInclude(),
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "staff_job.created",
          resourceType: "StaffJob",
          resourceId: job.id,
          metadata: {
            jobNumber: job.jobNumber,
            fulfillmentId: fulfillment.id,
            orderNumber: fulfillment.order.orderNumber,
            assignedStaffId: job.assignedStaffId,
            assignedRole: job.assignedRole,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return job;
    });

    if (syncToCrm) {
      return this.syncJobToCrmBestEffort(organizationId, created);
    }

    return created;
  }

  async listStaffJobs(tenant: AuthenticatedOrganization, query: ListStaffJobsQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const records = await this.prismaService.scoped.staffJob.findMany({
      where: {
        ...(query.fulfillmentId ? { fulfillmentId: query.fulfillmentId } : {}),
        ...(query.orderId ? { orderId: query.orderId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.assignedStaffId
          ? { assignedStaffId: query.assignedStaffId }
          : {}),
        ...(query.assignedDepartmentId
          ? { assignedDepartmentId: query.assignedDepartmentId }
          : {}),
        ...(query.assignedTeamId ? { assignedTeamId: query.assignedTeamId } : {}),
        ...(query.assignedRole ? { assignedRole: query.assignedRole } : {}),
        ...(search
          ? {
              OR: [
                { jobNumber: { contains: search, mode: "insensitive" } },
                { title: { contains: search, mode: "insensitive" } },
                {
                  order: {
                    orderNumber: { contains: search, mode: "insensitive" },
                  },
                },
              ],
            }
          : {}),
      },
      include: this.staffJobInclude(),
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ priority: "asc" }, { targetDueAt: "asc" }, { createdAt: "desc" }],
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

  async getStaffJob(tenant: AuthenticatedOrganization, jobId: string) {
    this.resolveVerifiedOrganizationId(tenant);
    const job = await this.prismaService.scoped.staffJob.findUnique({
      where: { id: jobId },
      include: this.staffJobInclude(),
    });
    if (!job) {
      throw new NotFoundException("Staff job was not found.");
    }
    return job;
  }

  async assignStaffJob(
    tenant: AuthenticatedOrganization,
    jobId: string,
    input: AssignStaffJobInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const existing = await this.prismaService.raw.staffJob.findFirst({
      where: { id: jobId, organizationId },
    });
    if (!existing) {
      throw new NotFoundException("Staff job was not found.");
    }
    if (
      existing.status === StaffJobStatus.COMPLETED ||
      existing.status === StaffJobStatus.CANCELLED
    ) {
      throw new BadRequestException(
        `Cannot reassign a ${existing.status} staff job.`,
      );
    }

    await this.validateAssignmentTargets(organizationId, {
      assignedStaffId: input.assignedStaffId,
      assignedDepartmentId: input.assignedDepartmentId,
      assignedTeamId: input.assignedTeamId,
      assignedRole: input.assignedRole,
    });

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const saved = await tx.staffJob.update({
        where: { id: existing.id },
        data: {
          ...(input.assignedStaffId !== undefined
            ? { assignedStaffId: input.assignedStaffId }
            : {}),
          ...(input.assignedDepartmentId !== undefined
            ? { assignedDepartmentId: input.assignedDepartmentId }
            : {}),
          ...(input.assignedTeamId !== undefined
            ? { assignedTeamId: input.assignedTeamId }
            : {}),
          ...(input.assignedRole !== undefined
            ? { assignedRole: input.assignedRole?.trim() || null }
            : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.targetDueAt !== undefined
            ? { targetDueAt: input.targetDueAt ? new Date(input.targetDueAt) : null }
            : {}),
          ...(input.instructions !== undefined
            ? { instructions: input.instructions?.trim() || null }
            : {}),
          updatedByUserId: tenant.userId,
        },
        include: this.staffJobInclude(),
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "staff_job.assigned",
          resourceType: "StaffJob",
          resourceId: saved.id,
          metadata: {
            jobNumber: saved.jobNumber,
            assignedStaffId: saved.assignedStaffId,
            assignedDepartmentId: saved.assignedDepartmentId,
            assignedTeamId: saved.assignedTeamId,
            assignedRole: saved.assignedRole,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });

    if (updated.syncToCrm) {
      return this.syncJobToCrmBestEffort(organizationId, updated);
    }

    return updated;
  }

  async updateStaffJobStatus(
    tenant: AuthenticatedOrganization,
    jobId: string,
    input: UpdateStaffJobStatusInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    if (
      input.status === StaffJobStatus.CANCELLED &&
      !hasOrganizationPermission(tenant.role, { staffJob: ["cancel"] })
    ) {
      throw new ForbiddenException(
        "Insufficient role permissions to cancel staff jobs.",
      );
    }
    if (
      input.status === StaffJobStatus.COMPLETED &&
      !hasOrganizationPermission(tenant.role, { staffJob: ["complete"] })
    ) {
      throw new ForbiddenException(
        "Insufficient role permissions to complete staff jobs.",
      );
    }

    const txResult = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.staffJob.findFirst({
        where: { id: jobId, organizationId },
        include: {
          fulfillment: true,
        },
      });
      if (!existing) {
        throw new NotFoundException("Staff job was not found.");
      }

      if (existing.status === StaffJobStatus.CANCELLED) {
        throw new BadRequestException("Cannot update a cancelled staff job.");
      }
      if (
        existing.status === StaffJobStatus.COMPLETED &&
        input.status !== StaffJobStatus.COMPLETED
      ) {
        throw new BadRequestException(
          "Completed staff jobs cannot be reverted.",
        );
      }

      const now = new Date();
      const updatedJob = await tx.staffJob.update({
        where: { id: existing.id },
        data: {
          status: input.status,
          ...(input.status === StaffJobStatus.IN_PROGRESS && !existing.startedAt
            ? { startedAt: now, startedByUserId: tenant.userId }
            : {}),
          ...(input.status === StaffJobStatus.COMPLETED && !existing.completedAt
            ? {
                startedAt: existing.startedAt ?? now,
                startedByUserId: existing.startedByUserId ?? tenant.userId,
                completedAt: now,
                completedByUserId: tenant.userId,
              }
            : {}),
          ...(input.status === StaffJobStatus.CANCELLED
            ? { cancelledAt: now }
            : {}),
          ...(input.notes
            ? {
                instructions: existing.instructions
                  ? `${existing.instructions}\n\n[Note]: ${input.notes.trim()}`
                  : input.notes.trim(),
              }
            : {}),
          updatedByUserId: tenant.userId,
        },
        include: this.staffJobInclude(),
      });

      let fulfillmentMovedToReady = false;
      let fulfillmentMovedToInProgress = false;

      if (
        input.status === StaffJobStatus.IN_PROGRESS &&
        existing.fulfillment.status === FulfillmentStatus.PENDING
      ) {
        await tx.orderFulfillment.update({
          where: { id: existing.fulfillmentId },
          data: {
            status: FulfillmentStatus.IN_PROGRESS,
            updatedByUserId: tenant.userId,
          },
        });
        fulfillmentMovedToInProgress = true;
      }

      if (input.status === StaffJobStatus.COMPLETED) {
        const siblingJobs = await tx.staffJob.findMany({
          where: {
            organizationId,
            fulfillmentId: existing.fulfillmentId,
            status: { not: StaffJobStatus.CANCELLED },
          },
          select: { id: true, status: true },
        });

        const allCompleted =
          siblingJobs.length > 0 &&
          siblingJobs.every((j) => j.status === StaffJobStatus.COMPLETED);

        if (
          allCompleted &&
          existing.fulfillment.type === FulfillmentType.PREORDER &&
          (existing.fulfillment.status === FulfillmentStatus.PENDING ||
            existing.fulfillment.status === FulfillmentStatus.IN_PROGRESS)
        ) {
          await tx.orderFulfillment.update({
            where: { id: existing.fulfillmentId },
            data: {
              status: FulfillmentStatus.READY,
              readyAt: existing.fulfillment.readyAt ?? now,
              updatedByUserId: tenant.userId,
            },
          });
          fulfillmentMovedToReady = true;
        }
      }

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "staff_job.status_updated",
          resourceType: "StaffJob",
          resourceId: existing.id,
          metadata: {
            jobNumber: existing.jobNumber,
            previousStatus: existing.status,
            nextStatus: input.status,
            fulfillmentMovedToReady,
            fulfillmentMovedToInProgress,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return {
        job: updatedJob,
        fulfillmentMovedToReady,
        fulfillmentMovedToInProgress,
      };
    });

    if (txResult.job.syncToCrm) {
      await this.syncJobToCrmBestEffort(organizationId, txResult.job);
    }

    const notifications = [];
    if (
      input.status === StaffJobStatus.COMPLETED &&
      input.notifyCustomerOnComplete !== false
    ) {
      const jobNotif =
        await this.notificationsService.dispatchFulfillmentNotification(
          tenant,
          {
            fulfillmentId: txResult.job.fulfillmentId,
            eventType: NotificationEventType.JOB_COMPLETED,
            triggerSource: "AUTO",
            staffJobId: txResult.job.id,
            jobTitle: txResult.job.title,
          },
          ipAddress,
        );
      notifications.push(jobNotif);
    }

    if (txResult.fulfillmentMovedToReady) {
      const readyNotif =
        await this.notificationsService.dispatchFulfillmentNotification(
          tenant,
          {
            fulfillmentId: txResult.job.fulfillmentId,
            eventType: NotificationEventType.PREORDER_READY,
            triggerSource: "AUTO",
            staffJobId: txResult.job.id,
            jobTitle: txResult.job.title,
          },
          ipAddress,
        );
      notifications.push(readyNotif);
    }

    const refreshedJob = await this.getStaffJob(tenant, txResult.job.id);

    return {
      job: refreshedJob,
      fulfillmentMovedToReady: txResult.fulfillmentMovedToReady,
      fulfillmentMovedToInProgress: txResult.fulfillmentMovedToInProgress,
      notifications,
    };
  }

  private async validateAssignmentTargets(
    organizationId: string,
    targets: {
      assignedStaffId?: string | null;
      assignedDepartmentId?: string | null;
      assignedTeamId?: string | null;
      assignedRole?: string | null;
    },
  ): Promise<void> {
    if (targets.assignedStaffId) {
      const staff = await this.prismaService.raw.staffProfile.findFirst({
        where: { id: targets.assignedStaffId, organizationId },
        select: { id: true, status: true },
      });
      if (!staff) {
        throw new NotFoundException("Assigned staff profile was not found.");
      }
      if (staff.status === StaffStatus.OFFBOARDED) {
        throw new BadRequestException(
          "Cannot assign a job to an offboarded staff member.",
        );
      }
    }

    if (targets.assignedDepartmentId) {
      const dept = await this.prismaService.raw.department.findFirst({
        where: { id: targets.assignedDepartmentId, organizationId },
        select: { id: true },
      });
      if (!dept) {
        throw new NotFoundException("Assigned department was not found.");
      }
    }

    if (targets.assignedTeamId) {
      const team = await this.prismaService.raw.team.findFirst({
        where: { id: targets.assignedTeamId, organizationId },
        select: { id: true },
      });
      if (!team) {
        throw new NotFoundException("Assigned team was not found.");
      }
    }

    if (targets.assignedRole && !isValidOrganizationRole(targets.assignedRole.trim())) {
      throw new BadRequestException(
        `Invalid organization role "${targets.assignedRole}".`,
      );
    }
  }

  private async syncJobToCrmBestEffort<
    T extends {
      id: string;
      jobNumber: string;
      title: string;
      instructions: string | null;
      status: StaffJobStatus;
      targetDueAt: Date | null;
      assignedStaffId: string | null;
      externalTaskId: string | null;
      order: { orderNumber: string; customer?: { externalContactId?: string | null } | null };
    },
  >(organizationId: string, job: T): Promise<T> {
    try {
      const ctx = await this.crmConnectionService.resolveActiveConnection(
        organizationId,
      );

      let assigneeId: string | undefined;
      if (job.assignedStaffId) {
        try {
          const mapping = await this.crmBridgeService.resolveExternalOwnerFromStaff(
            organizationId,
            job.assignedStaffId,
          );
          assigneeId = mapping.externalUserId;
        } catch {
          // Staff member may not have a CRM mapping yet
        }
      }

      const payload: Record<string, unknown> = {
        title: `[${job.jobNumber}] ${job.title}`,
        description: job.instructions ?? undefined,
        status: job.status.toLowerCase(),
        ...(job.targetDueAt ? { dueAt: job.targetDueAt.toISOString() } : {}),
        ...(assigneeId ? { assigneeId } : {}),
        ...(job.order.customer?.externalContactId
          ? { contactId: job.order.customer.externalContactId }
          : {}),
        externalRef: job.id,
      };

      const crmTask = job.externalTaskId
        ? await this.customerMatesClient.updateResource(
            ctx,
            "tasks",
            job.externalTaskId,
            payload,
          )
        : await this.customerMatesClient.createResource(ctx, "tasks", payload);

      const updated = await this.prismaService.raw.staffJob.update({
        where: { id: job.id },
        data: {
          externalTaskId: crmTask.id,
          crmSyncedAt: new Date(),
        },
        include: this.staffJobInclude(),
      });
      return updated as unknown as T;
    } catch (err) {
      this.logger.warn(
        `CustomerMates task sync skipped for job ${job.jobNumber}: ${
          err instanceof Error ? err.message : "CRM unavailable"
        }`,
      );
      return job;
    }
  }

  private staffJobInclude() {
    return {
      assignedStaff: {
        select: {
          id: true,
          displayName: true,
          workEmail: true,
          jobTitle: true,
          status: true,
        },
      },
      assignedDepartment: {
        select: { id: true, code: true, name: true },
      },
      assignedTeam: {
        select: { id: true, slug: true, name: true },
      },
      fulfillment: {
        select: {
          id: true,
          fulfillmentNumber: true,
          type: true,
          status: true,
          scheduledFulfillmentAt: true,
          pickupWindowStart: true,
          pickupWindowEnd: true,
          deliveryWindowStart: true,
          deliveryWindowEnd: true,
          preparationNotes: true,
        },
      },
      order: {
        select: {
          id: true,
          orderNumber: true,
          channel: true,
          totalCents: true,
          currency: true,
          customer: {
            select: {
              id: true,
              code: true,
              name: true,
              companyName: true,
              phone: true,
              email: true,
              externalContactId: true,
            },
          },
          lines: {
            select: {
              id: true,
              sku: true,
              name: true,
              description: true,
              quantity: true,
              unitOfMeasure: true,
            },
          },
        },
      },
    } satisfies Prisma.StaffJobInclude;
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedOrganization): string {
    const contextOrgId = OrganizationContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active organization context mismatch.");
    }
    return tenant.organizationId;
  }
}

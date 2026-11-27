import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import type { Prisma } from "@scace/db";
import { APIError } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";
import { auth } from "../auth/auth.config.js";
import {
  getResolvedPermissionsForRole,
  intersectPermissionsWithScopes,
  ORGANIZATION_ROLE_NAMES,
  parseRoleNames,
  type OrganizationRoleName,
} from "../auth/permissions.js";
import { BillingEnforcementService } from "../billing/billing-enforcement.service.js";
import { getEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import { RedisService } from "../redis/redis.service.js";
import { deriveOrganizationBucketName } from "../storage/storage.utils.js";
import type { AuthenticatedOrganization } from "./organization.decorators.js";

export interface UpdateOrganizationSettingsInput {
  companyLegalName?: string | null;
  defaultCurrency?: string;
  timezone?: string;
  fiscalYearStartMonth?: number;
  features?: Record<string, boolean>;
}

export interface CreateInvitationInput {
  email: string;
  role: OrganizationRoleName;
  resend?: boolean;
}

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redisService: RedisService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
    @Optional()
    @Inject(BillingEnforcementService)
    private readonly billingEnforcement?: BillingEnforcementService,
  ) {}

  async getCurrentOrganizationOverview(organizationCtx: AuthenticatedOrganization) {
    const organization = await this.prismaService.raw.organization.findUnique({
      where: { id: organizationCtx.organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        logo: true,
        createdAt: true,
        metadata: true,
      },
    });

    if (!organization) {
      throw new NotFoundException("Active organization was not found.");
    }

    const settings = await this.getOrCreateSettings(organizationCtx.organizationId);
    const basePermissions = getResolvedPermissionsForRole(organizationCtx.role);
    const effectivePermissions = organizationCtx.grantedScopes
      ? intersectPermissionsWithScopes(basePermissions, organizationCtx.grantedScopes)
      : basePermissions;

    return {
      organization,
      membership: {
        memberId: organizationCtx.memberId,
        role: organizationCtx.role,
        userId: organizationCtx.userId,
        authMethod: organizationCtx.authMethod ?? "COOKIE_SESSION",
        grantedScopes: organizationCtx.grantedScopes ?? null,
        deviceId: organizationCtx.deviceId ?? null,
        clientId: organizationCtx.clientId ?? null,
        isServicePrincipal: organizationCtx.isServicePrincipal ?? false,
        permissions: effectivePermissions,
      },
      settings,
    };
  }

  getEffectivePermissions(organizationCtx: AuthenticatedOrganization) {
    const basePermissions = getResolvedPermissionsForRole(organizationCtx.role);
    const effectivePermissions = organizationCtx.grantedScopes
      ? intersectPermissionsWithScopes(basePermissions, organizationCtx.grantedScopes)
      : basePermissions;

    return {
      organizationId: organizationCtx.organizationId,
      memberId: organizationCtx.memberId,
      role: organizationCtx.role,
      authMethod: organizationCtx.authMethod ?? "COOKIE_SESSION",
      grantedScopes: organizationCtx.grantedScopes ?? null,
      deviceId: organizationCtx.deviceId ?? null,
      clientId: organizationCtx.clientId ?? null,
      isServicePrincipal: organizationCtx.isServicePrincipal ?? false,
      availableRoles: ORGANIZATION_ROLE_NAMES,
      permissions: effectivePermissions,
    };
  }

  async getOrCreateSettings(organizationId: string) {
    const cacheKey = `org:${organizationId}:settings`;

    try {
      const cached = await this.redisService.getJson<Record<string, unknown>>(cacheKey);
      if (cached) {
        return cached;
      }
    } catch {
      // Fallback to PostgreSQL on Redis read error
    }

    const env = getEnv();
    let settings = await this.prismaService.scoped.organizationSettings.findFirst({});

    if (!settings) {
      settings = await this.prismaService.scoped.organizationSettings.create({
        data: {
          organizationId,
          defaultCurrency: "USD",
          timezone: "UTC",
          fiscalYearStartMonth: 1,
          storageBucket: deriveOrganizationBucketName(
            organizationId,
            env.RUSTFS_BUCKET_PREFIX,
          ),
          storageQuotaBytes: BigInt(env.STORAGE_DEFAULT_QUOTA_BYTES),
        },
      });
    }

    const serialized = this.serializeSettings(settings);

    try {
      await this.redisService.setJson(cacheKey, serialized, 300);
    } catch {
      // Non-fatal cache population error
    }

    return serialized;
  }

  async updateSettings(
    organizationCtx: AuthenticatedOrganization,
    input: UpdateOrganizationSettingsInput,
    ipAddress?: string,
  ) {
    const env = getEnv();
    const existing = await this.prismaService.scoped.organizationSettings.findFirst({});

    const updated = existing
      ? await this.prismaService.scoped.organizationSettings.update({
          where: { id: existing.id },
          data: {
            ...(input.companyLegalName !== undefined
              ? { companyLegalName: input.companyLegalName }
              : {}),
            ...(input.defaultCurrency !== undefined
              ? { defaultCurrency: input.defaultCurrency }
              : {}),
            ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
            ...(input.fiscalYearStartMonth !== undefined
              ? { fiscalYearStartMonth: input.fiscalYearStartMonth }
              : {}),
            ...(input.features !== undefined
              ? { features: input.features as Prisma.InputJsonValue }
              : {}),
          },
        })
      : await this.prismaService.scoped.organizationSettings.create({
          data: {
            organizationId: organizationCtx.organizationId,
            companyLegalName: input.companyLegalName ?? null,
            defaultCurrency: input.defaultCurrency ?? "USD",
            timezone: input.timezone ?? "UTC",
            fiscalYearStartMonth: input.fiscalYearStartMonth ?? 1,
            storageBucket: deriveOrganizationBucketName(
              organizationCtx.organizationId,
              env.RUSTFS_BUCKET_PREFIX,
            ),
            storageQuotaBytes: BigInt(env.STORAGE_DEFAULT_QUOTA_BYTES),
            ...(input.features !== undefined
              ? { features: input.features as Prisma.InputJsonValue }
              : {}),
          },
        });

    await this.prismaService.scoped.auditLog.create({
      data: {
        organizationId: organizationCtx.organizationId,
        actorUserId: organizationCtx.userId,
        action: "organization.settings.updated",
        resourceType: "OrganizationSettings",
        resourceId: updated.id,
        metadata: input as Prisma.InputJsonValue,
        ipAddress: ipAddress ?? null,
      },
    });

    try {
      await this.redisService.invalidateOrganizationCache(
        organizationCtx.organizationId,
        "settings",
      );
    } catch {
      // Non-fatal cache invalidation error
    }

    const serialized = this.serializeSettings(updated);
    this.analyticsService.identifyOrganization({
      organizationId: organizationCtx.organizationId,
      distinctId: organizationCtx.userId,
      force: true,
      properties: {
        default_currency: serialized.defaultCurrency,
        timezone: serialized.timezone,
        fiscal_year_start_month: serialized.fiscalYearStartMonth,
      },
    });
    this.analyticsService.captureDomainEvent({
      event: "organization.settings_updated",
      distinctId: organizationCtx.userId,
      organizationId: organizationCtx.organizationId,
      properties: {
        default_currency: serialized.defaultCurrency,
        timezone: serialized.timezone,
      },
    });

    return serialized;
  }

  private serializeSettings<T extends { storageQuotaBytes?: bigint | number }>(
    settings: T,
  ) {
    return {
      ...settings,
      ...(settings.storageQuotaBytes !== undefined
        ? { storageQuotaBytes: Number(settings.storageQuotaBytes) }
        : {}),
    };
  }

  async listMembers(organizationCtx: AuthenticatedOrganization) {
    const members = await this.prismaService.raw.member.findMany({
      where: { organizationId: organizationCtx.organizationId },
      select: {
        id: true,
        role: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            emailVerified: true,
            image: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return {
      organizationId: organizationCtx.organizationId,
      items: members.map((item) => ({
        id: item.id,
        role: item.role,
        createdAt: item.createdAt,
        user: item.user,
        permissions: getResolvedPermissionsForRole(item.role),
      })),
    };
  }

  async updateMemberRole(
    organizationCtx: AuthenticatedOrganization,
    memberId: string,
    nextRole: OrganizationRoleName,
    rawHeaders: IncomingHttpHeaders,
  ) {
    const targetMember = await this.prismaService.raw.member.findFirst({
      where: {
        id: memberId,
        organizationId: organizationCtx.organizationId,
      },
      select: {
        id: true,
        userId: true,
        role: true,
      },
    });

    if (!targetMember) {
      throw new NotFoundException("Organization member not found.");
    }

    const actorIsOwner = parseRoleNames(organizationCtx.role).includes("owner");
    const targetIsOwner = parseRoleNames(targetMember.role).includes("owner");

    if ((targetIsOwner || nextRole === "owner") && !actorIsOwner) {
      throw new ForbiddenException(
        "Only an organization owner can assign or modify the owner role.",
      );
    }

    if (targetIsOwner && nextRole !== "owner") {
      await this.ensureAnotherOwnerExists(
        organizationCtx.organizationId,
        targetMember.id,
      );
    }

    try {
      const updated = await auth.api.updateMemberRole({
        headers: fromNodeHeaders(rawHeaders),
        body: {
          memberId,
          role: nextRole,
          organizationId: organizationCtx.organizationId,
        },
      });

      await this.invalidateMemberCacheSafe(
        organizationCtx.organizationId,
        targetMember.userId,
      );

      return updated;
    } catch (error) {
      throw this.mapBetterAuthError(error);
    }
  }

  async removeMember(
    organizationCtx: AuthenticatedOrganization,
    memberId: string,
    rawHeaders: IncomingHttpHeaders,
  ) {
    const targetMember = await this.prismaService.raw.member.findFirst({
      where: {
        id: memberId,
        organizationId: organizationCtx.organizationId,
      },
      select: {
        id: true,
        userId: true,
        role: true,
      },
    });

    if (!targetMember) {
      throw new NotFoundException("Organization member not found.");
    }

    const actorIsOwner = parseRoleNames(organizationCtx.role).includes("owner");
    const targetIsOwner = parseRoleNames(targetMember.role).includes("owner");

    if (targetIsOwner && !actorIsOwner) {
      throw new ForbiddenException(
        "Only an organization owner can remove another owner.",
      );
    }

    if (targetIsOwner) {
      await this.ensureAnotherOwnerExists(
        organizationCtx.organizationId,
        targetMember.id,
      );
    }

    try {
      const removed = await auth.api.removeMember({
        headers: fromNodeHeaders(rawHeaders),
        body: {
          memberIdOrEmail: memberId,
          organizationId: organizationCtx.organizationId,
        },
      });

      await this.invalidateMemberCacheSafe(
        organizationCtx.organizationId,
        targetMember.userId,
      );

      return removed;
    } catch (error) {
      throw this.mapBetterAuthError(error);
    }
  }

  async listInvitations(
    organizationCtx: AuthenticatedOrganization,
    status?: string,
  ) {
    const invitations = await this.prismaService.raw.invitation.findMany({
      where: {
        organizationId: organizationCtx.organizationId,
        ...(status ? { status } : {}),
      },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return {
      organizationId: organizationCtx.organizationId,
      items: invitations.map((inv) => ({
        id: inv.id,
        email: inv.email,
        role: inv.role,
        status: inv.status,
        expiresAt: inv.expiresAt,
        createdAt: inv.createdAt,
        invitedBy: inv.user,
      })),
    };
  }

  async createInvitation(
    organizationCtx: AuthenticatedOrganization,
    input: CreateInvitationInput,
    rawHeaders: IncomingHttpHeaders,
  ) {
    const actorIsOwner = parseRoleNames(organizationCtx.role).includes("owner");
    if (input.role === "owner" && !actorIsOwner) {
      throw new ForbiddenException(
        "Only an organization owner can invite a new owner.",
      );
    }

    await this.billingEnforcement?.assertQuotaAvailable(
      organizationCtx.organizationId,
      "maxMembers",
    );

    try {
      const invitation = await auth.api.createInvitation({
        headers: fromNodeHeaders(rawHeaders),
        body: {
          email: input.email.toLowerCase(),
          role: input.role,
          organizationId: organizationCtx.organizationId,
          resend: input.resend ?? false,
        },
      });
      this.analyticsService.captureDomainEvent({
        event: "organization.member_invited",
        distinctId: organizationCtx.userId,
        organizationId: organizationCtx.organizationId,
        properties: {
          invited_role: input.role,
          resend: input.resend ?? false,
        },
      });
      return invitation;
    } catch (error) {
      throw this.mapBetterAuthError(error);
    }
  }

  async cancelInvitation(
    organizationCtx: AuthenticatedOrganization,
    invitationId: string,
    rawHeaders: IncomingHttpHeaders,
  ) {
    const existing = await this.prismaService.raw.invitation.findFirst({
      where: {
        id: invitationId,
        organizationId: organizationCtx.organizationId,
      },
      select: { id: true, status: true },
    });

    if (!existing) {
      throw new NotFoundException("Organization invitation not found.");
    }

    try {
      return await auth.api.cancelInvitation({
        headers: fromNodeHeaders(rawHeaders),
        body: {
          invitationId,
        },
      });
    } catch (error) {
      throw this.mapBetterAuthError(error);
    }
  }

  async acceptInvitation(
    invitationId: string,
    emailVerified: boolean | undefined,
    rawHeaders: IncomingHttpHeaders,
  ) {
    if (!emailVerified) {
      throw new ForbiddenException(
        "Verify your email address before accepting an organization invitation.",
      );
    }

    try {
      return await auth.api.acceptInvitation({
        headers: fromNodeHeaders(rawHeaders),
        body: {
          invitationId,
        },
      });
    } catch (error) {
      throw this.mapBetterAuthError(error);
    }
  }

  async listAuditLogs(limit = 25, cursor?: string) {
    const take = Math.min(Math.max(limit, 1), 100);
    const logs = await this.prismaService.scoped.auditLog.findMany({
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { createdAt: "desc" },
    });

    const hasMore = logs.length > take;
    const items = hasMore ? logs.slice(0, take) : logs;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return {
      items,
      nextCursor,
    };
  }

  private async ensureAnotherOwnerExists(
    organizationId: string,
    excludingMemberId: string,
  ): Promise<void> {
    const otherOwners = await this.prismaService.raw.member.count({
      where: {
        organizationId,
        id: { not: excludingMemberId },
        role: { contains: "owner" },
      },
    });

    if (otherOwners === 0) {
      throw new BadRequestException(
        "Organization must retain at least one owner.",
      );
    }
  }

  private async invalidateMemberCacheSafe(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    try {
      await this.redisService.del(`membership:${organizationId}:${userId}`);
    } catch {
      // Non-fatal if Redis is temporarily unavailable
    }
  }

  private mapBetterAuthError(error: unknown): Error {
    if (error instanceof APIError) {
      const status = error.statusCode;
      if (status === 400) {
        return new BadRequestException(error.message);
      }
      if (status === 403) {
        return new ForbiddenException(error.message);
      }
      if (status === 404) {
        return new NotFoundException(error.message);
      }
      if (status === 409) {
        return new ConflictException(error.message);
      }
      return new BadRequestException(error.message);
    }

    return error instanceof Error
      ? error
      : new BadRequestException("Organization operation failed.");
  }
}

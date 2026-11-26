import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  LocationStatus,
  LocationType,
  Prisma,
  TenantContext,
  type Location,
} from "@scace/db";
import { BillingEnforcementService } from "../billing/billing-enforcement.service.js";
import { PrismaService } from "../database/prisma.service.js";
import { RedisService } from "../redis/redis.service.js";
import type { AuthenticatedTenant } from "../tenancy/tenant.decorators.js";

export interface CreateLocationInput {
  code: string;
  name: string;
  type: LocationType;
  status?: "ACTIVE" | "INACTIVE";
  isDefault?: boolean;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  timezone?: string | null;
  phone?: string | null;
  email?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateLocationInput {
  code?: string;
  name?: string;
  type?: LocationType;
  status?: "ACTIVE" | "INACTIVE";
  isDefault?: boolean;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  timezone?: string | null;
  phone?: string | null;
  email?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ListLocationsQuery {
  type?: LocationType;
  status?: LocationStatus;
  search?: string;
  limit: number;
  cursor?: string;
}

function toNullableJsonInput(
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

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

@Injectable()
export class LocationsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redisService: RedisService,
    @Optional()
    @Inject(BillingEnforcementService)
    private readonly billingEnforcement?: BillingEnforcementService,
  ) {}

  async createLocation(
    tenant: AuthenticatedTenant,
    input: CreateLocationInput,
    ipAddress?: string,
  ): Promise<Location> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    await this.billingEnforcement?.assertQuotaAvailable(
      organizationId,
      "maxLocations",
    );
    const code = input.code.trim().toUpperCase();
    const status = input.status ?? LocationStatus.ACTIVE;

    if (input.isDefault && status !== LocationStatus.ACTIVE) {
      throw new BadRequestException(
        "Only an ACTIVE location can be marked as the default location.",
      );
    }

    try {
      const location = await this.prismaService.raw.$transaction(async (tx) => {
        if (input.isDefault) {
          await tx.location.updateMany({
            where: { organizationId, isDefault: true },
            data: { isDefault: false },
          });
        }

        const created = await tx.location.create({
          data: {
            organizationId,
            code,
            name: input.name.trim(),
            type: input.type,
            status,
            isDefault: input.isDefault ?? false,
            addressLine1: input.addressLine1 ?? null,
            addressLine2: input.addressLine2 ?? null,
            city: input.city ?? null,
            state: input.state ?? null,
            postalCode: input.postalCode ?? null,
            country: input.country ?? null,
            timezone: input.timezone ?? null,
            phone: input.phone ?? null,
            email: input.email ?? null,
            metadata: toNullableJsonInput(input.metadata ?? null),
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "location.created",
            resourceType: "Location",
            resourceId: created.id,
            metadata: {
              code: created.code,
              name: created.name,
              type: created.type,
              isDefault: created.isDefault,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return created;
      });

      await this.invalidateLocationCacheSafe(organizationId, location.id);
      return location;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `A location with code "${code}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async listLocations(tenant: AuthenticatedTenant, query: ListLocationsQuery) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const where: Prisma.LocationWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(search
        ? {
            OR: [
              { code: { contains: search, mode: "insensitive" } },
              { name: { contains: search, mode: "insensitive" } },
              { city: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const records = await this.prismaService.scoped.location.findMany({
      where,
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
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

  async getLocation(
    tenant: AuthenticatedTenant,
    locationId: string,
  ): Promise<Location> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const cacheKey = `tenant:${organizationId}:location:${locationId}`;

    try {
      const cached = await this.redisService.getJson<Location>(cacheKey);
      if (cached && cached.organizationId === organizationId) {
        return cached;
      }
    } catch {
      // Fallback to PostgreSQL
    }

    const location = await this.prismaService.scoped.location.findUnique({
      where: { id: locationId },
    });

    if (!location) {
      throw new NotFoundException("Location was not found.");
    }

    try {
      await this.redisService.setJson(cacheKey, location, 300);
    } catch {
      // Non-fatal cache write error
    }

    return location;
  }

  async updateLocation(
    tenant: AuthenticatedTenant,
    locationId: string,
    input: UpdateLocationInput,
    ipAddress?: string,
  ): Promise<Location> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const nextCode = input.code?.trim().toUpperCase();

    try {
      const updated = await this.prismaService.raw.$transaction(async (tx) => {
        const existing = await tx.location.findFirst({
          where: { id: locationId, organizationId },
        });

        if (!existing) {
          throw new NotFoundException("Location was not found.");
        }

        if (existing.status === LocationStatus.ARCHIVED) {
          throw new BadRequestException(
            "Archived locations cannot be edited. Restore the location first.",
          );
        }

        const effectiveStatus = input.status ?? existing.status;
        const effectiveDefault = input.isDefault ?? existing.isDefault;

        if (effectiveDefault && effectiveStatus !== LocationStatus.ACTIVE) {
          throw new BadRequestException(
            "Only an ACTIVE location can be designated as default.",
          );
        }

        if (input.isDefault === true && !existing.isDefault) {
          await tx.location.updateMany({
            where: { organizationId, isDefault: true, id: { not: locationId } },
            data: { isDefault: false },
          });
        }

        const saved = await tx.location.update({
          where: { id: locationId },
          data: {
            ...(nextCode !== undefined ? { code: nextCode } : {}),
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.type !== undefined ? { type: input.type } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.isDefault !== undefined
              ? { isDefault: input.isDefault }
              : {}),
            ...(input.addressLine1 !== undefined
              ? { addressLine1: input.addressLine1 }
              : {}),
            ...(input.addressLine2 !== undefined
              ? { addressLine2: input.addressLine2 }
              : {}),
            ...(input.city !== undefined ? { city: input.city } : {}),
            ...(input.state !== undefined ? { state: input.state } : {}),
            ...(input.postalCode !== undefined
              ? { postalCode: input.postalCode }
              : {}),
            ...(input.country !== undefined ? { country: input.country } : {}),
            ...(input.timezone !== undefined
              ? { timezone: input.timezone }
              : {}),
            ...(input.phone !== undefined ? { phone: input.phone } : {}),
            ...(input.email !== undefined ? { email: input.email } : {}),
            ...(input.metadata !== undefined
              ? { metadata: toNullableJsonInput(input.metadata) }
              : {}),
            updatedByUserId: tenant.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: tenant.userId,
            action: "location.updated",
            resourceType: "Location",
            resourceId: saved.id,
            metadata: input as unknown as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return saved;
      });

      await this.invalidateLocationCacheSafe(organizationId, locationId);
      return updated;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          `A location with code "${nextCode}" already exists in this organization.`,
        );
      }
      throw error;
    }
  }

  async archiveLocation(
    tenant: AuthenticatedTenant,
    locationId: string,
    reason?: string,
    ipAddress?: string,
  ): Promise<Location> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const archived = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.location.findFirst({
        where: { id: locationId, organizationId },
      });

      if (!existing) {
        throw new NotFoundException("Location was not found.");
      }

      if (existing.status === LocationStatus.ARCHIVED) {
        throw new BadRequestException("Location is already archived.");
      }

      const saved = await tx.location.update({
        where: { id: locationId },
        data: {
          status: LocationStatus.ARCHIVED,
          isDefault: false,
          archivedAt: new Date(),
          archivedByUserId: tenant.userId,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "location.archived",
          resourceType: "Location",
          resourceId: saved.id,
          metadata: {
            code: saved.code,
            previousStatus: existing.status,
            ...(reason ? { reason } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });

    await this.invalidateLocationCacheSafe(organizationId, locationId);
    return archived;
  }

  async restoreLocation(
    tenant: AuthenticatedTenant,
    locationId: string,
    targetStatus: "ACTIVE" | "INACTIVE" = LocationStatus.ACTIVE,
    reason?: string,
    ipAddress?: string,
  ): Promise<Location> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const restored = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.location.findFirst({
        where: { id: locationId, organizationId },
      });

      if (!existing) {
        throw new NotFoundException("Location was not found.");
      }

      if (existing.status !== LocationStatus.ARCHIVED) {
        throw new BadRequestException("Only archived locations can be restored.");
      }

      const saved = await tx.location.update({
        where: { id: locationId },
        data: {
          status: targetStatus,
          archivedAt: null,
          archivedByUserId: null,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "location.restored",
          resourceType: "Location",
          resourceId: saved.id,
          metadata: {
            code: saved.code,
            targetStatus,
            ...(reason ? { reason } : {}),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });

    await this.invalidateLocationCacheSafe(organizationId, locationId);
    return restored;
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedTenant): string {
    const contextOrgId = TenantContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active tenant context mismatch.");
    }
    return tenant.organizationId;
  }

  private async invalidateLocationCacheSafe(
    organizationId: string,
    locationId: string,
  ): Promise<void> {
    try {
      await this.redisService.invalidateTenantCache(
        organizationId,
        `location:${locationId}`,
      );
    } catch {
      // Non-fatal
    }
  }
}

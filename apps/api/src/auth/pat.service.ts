import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { type Prisma } from "@scace/db";
import { PrismaService } from "../database/prisma.service.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import { RedisService } from "../redis/redis.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import {
  generateRandomToken,
  matchesIpAllowlist,
  sha256Hex,
} from "./crypto.utils.js";
import {
  hasOrganizationPermission,
  isValidErpScope,
  normalizeScopesInput,
  parseRoleNames,
  type ErpResource,
} from "./permissions.js";

export interface VerifiedPatIdentity {
  patId: string;
  organizationId: string;
  userId: string;
  userEmail: string;
  userName: string;
  scopes: string[];
}

export interface CreatePatInput {
  name: string;
  scopes: string[];
  expiresAt?: string;
  expiresInDays?: number;
  ipAllowlist?: string[];
}

@Injectable()
export class PatService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redisService: RedisService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  private cacheKey(tokenHash: string): string {
    return `pat:v1:${tokenHash}`;
  }

  private async recordAudit(params: {
    organizationId: string;
    actorUserId: string;
    action: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }) {
    try {
      await this.prismaService.raw.auditLog.create({
        data: {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          action: params.action,
          resourceType: "PersonalAccessToken",
          resourceId: params.resourceId,
          metadata: (params.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch {
      // Non-fatal audit write failure
    }
  }

  async createPat(tenant: AuthenticatedOrganization, input: CreatePatInput) {
    if (tenant.authMethod && tenant.authMethod !== "COOKIE_SESSION" && tenant.authMethod !== "BEARER_SESSION") {
      throw new ForbiddenException(
        "Personal Access Tokens can only be issued from an authenticated user session.",
      );
    }

    const scopes = normalizeScopesInput(input.scopes);
    if (scopes.length === 0) {
      throw new BadRequestException("At least one ERP permission scope is required for a PAT.");
    }

    for (const scope of scopes) {
      if (!isValidErpScope(scope)) {
        throw new BadRequestException(`Invalid ERP permission scope: "${scope}".`);
      }
      const [resource, action] = scope.split(":") as [ErpResource, string];
      const allowedByRole = hasOrganizationPermission(tenant.role, {
        [resource]: [action] as never,
      });
      if (!allowedByRole) {
        throw new ForbiddenException(
          `Your current organization role does not grant "${scope}".`,
        );
      }
    }

    let expiresAt: Date | null = null;
    if (input.expiresAt) {
      const parsed = new Date(input.expiresAt);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        throw new BadRequestException("expiresAt must be a valid future ISO timestamp.");
      }
      expiresAt = parsed;
    } else if (input.expiresInDays) {
      expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
    }

    const prefixSlug = generateRandomToken(9).replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "token12345";
    const tokenPrefix = `scace_pat_${prefixSlug}`;
    const secretPart = generateRandomToken(32);
    const rawToken = `${tokenPrefix}_${secretPart}`;
    const tokenHash = sha256Hex(rawToken);

    const created = await this.prismaService.scoped.personalAccessToken.create({
      data: {
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        name: input.name,
        tokenPrefix,
        tokenHash,
        scopes,
        ipAllowlist: input.ipAllowlist ?? [],
        expiresAt,
      },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        scopes: true,
        ipAllowlist: true,
        expiresAt: true,
        createdAt: true,
        organizationId: true,
        userId: true,
      },
    });

    await this.recordAudit({
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
      action: "pat.created",
      resourceId: created.id,
      metadata: {
        name: created.name,
        tokenPrefix: created.tokenPrefix,
        scopes: created.scopes,
        expiresAt: created.expiresAt?.toISOString() ?? null,
      },
    });

    this.analyticsService.captureDomainEvent({
      event: "auth.pat_created",
      distinctId: tenant.userId,
      organizationId: tenant.organizationId,
      properties: {
        pat_id: created.id,
        scope_count: created.scopes.length,
        has_expiry: Boolean(created.expiresAt),
        has_ip_allowlist: (input.ipAllowlist?.length ?? 0) > 0,
      },
    });

    return {
      ...created,
      token: rawToken,
      warning: "Store this Personal Access Token securely now. It will not be shown again.",
    };
  }

  async listPats(tenant: AuthenticatedOrganization, includeAll = false) {
    const roles = parseRoleNames(tenant.role);
    const isAdminOrOwner = roles.includes("owner") || roles.includes("admin");

    const where: Prisma.PersonalAccessTokenWhereInput =
      includeAll && isAdminOrOwner
        ? { organizationId: tenant.organizationId }
        : { organizationId: tenant.organizationId, userId: tenant.userId };

    const items = await this.prismaService.scoped.personalAccessToken.findMany({
      where,
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        scopes: true,
        ipAllowlist: true,
        lastUsedAt: true,
        lastUsedIp: true,
        expiresAt: true,
        revokedAt: true,
        revokedByUserId: true,
        createdAt: true,
        userId: true,
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

    return { items };
  }

  async revokePat(tenant: AuthenticatedOrganization, patId: string) {
    const existing = await this.prismaService.scoped.personalAccessToken.findUnique({
      where: { id: patId },
      select: {
        id: true,
        organizationId: true,
        userId: true,
        tokenHash: true,
        tokenPrefix: true,
        name: true,
        revokedAt: true,
      },
    });

    if (!existing || existing.organizationId !== tenant.organizationId) {
      throw new NotFoundException("Personal Access Token not found.");
    }

    const roles = parseRoleNames(tenant.role);
    const isAdminOrOwner = roles.includes("owner") || roles.includes("admin");
    if (existing.userId !== tenant.userId && !isAdminOrOwner) {
      throw new ForbiddenException("You can only revoke your own Personal Access Tokens.");
    }

    if (existing.revokedAt) {
      return { id: existing.id, revoked: true, revokedAt: existing.revokedAt };
    }

    const now = new Date();
    await this.prismaService.scoped.personalAccessToken.update({
      where: { id: existing.id },
      data: {
        revokedAt: now,
        revokedByUserId: tenant.userId,
      },
    });

    try {
      await this.redisService.del(this.cacheKey(existing.tokenHash));
    } catch {
      // ignore cache failure
    }

    await this.recordAudit({
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
      action: "pat.revoked",
      resourceId: existing.id,
      metadata: {
        name: existing.name,
        tokenPrefix: existing.tokenPrefix,
        ownerUserId: existing.userId,
      },
    });

    return { id: existing.id, revoked: true, revokedAt: now };
  }

  async verifyToken(
    rawToken: string,
    clientIp?: string,
  ): Promise<VerifiedPatIdentity | null> {
    if (!rawToken.startsWith("scace_pat_")) {
      return null;
    }

    const tokenHash = sha256Hex(rawToken);
    const cacheKey = this.cacheKey(tokenHash);

    interface CachedPat {
      patId: string;
      organizationId: string;
      userId: string;
      userEmail: string;
      userName: string;
      scopes: string[];
      ipAllowlist: string[];
      expiresAt: string | null;
      revokedAt: string | null;
    }

    let record: CachedPat | null = null;
    try {
      record = await this.redisService.getJson<CachedPat>(cacheKey);
    } catch {
      record = null;
    }

    if (!record) {
      const dbPat = await this.prismaService.raw.personalAccessToken.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          organizationId: true,
          userId: true,
          scopes: true,
          ipAllowlist: true,
          expiresAt: true,
          revokedAt: true,
          user: {
            select: {
              email: true,
              name: true,
              emailVerified: true,
            },
          },
        },
      });

      if (!dbPat || !dbPat.user?.emailVerified) {
        return null;
      }

      record = {
        patId: dbPat.id,
        organizationId: dbPat.organizationId,
        userId: dbPat.userId,
        userEmail: dbPat.user.email,
        userName: dbPat.user.name,
        scopes: dbPat.scopes,
        ipAllowlist: dbPat.ipAllowlist,
        expiresAt: dbPat.expiresAt ? dbPat.expiresAt.toISOString() : null,
        revokedAt: dbPat.revokedAt ? dbPat.revokedAt.toISOString() : null,
      };

      try {
        await this.redisService.setJson(cacheKey, record, 60);
      } catch {
        // non-fatal
      }
    }

    if (record.revokedAt) {
      return null;
    }
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
      return null;
    }
    if (!matchesIpAllowlist(clientIp, record.ipAllowlist)) {
      return null;
    }

    void this.prismaService.raw.personalAccessToken
      .update({
        where: { id: record.patId },
        data: {
          lastUsedAt: new Date(),
          lastUsedIp: clientIp ?? null,
        },
      })
      .catch(() => undefined);

    return {
      patId: record.patId,
      organizationId: record.organizationId,
      userId: record.userId,
      userEmail: record.userEmail,
      userName: record.userName,
      scopes: record.scopes,
    };
  }
}

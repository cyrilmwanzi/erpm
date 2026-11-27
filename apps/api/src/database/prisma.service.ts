import { Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  disconnectPrisma,
  forOrganization,
  organizationPrisma,
  prisma,
} from "@scace/db";

@Injectable()
export class PrismaService implements OnModuleDestroy {
  /**
   * Unscoped Prisma client for system-level queries, health checks,
   * and Better Auth's database adapter.
   */
  public readonly raw = prisma;

  /**
   * Context-aware organization-isolated Prisma client. Automatically scopes
   * queries and mutations on organization-scoped models using OrganizationContext.
   */
  public readonly scoped = organizationPrisma;

  /**
   * Returns a Prisma client explicitly locked to a specific organizationId.
   */
  forOrganization(organizationId: string) {
    return forOrganization(organizationId);
  }

  async ping(): Promise<boolean> {
    await this.raw.$queryRaw`SELECT 1`;
    return true;
  }

  async onModuleDestroy(): Promise<void> {
    await disconnectPrisma();
  }
}

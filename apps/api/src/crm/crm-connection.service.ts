import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  PreconditionFailedException,
} from "@nestjs/common";
import { CrmProvider, type Prisma } from "@scace/db";
import { getEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import {
  decryptCrmSecret,
  encryptCrmSecret,
  maskSecretTail,
  validateCustomerMatesBaseUrl,
} from "./crm-security.utils.js";
import {
  CustomerMatesClient,
  type CustomerMatesConnectionContext,
} from "./customermates.client.js";

export interface UpsertCrmConnectionInput {
  baseUrl: string;
  workspaceId?: string | null;
  apiKey?: string;
  webhookSecret?: string | null;
  isEnabled?: boolean;
  sandboxMode?: boolean;
}

@Injectable()
export class CrmConnectionService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(CustomerMatesClient)
    private readonly customerMatesClient: CustomerMatesClient,
  ) {}

  private serializeConnection(
    organizationId: string,
    conn: {
      id: string;
      provider: CrmProvider;
      baseUrl: string;
      workspaceId: string | null;
      apiKeyLast4: string;
      webhookSecretEncrypted: string | null;
      isEnabled: boolean;
      sandboxMode: boolean;
      lastTestedAt: Date | null;
      lastTestStatus: string | null;
      lastTestMessage: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
  ) {
    return {
      configured: true,
      id: conn.id,
      organizationId,
      provider: conn.provider,
      baseUrl: conn.baseUrl,
      workspaceId: conn.workspaceId,
      apiKeyMasked: `****${conn.apiKeyLast4}`,
      hasWebhookSecret: Boolean(conn.webhookSecretEncrypted),
      webhookCallbackPath: `/api/v1/crm/webhooks/${organizationId}`,
      isEnabled: conn.isEnabled,
      sandboxMode: conn.sandboxMode,
      lastTestedAt: conn.lastTestedAt,
      lastTestStatus: conn.lastTestStatus,
      lastTestMessage: conn.lastTestMessage,
      createdAt: conn.createdAt,
      updatedAt: conn.updatedAt,
    };
  }

  async getConnectionStatus(tenant: AuthenticatedOrganization) {
    const conn = await this.prismaService.scoped.crmConnection.findFirst({
      where: { organizationId: tenant.organizationId },
    });

    if (!conn) {
      return {
        configured: false,
        organizationId: tenant.organizationId,
        provider: CrmProvider.CUSTOMERMATES,
        webhookCallbackPath: `/api/v1/crm/webhooks/${tenant.organizationId}`,
      };
    }

    return this.serializeConnection(tenant.organizationId, conn);
  }

  async upsertConnection(
    tenant: AuthenticatedOrganization,
    input: UpsertCrmConnectionInput,
    ipAddress?: string,
  ) {
    const env = getEnv();
    const sandboxMode = Boolean(input.sandboxMode);
    const cleanBaseUrl = validateCustomerMatesBaseUrl(
      input.baseUrl,
      env.CRM_ALLOW_PRIVATE_URLS,
      sandboxMode,
    );

    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.crmConnection.findFirst({
        where: { organizationId: tenant.organizationId },
      });

      const apiKeyPlain = input.apiKey?.trim();
      if (!existing && (!apiKeyPlain || apiKeyPlain.length < 8)) {
        throw new BadRequestException(
          "apiKey (minimum 8 characters) is required when creating a CustomerMates connection.",
        );
      }

      const apiKeyEncrypted = apiKeyPlain
        ? encryptCrmSecret(apiKeyPlain)
        : existing!.apiKeyEncrypted;
      const apiKeyLast4 = apiKeyPlain
        ? maskSecretTail(apiKeyPlain)
        : existing!.apiKeyLast4;

      let webhookSecretEncrypted = existing?.webhookSecretEncrypted ?? null;
      if (input.webhookSecret !== undefined) {
        if (input.webhookSecret === null || input.webhookSecret.trim().length === 0) {
          webhookSecretEncrypted = null;
        } else {
          webhookSecretEncrypted = encryptCrmSecret(input.webhookSecret.trim());
        }
      }

      const saved = existing
        ? await tx.crmConnection.update({
            where: { id: existing.id },
            data: {
              baseUrl: cleanBaseUrl,
              workspaceId:
                input.workspaceId !== undefined
                  ? input.workspaceId?.trim() || null
                  : existing.workspaceId,
              apiKeyEncrypted,
              apiKeyLast4,
              webhookSecretEncrypted,
              isEnabled: input.isEnabled ?? existing.isEnabled,
              sandboxMode:
                input.sandboxMode !== undefined
                  ? input.sandboxMode
                  : existing.sandboxMode,
              updatedByUserId: tenant.userId,
            },
          })
        : await tx.crmConnection.create({
            data: {
              organizationId: tenant.organizationId,
              provider: CrmProvider.CUSTOMERMATES,
              baseUrl: cleanBaseUrl,
              workspaceId: input.workspaceId?.trim() || null,
              apiKeyEncrypted,
              apiKeyLast4,
              webhookSecretEncrypted,
              isEnabled: input.isEnabled ?? true,
              sandboxMode,
              createdByUserId: tenant.userId,
              updatedByUserId: tenant.userId,
            },
          });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "crm.connection.updated",
          resourceType: "CrmConnection",
          resourceId: saved.id,
          metadata: {
            baseUrl: saved.baseUrl,
            workspaceId: saved.workspaceId,
            isEnabled: saved.isEnabled,
            sandboxMode: saved.sandboxMode,
            rotatedApiKey: Boolean(apiKeyPlain),
            hasWebhookSecret: Boolean(saved.webhookSecretEncrypted),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return this.serializeConnection(tenant.organizationId, saved);
    });
  }

  async testConnection(tenant: AuthenticatedOrganization, ipAddress?: string) {
    const ctx = await this.resolveActiveConnection(tenant.organizationId, true);
    const probe = await this.customerMatesClient.pingWorkspace(ctx);

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const conn = await tx.crmConnection.findFirst({
        where: { organizationId: tenant.organizationId },
      });
      if (!conn) {
        throw new NotFoundException("CustomerMates connection not found.");
      }

      const saved = await tx.crmConnection.update({
        where: { id: conn.id },
        data: {
          lastTestedAt: new Date(),
          lastTestStatus: probe.reachable ? "ok" : "error",
          lastTestMessage: probe.detail.slice(0, 500),
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "crm.connection.tested",
          resourceType: "CrmConnection",
          resourceId: saved.id,
          metadata: {
            reachable: probe.reachable,
            mode: probe.mode,
            detail: probe.detail,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });

    return {
      ...probe,
      connection: this.serializeConnection(tenant.organizationId, updated),
    };
  }

  async deleteConnection(tenant: AuthenticatedOrganization, ipAddress?: string) {
    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.crmConnection.findFirst({
        where: { organizationId: tenant.organizationId },
      });
      if (!existing) {
        throw new NotFoundException("CustomerMates connection not configured.");
      }

      await tx.crmConnection.delete({ where: { id: existing.id } });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "crm.connection.deleted",
          resourceType: "CrmConnection",
          resourceId: existing.id,
          ipAddress: ipAddress ?? null,
        },
      });

      return { deleted: true, organizationId: tenant.organizationId };
    });
  }

  async resolveActiveConnection(
    organizationId: string,
    allowDisabled = false,
  ): Promise<CustomerMatesConnectionContext> {
    const conn = await this.prismaService.raw.crmConnection.findFirst({
      where: { organizationId },
    });

    if (!conn) {
      throw new PreconditionFailedException(
        "CustomerMates CRM is not configured for this organization. An admin must configure /api/v1/crm/connection first.",
      );
    }

    if (!allowDisabled && !conn.isEnabled) {
      throw new PreconditionFailedException(
        "CustomerMates CRM integration is currently disabled for this organization.",
      );
    }

    const apiKey = decryptCrmSecret(conn.apiKeyEncrypted);

    return {
      organizationId,
      baseUrl: conn.baseUrl,
      workspaceId: conn.workspaceId,
      apiKey,
      sandboxMode: conn.sandboxMode,
    };
  }
}

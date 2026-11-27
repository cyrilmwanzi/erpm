import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  MpesaC2bResponseType,
  MpesaEnvironment,
  MpesaShortcodeType,
  Prisma,
  OrganizationContext,
} from "@scace/db";
import {
  generateRandomToken,
  safeEqualStrings,
  sha256Hex,
} from "../auth/crypto.utils.js";
import { getEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import {
  MpesaDarajaClient,
  type DarajaCredentialsContext,
} from "./mpesa-daraja.client.js";
import {
  decryptPaymentSecret,
  encryptPaymentSecret,
  maskSecretTail,
  validateIpAllowlistEntries,
} from "./mpesa-security.utils.js";

export interface UpsertMpesaConfigurationInput {
  isEnabled?: boolean;
  environment?: MpesaEnvironment;
  shortcodeType?: MpesaShortcodeType;
  businessShortCode: string;
  partyB?: string | null;
  consumerKey?: string | null;
  consumerSecret?: string | null;
  passkey?: string | null;
  callbackIpAllowlist?: string[];
  c2bResponseType?: MpesaC2bResponseType;
  c2bValidateReference?: boolean;
  accountReferencePrefix?: string | null;
  transactionDescTemplate?: string | null;
}

export interface SanitizedMpesaConfigResponse {
  id: string;
  organizationId: string;
  isEnabled: boolean;
  environment: MpesaEnvironment;
  shortcodeType: MpesaShortcodeType;
  businessShortCode: string;
  partyB: string | null;
  hasConsumerKey: boolean;
  maskedConsumerKey: string | null;
  hasConsumerSecret: boolean;
  maskedConsumerSecret: string | null;
  hasPasskey: boolean;
  maskedPasskey: string | null;
  callbackIpAllowlist: string[];
  c2bResponseType: MpesaC2bResponseType;
  c2bValidateReference: boolean;
  accountReferencePrefix: string | null;
  transactionDescTemplate: string | null;
  callbackUrls: {
    stkCallbackTemplate: string;
    c2bValidationUrl: string;
    c2bConfirmationUrl: string;
  };
  c2bRegisteredAt: Date | null;
  lastTestedAt: Date | null;
  lastTestStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class MpesaConfigService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(MpesaDarajaClient) private readonly darajaClient: MpesaDarajaClient,
  ) {}

  async getConfig(tenant: AuthenticatedOrganization): Promise<SanitizedMpesaConfigResponse | null> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const config = await this.prismaService.scoped.mpesaConfiguration.findFirst({
      where: { organizationId },
    });
    if (!config) {
      return null;
    }
    return this.toSanitizedResponse(config);
  }

  async upsertConfig(
    tenant: AuthenticatedOrganization,
    input: UpsertMpesaConfigurationInput,
    ipAddress?: string,
  ): Promise<SanitizedMpesaConfigResponse> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);

    const validatedAllowlist =
      input.callbackIpAllowlist !== undefined
        ? validateIpAllowlistEntries(input.callbackIpAllowlist)
        : undefined;

    const existing = await this.prismaService.raw.mpesaConfiguration.findUnique({
      where: { organizationId },
    });

    const nextEnvironment =
      input.environment ?? existing?.environment ?? MpesaEnvironment.SANDBOX;
    const nextEnabled =
      input.isEnabled !== undefined ? input.isEnabled : (existing?.isEnabled ?? false);
    const nextShortcodeType =
      input.shortcodeType ?? existing?.shortcodeType ?? MpesaShortcodeType.PAYBILL;
    const businessShortCode = input.businessShortCode.trim();
    const partyB =
      input.partyB !== undefined
        ? input.partyB?.trim() || null
        : (existing?.partyB ?? null);

    let consumerKeyEncrypted = existing?.consumerKeyEncrypted ?? null;
    if (input.consumerKey !== undefined) {
      consumerKeyEncrypted =
        input.consumerKey && input.consumerKey.trim().length > 0
          ? encryptPaymentSecret(input.consumerKey.trim())
          : null;
    }

    let consumerSecretEncrypted = existing?.consumerSecretEncrypted ?? null;
    if (input.consumerSecret !== undefined) {
      consumerSecretEncrypted =
        input.consumerSecret && input.consumerSecret.trim().length > 0
          ? encryptPaymentSecret(input.consumerSecret.trim())
          : null;
    }

    let passkeyEncrypted = existing?.passkeyEncrypted ?? null;
    if (input.passkey !== undefined) {
      passkeyEncrypted =
        input.passkey && input.passkey.trim().length > 0
          ? encryptPaymentSecret(input.passkey.trim())
          : null;
    }

    if (
      nextEnabled &&
      nextEnvironment !== MpesaEnvironment.LOCAL_SIMULATOR &&
      (!consumerKeyEncrypted || !consumerSecretEncrypted || !passkeyEncrypted)
    ) {
      throw new BadRequestException(
        "Enabling live SANDBOX or PRODUCTION M-Pesa requires consumerKey, consumerSecret, and passkey.",
      );
    }

    let callbackRouteTokenHash = existing?.callbackRouteTokenHash;
    let callbackRouteTokenEncrypted = existing?.callbackRouteTokenEncrypted;
    if (!callbackRouteTokenHash || !callbackRouteTokenEncrypted) {
      const freshToken = generateRandomToken(32);
      callbackRouteTokenHash = sha256Hex(freshToken);
      callbackRouteTokenEncrypted = encryptPaymentSecret(freshToken);
    }

    const saved = await this.prismaService.raw.$transaction(async (tx) => {
      const record = existing
        ? await tx.mpesaConfiguration.update({
            where: { organizationId },
            data: {
              isEnabled: nextEnabled,
              environment: nextEnvironment,
              shortcodeType: nextShortcodeType,
              businessShortCode,
              partyB,
              consumerKeyEncrypted,
              consumerSecretEncrypted,
              passkeyEncrypted,
              ...(validatedAllowlist !== undefined
                ? { callbackIpAllowlist: validatedAllowlist }
                : {}),
              ...(input.c2bResponseType !== undefined
                ? { c2bResponseType: input.c2bResponseType }
                : {}),
              ...(input.c2bValidateReference !== undefined
                ? { c2bValidateReference: input.c2bValidateReference }
                : {}),
              ...(input.accountReferencePrefix !== undefined
                ? {
                    accountReferencePrefix:
                      input.accountReferencePrefix?.trim().toUpperCase() || null,
                  }
                : {}),
              ...(input.transactionDescTemplate !== undefined
                ? {
                    transactionDescTemplate:
                      input.transactionDescTemplate?.trim() || null,
                  }
                : {}),
              updatedByUserId: tenant.userId,
            },
          })
        : await tx.mpesaConfiguration.create({
            data: {
              organizationId,
              isEnabled: nextEnabled,
              environment: nextEnvironment,
              shortcodeType: nextShortcodeType,
              businessShortCode,
              partyB,
              consumerKeyEncrypted,
              consumerSecretEncrypted,
              passkeyEncrypted,
              callbackRouteTokenHash,
              callbackRouteTokenEncrypted,
              callbackIpAllowlist: validatedAllowlist ?? [],
              c2bResponseType:
                input.c2bResponseType ?? MpesaC2bResponseType.COMPLETED,
              c2bValidateReference: input.c2bValidateReference ?? true,
              accountReferencePrefix:
                input.accountReferencePrefix?.trim().toUpperCase() || null,
              transactionDescTemplate:
                input.transactionDescTemplate?.trim() || null,
              createdByUserId: tenant.userId,
              updatedByUserId: tenant.userId,
            },
          });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "payment.mpesa.configured",
          resourceType: "MpesaConfiguration",
          resourceId: record.id,
          metadata: {
            environment: record.environment,
            shortcodeType: record.shortcodeType,
            businessShortCode: record.businessShortCode,
            isEnabled: record.isEnabled,
            allowlistCount: record.callbackIpAllowlist.length,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return record;
    });

    return this.toSanitizedResponse(saved);
  }

  async rotateCallbackToken(
    tenant: AuthenticatedOrganization,
    ipAddress?: string,
  ): Promise<SanitizedMpesaConfigResponse> {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const existing = await this.prismaService.raw.mpesaConfiguration.findUnique({
      where: { organizationId },
    });
    if (!existing) {
      throw new NotFoundException("M-Pesa configuration was not found for this organization.");
    }

    const freshToken = generateRandomToken(32);
    const callbackRouteTokenHash = sha256Hex(freshToken);
    const callbackRouteTokenEncrypted = encryptPaymentSecret(freshToken);

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const record = await tx.mpesaConfiguration.update({
        where: { organizationId },
        data: {
          callbackRouteTokenHash,
          callbackRouteTokenEncrypted,
          c2bRegisteredAt: null,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "payment.mpesa.callback_token_rotated",
          resourceType: "MpesaConfiguration",
          resourceId: record.id,
          metadata: {
            businessShortCode: record.businessShortCode,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return record;
    });

    return this.toSanitizedResponse(updated);
  }

  async testConnection(
    tenant: AuthenticatedOrganization,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const { config, credentials } =
      await this.resolveCredentialsForOrg(organizationId, false);

    let statusText = "OK";
    let simulated = false;
    try {
      const tokenRes = await this.darajaClient.getAccessToken(credentials, true);
      simulated = tokenRes.simulated;
      statusText = simulated
        ? "LOCAL_SIMULATOR_READY"
        : "DARAJA_OAUTH_VERIFIED";
    } catch (error) {
      statusText = `FAILED: ${
        error instanceof Error ? error.message.slice(0, 120) : "Unknown error"
      }`;
      await this.prismaService.raw.mpesaConfiguration.update({
        where: { organizationId },
        data: {
          lastTestedAt: new Date(),
          lastTestStatus: statusText,
        },
      });
      throw error;
    }

    const now = new Date();
    await this.prismaService.raw.$transaction(async (tx) => {
      await tx.mpesaConfiguration.update({
        where: { organizationId },
        data: {
          lastTestedAt: now,
          lastTestStatus: statusText,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "payment.mpesa.connection_tested",
          resourceType: "MpesaConfiguration",
          resourceId: config.id,
          metadata: {
            environment: config.environment,
            status: statusText,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });
    });

    return {
      organizationId,
      environment: config.environment,
      status: statusText,
      simulated,
      testedAt: now.toISOString(),
    };
  }

  async registerC2bUrls(
    tenant: AuthenticatedOrganization,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const { config, credentials, callbackRouteToken } =
      await this.resolveCredentialsForOrg(organizationId, true);

    const urls = this.buildCallbackUrls(callbackRouteToken);
    const response = await this.darajaClient.registerC2bUrls({
      credentials,
      validationUrl: urls.c2bValidationUrl,
      confirmationUrl: urls.c2bConfirmationUrl,
      responseType:
        config.c2bResponseType === MpesaC2bResponseType.CANCELLED
          ? "Cancelled"
          : "Completed",
    });

    const now = new Date();
    await this.prismaService.raw.$transaction(async (tx) => {
      await tx.mpesaConfiguration.update({
        where: { organizationId },
        data: {
          c2bRegisteredAt: now,
          updatedByUserId: tenant.userId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: tenant.userId,
          action: "payment.mpesa.c2b_urls_registered",
          resourceType: "MpesaConfiguration",
          resourceId: config.id,
          metadata: {
            environment: config.environment,
            businessShortCode: config.businessShortCode,
            responseCode: response.responseCode,
            simulated: response.simulated,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });
    });

    return {
      organizationId,
      businessShortCode: config.businessShortCode,
      validationUrl: urls.c2bValidationUrl,
      confirmationUrl: urls.c2bConfirmationUrl,
      registeredAt: now.toISOString(),
      darajaResponse: response,
    };
  }

  async resolveCredentialsForOrg(
    organizationId: string,
    requireEnabled = true,
  ): Promise<{
    config: Awaited<
      ReturnType<PrismaService["raw"]["mpesaConfiguration"]["findUniqueOrThrow"]>
    >;
    credentials: DarajaCredentialsContext;
    callbackRouteToken: string;
  }> {
    const config = await this.prismaService.raw.mpesaConfiguration.findUnique({
      where: { organizationId },
    });
    if (!config) {
      throw new BadRequestException(
        "M-Pesa is not configured for this organization. Ask an organization admin to configure M-Pesa settings first.",
      );
    }
    if (requireEnabled && !config.isEnabled) {
      throw new BadRequestException(
        "M-Pesa payment processing is currently disabled for this organization.",
      );
    }

    const callbackRouteToken = decryptPaymentSecret(
      config.callbackRouteTokenEncrypted,
    );
    const credentials: DarajaCredentialsContext = {
      organizationId,
      environment: config.environment,
      shortcodeType: config.shortcodeType,
      businessShortCode: config.businessShortCode,
      partyB: config.partyB,
      consumerKey: config.consumerKeyEncrypted
        ? decryptPaymentSecret(config.consumerKeyEncrypted)
        : null,
      consumerSecret: config.consumerSecretEncrypted
        ? decryptPaymentSecret(config.consumerSecretEncrypted)
        : null,
      passkey: config.passkeyEncrypted
        ? decryptPaymentSecret(config.passkeyEncrypted)
        : null,
    };

    return { config, credentials, callbackRouteToken };
  }

  async resolveOrganizationByCallbackToken(orgToken: string) {
    const trimmed = orgToken.trim();
    if (!trimmed || trimmed.length < 16) {
      return null;
    }

    const tokenHash = sha256Hex(trimmed);
    const config = await this.prismaService.raw.mpesaConfiguration.findUnique({
      where: { callbackRouteTokenHash: tokenHash },
    });
    if (!config || !config.isEnabled) {
      return null;
    }

    try {
      const decryptedToken = decryptPaymentSecret(config.callbackRouteTokenEncrypted);
      if (!safeEqualStrings(decryptedToken, trimmed)) {
        return null;
      }
    } catch {
      return null;
    }

    return config;
  }

  buildCallbackUrls(callbackRouteToken: string, stkTxToken?: string) {
    const base = getEnv().MPESA_PUBLIC_CALLBACK_BASE_URL;
    const prefix = `${base}/api/v1/webhooks/daraja/o/${callbackRouteToken}`;
    return {
      stkCallbackUrl: stkTxToken
        ? `${prefix}/stk/${stkTxToken}`
        : `${prefix}/stk/{txToken}`,
      c2bValidationUrl: `${prefix}/c2b/validate`,
      c2bConfirmationUrl: `${prefix}/c2b/confirm`,
    };
  }

  private toSanitizedResponse(
    config: NonNullable<
      Awaited<ReturnType<PrismaService["raw"]["mpesaConfiguration"]["findUnique"]>>
    >,
  ): SanitizedMpesaConfigResponse {
    const decryptMask = (enc: string | null): string | null => {
      if (!enc) return null;
      try {
        return maskSecretTail(decryptPaymentSecret(enc));
      } catch {
        return "****";
      }
    };

    const callbackRouteToken = decryptPaymentSecret(
      config.callbackRouteTokenEncrypted,
    );
    const urls = this.buildCallbackUrls(callbackRouteToken);

    return {
      id: config.id,
      organizationId: config.organizationId,
      isEnabled: config.isEnabled,
      environment: config.environment,
      shortcodeType: config.shortcodeType,
      businessShortCode: config.businessShortCode,
      partyB: config.partyB,
      hasConsumerKey: Boolean(config.consumerKeyEncrypted),
      maskedConsumerKey: decryptMask(config.consumerKeyEncrypted),
      hasConsumerSecret: Boolean(config.consumerSecretEncrypted),
      maskedConsumerSecret: decryptMask(config.consumerSecretEncrypted),
      hasPasskey: Boolean(config.passkeyEncrypted),
      maskedPasskey: decryptMask(config.passkeyEncrypted),
      callbackIpAllowlist: config.callbackIpAllowlist,
      c2bResponseType: config.c2bResponseType,
      c2bValidateReference: config.c2bValidateReference,
      accountReferencePrefix: config.accountReferencePrefix,
      transactionDescTemplate: config.transactionDescTemplate,
      callbackUrls: {
        stkCallbackTemplate: urls.stkCallbackUrl,
        c2bValidationUrl: urls.c2bValidationUrl,
        c2bConfirmationUrl: urls.c2bConfirmationUrl,
      },
      c2bRegisteredAt: config.c2bRegisteredAt,
      lastTestedAt: config.lastTestedAt,
      lastTestStatus: config.lastTestStatus,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedOrganization): string {
    const contextOrgId = OrganizationContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active organization context mismatch.");
    }
    return tenant.organizationId;
  }
}

import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  BillingInvoiceStatus,
  BillingPaymentMethod,
  BillingPaymentStatus,
  BillingSubscriptionStatus,
  MpesaEnvironment,
  MpesaShortcodeType,
  Prisma,
  SubscriptionBillingCycle,
} from "@scace/db";
import {
  generateRandomToken,
  matchesIpAllowlist,
  safeEqualStrings,
  sha256Hex,
} from "../auth/crypto.utils.js";
import { getEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import {
  MpesaDarajaClient,
  type DarajaCredentialsContext,
} from "../payments/mpesa-daraja.client.js";
import type { DarajaStkCallbackPayload } from "../payments/mpesa-payment.service.js";
import {
  centsToDarajaWholeAmount,
  normalizeKenyanPhoneNumber,
  parseDarajaAmountToCents,
  parseDarajaTransactionDate,
  sanitizeDarajaAccountReference,
  validateIpAllowlistEntries,
} from "../payments/mpesa-security.utils.js";
import { provisionPlatformBillingDefaults } from "./billing-bootstrap.service.js";
import { BillingEnforcementService } from "./billing-enforcement.service.js";
import {
  addBillingCycleDuration,
  addDays,
  decryptBillingSecret,
  encryptBillingSecret,
  maskBillingSecretTail,
} from "./billing-security.utils.js";

export interface UpsertPlatformMpesaConfigInput {
  isEnabled?: boolean;
  environment?: MpesaEnvironment;
  shortcodeType?: MpesaShortcodeType;
  businessShortCode: string;
  partyB?: string | null;
  consumerKey?: string | null;
  consumerSecret?: string | null;
  passkey?: string | null;
  callbackIpAllowlist?: string[];
  accountReferencePrefix?: string | null;
  transactionDescTemplate?: string | null;
}

export interface SanitizedPlatformMpesaConfig {
  id: string;
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
  accountReferencePrefix: string | null;
  transactionDescTemplate: string | null;
  stkCallbackTemplateUrl: string;
  lastTestedAt: Date | null;
  lastTestStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function generateBillingTxRef(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
}

@Injectable()
export class PlatformMpesaService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(MpesaDarajaClient) private readonly darajaClient: MpesaDarajaClient,
    @Inject(BillingEnforcementService)
    private readonly billingEnforcement: BillingEnforcementService,
  ) {}

  async getConfig(): Promise<SanitizedPlatformMpesaConfig> {
    await provisionPlatformBillingDefaults(this.prismaService.raw);
    const config = await this.prismaService.raw.platformMpesaConfig.findUniqueOrThrow({
      where: { id: "default" },
    });
    return this.toSanitizedResponse(config);
  }

  async upsertConfig(
    actorUserId: string,
    input: UpsertPlatformMpesaConfigInput,
    ipAddress?: string,
  ): Promise<SanitizedPlatformMpesaConfig> {
    await provisionPlatformBillingDefaults(this.prismaService.raw);
    const existing = await this.prismaService.raw.platformMpesaConfig.findUniqueOrThrow({
      where: { id: "default" },
    });

    const validatedAllowlist =
      input.callbackIpAllowlist !== undefined
        ? validateIpAllowlistEntries(input.callbackIpAllowlist)
        : undefined;

    const nextEnvironment = input.environment ?? existing.environment;
    const nextEnabled =
      input.isEnabled !== undefined ? input.isEnabled : existing.isEnabled;
    const nextShortcodeType = input.shortcodeType ?? existing.shortcodeType;
    const businessShortCode = input.businessShortCode.trim();
    const partyB =
      input.partyB !== undefined ? input.partyB?.trim() || null : existing.partyB;

    let consumerKeyEncrypted = existing.consumerKeyEncrypted;
    if (input.consumerKey !== undefined) {
      consumerKeyEncrypted =
        input.consumerKey && input.consumerKey.trim().length > 0
          ? encryptBillingSecret(input.consumerKey.trim())
          : null;
    }

    let consumerSecretEncrypted = existing.consumerSecretEncrypted;
    if (input.consumerSecret !== undefined) {
      consumerSecretEncrypted =
        input.consumerSecret && input.consumerSecret.trim().length > 0
          ? encryptBillingSecret(input.consumerSecret.trim())
          : null;
    }

    let passkeyEncrypted = existing.passkeyEncrypted;
    if (input.passkey !== undefined) {
      passkeyEncrypted =
        input.passkey && input.passkey.trim().length > 0
          ? encryptBillingSecret(input.passkey.trim())
          : null;
    }

    if (
      nextEnabled &&
      nextEnvironment !== MpesaEnvironment.LOCAL_SIMULATOR &&
      (!consumerKeyEncrypted || !consumerSecretEncrypted || !passkeyEncrypted)
    ) {
      throw new BadRequestException(
        "Enabling live SANDBOX or PRODUCTION platform M-Pesa requires consumerKey, consumerSecret, and passkey.",
      );
    }

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const saved = await tx.platformMpesaConfig.update({
        where: { id: "default" },
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
          updatedByUserId: actorUserId,
        },
      });

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId,
          action: "platform.mpesa.configured",
          resourceType: "PlatformMpesaConfig",
          resourceId: saved.id,
          metadata: {
            isEnabled: saved.isEnabled,
            environment: saved.environment,
            shortcodeType: saved.shortcodeType,
            businessShortCode: saved.businessShortCode,
            allowlistCount: saved.callbackIpAllowlist.length,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });

    await this.billingEnforcement.invalidateAllOrganizationCaches();
    return this.toSanitizedResponse(updated);
  }

  async rotateCallbackToken(
    actorUserId: string,
    ipAddress?: string,
  ): Promise<SanitizedPlatformMpesaConfig> {
    await provisionPlatformBillingDefaults(this.prismaService.raw);
    const freshToken = generateRandomToken(32);

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const saved = await tx.platformMpesaConfig.update({
        where: { id: "default" },
        data: {
          callbackRouteTokenHash: sha256Hex(freshToken),
          callbackRouteTokenEncrypted: encryptBillingSecret(freshToken),
          updatedByUserId: actorUserId,
        },
      });

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId,
          action: "platform.mpesa.callback_token_rotated",
          resourceType: "PlatformMpesaConfig",
          resourceId: saved.id,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });

    return this.toSanitizedResponse(updated);
  }

  async testConnection(actorUserId: string, ipAddress?: string) {
    const { config, credentials } = await this.resolvePlatformCredentials(false);

    let statusText = "OK";
    let simulated = false;
    try {
      const res = await this.darajaClient.getAccessToken(credentials, true);
      simulated = res.simulated;
      statusText = simulated ? "LOCAL_SIMULATOR_READY" : "DARAJA_OAUTH_VERIFIED";
    } catch (error) {
      statusText = `FAILED: ${
        error instanceof Error ? error.message.slice(0, 120) : "Unknown error"
      }`;
      await this.prismaService.raw.platformMpesaConfig.update({
        where: { id: "default" },
        data: {
          lastTestedAt: new Date(),
          lastTestStatus: statusText,
          updatedByUserId: actorUserId,
        },
      });
      throw error;
    }

    const now = new Date();
    await this.prismaService.raw.$transaction(async (tx) => {
      await tx.platformMpesaConfig.update({
        where: { id: "default" },
        data: {
          lastTestedAt: now,
          lastTestStatus: statusText,
          updatedByUserId: actorUserId,
        },
      });
      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId,
          action: "platform.mpesa.connection_tested",
          resourceType: "PlatformMpesaConfig",
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
      environment: config.environment,
      status: statusText,
      simulated,
      testedAt: now.toISOString(),
    };
  }

  async initiateStkPushForInvoice(params: {
    organizationId: string;
    invoiceId: string;
    phoneNumber: string;
    actorUserId: string;
    ipAddress?: string;
  }) {
    const normalizedPhone = normalizeKenyanPhoneNumber(params.phoneNumber);
    const { config, credentials, callbackRouteToken } =
      await this.resolvePlatformCredentials(true);

    const invoice = await this.prismaService.raw.billingInvoice.findFirst({
      where: {
        id: params.invoiceId,
        organizationId: params.organizationId,
      },
      include: { plan: true },
    });
    if (!invoice) {
      throw new NotFoundException("Billing invoice was not found.");
    }
    if (
      invoice.status === BillingInvoiceStatus.PAID ||
      invoice.status === BillingInvoiceStatus.WAIVED ||
      invoice.status === BillingInvoiceStatus.VOID
    ) {
      throw new BadRequestException(
        `Invoice "${invoice.invoiceNumber}" is already ${invoice.status}.`,
      );
    }

    const remainingCents = Math.max(0, invoice.totalCents - invoice.amountPaidCents);
    if (remainingCents <= 0) {
      throw new BadRequestException("Invoice balance is already settled.");
    }

    const amountWholeUnits = centsToDarajaWholeAmount(remainingCents);
    const txToken = generateRandomToken(24);
    const referenceNumber = generateBillingTxRef("BPAY");
    const accountReference = sanitizeDarajaAccountReference(
      `${config.accountReferencePrefix ?? "SCACE"}-${invoice.invoiceNumber}`,
    );
    const transactionDesc = (
      config.transactionDescTemplate ||
      `Scace ${invoice.plan.code} Subscription`
    ).slice(0, 32);

    const callbackUrl = this.buildCallbackUrl(callbackRouteToken, txToken);

    const darajaRes = await this.darajaClient.initiateStkPush({
      credentials,
      amountWholeUnits,
      phoneNumber: normalizedPhone,
      accountReference,
      transactionDesc,
      callbackUrl,
    });

    const txRecord = await this.prismaService.raw.$transaction(async (tx) => {
      const created = await tx.billingPaymentTransaction.create({
        data: {
          referenceNumber,
          organizationId: params.organizationId,
          invoiceId: invoice.id,
          method: BillingPaymentMethod.MPESA,
          status: BillingPaymentStatus.PENDING,
          currency: invoice.currency,
          amountCents: remainingCents,
          phoneNumber: normalizedPhone,
          accountReference,
          callbackToken: txToken,
          merchantRequestId: darajaRes.merchantRequestId,
          checkoutRequestId: darajaRes.checkoutRequestId,
          resultCode: darajaRes.responseCode,
          resultDesc: darajaRes.responseDescription,
          initiatedByUserId: params.actorUserId,
        },
      });

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId: params.actorUserId,
          organizationId: params.organizationId,
          action: "billing.mpesa.stk_initiated",
          resourceType: "BillingPaymentTransaction",
          resourceId: created.id,
          metadata: {
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            amountCents: remainingCents,
            checkoutRequestId: darajaRes.checkoutRequestId,
            simulated: darajaRes.simulated,
          } as Prisma.InputJsonValue,
          ipAddress: params.ipAddress ?? null,
        },
      });

      return created;
    });

    return {
      transaction: this.sanitizeTransaction(txRecord),
      invoice,
      daraja: {
        merchantRequestId: darajaRes.merchantRequestId,
        checkoutRequestId: darajaRes.checkoutRequestId,
        customerMessage: darajaRes.customerMessage,
        simulated: darajaRes.simulated,
      },
    };
  }

  async handleStkCallback(params: {
    platformToken: string;
    txToken: string;
    payload: DarajaStkCallbackPayload;
    clientIp?: string;
  }) {
    const config = await this.resolveConfigByCallbackToken(params.platformToken);
    if (!config) {
      throw new UnauthorizedException("Invalid platform M-Pesa callback token.");
    }

    if (
      config.callbackIpAllowlist.length > 0 &&
      !matchesIpAllowlist(params.clientIp, config.callbackIpAllowlist)
    ) {
      throw new UnauthorizedException("Callback source IP is not allowlisted.");
    }

    const cb = params.payload.Body.stkCallback;
    const txRecord =
      await this.prismaService.raw.billingPaymentTransaction.findFirst({
        where: {
          callbackToken: params.txToken,
          checkoutRequestId: cb.CheckoutRequestID,
        },
      });

    if (!txRecord || !txRecord.callbackToken) {
      throw new NotFoundException("Matching billing payment transaction not found.");
    }
    if (!safeEqualStrings(txRecord.callbackToken, params.txToken)) {
      throw new UnauthorizedException("Invalid transaction callback token.");
    }

    return this.finalizeStkResult({
      transactionId: txRecord.id,
      resultCode: String(cb.ResultCode),
      resultDesc: cb.ResultDesc,
      callbackMetadata: cb.CallbackMetadata?.Item ?? [],
      rawPayload: params.payload,
    });
  }

  async queryStkStatusAndReconcile(params: {
    organizationId: string;
    transactionId: string;
    actorUserId: string;
    ipAddress?: string;
  }) {
    const txRecord =
      await this.prismaService.raw.billingPaymentTransaction.findFirst({
        where: {
          id: params.transactionId,
          organizationId: params.organizationId,
        },
      });

    if (!txRecord) {
      throw new NotFoundException("Billing payment transaction was not found.");
    }

    if (txRecord.status !== BillingPaymentStatus.PENDING) {
      return {
        reconciled: false,
        transaction: this.sanitizeTransaction(txRecord),
      };
    }

    if (!txRecord.checkoutRequestId) {
      throw new BadRequestException(
        "Transaction has no Daraja CheckoutRequestID to query.",
      );
    }

    const { credentials } = await this.resolvePlatformCredentials(true);
    const queryRes = await this.darajaClient.queryStkPushStatus({
      credentials,
      checkoutRequestId: txRecord.checkoutRequestId,
    });

    if (queryRes.resultCode === "PENDING") {
      return {
        reconciled: false,
        darajaStatus: queryRes,
        transaction: this.sanitizeTransaction(txRecord),
      };
    }

    const result = await this.finalizeStkResult({
      transactionId: txRecord.id,
      resultCode: queryRes.resultCode,
      resultDesc: queryRes.resultDesc,
      callbackMetadata: [],
      rawPayload: queryRes,
      actorUserId: params.actorUserId,
      ipAddress: params.ipAddress,
    });

    return {
      reconciled: true,
      darajaStatus: queryRes,
      ...result,
    };
  }

  async simulateStkCallback(params: {
    organizationId: string;
    transactionId: string;
    outcome: "SUCCESS" | "CANCELLED" | "FAILED" | "TIMEOUT";
    mpesaReceiptNumber?: string;
    resultDesc?: string;
    actorUserId: string;
    ipAddress?: string;
  }) {
    const { config } = await this.resolvePlatformCredentials(true);
    if (config.environment !== MpesaEnvironment.LOCAL_SIMULATOR) {
      throw new BadRequestException(
        "Platform M-Pesa simulator is only available when environment is LOCAL_SIMULATOR.",
      );
    }

    const txRecord =
      await this.prismaService.raw.billingPaymentTransaction.findFirst({
        where: {
          id: params.transactionId,
          organizationId: params.organizationId,
        },
      });
    if (!txRecord) {
      throw new NotFoundException("Billing payment transaction was not found.");
    }

    const outcomeMap: Record<
      "SUCCESS" | "CANCELLED" | "FAILED" | "TIMEOUT",
      { code: string; desc: string }
    > = {
      SUCCESS: {
        code: "0",
        desc: "The service request is processed successfully.",
      },
      CANCELLED: { code: "1032", desc: "Request cancelled by user." },
      FAILED: {
        code: "1",
        desc: "The balance is insufficient for the transaction.",
      },
      TIMEOUT: { code: "1037", desc: "DS timeout user cannot be reached." },
    };
    const mapped = outcomeMap[params.outcome];
    const receipt =
      params.outcome === "SUCCESS"
        ? (
            params.mpesaReceiptNumber ||
            `SIM${Date.now().toString(36).toUpperCase().slice(-7)}`
          ).toUpperCase()
        : undefined;

    const metadata =
      params.outcome === "SUCCESS"
        ? [
            { Name: "Amount", Value: txRecord.amountCents / 100 },
            { Name: "MpesaReceiptNumber", Value: receipt },
            { Name: "PhoneNumber", Value: txRecord.phoneNumber },
          ]
        : [];

    return this.finalizeStkResult({
      transactionId: txRecord.id,
      resultCode: mapped.code,
      resultDesc: params.resultDesc ?? mapped.desc,
      callbackMetadata: metadata,
      rawPayload: {
        simulated: true,
        outcome: params.outcome,
      },
      actorUserId: params.actorUserId,
      ipAddress: params.ipAddress,
    });
  }

  private async finalizeStkResult(params: {
    transactionId: string;
    resultCode: string;
    resultDesc: string;
    callbackMetadata: Array<{ Name: string; Value?: string | number | null }>;
    rawPayload: unknown;
    actorUserId?: string;
    ipAddress?: string;
  }) {
    const existing =
      await this.prismaService.raw.billingPaymentTransaction.findUniqueOrThrow({
        where: { id: params.transactionId },
      });

    if (existing.status !== BillingPaymentStatus.PENDING) {
      return {
        idempotentReplay: true,
        transaction: this.sanitizeTransaction(existing),
      };
    }

    const now = new Date();
    const isSuccess = params.resultCode === "0";
    let nextTxStatus: BillingPaymentStatus = BillingPaymentStatus.FAILED;
    if (isSuccess) {
      nextTxStatus = BillingPaymentStatus.SUCCEEDED;
    } else if (params.resultCode === "1032") {
      nextTxStatus = BillingPaymentStatus.CANCELLED;
    } else if (params.resultCode === "1037") {
      nextTxStatus = BillingPaymentStatus.EXPIRED;
    }

    const getMeta = (name: string) =>
      params.callbackMetadata.find(
        (item) => item.Name.toLowerCase() === name.toLowerCase(),
      )?.Value;

    const receiptRaw = getMeta("MpesaReceiptNumber");
    const mpesaReceiptNumber = receiptRaw
      ? String(receiptRaw).trim().toUpperCase()
      : isSuccess
        ? `MP${Date.now().toString(36).toUpperCase()}`
        : null;
    const paidAmountRaw = getMeta("Amount");
    const paidAmountCents =
      paidAmountRaw !== undefined && paidAmountRaw !== null
        ? parseDarajaAmountToCents(paidAmountRaw)
        : existing.amountCents;
    const txDate = parseDarajaTransactionDate(
      getMeta("TransactionDate") ?? undefined,
    );

    const outcome = await this.prismaService.raw.$transaction(async (tx) => {
      const updatedTx = await tx.billingPaymentTransaction.update({
        where: { id: existing.id },
        data: {
          status: nextTxStatus,
          mpesaReceiptNumber: isSuccess ? mpesaReceiptNumber : null,
          resultCode: params.resultCode,
          resultDesc: params.resultDesc,
          processedAt: txDate ?? now,
          rawCallbackPayload: params.rawPayload as Prisma.InputJsonValue,
        },
      });

      let updatedInvoice = await tx.billingInvoice.findUniqueOrThrow({
        where: { id: existing.invoiceId },
        include: { plan: true },
      });

      let updatedSubscription = null;
      if (isSuccess) {
        const nextPaid = updatedInvoice.amountPaidCents + paidAmountCents;
        const fullyPaid = nextPaid >= updatedInvoice.totalCents;
        updatedInvoice = await tx.billingInvoice.update({
          where: { id: updatedInvoice.id },
          data: {
            amountPaidCents: nextPaid,
            status: fullyPaid
              ? BillingInvoiceStatus.PAID
              : updatedInvoice.status,
            paidAt: fullyPaid ? now : updatedInvoice.paidAt,
          },
          include: { plan: true },
        });

        if (fullyPaid) {
          updatedSubscription = await this.activateSubscriptionFromInvoiceTx(
            tx,
            updatedInvoice,
            now,
          );
        }
      }

      await tx.platformBillingAuditLog.create({
        data: {
          actorUserId: params.actorUserId ?? null,
          organizationId: existing.organizationId,
          action: isSuccess
            ? "billing.mpesa.payment_succeeded"
            : "billing.mpesa.payment_failed",
          resourceType: "BillingPaymentTransaction",
          resourceId: updatedTx.id,
          metadata: {
            invoiceId: existing.invoiceId,
            resultCode: params.resultCode,
            resultDesc: params.resultDesc,
            mpesaReceiptNumber,
            paidAmountCents: isSuccess ? paidAmountCents : 0,
          } as Prisma.InputJsonValue,
          ipAddress: params.ipAddress ?? null,
        },
      });

      return {
        idempotentReplay: false,
        transaction: this.sanitizeTransaction(updatedTx),
        invoice: updatedInvoice,
        subscription: updatedSubscription,
      };
    });

    await this.billingEnforcement.invalidateOrganizationCache(
      existing.organizationId,
    );

    return outcome;
  }

  async activateSubscriptionFromInvoiceTx(
    tx: Prisma.TransactionClient,
    invoice: {
      id: string;
      organizationId: string;
      planId: string;
      billingCycle: SubscriptionBillingCycle;
      plan: {
        gracePeriodDays: number;
      };
    },
    now = new Date(),
  ) {
    const existingSub = await tx.organizationSubscription.findUnique({
      where: { organizationId: invoice.organizationId },
    });

    const periodStart =
      existingSub &&
      existingSub.status === BillingSubscriptionStatus.ACTIVE &&
      existingSub.currentPeriodEnd &&
      existingSub.currentPeriodEnd > now &&
      existingSub.planId === invoice.planId
        ? existingSub.currentPeriodEnd
        : now;
    const periodEnd = addBillingCycleDuration(periodStart, invoice.billingCycle);
    const gracePeriodEndsAt = addDays(
      periodEnd,
      Math.max(0, invoice.plan.gracePeriodDays),
    );

    if (existingSub) {
      return tx.organizationSubscription.update({
        where: { id: existingSub.id },
        data: {
          planId: invoice.planId,
          billingCycle: invoice.billingCycle,
          status: BillingSubscriptionStatus.ACTIVE,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          gracePeriodEndsAt,
          cancelAtPeriodEnd: false,
          canceledAt: null,
          suspendedAt: null,
          suspensionReason: null,
          lockedAt: null,
          lastEnforcedStatus: BillingSubscriptionStatus.ACTIVE,
          lastStatusEvaluatedAt: now,
          lastPaymentAt: now,
        },
        include: { plan: true },
      });
    }

    return tx.organizationSubscription.create({
      data: {
        organizationId: invoice.organizationId,
        planId: invoice.planId,
        billingCycle: invoice.billingCycle,
        status: BillingSubscriptionStatus.ACTIVE,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        gracePeriodEndsAt,
        lastEnforcedStatus: BillingSubscriptionStatus.ACTIVE,
        lastStatusEvaluatedAt: now,
        lastPaymentAt: now,
      },
      include: { plan: true },
    });
  }

  private async resolvePlatformCredentials(requireEnabled: boolean): Promise<{
    config: NonNullable<
      Awaited<ReturnType<PrismaService["raw"]["platformMpesaConfig"]["findUnique"]>>
    >;
    credentials: DarajaCredentialsContext;
    callbackRouteToken: string;
  }> {
    await provisionPlatformBillingDefaults(this.prismaService.raw);
    const config = await this.prismaService.raw.platformMpesaConfig.findUniqueOrThrow({
      where: { id: "default" },
    });

    if (requireEnabled && !config.isEnabled) {
      throw new BadRequestException(
        "Platform M-Pesa billing is currently disabled by system administrators.",
      );
    }

    const callbackRouteToken = decryptBillingSecret(
      config.callbackRouteTokenEncrypted,
    );

    const credentials: DarajaCredentialsContext = {
      organizationId: "platform",
      environment: config.environment,
      shortcodeType: config.shortcodeType,
      businessShortCode: config.businessShortCode,
      partyB: config.partyB,
      consumerKey: config.consumerKeyEncrypted
        ? decryptBillingSecret(config.consumerKeyEncrypted)
        : null,
      consumerSecret: config.consumerSecretEncrypted
        ? decryptBillingSecret(config.consumerSecretEncrypted)
        : null,
      passkey: config.passkeyEncrypted
        ? decryptBillingSecret(config.passkeyEncrypted)
        : null,
    };

    return { config, credentials, callbackRouteToken };
  }

  private async resolveConfigByCallbackToken(rawToken: string) {
    const trimmed = rawToken.trim();
    if (!trimmed || trimmed.length < 16) {
      return null;
    }
    const tokenHash = sha256Hex(trimmed);
    const config = await this.prismaService.raw.platformMpesaConfig.findUnique({
      where: { callbackRouteTokenHash: tokenHash },
    });
    if (!config || !config.isEnabled) {
      return null;
    }
    try {
      const decrypted = decryptBillingSecret(config.callbackRouteTokenEncrypted);
      if (!safeEqualStrings(decrypted, trimmed)) {
        return null;
      }
    } catch {
      return null;
    }
    return config;
  }

  buildCallbackUrl(platformToken: string, txToken?: string): string {
    const base = getEnv().MPESA_PUBLIC_CALLBACK_BASE_URL;
    const prefix = `${base}/api/v1/webhooks/platform-daraja/${platformToken}`;
    return txToken ? `${prefix}/stk/${txToken}` : `${prefix}/stk/{txToken}`;
  }

  sanitizeTransaction<
    T extends {
      callbackToken?: string | null;
    },
  >(txRecord: T): Omit<T, "callbackToken"> {
    const { callbackToken: _omit, ...rest } = txRecord;
    return rest;
  }

  private toSanitizedResponse(
    config: NonNullable<
      Awaited<ReturnType<PrismaService["raw"]["platformMpesaConfig"]["findUnique"]>>
    >,
  ): SanitizedPlatformMpesaConfig {
    const decryptMask = (enc: string | null): string | null => {
      if (!enc) return null;
      try {
        return maskBillingSecretTail(decryptBillingSecret(enc));
      } catch {
        return "****";
      }
    };

    const callbackRouteToken = decryptBillingSecret(
      config.callbackRouteTokenEncrypted,
    );

    return {
      id: config.id,
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
      accountReferencePrefix: config.accountReferencePrefix,
      transactionDescTemplate: config.transactionDescTemplate,
      stkCallbackTemplateUrl: this.buildCallbackUrl(callbackRouteToken),
      lastTestedAt: config.lastTestedAt,
      lastTestStatus: config.lastTestStatus,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }
}

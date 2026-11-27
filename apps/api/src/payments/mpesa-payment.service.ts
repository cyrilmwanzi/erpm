import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  MpesaEnvironment,
  MpesaShortcodeType,
  OrderChannel,
  OrderStatus,
  PaymentProvider,
  PaymentTargetType,
  PaymentTransactionFlow,
  PaymentTransactionStatus,
  Prisma,
  SalesInvoiceStatus,
  OrganizationContext,
} from "@scace/db";
import {
  generateRandomToken,
  matchesIpAllowlist,
  safeEqualStrings,
  sha256Hex,
} from "../auth/crypto.utils.js";
import { PrismaService } from "../database/prisma.service.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { MpesaConfigService } from "./mpesa-config.service.js";
import { MpesaDarajaClient } from "./mpesa-daraja.client.js";
import {
  centsToDarajaWholeAmount,
  normalizeKenyanPhoneNumber,
  parseDarajaAmountToCents,
  parseDarajaTransactionDate,
  sanitizeDarajaAccountReference,
} from "./mpesa-security.utils.js";
import { MpesaSettlementService } from "./mpesa-settlement.service.js";

function generateDocNumber(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
}

export interface InitiateOrderMpesaStkInput {
  phoneNumber: string;
  amountCents?: number;
  accountReference?: string | null;
  transactionDesc?: string | null;
}

export interface InitiateInvoiceMpesaStkInput {
  phoneNumber: string;
  amountCents?: number;
  accountReference?: string | null;
  transactionDesc?: string | null;
}

export interface InitiateFulfillmentMpesaStkInput {
  phoneNumber: string;
  amountCents?: number;
  accountReference?: string | null;
  transactionDesc?: string | null;
}

export interface ListMpesaTransactionsQuery {
  status?: PaymentTransactionStatus;
  flow?: PaymentTransactionFlow;
  targetType?: PaymentTargetType;
  orderId?: string;
  salesInvoiceId?: string;
  fulfillmentId?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

export interface ReconcileUnmatchedC2bInput {
  targetType: "ORDER" | "SALES_INVOICE" | "FULFILLMENT";
  targetId: string;
}

export interface DarajaStkCallbackPayload {
  Body: {
    stkCallback: {
      MerchantRequestID: string;
      CheckoutRequestID: string;
      ResultCode: number;
      ResultDesc: string;
      CallbackMetadata?: {
        Item?: Array<{
          Name: string;
          Value?: string | number | null;
        }>;
      };
    };
  };
}

export interface DarajaC2bPayload {
  TransactionType?: string;
  TransID: string;
  TransTime?: string;
  TransAmount: string | number;
  BusinessShortCode: string;
  BillRefNumber?: string;
  InvoiceNumber?: string;
  OrgAccountBalance?: string | number;
  ThirdPartyTransID?: string;
  MSISDN?: string;
  FirstName?: string;
  MiddleName?: string;
  LastName?: string;
}

export interface SimulateStkCallbackInput {
  transactionId: string;
  outcome?: "SUCCESS" | "CANCELLED" | "FAILED" | "TIMEOUT";
  mpesaReceiptNumber?: string;
  resultDesc?: string;
}

export interface SimulateC2bInput {
  action?: "VALIDATE" | "CONFIRM" | "VALIDATE_AND_CONFIRM";
  transId?: string;
  amountCents: number;
  billRefNumber: string;
  phoneNumber: string;
  firstName?: string;
  lastName?: string;
}

@Injectable()
export class MpesaPaymentService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(MpesaConfigService) private readonly configService: MpesaConfigService,
    @Inject(MpesaDarajaClient) private readonly darajaClient: MpesaDarajaClient,
    @Inject(MpesaSettlementService)
    private readonly settlementService: MpesaSettlementService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  async initiateStkPushForOrder(
    tenant: AuthenticatedOrganization,
    orderId: string,
    input: InitiateOrderMpesaStkInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const phoneNumber = normalizeKenyanPhoneNumber(input.phoneNumber);

    const order = await this.prismaService.raw.order.findFirst({
      where: { id: orderId, organizationId },
      include: { fulfillment: { select: { id: true } } },
    });
    if (!order) {
      throw new NotFoundException("Order was not found.");
    }
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.COMPLETED) {
      throw new BadRequestException(
        `Cannot initiate M-Pesa payment for order "${order.orderNumber}" in status ${order.status}.`,
      );
    }

    const remainingCents = Math.max(0, order.totalCents - order.paidAmountCents);
    if (remainingCents <= 0) {
      throw new BadRequestException("Order is already fully paid.");
    }

    const amountCents = input.amountCents ?? remainingCents;
    if (amountCents > remainingCents) {
      throw new BadRequestException(
        `Requested amount (${amountCents} cents) exceeds remaining order balance (${remainingCents} cents).`,
      );
    }

    return this.dispatchStkPush({
      organizationId,
      actorUserId: tenant.userId,
      targetType:
        order.channel === OrderChannel.POS && !order.fulfillment
          ? PaymentTargetType.POS_ORDER
          : PaymentTargetType.ORDER,
      orderId: order.id,
      fulfillmentId: order.fulfillment?.id ?? null,
      customerId: order.customerId,
      currency: order.currency,
      amountCents,
      phoneNumber,
      defaultAccountReference: order.orderNumber,
      accountReference: input.accountReference,
      transactionDesc: input.transactionDesc,
      ipAddress,
    });
  }

  async initiateStkPushForInvoice(
    tenant: AuthenticatedOrganization,
    invoiceId: string,
    input: InitiateInvoiceMpesaStkInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const phoneNumber = normalizeKenyanPhoneNumber(input.phoneNumber);

    const invoice = await this.prismaService.raw.salesInvoice.findFirst({
      where: { id: invoiceId, organizationId },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            fulfillment: { select: { id: true } },
          },
        },
      },
    });
    if (!invoice) {
      throw new NotFoundException("Sales invoice was not found.");
    }
    if (
      invoice.status !== SalesInvoiceStatus.ISSUED &&
      invoice.status !== SalesInvoiceStatus.PARTIALLY_PAID
    ) {
      throw new BadRequestException(
        `M-Pesa payment can only be initiated for ISSUED or PARTIALLY_PAID invoices (current status: ${invoice.status}).`,
      );
    }

    const remainingCents = Math.max(0, invoice.totalCents - invoice.paidAmountCents);
    if (remainingCents <= 0) {
      throw new BadRequestException("Invoice is already fully paid.");
    }

    const amountCents = input.amountCents ?? remainingCents;
    if (amountCents > remainingCents) {
      throw new BadRequestException(
        `Requested amount (${amountCents} cents) exceeds remaining invoice balance (${remainingCents} cents).`,
      );
    }

    return this.dispatchStkPush({
      organizationId,
      actorUserId: tenant.userId,
      targetType: PaymentTargetType.SALES_INVOICE,
      orderId: invoice.orderId,
      salesInvoiceId: invoice.id,
      fulfillmentId: invoice.order.fulfillment?.id ?? null,
      customerId: invoice.customerId,
      currency: invoice.currency,
      amountCents,
      phoneNumber,
      defaultAccountReference: invoice.invoiceNumber,
      accountReference: input.accountReference,
      transactionDesc: input.transactionDesc,
      ipAddress,
    });
  }

  async initiateStkPushForFulfillment(
    tenant: AuthenticatedOrganization,
    fulfillmentId: string,
    input: InitiateFulfillmentMpesaStkInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const phoneNumber = normalizeKenyanPhoneNumber(input.phoneNumber);

    const fulfillment = await this.prismaService.raw.orderFulfillment.findFirst({
      where: { id: fulfillmentId, organizationId },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            currency: true,
            totalCents: true,
            paidAmountCents: true,
            status: true,
          },
        },
      },
    });
    if (!fulfillment) {
      throw new NotFoundException("Order fulfillment was not found.");
    }
    if (fulfillment.order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException(
        "Cannot initiate M-Pesa payment for a cancelled fulfillment.",
      );
    }

    const remainingOrderCents = Math.max(
      0,
      fulfillment.order.totalCents - fulfillment.order.paidAmountCents,
    );
    if (remainingOrderCents <= 0) {
      throw new BadRequestException("Fulfillment order is already fully paid.");
    }

    const remainingDepositCents = Math.max(
      0,
      fulfillment.depositRequiredCents - fulfillment.order.paidAmountCents,
    );
    const defaultAmountCents =
      remainingDepositCents > 0 ? remainingDepositCents : remainingOrderCents;

    const amountCents = input.amountCents ?? defaultAmountCents;
    if (amountCents > remainingOrderCents) {
      throw new BadRequestException(
        `Requested amount (${amountCents} cents) exceeds remaining balance (${remainingOrderCents} cents).`,
      );
    }

    return this.dispatchStkPush({
      organizationId,
      actorUserId: tenant.userId,
      targetType: PaymentTargetType.FULFILLMENT,
      orderId: fulfillment.orderId,
      fulfillmentId: fulfillment.id,
      customerId: fulfillment.customerId,
      currency: fulfillment.order.currency,
      amountCents,
      phoneNumber,
      defaultAccountReference: fulfillment.fulfillmentNumber,
      accountReference: input.accountReference,
      transactionDesc: input.transactionDesc,
      ipAddress,
    });
  }

  async dispatchStkPush(params: {
    organizationId: string;
    actorUserId: string;
    targetType: PaymentTargetType;
    orderId: string;
    salesInvoiceId?: string | null;
    fulfillmentId?: string | null;
    customerId?: string | null;
    currency: string;
    amountCents: number;
    phoneNumber: string;
    defaultAccountReference: string;
    accountReference?: string | null;
    transactionDesc?: string | null;
    ipAddress?: string;
  }) {
    const amountWholeUnits = centsToDarajaWholeAmount(params.amountCents);
    const { config, credentials, callbackRouteToken } =
      await this.configService.resolveCredentialsForOrg(
        params.organizationId,
        true,
      );

    const txNumber = generateDocNumber("TXN");
    const txCallbackNonce = generateRandomToken(24);
    const callbackNonceHash = sha256Hex(txCallbackNonce);
    const urls = this.configService.buildCallbackUrls(
      callbackRouteToken,
      txCallbackNonce,
    );

    const rawRef =
      params.accountReference?.trim() || params.defaultAccountReference;
    const prefixedRef = config.accountReferencePrefix
      ? `${config.accountReferencePrefix}-${rawRef}`
      : rawRef;
    const darajaAccountRef = sanitizeDarajaAccountReference(prefixedRef);
    const transactionDesc = (
      params.transactionDesc?.trim() ||
      config.transactionDescTemplate?.replace("{reference}", rawRef) ||
      `Payment for ${rawRef}`
    ).slice(0, 64);

    const pendingTx = await this.prismaService.raw.paymentTransaction.create({
      data: {
        organizationId: params.organizationId,
        transactionNumber: txNumber,
        provider: PaymentProvider.MPESA,
        flow: PaymentTransactionFlow.STK_PUSH,
        status: PaymentTransactionStatus.PENDING,
        targetType: params.targetType,
        orderId: params.orderId,
        salesInvoiceId: params.salesInvoiceId ?? null,
        fulfillmentId: params.fulfillmentId ?? null,
        customerId: params.customerId ?? null,
        currency: params.currency,
        amountCents: params.amountCents,
        phoneNumber: params.phoneNumber,
        businessShortCode: credentials.businessShortCode,
        accountReference: rawRef,
        transactionDesc,
        callbackNonceHash,
        initiatedByUserId: params.actorUserId,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });

    try {
      const darajaRes = await this.darajaClient.initiateStkPush({
        credentials,
        amountWholeUnits,
        phoneNumber: params.phoneNumber,
        accountReference: darajaAccountRef,
        transactionDesc,
        callbackUrl: urls.stkCallbackUrl,
      });

      const updatedTx = await this.prismaService.raw.paymentTransaction.update({
        where: { id: pendingTx.id },
        data: {
          merchantRequestId: darajaRes.merchantRequestId,
          checkoutRequestId: darajaRes.checkoutRequestId,
          resultCode: darajaRes.responseCode,
          resultDesc: darajaRes.customerMessage,
        },
      });

      await this.prismaService.raw.auditLog.create({
        data: {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          action: "payment.mpesa.stk_initiated",
          resourceType: "PaymentTransaction",
          resourceId: updatedTx.id,
          metadata: {
            transactionNumber: updatedTx.transactionNumber,
            targetType: updatedTx.targetType,
            orderId: updatedTx.orderId,
            salesInvoiceId: updatedTx.salesInvoiceId,
            fulfillmentId: updatedTx.fulfillmentId,
            amountCents: updatedTx.amountCents,
            checkoutRequestId: updatedTx.checkoutRequestId,
            simulated: darajaRes.simulated,
          } as Prisma.InputJsonValue,
          ipAddress: params.ipAddress ?? null,
        },
      });

      this.analyticsService.captureDomainEvent({
        event: "payment.mpesa.stk_initiated",
        distinctId: params.actorUserId,
        organizationId: params.organizationId,
        properties: {
          transaction_id: updatedTx.id,
          target_type: updatedTx.targetType,
          currency: updatedTx.currency,
          amount_cents: updatedTx.amountCents,
          simulated: darajaRes.simulated,
        },
      });

      return {
        transaction: this.sanitizeTransaction(updatedTx),
        stkResponse: darajaRes,
        ...(darajaRes.simulated ? { simulatorTxToken: txCallbackNonce } : {}),
      };
    } catch (error) {
      await this.prismaService.raw.paymentTransaction.update({
        where: { id: pendingTx.id },
        data: {
          status: PaymentTransactionStatus.FAILED,
          resultDesc:
            error instanceof Error
              ? error.message.slice(0, 240)
              : "Daraja STK Push initiation failed.",
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

  async listTransactions(
    tenant: AuthenticatedOrganization,
    query: ListMpesaTransactionsQuery,
  ) {
    this.resolveVerifiedOrganizationId(tenant);
    const take = Math.min(Math.max(query.limit, 1), 100);
    const search = query.search?.trim();

    const records = await this.prismaService.scoped.paymentTransaction.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.flow ? { flow: query.flow } : {}),
        ...(query.targetType ? { targetType: query.targetType } : {}),
        ...(query.orderId ? { orderId: query.orderId } : {}),
        ...(query.salesInvoiceId ? { salesInvoiceId: query.salesInvoiceId } : {}),
        ...(query.fulfillmentId ? { fulfillmentId: query.fulfillmentId } : {}),
        ...(search
          ? {
              OR: [
                { transactionNumber: { contains: search, mode: "insensitive" } },
                { mpesaReceiptNumber: { contains: search, mode: "insensitive" } },
                { checkoutRequestId: { contains: search, mode: "insensitive" } },
                { accountReference: { contains: search, mode: "insensitive" } },
                { phoneNumber: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        order: { select: { id: true, orderNumber: true, status: true, channel: true } },
        salesInvoice: { select: { id: true, invoiceNumber: true, status: true } },
        fulfillment: { select: { id: true, fulfillmentNumber: true, status: true } },
        customer: { select: { id: true, code: true, name: true, phone: true } },
        customerPayment: {
          select: {
            id: true,
            paymentNumber: true,
            amountAppliedCents: true,
            receipt: { select: { id: true, receiptNumber: true } },
          },
        },
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    const hasMore = records.length > take;
    const items = hasMore ? records.slice(0, take) : records;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return {
      organizationId: tenant.organizationId,
      items: items.map((item) => this.sanitizeTransaction(item)),
      nextCursor,
    };
  }

  async getTransaction(tenant: AuthenticatedOrganization, transactionId: string) {
    this.resolveVerifiedOrganizationId(tenant);
    const txRecord = await this.prismaService.scoped.paymentTransaction.findUnique({
      where: { id: transactionId },
      include: {
        order: { select: { id: true, orderNumber: true, status: true, channel: true } },
        salesInvoice: { select: { id: true, invoiceNumber: true, status: true } },
        fulfillment: { select: { id: true, fulfillmentNumber: true, status: true } },
        customer: { select: { id: true, code: true, name: true, phone: true } },
        customerPayment: {
          include: {
            receipt: true,
          },
        },
      },
    });
    if (!txRecord) {
      throw new NotFoundException("Payment transaction was not found.");
    }
    return this.sanitizeTransaction(txRecord);
  }

  async queryStkStatusAndReconcile(
    tenant: AuthenticatedOrganization,
    transactionId: string,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const txRecord = await this.prismaService.raw.paymentTransaction.findFirst({
      where: { id: transactionId, organizationId },
    });
    if (!txRecord) {
      throw new NotFoundException("Payment transaction was not found.");
    }
    if (txRecord.flow !== PaymentTransactionFlow.STK_PUSH) {
      throw new BadRequestException(
        "STK status query is only applicable to STK_PUSH transactions.",
      );
    }
    if (txRecord.status === PaymentTransactionStatus.SUCCEEDED) {
      return {
        status: "ALREADY_SUCCEEDED",
        transaction: this.sanitizeTransaction(txRecord),
      };
    }
    if (!txRecord.checkoutRequestId) {
      throw new BadRequestException(
        "Transaction does not have a Daraja CheckoutRequestID to query.",
      );
    }

    const { credentials } = await this.configService.resolveCredentialsForOrg(
      organizationId,
      false,
    );

    const queryRes = await this.darajaClient.queryStkPushStatus({
      credentials,
      checkoutRequestId: txRecord.checkoutRequestId,
    });

    if (queryRes.resultCode === "0") {
      const mpesaReceipt =
        txRecord.mpesaReceiptNumber ||
        `QRY-${txRecord.checkoutRequestId.slice(-8).toUpperCase()}`;
      const settled = await this.settlementService.settleSuccessfulTransaction({
        organizationId,
        transactionId: txRecord.id,
        mpesaReceiptNumber: mpesaReceipt,
        settledAmountCents: txRecord.amountCents,
        phoneNumber: txRecord.phoneNumber,
        resultCode: queryRes.resultCode,
        resultDesc: queryRes.resultDesc,
        rawCallbackPayload: queryRes as unknown as Record<string, unknown>,
        actorUserId: tenant.userId,
        ipAddress,
      });

      return {
        status: "SETTLED_VIA_STATUS_QUERY",
        queryResponse: queryRes,
        transaction: this.sanitizeTransaction(settled.transaction),
        payment: settled.payment,
        receipt: settled.receipt,
      };
    }

    if (queryRes.resultCode !== "PENDING") {
      const nextStatus =
        queryRes.resultCode === "1032"
          ? PaymentTransactionStatus.CANCELLED
          : queryRes.resultCode === "1037"
            ? PaymentTransactionStatus.EXPIRED
            : PaymentTransactionStatus.FAILED;

      const updated = await this.prismaService.raw.paymentTransaction.update({
        where: { id: txRecord.id },
        data: {
          status: nextStatus,
          resultCode: queryRes.resultCode,
          resultDesc: queryRes.resultDesc,
          reconciledByUserId: tenant.userId,
          reconciledAt: new Date(),
          completedAt: new Date(),
        },
      });

      return {
        status: nextStatus,
        queryResponse: queryRes,
        transaction: this.sanitizeTransaction(updated),
      };
    }

    return {
      status: "PENDING",
      queryResponse: queryRes,
      transaction: this.sanitizeTransaction(txRecord),
    };
  }

  async reconcileUnmatchedC2b(
    tenant: AuthenticatedOrganization,
    transactionId: string,
    input: ReconcileUnmatchedC2bInput,
    ipAddress?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const txRecord = await this.prismaService.raw.paymentTransaction.findFirst({
      where: { id: transactionId, organizationId },
    });
    if (!txRecord) {
      throw new NotFoundException("Payment transaction was not found.");
    }
    if (txRecord.status !== PaymentTransactionStatus.UNMATCHED_C2B) {
      throw new BadRequestException(
        `Only UNMATCHED_C2B transactions can be manually reconciled (current status: ${txRecord.status}).`,
      );
    }
    if (!txRecord.mpesaReceiptNumber) {
      throw new BadRequestException(
        "Unmatched C2B transaction is missing an M-Pesa receipt number.",
      );
    }

    const targetOverride =
      input.targetType === "SALES_INVOICE"
        ? {
            targetType: PaymentTargetType.SALES_INVOICE,
            salesInvoiceId: input.targetId,
          }
        : input.targetType === "FULFILLMENT"
          ? {
              targetType: PaymentTargetType.FULFILLMENT,
              fulfillmentId: input.targetId,
            }
          : {
              targetType: PaymentTargetType.ORDER,
              orderId: input.targetId,
            };

    const settled = await this.settlementService.settleSuccessfulTransaction({
      organizationId,
      transactionId: txRecord.id,
      mpesaReceiptNumber: txRecord.mpesaReceiptNumber,
      settledAmountCents: txRecord.amountCents,
      phoneNumber: txRecord.phoneNumber,
      payerName: txRecord.payerName,
      actorUserId: tenant.userId,
      ipAddress,
      targetOverride,
    });

    return {
      transaction: this.sanitizeTransaction(settled.transaction),
      payment: settled.payment,
      receipt: settled.receipt,
    };
  }

  // ==========================================
  // Hardened Anonymous Daraja Webhook Handlers
  // ==========================================

  async handleStkCallback(params: {
    orgToken: string;
    txToken: string;
    payload: DarajaStkCallbackPayload;
    clientIp?: string;
  }) {
    const config = await this.verifyCallbackConfigAndIp(
      params.orgToken,
      params.clientIp,
    );

    const stk = params.payload.Body.stkCallback;
    const txTokenHash = sha256Hex(params.txToken.trim());

    const txRecord = await this.prismaService.raw.paymentTransaction.findFirst({
      where: {
        organizationId: config.organizationId,
        checkoutRequestId: stk.CheckoutRequestID,
      },
    });
    if (!txRecord || !txRecord.callbackNonceHash) {
      throw new UnauthorizedException("Invalid STK callback transaction reference.");
    }
    if (!safeEqualStrings(txRecord.callbackNonceHash, txTokenHash)) {
      throw new UnauthorizedException("Invalid STK callback transaction token.");
    }
    if (txRecord.businessShortCode !== config.businessShortCode) {
      throw new UnauthorizedException("Organization shortcode mismatch.");
    }

    // Idempotent acknowledgment if already finalized
    if (
      txRecord.status === PaymentTransactionStatus.SUCCEEDED &&
      txRecord.customerPaymentId
    ) {
      return { ResultCode: 0, ResultDesc: "Accepted" };
    }

    const resultCodeStr = String(stk.ResultCode);
    if (stk.ResultCode !== 0) {
      const nextStatus =
        stk.ResultCode === 1032
          ? PaymentTransactionStatus.CANCELLED
          : stk.ResultCode === 1037
            ? PaymentTransactionStatus.EXPIRED
            : PaymentTransactionStatus.FAILED;

      await this.prismaService.raw.paymentTransaction.updateMany({
        where: {
          id: txRecord.id,
          organizationId: config.organizationId,
          status: PaymentTransactionStatus.PENDING,
        },
        data: {
          status: nextStatus,
          resultCode: resultCodeStr,
          resultDesc: stk.ResultDesc,
          rawCallbackPayload: params.payload as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });

      await this.prismaService.raw.auditLog.create({
        data: {
          organizationId: config.organizationId,
          actorUserId: null,
          action: "payment.mpesa.stk_failed",
          resourceType: "PaymentTransaction",
          resourceId: txRecord.id,
          metadata: {
            checkoutRequestId: stk.CheckoutRequestID,
            resultCode: resultCodeStr,
            resultDesc: stk.ResultDesc,
            status: nextStatus,
          } as Prisma.InputJsonValue,
          ipAddress: params.clientIp ?? null,
        },
      });

      return { ResultCode: 0, ResultDesc: "Accepted" };
    }

    const metaItems = stk.CallbackMetadata?.Item ?? [];
    const metaMap: Record<string, unknown> = {};
    for (const item of metaItems) {
      if (item.Name) {
        metaMap[item.Name] = item.Value ?? null;
      }
    }

    const rawAmount = metaMap.Amount;
    const rawReceipt = metaMap.MpesaReceiptNumber;
    const rawPhone = metaMap.PhoneNumber;
    const rawDate = metaMap.TransactionDate;

    const receiptStr =
      typeof rawReceipt === "string" && rawReceipt.trim().length > 0
        ? rawReceipt.trim().toUpperCase()
        : null;
    if (!receiptStr) {
      throw new BadRequestException(
        "Successful STK callback missing MpesaReceiptNumber.",
      );
    }

    const callbackAmountCents =
      rawAmount !== undefined && rawAmount !== null
        ? parseDarajaAmountToCents(rawAmount as number | string)
        : txRecord.amountCents;

    if (callbackAmountCents < txRecord.amountCents) {
      await this.prismaService.raw.paymentTransaction.update({
        where: { id: txRecord.id },
        data: {
          status: PaymentTransactionStatus.FAILED,
          resultCode: "AMOUNT_MISMATCH",
          resultDesc: `Paid amount (${callbackAmountCents} cents) does not match requested amount (${txRecord.amountCents} cents).`,
          mpesaReceiptNumber: receiptStr,
          callbackMetadata: metaMap as Prisma.InputJsonValue,
          rawCallbackPayload: params.payload as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
      return { ResultCode: 0, ResultDesc: "Accepted" };
    }

    const normalizedPhone = rawPhone
      ? (() => {
          try {
            return normalizeKenyanPhoneNumber(String(rawPhone));
          } catch {
            return txRecord.phoneNumber;
          }
        })()
      : txRecord.phoneNumber;

    const parsedDate = parseDarajaTransactionDate(
      rawDate as number | string | undefined,
    );

    await this.settlementService.settleSuccessfulTransaction({
      organizationId: config.organizationId,
      transactionId: txRecord.id,
      mpesaReceiptNumber: receiptStr,
      settledAmountCents: txRecord.amountCents,
      phoneNumber: normalizedPhone,
      resultCode: resultCodeStr,
      resultDesc: stk.ResultDesc,
      callbackMetadata: {
        ...metaMap,
        ...(parsedDate ? { parsedTransactionDate: parsedDate.toISOString() } : {}),
      },
      rawCallbackPayload: params.payload as unknown as Record<string, unknown>,
      ipAddress: params.clientIp ?? null,
    });

    return { ResultCode: 0, ResultDesc: "Accepted" };
  }

  async handleC2bValidation(params: {
    orgToken: string;
    payload: DarajaC2bPayload;
    clientIp?: string;
  }) {
    const config = await this.verifyCallbackConfigAndIp(
      params.orgToken,
      params.clientIp,
    );

    this.assertShortCodeMatchesOrg(config, params.payload.BusinessShortCode);

    const amountCents = parseDarajaAmountToCents(params.payload.TransAmount);
    if (amountCents < 100) {
      return {
        ResultCode: "C2B00013",
        ResultDesc: "Rejected: Invalid Amount",
      };
    }

    if (!config.c2bValidateReference) {
      return { ResultCode: 0, ResultDesc: "Accepted" };
    }

    const billRef = (params.payload.BillRefNumber || params.payload.InvoiceNumber || "").trim();
    if (!billRef) {
      return {
        ResultCode: "C2B00012",
        ResultDesc: "Rejected: Missing Account Reference",
      };
    }

    const match = await this.findC2bTargetInOrg(
      config.organizationId,
      billRef,
      amountCents,
    );
    if (!match) {
      return {
        ResultCode: "C2B00012",
        ResultDesc: "Rejected: Invalid Account Reference or Amount",
      };
    }

    return { ResultCode: 0, ResultDesc: "Accepted" };
  }

  async handleC2bConfirmation(params: {
    orgToken: string;
    payload: DarajaC2bPayload;
    clientIp?: string;
  }) {
    const config = await this.verifyCallbackConfigAndIp(
      params.orgToken,
      params.clientIp,
    );

    this.assertShortCodeMatchesOrg(config, params.payload.BusinessShortCode);

    const transId = params.payload.TransID.trim().toUpperCase();
    const existing = await this.prismaService.raw.paymentTransaction.findFirst({
      where: {
        organizationId: config.organizationId,
        mpesaReceiptNumber: transId,
      },
    });
    if (existing) {
      return { ResultCode: 0, ResultDesc: "Success" };
    }

    const amountCents = parseDarajaAmountToCents(params.payload.TransAmount);
    const billRef = (
      params.payload.BillRefNumber ||
      params.payload.InvoiceNumber ||
      ""
    ).trim();
    const phone = params.payload.MSISDN
      ? (() => {
          try {
            return normalizeKenyanPhoneNumber(params.payload.MSISDN!);
          } catch {
            return params.payload.MSISDN!.trim();
          }
        })()
      : null;
    const payerName = [
      params.payload.FirstName,
      params.payload.MiddleName,
      params.payload.LastName,
    ]
      .filter((p) => Boolean(p && p.trim().length > 0))
      .join(" ")
      .trim() || null;

    const flow =
      config.shortcodeType === MpesaShortcodeType.TILL
        ? PaymentTransactionFlow.C2B_TILL
        : PaymentTransactionFlow.C2B_PAYBILL;

    const match = billRef
      ? await this.findC2bTargetInOrg(config.organizationId, billRef, amountCents)
      : null;

    const txRecord = await this.prismaService.raw.paymentTransaction.create({
      data: {
        organizationId: config.organizationId,
        transactionNumber: generateDocNumber("TXN"),
        provider: PaymentProvider.MPESA,
        flow,
        status: match
          ? PaymentTransactionStatus.PENDING
          : PaymentTransactionStatus.UNMATCHED_C2B,
        targetType: match ? match.targetType : PaymentTargetType.UNMATCHED,
        orderId: match?.orderId ?? null,
        salesInvoiceId: match?.salesInvoiceId ?? null,
        fulfillmentId: match?.fulfillmentId ?? null,
        customerId: match?.customerId ?? null,
        currency: match?.currency ?? "KES",
        amountCents,
        phoneNumber: phone,
        businessShortCode: params.payload.BusinessShortCode.trim(),
        accountReference: billRef || null,
        transactionDesc: `C2B ${flow}`,
        mpesaReceiptNumber: transId,
        payerName,
        resultCode: "0",
        resultDesc: match
          ? "C2B confirmation received"
          : "C2B payment captured as UNMATCHED_C2B for manual finance reconciliation",
        rawCallbackPayload: params.payload as unknown as Prisma.InputJsonValue,
      },
    });

    if (match) {
      await this.settlementService.settleSuccessfulTransaction({
        organizationId: config.organizationId,
        transactionId: txRecord.id,
        mpesaReceiptNumber: transId,
        settledAmountCents: amountCents,
        phoneNumber: phone,
        payerName,
        resultCode: "0",
        resultDesc: "C2B payment settled",
        rawCallbackPayload: params.payload as unknown as Record<string, unknown>,
        ipAddress: params.clientIp ?? null,
      });
    } else {
      await this.prismaService.raw.auditLog.create({
        data: {
          organizationId: config.organizationId,
          actorUserId: null,
          action: "payment.mpesa.c2b_unmatched",
          resourceType: "PaymentTransaction",
          resourceId: txRecord.id,
          metadata: {
            mpesaReceiptNumber: transId,
            billRefNumber: billRef || null,
            amountCents,
          } as Prisma.InputJsonValue,
          ipAddress: params.clientIp ?? null,
        },
      });
    }

    return { ResultCode: 0, ResultDesc: "Success" };
  }

  // ==========================================
  // Local Sandbox Simulator Helpers
  // ==========================================

  async simulateStkCallback(
    tenant: AuthenticatedOrganization,
    input: SimulateStkCallbackInput,
    clientIp?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const { config, callbackRouteToken } =
      await this.configService.resolveCredentialsForOrg(organizationId, true);

    if (config.environment !== MpesaEnvironment.LOCAL_SIMULATOR) {
      throw new BadRequestException(
        "Local simulator triggers are only permitted when organization M-Pesa environment is LOCAL_SIMULATOR.",
      );
    }

    const txRecord = await this.prismaService.raw.paymentTransaction.findFirst({
      where: { id: input.transactionId, organizationId },
    });
    if (!txRecord || !txRecord.checkoutRequestId || !txRecord.merchantRequestId) {
      throw new NotFoundException(
        "Pending simulated STK transaction was not found.",
      );
    }

    const freshTxToken = generateRandomToken(24);
    await this.prismaService.raw.paymentTransaction.update({
      where: { id: txRecord.id },
      data: { callbackNonceHash: sha256Hex(freshTxToken) },
    });

    const outcome = input.outcome ?? "SUCCESS";
    const resultCode =
      outcome === "SUCCESS"
        ? 0
        : outcome === "CANCELLED"
          ? 1032
          : outcome === "TIMEOUT"
            ? 1037
            : 1;
    const resultDesc =
      input.resultDesc ??
      (outcome === "SUCCESS"
        ? "The service request is processed successfully."
        : outcome === "CANCELLED"
          ? "Request cancelled by user"
          : outcome === "TIMEOUT"
            ? "DS timeout user cannot be reached"
            : "The balance is insufficient for the transaction.");

    const receiptNumber =
      input.mpesaReceiptNumber?.trim().toUpperCase() ||
      `SIM${Date.now().toString(36).toUpperCase()}`;

    const payload: DarajaStkCallbackPayload = {
      Body: {
        stkCallback: {
          MerchantRequestID: txRecord.merchantRequestId,
          CheckoutRequestID: txRecord.checkoutRequestId,
          ResultCode: resultCode,
          ResultDesc: resultDesc,
          ...(resultCode === 0
            ? {
                CallbackMetadata: {
                  Item: [
                    { Name: "Amount", Value: txRecord.amountCents / 100 },
                    { Name: "MpesaReceiptNumber", Value: receiptNumber },
                    { Name: "TransactionDate", Value: "20261125120000" },
                    {
                      Name: "PhoneNumber",
                      Value: Number(txRecord.phoneNumber ?? "254708374149"),
                    },
                  ],
                },
              }
            : {}),
        },
      },
    };

    const ack = await this.handleStkCallback({
      orgToken: callbackRouteToken,
      txToken: freshTxToken,
      payload,
      clientIp,
    });
    const updatedTx = await this.getTransaction(tenant, txRecord.id);

    return {
      ack,
      transaction: updatedTx,
    };
  }

  async simulateC2bWebhook(
    tenant: AuthenticatedOrganization,
    input: SimulateC2bInput,
    clientIp?: string,
  ) {
    const organizationId = this.resolveVerifiedOrganizationId(tenant);
    const { config, callbackRouteToken } =
      await this.configService.resolveCredentialsForOrg(organizationId, true);

    if (config.environment !== MpesaEnvironment.LOCAL_SIMULATOR) {
      throw new BadRequestException(
        "Local simulator triggers are only permitted when organization M-Pesa environment is LOCAL_SIMULATOR.",
      );
    }

    const phone = normalizeKenyanPhoneNumber(input.phoneNumber);
    const transId =
      input.transId?.trim().toUpperCase() ||
      `C2BSIM${Date.now().toString(36).toUpperCase()}`;
    const payload: DarajaC2bPayload = {
      TransactionType:
        config.shortcodeType === MpesaShortcodeType.TILL
          ? "Buy Goods"
          : "Pay Bill",
      TransID: transId,
      TransTime: "20261125120000",
      TransAmount: (input.amountCents / 100).toFixed(2),
      BusinessShortCode: config.businessShortCode,
      BillRefNumber: input.billRefNumber.trim(),
      MSISDN: phone,
      FirstName: input.firstName ?? "Simulated",
      LastName: input.lastName ?? "Customer",
    };

    const action = input.action ?? "VALIDATE_AND_CONFIRM";
    const validationResult =
      action === "VALIDATE" || action === "VALIDATE_AND_CONFIRM"
        ? await this.handleC2bValidation({
            orgToken: callbackRouteToken,
            payload,
            clientIp,
          })
        : null;

    if (
      action === "VALIDATE_AND_CONFIRM" &&
      validationResult &&
      validationResult.ResultCode !== 0
    ) {
      return {
        validationResult,
        confirmationResult: null,
      };
    }

    const confirmationResult =
      action === "CONFIRM" || action === "VALIDATE_AND_CONFIRM"
        ? await this.handleC2bConfirmation({
            orgToken: callbackRouteToken,
            payload,
            clientIp,
          })
        : null;

    return {
      validationResult,
      confirmationResult,
      transId,
    };
  }

  private async verifyCallbackConfigAndIp(
    orgToken: string,
    clientIp?: string,
  ) {
    const config = await this.configService.resolveOrganizationByCallbackToken(
      orgToken,
    );
    if (!config) {
      throw new UnauthorizedException("Invalid or disabled M-Pesa callback endpoint.");
    }

    if (
      config.callbackIpAllowlist.length > 0 &&
      !matchesIpAllowlist(clientIp, config.callbackIpAllowlist)
    ) {
      throw new ForbiddenException(
        "M-Pesa callback source IP is not in the organization's allowlist.",
      );
    }

    return config;
  }

  private assertShortCodeMatchesOrg(
    config: { businessShortCode: string; partyB: string | null },
    incomingShortCode: string,
  ) {
    const normalized = incomingShortCode.trim();
    if (
      normalized !== config.businessShortCode &&
      (!config.partyB || normalized !== config.partyB)
    ) {
      throw new UnauthorizedException(
        "Incoming M-Pesa BusinessShortCode does not match this organization.",
      );
    }
  }

  private async findC2bTargetInOrg(
    organizationId: string,
    billRef: string,
    amountCents: number,
  ): Promise<{
    targetType: PaymentTargetType;
    orderId: string;
    salesInvoiceId?: string;
    fulfillmentId?: string;
    customerId: string | null;
    currency: string;
  } | null> {
    const normalizedRef = billRef.trim().toUpperCase();

    const invoice = await this.prismaService.raw.salesInvoice.findFirst({
      where: {
        organizationId,
        invoiceNumber: normalizedRef,
        status: {
          in: [SalesInvoiceStatus.ISSUED, SalesInvoiceStatus.PARTIALLY_PAID],
        },
      },
      include: {
        order: { select: { fulfillment: { select: { id: true } } } },
      },
    });
    if (invoice && invoice.totalCents - invoice.paidAmountCents >= amountCents) {
      return {
        targetType: PaymentTargetType.SALES_INVOICE,
        orderId: invoice.orderId,
        salesInvoiceId: invoice.id,
        fulfillmentId: invoice.order.fulfillment?.id,
        customerId: invoice.customerId,
        currency: invoice.currency,
      };
    }

    const fulfillment = await this.prismaService.raw.orderFulfillment.findFirst({
      where: {
        organizationId,
        fulfillmentNumber: normalizedRef,
      },
      include: {
        order: {
          select: {
            id: true,
            status: true,
            currency: true,
            totalCents: true,
            paidAmountCents: true,
            customerId: true,
          },
        },
      },
    });
    if (
      fulfillment &&
      fulfillment.order.status !== OrderStatus.CANCELLED &&
      fulfillment.order.totalCents - fulfillment.order.paidAmountCents >= amountCents
    ) {
      return {
        targetType: PaymentTargetType.FULFILLMENT,
        orderId: fulfillment.order.id,
        fulfillmentId: fulfillment.id,
        customerId: fulfillment.customerId ?? fulfillment.order.customerId,
        currency: fulfillment.order.currency,
      };
    }

    const order = await this.prismaService.raw.order.findFirst({
      where: {
        organizationId,
        orderNumber: normalizedRef,
        status: {
          notIn: [OrderStatus.CANCELLED, OrderStatus.COMPLETED, OrderStatus.DRAFT],
        },
      },
      include: { fulfillment: { select: { id: true } } },
    });
    if (order && order.totalCents - order.paidAmountCents >= amountCents) {
      return {
        targetType:
          order.channel === OrderChannel.POS && !order.fulfillment
            ? PaymentTargetType.POS_ORDER
            : PaymentTargetType.ORDER,
        orderId: order.id,
        fulfillmentId: order.fulfillment?.id,
        customerId: order.customerId,
        currency: order.currency,
      };
    }

    return null;
  }

  private sanitizeTransaction<T extends Record<string, unknown>>(txRecord: T) {
    const { callbackNonceHash: _hidden, ...rest } = txRecord;
    return rest;
  }

  private resolveVerifiedOrganizationId(tenant: AuthenticatedOrganization): string {
    const contextOrgId = OrganizationContext.getOrganizationId();
    if (contextOrgId && contextOrgId !== tenant.organizationId) {
      throw new BadRequestException("Active organization context mismatch.");
    }
    return tenant.organizationId;
  }
}

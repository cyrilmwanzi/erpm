import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  ExpiryAlertStatus,
  ExpiryEnforcementMode,
  LotAllocationStrategy,
  Prisma,
  StockMovementType,
} from "@scace/db";

export interface EffectiveExpiryPolicy {
  warningDays: number;
  criticalDays: number;
  enforcementMode: ExpiryEnforcementMode;
  autoQuarantineExpired: boolean;
  autoQuarantineOnCriticalDays: number | null;
  scanIntervalMinutes: number;
  isScannerActive: boolean;
}

export interface AllocatedLotSlice {
  stockLotId: string;
  lotNumber: string;
  batchCode: string | null;
  supplierId: string | null;
  supplierItemId: string | null;
  supplierSku: string | null;
  supplierBatchNumber: string | null;
  manufacturedAt: Date | null;
  expiresAt: Date | null;
  quantity: number;
  unitCostCents: number;
}

export type LotExpiryBucket =
  | "EXPIRED"
  | "CRITICAL"
  | "WARNING"
  | "HEALTHY"
  | "NO_EXPIRY";

export function computeExpiresAtFromShelfLife(
  baseDate: Date | null | undefined,
  shelfLifeDays: number | null | undefined,
): Date | null {
  if (!shelfLifeDays || shelfLifeDays <= 0) {
    return null;
  }
  const anchor = baseDate ?? new Date();
  return new Date(anchor.getTime() + shelfLifeDays * 86_400_000);
}

export function classifyLotExpiry(
  expiresAt: Date | null,
  now: Date,
  warningDays: number,
  criticalDays: number,
): { bucket: LotExpiryBucket; daysUntilExpiry: number | null } {
  if (!expiresAt) {
    return { bucket: "NO_EXPIRY", daysUntilExpiry: null };
  }
  const diffMs = expiresAt.getTime() - now.getTime();
  const daysUntilExpiry = Math.ceil(diffMs / 86_400_000);

  if (diffMs <= 0) {
    return { bucket: "EXPIRED", daysUntilExpiry };
  }
  if (diffMs <= Math.max(0, criticalDays) * 86_400_000) {
    return { bucket: "CRITICAL", daysUntilExpiry };
  }
  if (diffMs <= Math.max(0, warningDays) * 86_400_000) {
    return { bucket: "WARNING", daysUntilExpiry };
  }
  return { bucket: "HEALTHY", daysUntilExpiry };
}

export async function resolveEffectiveExpiryPolicyTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<EffectiveExpiryPolicy> {
  const existing = await tx.stockExpiryPolicy.findUnique({
    where: { organizationId },
  });
  if (!existing) {
    return {
      warningDays: 30,
      criticalDays: 7,
      enforcementMode: ExpiryEnforcementMode.BLOCK_EXPIRED,
      autoQuarantineExpired: false,
      autoQuarantineOnCriticalDays: null,
      scanIntervalMinutes: 60,
      isScannerActive: true,
    };
  }
  return {
    warningDays: existing.warningDays,
    criticalDays: existing.criticalDays,
    enforcementMode: existing.enforcementMode,
    autoQuarantineExpired: existing.autoQuarantineExpired,
    autoQuarantineOnCriticalDays: existing.autoQuarantineOnCriticalDays,
    scanIntervalMinutes: existing.scanIntervalMinutes,
    isScannerActive: existing.isScannerActive,
  };
}

function sortLotsByStrategy<
  T extends { id: string; expiresAt: Date | null; createdAt: Date },
>(lots: T[], strategy: LotAllocationStrategy): T[] {
  return [...lots].sort((a, b) => {
    if (strategy === LotAllocationStrategy.FEFO) {
      const aExp = a.expiresAt
        ? a.expiresAt.getTime()
        : Number.POSITIVE_INFINITY;
      const bExp = b.expiresAt
        ? b.expiresAt.getTime()
        : Number.POSITIVE_INFINITY;
      if (aExp !== bExp) {
        return aExp - bExp;
      }
    }
    const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return a.id.localeCompare(b.id);
  });
}

export async function assertReservableStockExpiryInTx(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    itemId: string;
    sku: string;
    trackExpiry: boolean;
    allowNegativeStock: boolean;
    locationId: string;
    locationCode: string;
    stockBalanceOnHand: number;
    alreadyReservedQty: number;
    requestedBaseQty: number;
    now?: Date;
  },
): Promise<void> {
  if (params.requestedBaseQty <= 0 || params.allowNegativeStock) {
    return;
  }

  const now = params.now ?? new Date();
  const lots = await tx.stockLot.findMany({
    where: {
      organizationId: params.organizationId,
      itemId: params.itemId,
      locationId: params.locationId,
      onHandQty: { gt: 0 },
    },
    select: {
      id: true,
      onHandQty: true,
      expiresAt: true,
    },
  });

  if (lots.length === 0) {
    if (params.trackExpiry) {
      throw new BadRequestException(
        `SKU "${params.sku}" tracks expiry and has no active stock lots available to reserve at "${params.locationCode}".`,
      );
    }
    return;
  }

  const policy = await resolveEffectiveExpiryPolicyTx(tx, params.organizationId);
  if (policy.enforcementMode !== ExpiryEnforcementMode.BLOCK_EXPIRED) {
    return;
  }

  let totalLotOnHand = 0;
  let nonExpiredLotOnHand = 0;
  let expiredLotOnHand = 0;

  for (const lot of lots) {
    totalLotOnHand += lot.onHandQty;
    if (!lot.expiresAt || lot.expiresAt.getTime() > now.getTime()) {
      nonExpiredLotOnHand += lot.onHandQty;
    } else {
      expiredLotOnHand += lot.onHandQty;
    }
  }

  const unlottedOnHand = params.trackExpiry
    ? 0
    : Math.max(0, params.stockBalanceOnHand - totalLotOnHand);
  const nonExpiredAvailable =
    nonExpiredLotOnHand + unlottedOnHand - params.alreadyReservedQty;

  if (nonExpiredAvailable < params.requestedBaseQty) {
    throw new BadRequestException(
      `Insufficient non-expired stock to reserve SKU "${params.sku}" at "${params.locationCode}" (non-expired available: ${Math.max(0, nonExpiredAvailable)}, expired blocked: ${expiredLotOnHand}, requested: ${params.requestedBaseQty}).`,
    );
  }
}

export async function allocateAndDeductLotsInTx(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    itemId: string;
    sku: string;
    trackExpiry: boolean;
    allowNegativeStock: boolean;
    lotAllocationStrategy: LotAllocationStrategy;
    locationId: string;
    locationCode: string;
    currentBalanceOnHand: number;
    baseQty: number;
    allowExpiredOverride?: boolean;
    now?: Date;
  },
): Promise<{
  usedLots: AllocatedLotSlice[];
  unlottedQty: number;
}> {
  if (params.baseQty <= 0) {
    return { usedLots: [], unlottedQty: 0 };
  }

  const now = params.now ?? new Date();
  const lots = await tx.stockLot.findMany({
    where: {
      organizationId: params.organizationId,
      itemId: params.itemId,
      locationId: params.locationId,
      onHandQty: { gt: 0 },
    },
  });

  if (lots.length === 0) {
    if (params.trackExpiry && !params.allowNegativeStock) {
      throw new BadRequestException(
        `SKU "${params.sku}" tracks expiry and has no eligible stock lots on hand at "${params.locationCode}".`,
      );
    }
    return { usedLots: [], unlottedQty: params.baseQty };
  }

  const policy = await resolveEffectiveExpiryPolicyTx(tx, params.organizationId);
  const strategy =
    params.lotAllocationStrategy === LotAllocationStrategy.FIFO
      ? LotAllocationStrategy.FIFO
      : LotAllocationStrategy.FEFO;

  const nonExpiredLots = sortLotsByStrategy(
    lots.filter((l) => !l.expiresAt || l.expiresAt.getTime() > now.getTime()),
    strategy,
  );
  const expiredLots = sortLotsByStrategy(
    lots.filter((l) => l.expiresAt !== null && l.expiresAt.getTime() <= now.getTime()),
    strategy,
  );

  const totalLotOnHand = lots.reduce((sum, l) => sum + l.onHandQty, 0);
  const nonExpiredOnHand = nonExpiredLots.reduce((sum, l) => sum + l.onHandQty, 0);
  const expiredOnHand = expiredLots.reduce((sum, l) => sum + l.onHandQty, 0);

  const allowExpired =
    policy.enforcementMode === ExpiryEnforcementMode.WARN_ONLY ||
    Boolean(
      params.allowExpiredOverride &&
        policy.enforcementMode !== ExpiryEnforcementMode.BLOCK_EXPIRED,
    );

  const orderedPool = allowExpired
    ? [...nonExpiredLots, ...expiredLots]
    : nonExpiredLots;

  let remaining = params.baseQty;
  const chosen: Array<{
    lot: (typeof lots)[number];
    takeQty: number;
  }> = [];

  for (const lot of orderedPool) {
    if (remaining <= 0) break;
    const takeQty = Math.min(lot.onHandQty, remaining);
    if (takeQty > 0) {
      chosen.push({ lot, takeQty });
      remaining -= takeQty;
    }
  }

  let unlottedQty = 0;
  if (remaining > 0) {
    const unlottedOnHand = Math.max(0, params.currentBalanceOnHand - totalLotOnHand);
    if (!params.trackExpiry && unlottedOnHand >= remaining) {
      unlottedQty = remaining;
      remaining = 0;
    } else if (params.allowNegativeStock && !params.trackExpiry) {
      unlottedQty = remaining;
      remaining = 0;
    } else if (!allowExpired && expiredOnHand > 0) {
      throw new BadRequestException(
        `Expired stock blocked by FEFO policy for SKU "${params.sku}" at "${params.locationCode}" (non-expired lot qty: ${nonExpiredOnHand}, expired lot qty: ${expiredOnHand}, needed: ${params.baseQty}).`,
      );
    } else {
      throw new BadRequestException(
        `Insufficient lot stock for SKU "${params.sku}" at "${params.locationCode}" (available: ${params.baseQty - remaining}, needed: ${params.baseQty}).`,
      );
    }
  }

  const usedLots: AllocatedLotSlice[] = [];
  for (const step of chosen) {
    const updated = await tx.stockLot.updateMany({
      where: {
        id: step.lot.id,
        organizationId: params.organizationId,
        onHandQty: { gte: step.takeQty },
      },
      data: {
        onHandQty: { decrement: step.takeQty },
        consumedQty: { increment: step.takeQty },
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException(
        `Stock lot "${step.lot.lotNumber}" was modified concurrently. Retry operation.`,
      );
    }

    if (step.lot.onHandQty - step.takeQty === 0 && step.lot.quarantinedQty === 0) {
      await tx.stockExpiryAlert.updateMany({
        where: {
          organizationId: params.organizationId,
          stockLotId: step.lot.id,
          status: { in: [ExpiryAlertStatus.OPEN, ExpiryAlertStatus.ACKNOWLEDGED] },
        },
        data: {
          status: ExpiryAlertStatus.RESOLVED,
          resolvedAt: now,
          resolutionNotes: "Lot depleted through stock allocation.",
        },
      });
    }

    usedLots.push({
      stockLotId: step.lot.id,
      lotNumber: step.lot.lotNumber,
      batchCode: step.lot.batchCode,
      supplierId: step.lot.supplierId,
      supplierItemId: step.lot.supplierItemId,
      supplierSku: step.lot.supplierSku,
      supplierBatchNumber: step.lot.supplierBatchNumber,
      manufacturedAt: step.lot.manufacturedAt,
      expiresAt: step.lot.expiresAt,
      quantity: step.takeQty,
      unitCostCents: step.lot.unitCostCents,
    });
  }

  return { usedLots, unlottedQty };
}

export async function recordAllocatedStockMovementsInTx(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    itemId: string;
    locationId: string;
    type: StockMovementType;
    startingBalanceOnHand: number;
    usedLots: AllocatedLotSlice[];
    unlottedQty: number;
    referenceType: string;
    referenceId: string;
    reason: string;
    actorUserId: string;
  },
): Promise<void> {
  let runningBalance = params.startingBalanceOnHand;

  for (const slice of params.usedLots) {
    runningBalance -= slice.quantity;
    await tx.stockMovement.create({
      data: {
        organizationId: params.organizationId,
        itemId: params.itemId,
        locationId: params.locationId,
        type: params.type,
        quantityDelta: -slice.quantity,
        balanceAfter: runningBalance,
        stockLotId: slice.stockLotId,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        reason: `${params.reason} [Lot ${slice.lotNumber}]`,
        actorUserId: params.actorUserId,
      },
    });
  }

  if (params.unlottedQty > 0) {
    runningBalance -= params.unlottedQty;
    await tx.stockMovement.create({
      data: {
        organizationId: params.organizationId,
        itemId: params.itemId,
        locationId: params.locationId,
        type: params.type,
        quantityDelta: -params.unlottedQty,
        balanceAfter: runningBalance,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        reason: params.reason,
        actorUserId: params.actorUserId,
      },
    });
  }
}

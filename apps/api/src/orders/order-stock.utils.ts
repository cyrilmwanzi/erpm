import { BadRequestException, NotFoundException } from "@nestjs/common";
import { LocationStatus, Prisma, StockMovementType } from "@scace/db";
import {
  allocateAndDeductLotsInTx,
  assertReservableStockExpiryInTx,
  recordAllocatedStockMovementsInTx,
} from "../locations/lot-allocation.utils.js";

export interface StockTargetRequirement {
  itemId: string;
  sku: string;
  baseQty: number;
}

export async function resolveLineStockTargets(
  tx: Prisma.TransactionClient,
  organizationId: string,
  item: {
    id: string;
    sku: string;
    trackInventory: boolean;
    isBundle: boolean;
  },
  baseQty: number,
  lineQty: number,
): Promise<StockTargetRequirement[]> {
  if (item.trackInventory) {
    return [{ itemId: item.id, sku: item.sku, baseQty }];
  }

  if (!item.isBundle) {
    return [];
  }

  const components = await tx.itemBundleComponent.findMany({
    where: { organizationId, bundleItemId: item.id, isOptional: false },
    include: {
      componentItem: {
        select: { id: true, sku: true, trackInventory: true },
      },
      componentPack: {
        select: { unitsPerPack: true },
      },
    },
  });

  const targets: StockTargetRequirement[] = [];
  for (const comp of components) {
    if (comp.componentItem.trackInventory) {
      const compBase =
        comp.quantity * lineQty * (comp.componentPack?.unitsPerPack ?? 1);
      targets.push({
        itemId: comp.componentItem.id,
        sku: comp.componentItem.sku,
        baseQty: compBase,
      });
    }
  }

  return targets;
}

export async function reserveStockBalance(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    itemId: string;
    locationId: string;
    locationCode: string;
    baseQty: number;
  },
): Promise<void> {
  if (params.baseQty <= 0) return;

  const item = await tx.item.findFirstOrThrow({
    where: { id: params.itemId, organizationId: params.organizationId },
    select: {
      sku: true,
      trackInventory: true,
      allowNegativeStock: true,
      trackExpiry: true,
    },
  });
  if (!item.trackInventory) return;

  const bal = await tx.stockBalance.findUnique({
    where: {
      organizationId_itemId_locationId: {
        organizationId: params.organizationId,
        itemId: params.itemId,
        locationId: params.locationId,
      },
    },
  });

  const onHand = bal?.onHandQty ?? 0;
  const reserved = bal?.reservedQty ?? 0;
  const available = onHand - reserved;

  if (available < params.baseQty && !item.allowNegativeStock) {
    throw new BadRequestException(
      `Insufficient available stock to reserve SKU "${item.sku}" at "${params.locationCode}" (available: ${available}, requested: ${params.baseQty}).`,
    );
  }

  await assertReservableStockExpiryInTx(tx, {
    organizationId: params.organizationId,
    itemId: params.itemId,
    sku: item.sku,
    trackExpiry: item.trackExpiry,
    allowNegativeStock: item.allowNegativeStock,
    locationId: params.locationId,
    locationCode: params.locationCode,
    stockBalanceOnHand: onHand,
    alreadyReservedQty: reserved,
    requestedBaseQty: params.baseQty,
  });

  if (bal) {
    await tx.stockBalance.update({
      where: { id: bal.id },
      data: { reservedQty: reserved + params.baseQty },
    });
  } else {
    await tx.stockBalance.create({
      data: {
        organizationId: params.organizationId,
        itemId: params.itemId,
        locationId: params.locationId,
        onHandQty: 0,
        reservedQty: params.baseQty,
      },
    });
  }
}

export async function deductStockBalance(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    itemId: string;
    locationId: string;
    locationCode: string;
    baseQty: number;
    releaseReservedQty: number;
    referenceType: string;
    referenceId: string;
    reason: string;
    actorUserId: string;
  },
): Promise<void> {
  if (params.baseQty <= 0) return;

  const item = await tx.item.findFirstOrThrow({
    where: { id: params.itemId, organizationId: params.organizationId },
    select: {
      sku: true,
      trackInventory: true,
      allowNegativeStock: true,
      trackExpiry: true,
      lotAllocationStrategy: true,
    },
  });
  if (!item.trackInventory) return;

  const bal = await tx.stockBalance.findUnique({
    where: {
      organizationId_itemId_locationId: {
        organizationId: params.organizationId,
        itemId: params.itemId,
        locationId: params.locationId,
      },
    },
  });

  const currentQty = bal?.onHandQty ?? 0;
  const nextQty = currentQty - params.baseQty;

  if (nextQty < 0 && !item.allowNegativeStock) {
    throw new BadRequestException(
      `Insufficient stock for SKU "${item.sku}" at location "${params.locationCode}" (on hand: ${currentQty}, needed: ${params.baseQty}).`,
    );
  }

  const allocation = await allocateAndDeductLotsInTx(tx, {
    organizationId: params.organizationId,
    itemId: params.itemId,
    sku: item.sku,
    trackExpiry: item.trackExpiry,
    allowNegativeStock: item.allowNegativeStock,
    lotAllocationStrategy: item.lotAllocationStrategy,
    locationId: params.locationId,
    locationCode: params.locationCode,
    currentBalanceOnHand: currentQty,
    baseQty: params.baseQty,
  });

  const nextReserved = Math.max(
    0,
    (bal?.reservedQty ?? 0) - params.releaseReservedQty,
  );

  if (bal) {
    await tx.stockBalance.update({
      where: { id: bal.id },
      data: { onHandQty: nextQty, reservedQty: nextReserved },
    });
  } else {
    await tx.stockBalance.create({
      data: {
        organizationId: params.organizationId,
        itemId: params.itemId,
        locationId: params.locationId,
        onHandQty: nextQty,
        reservedQty: 0,
      },
    });
  }

  await recordAllocatedStockMovementsInTx(tx, {
    organizationId: params.organizationId,
    itemId: params.itemId,
    locationId: params.locationId,
    type: StockMovementType.SALE,
    startingBalanceOnHand: currentQty,
    usedLots: allocation.usedLots,
    unlottedQty: allocation.unlottedQty,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    reason: params.reason,
    actorUserId: params.actorUserId,
  });
}

export async function reserveOrderStockInTransaction(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    orderId: string;
  },
): Promise<boolean> {
  const order = await tx.order.findFirst({
    where: { id: params.orderId, organizationId: params.organizationId },
    include: {
      location: { select: { id: true, code: true, status: true } },
      lines: { include: { item: true } },
    },
  });
  if (!order) {
    throw new NotFoundException("Order was not found.");
  }
  if (order.location.status !== LocationStatus.ACTIVE) {
    throw new BadRequestException("Order location must be ACTIVE.");
  }

  let reservedAny = false;
  for (const line of order.lines) {
    const remainingToReserve = Math.max(
      0,
      line.orderedBaseQty - line.fulfilledBaseQty - line.reservedBaseQty,
    );
    if (remainingToReserve <= 0) {
      continue;
    }

    const targets = await resolveLineStockTargets(
      tx,
      params.organizationId,
      line.item,
      remainingToReserve,
      Math.max(1, line.quantity - line.fulfilledQty),
    );

    let totalReservedForLine = 0;
    for (const target of targets) {
      await reserveStockBalance(tx, {
        organizationId: params.organizationId,
        itemId: target.itemId,
        locationId: order.locationId,
        locationCode: order.location.code,
        baseQty: target.baseQty,
      });
      totalReservedForLine += target.baseQty;
    }

    if (totalReservedForLine > 0) {
      reservedAny = true;
      await tx.orderLine.update({
        where: { id: line.id },
        data: { reservedBaseQty: line.reservedBaseQty + totalReservedForLine },
      });
    }
  }

  return reservedAny;
}

export async function deductOrderStockInTransaction(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    orderId: string;
    actorUserId: string;
    reason: string;
  },
): Promise<void> {
  const order = await tx.order.findFirst({
    where: { id: params.orderId, organizationId: params.organizationId },
    include: {
      location: { select: { id: true, code: true } },
      lines: { include: { item: true } },
    },
  });
  if (!order) {
    throw new NotFoundException("Order was not found.");
  }

  for (const line of order.lines) {
    const remainingBaseQty = Math.max(
      0,
      line.orderedBaseQty - line.fulfilledBaseQty,
    );
    const remainingLineQty = Math.max(0, line.quantity - line.fulfilledQty);
    if (remainingBaseQty <= 0 && remainingLineQty <= 0) {
      continue;
    }

    const releaseReserved = Math.min(line.reservedBaseQty, remainingBaseQty);
    const targets = await resolveLineStockTargets(
      tx,
      params.organizationId,
      line.item,
      remainingBaseQty,
      Math.max(1, remainingLineQty),
    );

    let remainingReserveToRelease = releaseReserved;
    for (const target of targets) {
      const releaseForTarget = Math.min(
        remainingReserveToRelease,
        target.baseQty,
      );
      remainingReserveToRelease -= releaseForTarget;

      await deductStockBalance(tx, {
        organizationId: params.organizationId,
        itemId: target.itemId,
        locationId: order.locationId,
        locationCode: order.location.code,
        baseQty: target.baseQty,
        releaseReservedQty: releaseForTarget,
        referenceType: "Order",
        referenceId: order.id,
        reason: params.reason,
        actorUserId: params.actorUserId,
      });
    }

    await tx.orderLine.update({
      where: { id: line.id },
      data: {
        fulfilledQty: line.quantity,
        fulfilledBaseQty: line.orderedBaseQty,
        reservedBaseQty: 0,
      },
    });
  }
}

export async function releaseOrderStockInTransaction(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    orderId: string;
  },
): Promise<void> {
  const order = await tx.order.findFirst({
    where: { id: params.orderId, organizationId: params.organizationId },
    include: {
      lines: { include: { item: true } },
    },
  });
  if (!order) {
    return;
  }

  for (const line of order.lines) {
    if (line.reservedBaseQty <= 0) {
      continue;
    }
    const targets = await resolveLineStockTargets(
      tx,
      params.organizationId,
      line.item,
      line.reservedBaseQty,
      Math.max(1, line.quantity - line.fulfilledQty),
    );
    let toRelease = line.reservedBaseQty;
    for (const target of targets) {
      const chunk = Math.min(toRelease, target.baseQty);
      toRelease -= chunk;
      if (chunk > 0) {
        const bal = await tx.stockBalance.findUnique({
          where: {
            organizationId_itemId_locationId: {
              organizationId: params.organizationId,
              itemId: target.itemId,
              locationId: order.locationId,
            },
          },
        });
        if (bal) {
          await tx.stockBalance.update({
            where: { id: bal.id },
            data: { reservedQty: Math.max(0, bal.reservedQty - chunk) },
          });
        }
      }
    }
    await tx.orderLine.update({
      where: { id: line.id },
      data: { reservedBaseQty: 0 },
    });
  }
}

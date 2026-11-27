import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
} from "@nestjs/common";
import {
  StorageEntityType,
  StoredObjectStatus,
  type Prisma,
  type StoredObject,
} from "@scace/db";
import { BillingEnforcementService } from "../billing/billing-enforcement.service.js";
import { getEnv } from "../config/env.js";
import { PrismaService } from "../database/prisma.service.js";
import { AnalyticsService } from "../observability/analytics.service.js";
import { RedisService } from "../redis/redis.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { RustfsService } from "./rustfs.service.js";
import {
  buildContentDisposition,
  buildOrganizationObjectKey,
  deriveOrganizationBucketName,
  sanitizeFilename,
} from "./storage.utils.js";

export interface SerializedStoredObject {
  id: string;
  organizationId: string;
  bucket: string;
  objectKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  etag: string | null;
  status: StoredObjectStatus;
  entityType: StorageEntityType;
  entityId: string | null;
  uploadedByUserId: string | null;
  tags: string[];
  metadata: unknown;
  completedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePresignedUploadInput {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  entityType?: StorageEntityType;
  entityId?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
}

export interface DirectUploadInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  entityType?: StorageEntityType;
  entityId?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
}

export interface ListStoredObjectsQuery {
  entityType?: StorageEntityType;
  entityId?: string;
  status?: StoredObjectStatus;
  mimeType?: string;
  search?: string;
  limit?: number;
  cursor?: string;
}

export interface UpdateStoredObjectInput {
  entityType?: StorageEntityType;
  entityId?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
}

@Injectable()
export class StorageService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(RedisService) private readonly redisService: RedisService,
    @Inject(RustfsService) private readonly rustfsService: RustfsService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
    @Optional()
    @Inject(BillingEnforcementService)
    private readonly billingEnforcement?: BillingEnforcementService,
  ) {}

  private serializeObject(obj: StoredObject): SerializedStoredObject {
    return {
      ...obj,
      sizeBytes: Number(obj.sizeBytes),
    };
  }

  private normalizeMimeType(rawMimeType: string | undefined): string {
    const cleaned = (rawMimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(cleaned)) {
      return cleaned.slice(0, 128);
    }
    return "application/octet-stream";
  }

  private async ensureOrgStorageSettings(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<{ bucket: string; quotaBytes: number }> {
    const env = getEnv();
    const expectedBucket = deriveOrganizationBucketName(
      organizationId,
      env.RUSTFS_BUCKET_PREFIX,
    );

    let settings = await tx.organizationSettings.findFirst({
      where: { organizationId },
    });

    if (!settings) {
      settings = await tx.organizationSettings.create({
        data: {
          organizationId,
          defaultCurrency: "USD",
          timezone: "UTC",
          fiscalYearStartMonth: 1,
          storageBucket: expectedBucket,
          storageQuotaBytes: BigInt(env.STORAGE_DEFAULT_QUOTA_BYTES),
        },
      });
    } else if (!settings.storageBucket) {
      settings = await tx.organizationSettings.update({
        where: { id: settings.id },
        data: { storageBucket: expectedBucket },
      });
    }

    const bucket = settings.storageBucket ?? expectedBucket;
    let quotaBytes = Number(
      settings.storageQuotaBytes ?? BigInt(env.STORAGE_DEFAULT_QUOTA_BYTES),
    );

    if (this.billingEnforcement) {
      const entitlement =
        await this.billingEnforcement.evaluateOrganizationEntitlement(
          organizationId,
        );
      if (entitlement.isExempt) {
        quotaBytes = Number.MAX_SAFE_INTEGER;
      } else if (
        entitlement.enforceQuotas &&
        entitlement.limits.maxStorageBytes !== null &&
        entitlement.limits.maxStorageBytes !== undefined
      ) {
        quotaBytes = entitlement.limits.maxStorageBytes;
      }
    }

    // Lock organization settings row during quota-sensitive transactions on PostgreSQL
    await tx.$queryRaw`SELECT "id" FROM "tenant_settings" WHERE "organizationId" = ${organizationId} FOR UPDATE`;

    return { bucket, quotaBytes };
  }

  private async verifySameOrganizationEntity(
    tx: Prisma.TransactionClient,
    organizationId: string,
    entityType: StorageEntityType,
    entityId?: string | null,
  ): Promise<string | null> {
    if (entityType === StorageEntityType.ORGANIZATION) {
      if (entityId && entityId !== organizationId) {
        throw new BadRequestException(
          "entityId cannot reference a different organization.",
        );
      }
      return entityId ? organizationId : null;
    }

    if (!entityId || entityId.trim().length === 0) {
      throw new BadRequestException(
        `entityId is required when entityType is ${entityType}.`,
      );
    }

    const trimmedId = entityId.trim();
    let found: { id: string } | null = null;

    switch (entityType) {
      case StorageEntityType.ITEM:
        found = await tx.item.findFirst({
          where: { id: trimmedId, organizationId },
          select: { id: true },
        });
        break;
      case StorageEntityType.VENDOR_BILL:
        found = await tx.vendorBill.findFirst({
          where: { id: trimmedId, organizationId },
          select: { id: true },
        });
        break;
      case StorageEntityType.PURCHASE_ORDER:
        found = await tx.purchaseOrder.findFirst({
          where: { id: trimmedId, organizationId },
          select: { id: true },
        });
        break;
      case StorageEntityType.GOODS_RECEIPT:
        found = await tx.goodsReceipt.findFirst({
          where: { id: trimmedId, organizationId },
          select: { id: true },
        });
        break;
      case StorageEntityType.GOODS_RECEIPT_LINE:
        found = await tx.goodsReceiptLine.findFirst({
          where: { id: trimmedId, organizationId },
          select: { id: true },
        });
        break;
      case StorageEntityType.STOCK_LOT:
        found = await tx.stockLot.findFirst({
          where: { id: trimmedId, organizationId },
          select: { id: true },
        });
        break;
      case StorageEntityType.PRODUCTION_BATCH:
        found = await tx.productionBatch.findFirst({
          where: { id: trimmedId, organizationId },
          select: { id: true },
        });
        break;
      case StorageEntityType.PRODUCTION_OPERATION:
        found = await tx.productionOperation.findFirst({
          where: { id: trimmedId, organizationId },
          select: { id: true },
        });
        break;
      case StorageEntityType.PRODUCTION_QC_CHECKPOINT:
        found = await tx.productionQcCheckpoint.findFirst({
          where: { id: trimmedId, organizationId },
          select: { id: true },
        });
        break;
      case StorageEntityType.SUPPLIER:
        found = await tx.supplier.findFirst({
          where: { id: trimmedId, organizationId },
          select: { id: true },
        });
        break;
      case StorageEntityType.CUSTOMER:
        found = await tx.customer.findFirst({
          where: { id: trimmedId, organizationId },
          select: { id: true },
        });
        break;
      case StorageEntityType.ORDER:
        found = await tx.order.findFirst({
          where: { id: trimmedId, organizationId },
          select: { id: true },
        });
        break;
      case StorageEntityType.SALES_INVOICE:
        found = await tx.salesInvoice.findFirst({
          where: { id: trimmedId, organizationId },
          select: { id: true },
        });
        break;
      case StorageEntityType.PAYMENT_RECEIPT:
        found = await tx.paymentReceipt.findFirst({
          where: { id: trimmedId, organizationId },
          select: { id: true },
        });
        break;
      case StorageEntityType.REPORT_RUN:
        found = await tx.reportRun.findFirst({
          where: { id: trimmedId, organizationId },
          select: { id: true },
        });
        break;
    }

    if (!found) {
      throw new NotFoundException(
        `Referenced ${entityType} (${trimmedId}) was not found in the active organization.`,
      );
    }

    return found.id;
  }

  private async getCurrentUsageBytes(
    tx: Prisma.TransactionClient,
    organizationId: string,
    excludeObjectId?: string,
  ): Promise<{ usedBytes: number; pendingBytes: number; objectCount: number }> {
    const [readyAgg, pendingAgg] = await Promise.all([
      tx.storedObject.aggregate({
        where: {
          organizationId,
          status: StoredObjectStatus.READY,
          ...(excludeObjectId ? { id: { not: excludeObjectId } } : {}),
        },
        _sum: { sizeBytes: true },
        _count: { _all: true },
      }),
      tx.storedObject.aggregate({
        where: {
          organizationId,
          status: StoredObjectStatus.PENDING,
          ...(excludeObjectId ? { id: { not: excludeObjectId } } : {}),
        },
        _sum: { sizeBytes: true },
        _count: { _all: true },
      }),
    ]);

    const usedBytes = Number(readyAgg?._sum?.sizeBytes ?? 0);
    const pendingBytes = Number(pendingAgg?._sum?.sizeBytes ?? 0);
    const objectCount =
      Number(readyAgg?._count?._all ?? 0) + Number(pendingAgg?._count?._all ?? 0);

    return { usedBytes, pendingBytes, objectCount };
  }

  async getQuota(tenant: AuthenticatedOrganization) {
    const result = await this.prismaService.raw.$transaction(async (tx) => {
      const { bucket, quotaBytes } = await this.ensureOrgStorageSettings(
        tx,
        tenant.organizationId,
      );
      await this.rustfsService.ensureBucket(bucket);
      const usage = await this.getCurrentUsageBytes(tx, tenant.organizationId);
      const reservedBytes = usage.usedBytes + usage.pendingBytes;

      return {
        organizationId: tenant.organizationId,
        bucket,
        quotaBytes,
        usedBytes: usage.usedBytes,
        pendingBytes: usage.pendingBytes,
        reservedBytes,
        remainingBytes: Math.max(0, quotaBytes - reservedBytes),
        objectCount: usage.objectCount,
      };
    });

    return result;
  }

  async updateQuota(
    tenant: AuthenticatedOrganization,
    quotaBytes: number,
    ipAddress?: string,
  ) {
    if (!Number.isFinite(quotaBytes) || quotaBytes < 1024) {
      throw new BadRequestException(
        "storageQuotaBytes must be at least 1024 bytes.",
      );
    }

    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const { bucket } = await this.ensureOrgStorageSettings(
        tx,
        tenant.organizationId,
      );
      await this.rustfsService.ensureBucket(bucket);

      const settings = await tx.organizationSettings.findFirst({
        where: { organizationId: tenant.organizationId },
      });

      if (!settings) {
        throw new NotFoundException("Organization settings not found.");
      }

      const saved = await tx.organizationSettings.update({
        where: { id: settings.id },
        data: {
          storageQuotaBytes: BigInt(Math.floor(quotaBytes)),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "storage.quota.updated",
          resourceType: "OrganizationSettings",
          resourceId: saved.id,
          metadata: {
            previousQuotaBytes: Number(settings.storageQuotaBytes),
            nextQuotaBytes: Math.floor(quotaBytes),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      const usage = await this.getCurrentUsageBytes(tx, tenant.organizationId);
      const nextQuota = Number(saved.storageQuotaBytes);
      const reservedBytes = usage.usedBytes + usage.pendingBytes;

      return {
        organizationId: tenant.organizationId,
        bucket,
        quotaBytes: nextQuota,
        usedBytes: usage.usedBytes,
        pendingBytes: usage.pendingBytes,
        reservedBytes,
        remainingBytes: Math.max(0, nextQuota - reservedBytes),
        objectCount: usage.objectCount,
      };
    });

    try {
      await this.redisService.invalidateOrganizationCache(
        tenant.organizationId,
        "settings",
      );
    } catch {
      // Non-fatal cache invalidation failure
    }

    return updated;
  }

  async createPresignedUpload(
    tenant: AuthenticatedOrganization,
    input: CreatePresignedUploadInput,
    ipAddress?: string,
  ) {
    const env = getEnv();
    if (input.sizeBytes <= 0) {
      throw new BadRequestException("File sizeBytes must be greater than 0.");
    }
    if (input.sizeBytes > env.STORAGE_MAX_FILE_BYTES) {
      throw new PayloadTooLargeException(
        `File exceeds maximum allowed object size of ${env.STORAGE_MAX_FILE_BYTES} bytes.`,
      );
    }

    const originalName = sanitizeFilename(input.filename);
    const mimeType = this.normalizeMimeType(input.mimeType);
    const entityType = input.entityType ?? StorageEntityType.ORGANIZATION;
    const objectKey = buildOrganizationObjectKey(entityType, originalName);

    const reserved = await this.prismaService.raw.$transaction(async (tx) => {
      const { bucket, quotaBytes } = await this.ensureOrgStorageSettings(
        tx,
        tenant.organizationId,
      );
      const verifiedEntityId = await this.verifySameOrganizationEntity(
        tx,
        tenant.organizationId,
        entityType,
        input.entityId,
      );

      const usage = await this.getCurrentUsageBytes(tx, tenant.organizationId);
      const projectedBytes =
        usage.usedBytes + usage.pendingBytes + Math.floor(input.sizeBytes);
      if (projectedBytes > quotaBytes) {
        throw new PayloadTooLargeException(
          `Organization storage quota exceeded (${projectedBytes} > ${quotaBytes} bytes).`,
        );
      }

      const created = await tx.storedObject.create({
        data: {
          organizationId: tenant.organizationId,
          bucket,
          objectKey,
          originalName,
          mimeType,
          sizeBytes: BigInt(Math.floor(input.sizeBytes)),
          status: StoredObjectStatus.PENDING,
          entityType,
          entityId: verifiedEntityId,
          uploadedByUserId: tenant.userId,
          tags: input.tags ?? [],
          metadata: (input.metadata ?? null) as Prisma.InputJsonValue,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "storage.object.presigned",
          resourceType: "StoredObject",
          resourceId: created.id,
          metadata: {
            bucket,
            objectKey,
            originalName,
            mimeType,
            sizeBytes: Math.floor(input.sizeBytes),
            entityType,
            entityId: verifiedEntityId,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return created;
    });

    const uploadUrl = await this.rustfsService.createPresignedPutUrl(
      reserved.bucket,
      reserved.objectKey,
      reserved.mimeType,
      env.STORAGE_PRESIGN_EXPIRES_SECONDS,
    );

    return {
      object: this.serializeObject(reserved),
      upload: {
        method: "PUT" as const,
        url: uploadUrl,
        expiresInSeconds: env.STORAGE_PRESIGN_EXPIRES_SECONDS,
        headers: {
          "Content-Type": reserved.mimeType,
        },
      },
    };
  }

  async completeUpload(
    tenant: AuthenticatedOrganization,
    objectId: string,
    ipAddress?: string,
  ) {
    const existing = await this.prismaService.scoped.storedObject.findFirst({
      where: { id: objectId },
    });

    if (!existing || existing.status === StoredObjectStatus.DELETED) {
      throw new NotFoundException("Stored object record not found.");
    }

    if (existing.status === StoredObjectStatus.READY) {
      return this.serializeObject(existing);
    }

    const head = await this.rustfsService.headObject(
      existing.bucket,
      existing.objectKey,
    );

    const env = getEnv();
    if (head.sizeBytes <= 0) {
      await this.rustfsService.deleteObject(existing.bucket, existing.objectKey);
      throw new BadRequestException("Uploaded object cannot be empty.");
    }
    if (head.sizeBytes > env.STORAGE_MAX_FILE_BYTES) {
      await this.rustfsService.deleteObject(existing.bucket, existing.objectKey);
      throw new PayloadTooLargeException(
        `Uploaded object exceeds maximum size of ${env.STORAGE_MAX_FILE_BYTES} bytes.`,
      );
    }

    const completed = await this.prismaService.raw.$transaction(async (tx) => {
      const { quotaBytes } = await this.ensureOrgStorageSettings(
        tx,
        tenant.organizationId,
      );
      const usage = await this.getCurrentUsageBytes(
        tx,
        tenant.organizationId,
        existing.id,
      );
      const projectedBytes =
        usage.usedBytes + usage.pendingBytes + head.sizeBytes;
      if (projectedBytes > quotaBytes) {
        throw new PayloadTooLargeException(
          `Organization storage quota exceeded (${projectedBytes} > ${quotaBytes} bytes).`,
        );
      }

      const updated = await tx.storedObject.update({
        where: { id: existing.id },
        data: {
          status: StoredObjectStatus.READY,
          sizeBytes: BigInt(head.sizeBytes),
          etag: head.etag,
          completedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "storage.object.completed",
          resourceType: "StoredObject",
          resourceId: updated.id,
          metadata: {
            bucket: updated.bucket,
            objectKey: updated.objectKey,
            sizeBytes: head.sizeBytes,
            etag: head.etag,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });

    this.analyticsService.captureDomainEvent({
      event: "storage.file_uploaded",
      distinctId: tenant.userId,
      organizationId: tenant.organizationId,
      properties: {
        stored_object_id: completed.id,
        entity_type: completed.entityType,
        mime_type: completed.mimeType,
        size_bytes: Number(completed.sizeBytes),
        upload_mode: "presigned",
      },
    });

    return this.serializeObject(completed);
  }

  async uploadDirect(
    tenant: AuthenticatedOrganization,
    input: DirectUploadInput,
    ipAddress?: string,
  ) {
    const env = getEnv();
    const sizeBytes = input.buffer.byteLength;

    if (sizeBytes <= 0) {
      throw new BadRequestException("Uploaded file cannot be empty.");
    }
    if (sizeBytes > env.STORAGE_MAX_FILE_BYTES) {
      throw new PayloadTooLargeException(
        `File exceeds maximum allowed object size of ${env.STORAGE_MAX_FILE_BYTES} bytes.`,
      );
    }

    const originalName = sanitizeFilename(input.filename);
    const mimeType = this.normalizeMimeType(input.mimeType);
    const entityType = input.entityType ?? StorageEntityType.ORGANIZATION;
    const objectKey = buildOrganizationObjectKey(entityType, originalName);

    const reserved = await this.prismaService.raw.$transaction(async (tx) => {
      const { bucket, quotaBytes } = await this.ensureOrgStorageSettings(
        tx,
        tenant.organizationId,
      );
      const verifiedEntityId = await this.verifySameOrganizationEntity(
        tx,
        tenant.organizationId,
        entityType,
        input.entityId,
      );
      const usage = await this.getCurrentUsageBytes(tx, tenant.organizationId);
      const projectedBytes = usage.usedBytes + usage.pendingBytes + sizeBytes;
      if (projectedBytes > quotaBytes) {
        throw new PayloadTooLargeException(
          `Organization storage quota exceeded (${projectedBytes} > ${quotaBytes} bytes).`,
        );
      }

      return tx.storedObject.create({
        data: {
          organizationId: tenant.organizationId,
          bucket,
          objectKey,
          originalName,
          mimeType,
          sizeBytes: BigInt(sizeBytes),
          status: StoredObjectStatus.PENDING,
          entityType,
          entityId: verifiedEntityId,
          uploadedByUserId: tenant.userId,
          tags: input.tags ?? [],
          metadata: (input.metadata ?? null) as Prisma.InputJsonValue,
        },
      });
    });

    let putResult: { etag: string; sizeBytes: number };
    try {
      putResult = await this.rustfsService.putObject(
        reserved.bucket,
        reserved.objectKey,
        input.buffer,
        reserved.mimeType,
      );
    } catch (uploadError) {
      await this.prismaService.raw.storedObject
        .deleteMany({
          where: { id: reserved.id, organizationId: tenant.organizationId },
        })
        .catch(() => undefined);
      throw uploadError;
    }

    try {
      const completed = await this.prismaService.raw.$transaction(async (tx) => {
        const updated = await tx.storedObject.update({
          where: { id: reserved.id },
          data: {
            status: StoredObjectStatus.READY,
            sizeBytes: BigInt(putResult.sizeBytes),
            etag: putResult.etag,
            completedAt: new Date(),
          },
        });

        await tx.auditLog.create({
          data: {
            organizationId: tenant.organizationId,
            actorUserId: tenant.userId,
            action: "storage.object.uploaded",
            resourceType: "StoredObject",
            resourceId: updated.id,
            metadata: {
              bucket: updated.bucket,
              objectKey: updated.objectKey,
              originalName: updated.originalName,
              mimeType: updated.mimeType,
              sizeBytes: putResult.sizeBytes,
              entityType: updated.entityType,
              entityId: updated.entityId,
            } as Prisma.InputJsonValue,
            ipAddress: ipAddress ?? null,
          },
        });

        return updated;
      });

      this.analyticsService.captureDomainEvent({
        event: "storage.file_uploaded",
        distinctId: tenant.userId,
        organizationId: tenant.organizationId,
        properties: {
          stored_object_id: completed.id,
          entity_type: completed.entityType,
          mime_type: completed.mimeType,
          size_bytes: Number(completed.sizeBytes),
          upload_mode: "direct",
        },
      });

      return this.serializeObject(completed);
    } catch (dbError) {
      await this.rustfsService
        .deleteObject(reserved.bucket, reserved.objectKey)
        .catch(() => undefined);
      throw dbError;
    }
  }

  async listObjects(
    tenant: AuthenticatedOrganization,
    query: ListStoredObjectsQuery,
  ) {
    const take = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const statusFilter = query.status ?? StoredObjectStatus.READY;

    const where: Prisma.StoredObjectWhereInput = {
      organizationId: tenant.organizationId,
      status: statusFilter,
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.mimeType ? { mimeType: query.mimeType.toLowerCase() } : {}),
      ...(query.search
        ? {
            originalName: {
              contains: query.search,
              mode: "insensitive",
            },
          }
        : {}),
    };

    const records = await this.prismaService.scoped.storedObject.findMany({
      where,
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    const hasMore = records.length > take;
    const slice = hasMore ? records.slice(0, take) : records;
    const nextCursor = hasMore ? (slice[slice.length - 1]?.id ?? null) : null;

    return {
      organizationId: tenant.organizationId,
      items: slice.map((item) => this.serializeObject(item)),
      nextCursor,
    };
  }

  async getObjectMetadata(tenant: AuthenticatedOrganization, objectId: string) {
    const record = await this.prismaService.scoped.storedObject.findFirst({
      where: {
        id: objectId,
        organizationId: tenant.organizationId,
        status: { not: StoredObjectStatus.DELETED },
      },
    });

    if (!record) {
      throw new NotFoundException("Stored object not found.");
    }

    return this.serializeObject(record);
  }

  async createPresignedDownloadUrl(
    tenant: AuthenticatedOrganization,
    objectId: string,
    disposition: "attachment" | "inline" = "attachment",
  ) {
    const record = await this.prismaService.scoped.storedObject.findFirst({
      where: {
        id: objectId,
        organizationId: tenant.organizationId,
      },
    });

    if (!record || record.status === StoredObjectStatus.DELETED) {
      throw new NotFoundException("Stored object not found.");
    }

    if (record.status !== StoredObjectStatus.READY) {
      throw new ConflictException(
        "Object upload is still pending completion.",
      );
    }

    await this.rustfsService.headObject(record.bucket, record.objectKey);

    const env = getEnv();
    const contentDisposition = buildContentDisposition(
      record.originalName,
      disposition,
    );
    const url = await this.rustfsService.createPresignedGetUrl(
      record.bucket,
      record.objectKey,
      contentDisposition,
      env.STORAGE_PRESIGN_EXPIRES_SECONDS,
    );

    return {
      url,
      expiresInSeconds: env.STORAGE_PRESIGN_EXPIRES_SECONDS,
      object: this.serializeObject(record),
    };
  }

  async downloadDirect(
    tenant: AuthenticatedOrganization,
    objectId: string,
    disposition: "attachment" | "inline" = "attachment",
  ) {
    const record = await this.prismaService.scoped.storedObject.findFirst({
      where: {
        id: objectId,
        organizationId: tenant.organizationId,
      },
    });

    if (!record || record.status === StoredObjectStatus.DELETED) {
      throw new NotFoundException("Stored object not found.");
    }

    if (record.status !== StoredObjectStatus.READY) {
      throw new ConflictException(
        "Object upload is still pending completion.",
      );
    }

    const streamResult = await this.rustfsService.getObjectStream(
      record.bucket,
      record.objectKey,
    );

    return {
      body: streamResult.body,
      contentType: record.mimeType || streamResult.contentType,
      contentLength:
        Number(record.sizeBytes) > 0
          ? Number(record.sizeBytes)
          : streamResult.contentLength,
      contentDisposition: buildContentDisposition(
        record.originalName,
        disposition,
      ),
      etag: record.etag ?? streamResult.etag,
    };
  }

  async updateObject(
    tenant: AuthenticatedOrganization,
    objectId: string,
    input: UpdateStoredObjectInput,
    ipAddress?: string,
  ) {
    const updated = await this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.storedObject.findFirst({
        where: {
          id: objectId,
          organizationId: tenant.organizationId,
          status: { not: StoredObjectStatus.DELETED },
        },
      });

      if (!existing) {
        throw new NotFoundException("Stored object not found.");
      }

      const nextEntityType = input.entityType ?? existing.entityType;
      const nextEntityId =
        input.entityType !== undefined || input.entityId !== undefined
          ? await this.verifySameOrganizationEntity(
              tx,
              tenant.organizationId,
              nextEntityType,
              input.entityId,
            )
          : existing.entityId;

      const saved = await tx.storedObject.update({
        where: { id: existing.id },
        data: {
          entityType: nextEntityType,
          entityId: nextEntityId,
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          ...(input.metadata !== undefined
            ? { metadata: input.metadata as Prisma.InputJsonValue }
            : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "storage.object.updated",
          resourceType: "StoredObject",
          resourceId: saved.id,
          metadata: {
            entityType: saved.entityType,
            entityId: saved.entityId,
            tags: saved.tags,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return saved;
    });

    return this.serializeObject(updated);
  }

  async deleteObject(
    tenant: AuthenticatedOrganization,
    objectId: string,
    ipAddress?: string,
  ) {
    const existing = await this.prismaService.scoped.storedObject.findFirst({
      where: {
        id: objectId,
        organizationId: tenant.organizationId,
        status: { not: StoredObjectStatus.DELETED },
      },
    });

    if (!existing) {
      throw new NotFoundException("Stored object not found.");
    }

    await this.rustfsService.deleteObject(existing.bucket, existing.objectKey);

    const deleted = await this.prismaService.raw.$transaction(async (tx) => {
      const updated = await tx.storedObject.update({
        where: { id: existing.id },
        data: {
          status: StoredObjectStatus.DELETED,
          deletedAt: new Date(),
          sizeBytes: BigInt(0),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "storage.object.deleted",
          resourceType: "StoredObject",
          resourceId: updated.id,
          metadata: {
            bucket: updated.bucket,
            objectKey: updated.objectKey,
            originalName: updated.originalName,
            freedBytes: Number(existing.sizeBytes),
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return updated;
    });

    return this.serializeObject(deleted);
  }
}

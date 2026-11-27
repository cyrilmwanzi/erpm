import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { MultipartValue } from "@fastify/multipart";
import {
  AttachmentDocumentType,
  Prisma,
  StorageEntityType,
  StoredObjectStatus,
} from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { PrismaService } from "../database/prisma.service.js";
import type { AuthenticatedOrganization } from "../organizations/organization.decorators.js";
import { StorageService } from "./storage.service.js";

export const attachmentDocumentTypeEnum = z.enum([
  AttachmentDocumentType.PACKING_SLIP,
  AttachmentDocumentType.BILL_OF_LADING,
  AttachmentDocumentType.COA,
  AttachmentDocumentType.QC_PHOTO,
  AttachmentDocumentType.INSPECTION_REPORT,
  AttachmentDocumentType.SUPPLIER_INVOICE,
  AttachmentDocumentType.SAFETY_DATA_SHEET,
  AttachmentDocumentType.OTHER,
]);

export const attachStoredObjectSchema = z.object({
  storedObjectId: z.string().trim().min(1),
  documentType: attachmentDocumentTypeEnum
    .optional()
    .default(AttachmentDocumentType.OTHER),
  caption: z.string().trim().max(500).nullable().optional(),
});

export interface AttachmentInput {
  storedObjectId: string;
  documentType?: AttachmentDocumentType;
  caption?: string | null;
}

export interface AttachmentTarget {
  goodsReceiptId?: string;
  goodsReceiptLineId?: string;
  stockLotId?: string;
  productionBatchId?: string;
  productionOperationId?: string;
  productionQcCheckpointId?: string;
}

export const STORED_OBJECT_SUMMARY_SELECT = {
  id: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  status: true,
  entityType: true,
  entityId: true,
  createdAt: true,
} as const;

type DbClient = Prisma.TransactionClient | PrismaService["raw"];

function readMultipartField(
  fields: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!fields || !(key in fields)) {
    return undefined;
  }
  const entry = fields[key];
  const candidate = Array.isArray(entry) ? entry[0] : entry;
  if (
    candidate &&
    typeof candidate === "object" &&
    "type" in candidate &&
    (candidate as MultipartValue).type === "field"
  ) {
    const val = (candidate as MultipartValue).value;
    return typeof val === "string" ? val : String(val);
  }
  return undefined;
}

@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(StorageService) private readonly storageService: StorageService,
  ) {}

  serializeAttachment<
    T extends {
      storedObject?: {
        id: string;
        originalName: string;
        mimeType: string;
        sizeBytes: bigint | number;
        status: StoredObjectStatus;
        entityType: StorageEntityType;
        entityId: string | null;
        createdAt: Date;
      } | null;
    },
  >(attachment: T) {
    return {
      ...attachment,
      ...(attachment.storedObject
        ? {
            storedObject: {
              ...attachment.storedObject,
              sizeBytes: Number(attachment.storedObject.sizeBytes),
            },
          }
        : {}),
    };
  }

  async attachStoredObject(
    db: DbClient,
    tenant: AuthenticatedOrganization,
    input: {
      storedObjectId: string;
      documentType?: AttachmentDocumentType;
      caption?: string | null;
      target: AttachmentTarget;
    },
    ipAddress?: string,
  ) {
    const organizationId = tenant.organizationId;
    const { target } = input;
    const targetCount = [
      target.goodsReceiptId,
      target.goodsReceiptLineId,
      target.stockLotId,
      target.productionBatchId,
      target.productionOperationId,
      target.productionQcCheckpointId,
    ].filter(Boolean).length;

    if (targetCount !== 1) {
      throw new BadRequestException(
        "Exactly one attachment target (goodsReceiptId, goodsReceiptLineId, stockLotId, productionBatchId, productionOperationId, or productionQcCheckpointId) must be provided.",
      );
    }

    const storedObj = await db.storedObject.findFirst({
      where: {
        id: input.storedObjectId,
        organizationId,
        status: { not: StoredObjectStatus.DELETED },
      },
    });

    if (!storedObj) {
      throw new NotFoundException(
        `Stored object "${input.storedObjectId}" was not found in the active organization.`,
      );
    }

    if (target.goodsReceiptId) {
      const receipt = await db.goodsReceipt.findFirst({
        where: { id: target.goodsReceiptId, organizationId },
        select: { id: true },
      });
      if (!receipt) {
        throw new NotFoundException("Supplier delivery was not found.");
      }
    } else if (target.goodsReceiptLineId) {
      const line = await db.goodsReceiptLine.findFirst({
        where: { id: target.goodsReceiptLineId, organizationId },
        select: { id: true },
      });
      if (!line) {
        throw new NotFoundException("Supplier delivery line was not found.");
      }
    } else if (target.stockLotId) {
      const lot = await db.stockLot.findFirst({
        where: { id: target.stockLotId, organizationId },
        select: { id: true },
      });
      if (!lot) {
        throw new NotFoundException("Stock lot was not found.");
      }
    } else if (target.productionBatchId) {
      const batch = await db.productionBatch.findFirst({
        where: { id: target.productionBatchId, organizationId },
        select: { id: true },
      });
      if (!batch) {
        throw new NotFoundException("Production batch was not found.");
      }
    } else if (target.productionOperationId) {
      const operation = await db.productionOperation.findFirst({
        where: { id: target.productionOperationId, organizationId },
        select: { id: true },
      });
      if (!operation) {
        throw new NotFoundException("Production operation was not found.");
      }
    } else if (target.productionQcCheckpointId) {
      const checkpoint = await db.productionQcCheckpoint.findFirst({
        where: { id: target.productionQcCheckpointId, organizationId },
        select: { id: true },
      });
      if (!checkpoint) {
        throw new NotFoundException("Production QC checkpoint was not found.");
      }
    }

    const existing = await db.documentAttachment.findFirst({
      where: {
        organizationId,
        storedObjectId: storedObj.id,
        goodsReceiptId: target.goodsReceiptId ?? null,
        goodsReceiptLineId: target.goodsReceiptLineId ?? null,
        stockLotId: target.stockLotId ?? null,
        productionBatchId: target.productionBatchId ?? null,
        productionOperationId: target.productionOperationId ?? null,
        productionQcCheckpointId: target.productionQcCheckpointId ?? null,
      },
      include: {
        storedObject: { select: STORED_OBJECT_SUMMARY_SELECT },
      },
    });

    if (existing) {
      return this.serializeAttachment(existing);
    }

    const docType = input.documentType ?? AttachmentDocumentType.OTHER;
    const created = await db.documentAttachment.create({
      data: {
        organizationId,
        storedObjectId: storedObj.id,
        documentType: docType,
        caption: input.caption?.trim() || null,
        goodsReceiptId: target.goodsReceiptId ?? null,
        goodsReceiptLineId: target.goodsReceiptLineId ?? null,
        stockLotId: target.stockLotId ?? null,
        productionBatchId: target.productionBatchId ?? null,
        productionOperationId: target.productionOperationId ?? null,
        productionQcCheckpointId: target.productionQcCheckpointId ?? null,
        uploadedByUserId: tenant.userId,
      },
      include: {
        storedObject: { select: STORED_OBJECT_SUMMARY_SELECT },
      },
    });

    await db.auditLog.create({
      data: {
        organizationId,
        actorUserId: tenant.userId,
        action: "attachment.linked",
        resourceType: "DocumentAttachment",
        resourceId: created.id,
        metadata: {
          storedObjectId: storedObj.id,
          documentType: docType,
          ...target,
        } as Prisma.InputJsonValue,
        ipAddress: ipAddress ?? null,
      },
    });

    return this.serializeAttachment(created);
  }

  async uploadAndAttach(
    tenant: AuthenticatedOrganization,
    input: {
      buffer: Buffer;
      filename: string;
      mimeType: string;
      entityType: StorageEntityType;
      entityId: string;
      documentType?: AttachmentDocumentType;
      caption?: string | null;
      target: AttachmentTarget;
    },
    ipAddress?: string,
  ) {
    const docType = input.documentType ?? AttachmentDocumentType.OTHER;
    const uploaded = await this.storageService.uploadDirect(
      tenant,
      {
        buffer: input.buffer,
        filename: input.filename,
        mimeType: input.mimeType,
        entityType: input.entityType,
        entityId: input.entityId,
        tags: [docType],
        metadata: {
          documentType: docType,
          ...(input.caption ? { caption: input.caption } : {}),
        },
      },
      ipAddress,
    );

    return this.attachStoredObject(
      this.prismaService.raw,
      tenant,
      {
        storedObjectId: uploaded.id,
        documentType: docType,
        caption: input.caption,
        target: input.target,
      },
      ipAddress,
    );
  }

  async handleUploadOrLinkRequest(
    tenant: AuthenticatedOrganization,
    req: FastifyRequest,
    body: unknown,
    options: {
      entityType: StorageEntityType;
      entityId: string;
      target: AttachmentTarget;
    },
  ) {
    if (req.isMultipart()) {
      const filePart = await req.file();
      if (!filePart) {
        throw new BadRequestException(
          "Multipart form must include a file field.",
        );
      }

      const rawDocType = readMultipartField(filePart.fields, "documentType");
      const rawCaption = readMultipartField(filePart.fields, "caption");

      let documentType: AttachmentDocumentType = AttachmentDocumentType.OTHER;
      if (rawDocType && rawDocType.trim().length > 0) {
        const parsedType = attachmentDocumentTypeEnum.safeParse(
          rawDocType.trim().toUpperCase(),
        );
        if (!parsedType.success) {
          throw new BadRequestException({
            message: "Invalid documentType field.",
            issues: parsedType.error.issues,
          });
        }
        documentType = parsedType.data;
      }

      const buffer = await filePart.toBuffer();
      return this.uploadAndAttach(
        tenant,
        {
          buffer,
          filename: filePart.filename || "attachment",
          mimeType: filePart.mimetype || "application/octet-stream",
          entityType: options.entityType,
          entityId: options.entityId,
          documentType,
          caption: rawCaption?.trim() || null,
          target: options.target,
        },
        req.ip,
      );
    }

    const parsed = attachStoredObjectSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid attachment payload.",
        issues: parsed.error.issues,
      });
    }

    return this.attachStoredObject(
      this.prismaService.raw,
      tenant,
      {
        storedObjectId: parsed.data.storedObjectId,
        documentType: parsed.data.documentType,
        caption: parsed.data.caption ?? null,
        target: options.target,
      },
      req.ip,
    );
  }

  async listForDelivery(tenant: AuthenticatedOrganization, deliveryId: string) {
    const receipt = await this.prismaService.scoped.goodsReceipt.findFirst({
      where: { id: deliveryId, organizationId: tenant.organizationId },
      select: { id: true, receiptNumber: true },
    });
    if (!receipt) {
      throw new NotFoundException("Supplier delivery was not found.");
    }

    const attachments = await this.prismaService.scoped.documentAttachment.findMany(
      {
        where: {
          OR: [
            { goodsReceiptId: deliveryId },
            { goodsReceiptLine: { goodsReceiptId: deliveryId } },
          ],
        },
        include: {
          storedObject: { select: STORED_OBJECT_SUMMARY_SELECT },
          goodsReceiptLine: {
            select: {
              id: true,
              itemId: true,
              lotNumber: true,
              supplierBatchNumber: true,
            },
          },
        },
        orderBy: [{ createdAt: "desc" }],
      },
    );

    return {
      organizationId: tenant.organizationId,
      goodsReceiptId: receipt.id,
      receiptNumber: receipt.receiptNumber,
      items: attachments.map((a) => this.serializeAttachment(a)),
    };
  }

  async listForTarget(
    tenant: AuthenticatedOrganization,
    where: Prisma.DocumentAttachmentWhereInput,
  ) {
    const attachments = await this.prismaService.scoped.documentAttachment.findMany(
      {
        where,
        include: {
          storedObject: { select: STORED_OBJECT_SUMMARY_SELECT },
        },
        orderBy: [{ createdAt: "desc" }],
      },
    );
    return attachments.map((a) => this.serializeAttachment(a));
  }

  async removeAttachment(
    tenant: AuthenticatedOrganization,
    attachmentId: string,
    filter?: Prisma.DocumentAttachmentWhereInput,
    ipAddress?: string,
  ) {
    return this.prismaService.raw.$transaction(async (tx) => {
      const existing = await tx.documentAttachment.findFirst({
        where: {
          id: attachmentId,
          organizationId: tenant.organizationId,
          ...(filter ?? {}),
        },
      });
      if (!existing) {
        throw new NotFoundException("Document attachment was not found.");
      }

      await tx.documentAttachment.delete({
        where: { id: existing.id },
      });

      await tx.auditLog.create({
        data: {
          organizationId: tenant.organizationId,
          actorUserId: tenant.userId,
          action: "attachment.unlinked",
          resourceType: "DocumentAttachment",
          resourceId: existing.id,
          metadata: {
            storedObjectId: existing.storedObjectId,
            documentType: existing.documentType,
            goodsReceiptId: existing.goodsReceiptId,
            goodsReceiptLineId: existing.goodsReceiptLineId,
            stockLotId: existing.stockLotId,
            productionBatchId: existing.productionBatchId,
            productionOperationId: existing.productionOperationId,
            productionQcCheckpointId: existing.productionQcCheckpointId,
          } as Prisma.InputJsonValue,
          ipAddress: ipAddress ?? null,
        },
      });

      return { deleted: true, id: existing.id };
    });
  }
}

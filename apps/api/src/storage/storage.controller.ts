import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { MultipartValue } from "@fastify/multipart";
import { StorageEntityType, StoredObjectStatus } from "@scace/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { StorageService } from "./storage.service.js";

const entityTypeEnum = z.enum([
  StorageEntityType.ORGANIZATION,
  StorageEntityType.ITEM,
  StorageEntityType.VENDOR_BILL,
  StorageEntityType.PURCHASE_ORDER,
  StorageEntityType.GOODS_RECEIPT,
  StorageEntityType.GOODS_RECEIPT_LINE,
  StorageEntityType.STOCK_LOT,
  StorageEntityType.PRODUCTION_BATCH,
  StorageEntityType.PRODUCTION_OPERATION,
  StorageEntityType.PRODUCTION_QC_CHECKPOINT,
  StorageEntityType.SUPPLIER,
  StorageEntityType.CUSTOMER,
  StorageEntityType.ORDER,
  StorageEntityType.SALES_INVOICE,
  StorageEntityType.PAYMENT_RECEIPT,
]);

const objectStatusEnum = z.enum([
  StoredObjectStatus.PENDING,
  StoredObjectStatus.READY,
  StoredObjectStatus.DELETED,
]);

const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(25);
const metadataSchema = z.record(z.string(), z.unknown()).nullable();

const presignUploadSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(1).max(128),
  sizeBytes: z.coerce.number().int().positive(),
  entityType: entityTypeEnum.optional(),
  entityId: z.string().trim().min(1).max(128).nullable().optional(),
  tags: tagsSchema.optional(),
  metadata: metadataSchema.optional(),
});

const listObjectsQuerySchema = z.object({
  entityType: entityTypeEnum.optional(),
  entityId: z.string().trim().min(1).max(128).optional(),
  status: objectStatusEnum.optional(),
  mimeType: z.string().trim().min(1).max(128).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const updateObjectSchema = z.object({
  entityType: entityTypeEnum.optional(),
  entityId: z.string().trim().min(1).max(128).nullable().optional(),
  tags: tagsSchema.optional(),
  metadata: metadataSchema.optional(),
});

const updateQuotaSchema = z.object({
  storageQuotaBytes: z.coerce
    .number()
    .int()
    .min(1024)
    .max(10_995_116_277_760), // up to 10 TiB
});

const dispositionQuerySchema = z.object({
  disposition: z.enum(["attachment", "inline"]).default("attachment"),
});

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

@Controller("api/v1/storage")
@RequireActiveOrganization()
export class StorageController {
  constructor(
    @Inject(StorageService) private readonly storageService: StorageService,
  ) {}

  @Get("quota")
  @RequiredOrgPermissions({ storage: ["read"] })
  async getQuota(@CurrentOrganization() tenant: AuthenticatedOrganization) {
    return this.storageService.getQuota(tenant);
  }

  @Patch("quota")
  @RequiredOrgPermissions({ storage: ["manage"] })
  async updateQuota(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateQuotaSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid storage quota payload.",
        issues: parsed.error.issues,
      });
    }

    return this.storageService.updateQuota(
      tenant,
      parsed.data.storageQuotaBytes,
      req.ip,
    );
  }

  @Post("uploads/presign")
  @RequiredOrgPermissions({ storage: ["upload"] })
  async createPresignedUpload(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = presignUploadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid presigned upload payload.",
        issues: parsed.error.issues,
      });
    }

    return this.storageService.createPresignedUpload(
      tenant,
      parsed.data,
      req.ip,
    );
  }

  @Post("objects")
  @RequiredOrgPermissions({ storage: ["upload"] })
  async uploadDirect(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart()) {
      throw new BadRequestException(
        "Direct upload requires multipart/form-data content type.",
      );
    }

    const filePart = await req.file();
    if (!filePart) {
      throw new BadRequestException("Multipart form must include a file field.");
    }

    const buffer = await filePart.toBuffer();

    const rawEntityType = readMultipartField(filePart.fields, "entityType");
    const rawEntityId = readMultipartField(filePart.fields, "entityId");
    const rawTags = readMultipartField(filePart.fields, "tags");
    const rawMetadata = readMultipartField(filePart.fields, "metadata");

    let parsedTags: string[] | undefined;
    if (rawTags && rawTags.trim().length > 0) {
      let jsonTags: unknown;
      try {
        jsonTags = JSON.parse(rawTags);
      } catch {
        jsonTags = rawTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
      const validated = tagsSchema.safeParse(jsonTags);
      if (!validated.success) {
        throw new BadRequestException({
          message: "Invalid tags field.",
          issues: validated.error.issues,
        });
      }
      parsedTags = validated.data;
    }

    let parsedMetadata: Record<string, unknown> | null | undefined;
    if (rawMetadata && rawMetadata.trim().length > 0) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawMetadata);
      } catch {
        throw new BadRequestException("metadata field must be valid JSON.");
      }
      const validated = metadataSchema.safeParse(decoded);
      if (!validated.success) {
        throw new BadRequestException({
          message: "Invalid metadata JSON object.",
          issues: validated.error.issues,
        });
      }
      parsedMetadata = validated.data;
    }

    let parsedEntityType: StorageEntityType | undefined;
    if (rawEntityType && rawEntityType.trim().length > 0) {
      const validated = entityTypeEnum.safeParse(rawEntityType.trim());
      if (!validated.success) {
        throw new BadRequestException({
          message: "Invalid entityType.",
          issues: validated.error.issues,
        });
      }
      parsedEntityType = validated.data;
    }

    return this.storageService.uploadDirect(
      tenant,
      {
        buffer,
        filename: filePart.filename || "upload",
        mimeType: filePart.mimetype || "application/octet-stream",
        entityType: parsedEntityType,
        entityId: rawEntityId?.trim() || null,
        tags: parsedTags,
        metadata: parsedMetadata,
      },
      req.ip,
    );
  }

  @Post("objects/:objectId/complete")
  @RequiredOrgPermissions({ storage: ["upload"] })
  async completeUpload(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("objectId") objectId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.storageService.completeUpload(tenant, objectId, req.ip);
  }

  @Get("objects")
  @RequiredOrgPermissions({ storage: ["read"] })
  async listObjects(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listObjectsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid storage object query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.storageService.listObjects(tenant, parsed.data);
  }

  @Get("objects/:objectId")
  @RequiredOrgPermissions({ storage: ["read"] })
  async getObjectMetadata(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("objectId") objectId: string,
  ) {
    return this.storageService.getObjectMetadata(tenant, objectId);
  }

  @Get("objects/:objectId/download-url")
  @RequiredOrgPermissions({ storage: ["read"] })
  async getPresignedDownloadUrl(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("objectId") objectId: string,
    @Query() query: unknown,
  ) {
    const parsed = dispositionQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid download-url query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.storageService.createPresignedDownloadUrl(
      tenant,
      objectId,
      parsed.data.disposition,
    );
  }

  @Get("objects/:objectId/content")
  @RequiredOrgPermissions({ storage: ["read"] })
  async downloadDirect(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("objectId") objectId: string,
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ) {
    const parsed = dispositionQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid download query parameters.",
        issues: parsed.error.issues,
      });
    }

    const result = await this.storageService.downloadDirect(
      tenant,
      objectId,
      parsed.data.disposition,
    );

    reply.header("Content-Type", result.contentType);
    reply.header("Content-Length", String(result.contentLength));
    reply.header("Content-Disposition", result.contentDisposition);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "private, no-store");
    if (result.etag) {
      reply.header("ETag", result.etag);
    }

    return reply.send(result.body);
  }

  @Patch("objects/:objectId")
  @RequiredOrgPermissions({ storage: ["upload"] })
  async updateObject(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("objectId") objectId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateObjectSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid stored object update payload.",
        issues: parsed.error.issues,
      });
    }

    return this.storageService.updateObject(
      tenant,
      objectId,
      parsed.data,
      req.ip,
    );
  }

  @Delete("objects/:objectId")
  @RequiredOrgPermissions({ storage: ["delete"] })
  async deleteObject(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("objectId") objectId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.storageService.deleteObject(tenant, objectId, req.ip);
  }
}

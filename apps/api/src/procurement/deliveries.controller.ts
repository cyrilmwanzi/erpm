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
} from "@nestjs/common";
import {
  GoodsReceiptStatus,
  QuarantineStatus,
  RejectionDisposition,
  SupplierClaimStatus,
  SupplierClaimType,
} from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { attachStoredObjectSchema } from "../storage/attachments.service.js";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { DeliveriesService } from "./deliveries.service.js";

const bulkQuantitySchema = z
  .object({
    packQty: z.number().int().min(0).max(1_000_000).optional(),
    looseBaseQty: z.number().int().min(0).max(10_000_000).optional(),
    baseQty: z.number().int().min(0).max(10_000_000).optional(),
  })
  .optional();

const listDeliveriesQuerySchema = z.object({
  purchaseOrderId: z.string().trim().min(1).optional(),
  supplierId: z.string().trim().min(1).optional(),
  locationId: z.string().trim().min(1).optional(),
  status: z
    .enum([
      GoodsReceiptStatus.PENDING_QC,
      GoodsReceiptStatus.QC_IN_PROGRESS,
      GoodsReceiptStatus.QC_COMPLETED,
      GoodsReceiptStatus.ACCEPTED,
      GoodsReceiptStatus.PARTIALLY_ACCEPTED,
      GoodsReceiptStatus.REJECTED,
      GoodsReceiptStatus.CANCELLED,
    ])
    .optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const submitQcSchema = z.object({
  qcNotes: z.string().trim().max(2000).nullable().optional(),
  attachments: z.array(attachStoredObjectSchema).max(20).optional(),
  lines: z
    .array(
      z.object({
        deliveryLineId: z.string().trim().min(1),
        accepted: bulkQuantitySchema,
        acceptedBaseQty: z.number().int().min(0).max(10_000_000).optional(),
        rejected: bulkQuantitySchema,
        rejectedBaseQty: z.number().int().min(0).max(10_000_000).optional(),
        quarantined: bulkQuantitySchema,
        quarantinedBaseQty: z.number().int().min(0).max(10_000_000).optional(),
        rejectionDisposition: z
          .enum([
            RejectionDisposition.REOPEN_PO,
            RejectionDisposition.SUPPLIER_CLAIM,
            RejectionDisposition.QUARANTINE,
            RejectionDisposition.SCRAP,
          ])
          .optional(),
        defectReasonCode: z.string().trim().max(80).nullable().optional(),
        qcNotes: z.string().trim().max(1000).nullable().optional(),
        lotNumber: z.string().trim().max(80).nullable().optional(),
        batchCode: z.string().trim().max(80).nullable().optional(),
        supplierBatchNumber: z.string().trim().max(100).nullable().optional(),
        manufacturedAt: z.string().datetime().nullable().optional(),
        expiresAt: z.string().datetime().nullable().optional(),
        serialNumbers: z
          .array(z.string().trim().min(1).max(100))
          .max(1000)
          .nullable()
          .optional(),
        attachments: z.array(attachStoredObjectSchema).max(20).optional(),
      }),
    )
    .min(1)
    .max(200),
});

const acceptDeliverySchema = z.object({
  locationId: z.string().trim().min(1).optional(),
  acceptanceNotes: z.string().trim().max(2000).nullable().optional(),
  defaultClaimType: z
    .enum([
      SupplierClaimType.CREDIT,
      SupplierClaimType.REPLACEMENT,
      SupplierClaimType.RETURN,
    ])
    .optional(),
});

const cancelDeliverySchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

const listQuarantineQuerySchema = z.object({
  status: z
    .enum([
      QuarantineStatus.OPEN,
      QuarantineStatus.RELEASED_TO_STOCK,
      QuarantineStatus.RETURNED_TO_SUPPLIER,
      QuarantineStatus.CLAIMED,
      QuarantineStatus.SCRAPPED,
    ])
    .optional(),
  itemId: z.string().trim().min(1).optional(),
  goodsReceiptId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const resolveQuarantineSchema = z.object({
  resolution: z.enum([
    "RELEASE_TO_STOCK",
    "RETURN_TO_SUPPLIER",
    "SUPPLIER_CLAIM",
    "SCRAP",
  ]),
  packQty: z.number().int().min(0).max(1_000_000).optional(),
  looseBaseQty: z.number().int().min(0).max(10_000_000).optional(),
  baseQty: z.number().int().min(1).max(10_000_000).optional(),
  claimType: z
    .enum([
      SupplierClaimType.CREDIT,
      SupplierClaimType.REPLACEMENT,
      SupplierClaimType.RETURN,
    ])
    .optional(),
  resolutionNotes: z.string().trim().max(1000).nullable().optional(),
});

const listClaimsQuerySchema = z.object({
  status: z
    .enum([
      SupplierClaimStatus.OPEN,
      SupplierClaimStatus.SUBMITTED,
      SupplierClaimStatus.CREDITED,
      SupplierClaimStatus.REPLACED,
      SupplierClaimStatus.CLOSED,
    ])
    .optional(),
  supplierId: z.string().trim().min(1).optional(),
  purchaseOrderId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const updateClaimSchema = z.object({
  status: z.enum([
    SupplierClaimStatus.OPEN,
    SupplierClaimStatus.SUBMITTED,
    SupplierClaimStatus.CREDITED,
    SupplierClaimStatus.REPLACED,
    SupplierClaimStatus.CLOSED,
  ]),
  claimAmountCents: z.number().int().min(0).max(2_000_000_000).optional(),
  resolutionNotes: z.string().trim().max(1000).nullable().optional(),
});

@Controller("api/v1/deliveries")
@RequireActiveOrganization()
export class DeliveriesController {
  constructor(
    @Inject(DeliveriesService)
    private readonly deliveriesService: DeliveriesService,
  ) {}

  @Get()
  @RequiredOrgPermissions({ purchaseOrder: ["read"] })
  async listDeliveries(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listDeliveriesQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid delivery query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.deliveriesService.listDeliveries(tenant, parsed.data);
  }

  @Get("quarantine")
  @RequiredOrgPermissions({ purchaseOrder: ["read"] })
  async listQuarantineHolds(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listQuarantineQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid quarantine query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.deliveriesService.listQuarantineHolds(tenant, parsed.data);
  }

  @Post("quarantine/:holdId/resolve")
  @RequiredOrgPermissions({ purchaseOrder: ["accept"] })
  async resolveQuarantineHold(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("holdId") holdId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = resolveQuarantineSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid quarantine resolution payload.",
        issues: parsed.error.issues,
      });
    }
    return this.deliveriesService.resolveQuarantineHold(
      tenant,
      holdId,
      parsed.data,
      req.ip,
    );
  }

  @Get("claims")
  @RequiredOrgPermissions({ purchaseOrder: ["read"] })
  async listSupplierClaims(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listClaimsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid supplier claim query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.deliveriesService.listSupplierClaims(tenant, parsed.data);
  }

  @Patch("claims/:claimId")
  @RequiredOrgPermissions({ purchaseOrder: ["update"] })
  async updateSupplierClaim(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("claimId") claimId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateClaimSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid supplier claim update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.deliveriesService.updateSupplierClaim(
      tenant,
      claimId,
      parsed.data,
      req.ip,
    );
  }

  @Get(":deliveryId")
  @RequiredOrgPermissions({ purchaseOrder: ["read"] })
  async getDelivery(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("deliveryId") deliveryId: string,
  ) {
    return this.deliveriesService.getDelivery(tenant, deliveryId);
  }

  @Post(":deliveryId/qc")
  @RequiredOrgPermissions({ purchaseOrder: ["qc"] })
  async submitQcInspection(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("deliveryId") deliveryId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = submitQcSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid QC inspection payload.",
        issues: parsed.error.issues,
      });
    }
    return this.deliveriesService.submitQcInspection(
      tenant,
      deliveryId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":deliveryId/accept")
  @RequiredOrgPermissions({ purchaseOrder: ["accept"] })
  async acceptDelivery(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("deliveryId") deliveryId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = acceptDeliverySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid delivery acceptance payload.",
        issues: parsed.error.issues,
      });
    }
    return this.deliveriesService.acceptDelivery(
      tenant,
      deliveryId,
      parsed.data,
      req.ip,
    );
  }

  @Get(":deliveryId/files")
  @RequiredOrgPermissions({ purchaseOrder: ["read"] })
  async listDeliveryFiles(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("deliveryId") deliveryId: string,
  ) {
    return this.deliveriesService.listFiles(tenant, deliveryId);
  }

  @Post(":deliveryId/files")
  @RequiredOrgPermissions({ purchaseOrder: ["receive"] })
  async addDeliveryFile(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("deliveryId") deliveryId: string,
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ) {
    return this.deliveriesService.addDeliveryFile(
      tenant,
      deliveryId,
      req,
      body,
    );
  }

  @Post(":deliveryId/lines/:lineId/files")
  @RequiredOrgPermissions({ purchaseOrder: ["receive"] })
  async addDeliveryLineFile(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("deliveryId") deliveryId: string,
    @Param("lineId") lineId: string,
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ) {
    return this.deliveriesService.addDeliveryLineFile(
      tenant,
      deliveryId,
      lineId,
      req,
      body,
    );
  }

  @Delete(":deliveryId/files/:attachmentId")
  @RequiredOrgPermissions({ purchaseOrder: ["update"] })
  async removeDeliveryFile(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("deliveryId") deliveryId: string,
    @Param("attachmentId") attachmentId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.deliveriesService.removeDeliveryFile(
      tenant,
      deliveryId,
      attachmentId,
      req.ip,
    );
  }

  @Post(":deliveryId/cancel")
  @RequiredOrgPermissions({ purchaseOrder: ["receive"] })
  async cancelDelivery(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("deliveryId") deliveryId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = cancelDeliverySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid delivery cancellation payload.",
        issues: parsed.error.issues,
      });
    }
    return this.deliveriesService.cancelDelivery(
      tenant,
      deliveryId,
      parsed.data.reason,
      req.ip,
    );
  }
}

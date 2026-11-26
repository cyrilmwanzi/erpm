import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ProductionBatchStatus, ProductionPriority } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { attachStoredObjectSchema } from "../storage/attachments.service.js";
import {
  CurrentTenant,
  RequireActiveTenant,
  RequiredBillingFeature,
  RequiredOrgPermissions,
  type AuthenticatedTenant,
} from "../tenancy/tenant.decorators.js";
import { ProductionService } from "./production.service.js";

const priorityEnum = z.enum([
  ProductionPriority.LOW,
  ProductionPriority.NORMAL,
  ProductionPriority.HIGH,
  ProductionPriority.URGENT,
]);

const createBatchSchema = z.object({
  batchNumber: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
  name: z.string().trim().max(200).nullable().optional(),
  locationId: z.string().trim().min(1),
  outputItemId: z.string().trim().min(1).nullable().optional(),
  bomId: z.string().trim().min(1).nullable().optional(),
  routingId: z.string().trim().min(1).nullable().optional(),
  useDefaultEngineering: z.boolean().optional(),
  autoCreateSubAssemblyBatches: z.boolean().optional(),
  parentBatchId: z.string().trim().min(1).nullable().optional(),
  plannedOutputQty: z.number().int().min(0).max(10_000_000).optional(),
  priority: priorityEnum.optional(),
  requiresFinalQcRelease: z.boolean().optional(),
  scheduledStartAt: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  attachments: z.array(attachStoredObjectSchema).max(20).optional(),
});

const releaseBatchSchema = z.object({
  strictReserve: z.boolean().optional(),
  autoSchedule: z.boolean().optional(),
  scheduledStartAt: z.string().datetime().nullable().optional(),
});

const listBatchesQuerySchema = z.object({
  status: z
    .enum([
      ProductionBatchStatus.PLANNED,
      ProductionBatchStatus.RELEASED,
      ProductionBatchStatus.IN_PROGRESS,
      ProductionBatchStatus.QC_HOLD,
      ProductionBatchStatus.COMPLETED,
      ProductionBatchStatus.CLOSED,
      ProductionBatchStatus.CANCELLED,
    ])
    .optional(),
  priority: priorityEnum.optional(),
  locationId: z.string().trim().min(1).optional(),
  outputItemId: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const suggestBatchLotsSchema = z.object({
  itemId: z.string().trim().min(1),
  locationId: z.string().trim().min(1).optional(),
  strategy: z.enum(["FEFO", "FIFO"]).default("FEFO"),
  packId: z.string().trim().min(1).nullable().optional(),
  packQty: z.number().int().min(0).max(1_000_000).optional(),
  looseBaseQty: z.number().int().min(0).max(10_000_000).optional(),
  baseQty: z.number().int().min(1).max(10_000_000).optional(),
  includeExpired: z.boolean().optional(),
});

const consumeMaterialLineSchema = z.object({
  itemId: z.string().trim().min(1),
  locationId: z.string().trim().min(1).optional(),
  packId: z.string().trim().min(1).nullable().optional(),
  packQty: z.number().int().min(0).max(1_000_000).optional(),
  looseBaseQty: z.number().int().min(0).max(10_000_000).optional(),
  baseQty: z.number().int().min(1).max(10_000_000).optional(),
  stockLotId: z.string().trim().min(1).nullable().optional(),
  allocationStrategy: z.enum(["FEFO", "FIFO"]).optional(),
  includeExpired: z.boolean().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  productionOperationId: z.string().trim().min(1).nullable().optional(),
  reservationId: z.string().trim().min(1).nullable().optional(),
});

const consumeMaterialsSchema = z.union([
  z.object({
    lines: z.array(consumeMaterialLineSchema).min(1).max(200),
  }),
  consumeMaterialLineSchema,
]);

const completeBatchSchema = z.object({
  actualOutputQty: z.number().int().min(0).max(10_000_000).optional(),
  scrapQty: z.number().int().min(0).max(10_000_000).optional(),
  createOutputLot: z.boolean().optional(),
  outputLotNumber: z.string().trim().max(80).nullable().optional(),
  outputBatchCode: z.string().trim().max(80).nullable().optional(),
  manufacturedAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  backflushRemaining: z.boolean().optional(),
  includeExpired: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const cancelBatchSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

@Controller("api/v1/production")
@RequireActiveTenant()
@RequiredBillingFeature("production")
export class ProductionController {
  constructor(
    @Inject(ProductionService)
    private readonly productionService: ProductionService,
  ) {}

  @Post("batches")
  @RequiredOrgPermissions({ production: ["create"] })
  async createBatch(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createBatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid production batch payload.",
        issues: parsed.error.issues,
      });
    }

    return this.productionService.createBatch(tenant, parsed.data, req.ip);
  }

  @Get("batches")
  @RequiredOrgPermissions({ production: ["read"] })
  async listBatches(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listBatchesQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid production batch query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.productionService.listBatches(tenant, parsed.data);
  }

  @Get("batches/:batchId")
  @RequiredOrgPermissions({ production: ["read"] })
  async getBatch(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
  ) {
    return this.productionService.getBatch(tenant, batchId);
  }

  @Post("batches/:batchId/release")
  @RequiredOrgPermissions({ production: ["release"] })
  async releaseBatch(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = releaseBatchSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid production batch release payload.",
        issues: parsed.error.issues,
      });
    }

    return this.productionService.releaseBatch(
      tenant,
      batchId,
      parsed.data,
      req.ip,
    );
  }

  @Post("batches/:batchId/start")
  @RequiredOrgPermissions({ production: ["update"] })
  async startBatch(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.productionService.startBatch(tenant, batchId, req.ip);
  }

  @Post("batches/:batchId/suggest-lots")
  @RequiredOrgPermissions({ production: ["read"] })
  async suggestLotsForBatch(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Body() body: unknown,
  ) {
    const parsed = suggestBatchLotsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid lot suggestion payload.",
        issues: parsed.error.issues,
      });
    }

    return this.productionService.suggestLotsForBatch(
      tenant,
      batchId,
      parsed.data,
    );
  }

  @Post("batches/:batchId/consume")
  @RequiredOrgPermissions({ production: ["consume"] })
  async consumeMaterials(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = consumeMaterialsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid material consumption payload.",
        issues: parsed.error.issues,
      });
    }

    const normalizedInput =
      "lines" in parsed.data ? parsed.data : { lines: [parsed.data] };

    return this.productionService.consumeMaterials(
      tenant,
      batchId,
      normalizedInput,
      req.ip,
    );
  }

  @Post("batches/:batchId/complete")
  @RequiredOrgPermissions({ production: ["complete"] })
  async completeBatch(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = completeBatchSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid production batch completion payload.",
        issues: parsed.error.issues,
      });
    }

    return this.productionService.completeBatch(
      tenant,
      batchId,
      parsed.data,
      req.ip,
    );
  }

  @Post("batches/:batchId/cancel")
  @RequiredOrgPermissions({ production: ["cancel"] })
  async cancelBatch(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = cancelBatchSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid production batch cancellation payload.",
        issues: parsed.error.issues,
      });
    }

    return this.productionService.cancelBatch(
      tenant,
      batchId,
      parsed.data.reason,
      req.ip,
    );
  }

  @Get("batches/:batchId/traceability")
  @RequiredOrgPermissions({ production: ["read"] })
  async getBatchTraceability(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
  ) {
    return this.productionService.getBatchTraceability(tenant, batchId);
  }

  @Get("batches/:batchId/files")
  @RequiredOrgPermissions({ production: ["read"] })
  async listBatchFiles(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
  ) {
    return this.productionService.listBatchFiles(tenant, batchId);
  }

  @Post("batches/:batchId/files")
  @RequiredOrgPermissions({ production: ["update"] })
  async addBatchFile(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ) {
    return this.productionService.addBatchFile(tenant, batchId, req, body);
  }

  @Delete("batches/:batchId/files/:attachmentId")
  @RequiredOrgPermissions({ production: ["update"] })
  async removeBatchFile(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Param("attachmentId") attachmentId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.productionService.removeBatchFile(
      tenant,
      batchId,
      attachmentId,
      req.ip,
    );
  }
}

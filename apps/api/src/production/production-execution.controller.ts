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
import {
  ProductionCostCategory,
  ProductionOperationStatus,
  ProductionQcCheckpointType,
} from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentTenant,
  RequireActiveTenant,
  RequiredBillingFeature,
  RequiredOrgPermissions,
  type AuthenticatedTenant,
} from "../tenancy/tenant.decorators.js";
import { ProductionExecutionService } from "./production-execution.service.js";

const scheduleBatchSchema = z.object({
  startAt: z.string().datetime().nullable().optional(),
});

const dispatchQueueQuerySchema = z.object({
  statuses: z
    .union([
      z.string(),
      z.array(
        z.enum([
          ProductionOperationStatus.PENDING,
          ProductionOperationStatus.READY,
          ProductionOperationStatus.IN_PROGRESS,
          ProductionOperationStatus.PAUSED,
          ProductionOperationStatus.QC_PENDING,
          ProductionOperationStatus.COMPLETED,
          ProductionOperationStatus.SKIPPED,
        ]),
      ),
    ])
    .optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const startOperationSchema = z.object({
  assignedStaffId: z.string().trim().min(1).nullable().optional(),
});

const logOperationTimeSchema = z.object({
  timeLogId: z.string().trim().min(1).nullable().optional(),
  staffId: z.string().trim().min(1).nullable().optional(),
  logType: z.enum(["SETUP", "RUN", "REWORK"]).optional(),
  startedAt: z.string().datetime().nullable().optional(),
  endedAt: z.string().datetime().nullable().optional(),
  durationMinutes: z.number().int().min(0).max(100_000).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

const completeOperationSchema = z.object({
  completedQty: z.number().int().min(0).max(10_000_000).optional(),
  scrapQty: z.number().int().min(0).max(10_000_000).optional(),
  signOffNotes: z.string().trim().max(1000).nullable().optional(),
  backflushMaterials: z.boolean().optional(),
  includeExpired: z.boolean().optional(),
});

const createQcCheckpointSchema = z.object({
  productionOperationId: z.string().trim().min(1).nullable().optional(),
  checkpointType: z
    .enum([
      ProductionQcCheckpointType.IN_PROCESS,
      ProductionQcCheckpointType.FINAL_RELEASE,
    ])
    .optional(),
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  checklistTemplate: z
    .union([
      z.array(z.record(z.string(), z.unknown())),
      z.record(z.string(), z.unknown()),
    ])
    .nullable()
    .optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const inspectQcCheckpointSchema = z.object({
  status: z.enum(["PASSED", "FAILED", "WAIVED"]),
  checklistResults: z
    .union([
      z.array(z.record(z.string(), z.unknown())),
      z.record(z.string(), z.unknown()),
    ])
    .nullable()
    .optional(),
  disposition: z.string().trim().max(64).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const qcReleaseBatchSchema = z.object({
  disposition: z.enum(["RELEASE", "QUARANTINE", "SCRAP"]).default("RELEASE"),
  waivePendingCheckpoints: z.boolean().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const addCostEntrySchema = z.object({
  category: z.enum([
    ProductionCostCategory.MATERIAL,
    ProductionCostCategory.LABOR,
    ProductionCostCategory.MACHINE,
    ProductionCostCategory.OVERHEAD,
    ProductionCostCategory.SCRAP,
    ProductionCostCategory.ADJUSTMENT,
  ]),
  description: z.string().trim().min(1).max(500),
  quantity: z.number().positive().max(10_000_000).optional(),
  unitCostCents: z.number().int().min(-100_000_000).max(100_000_000).optional(),
  totalCostCents: z.number().int().min(-100_000_000).max(100_000_000),
});

@Controller("api/v1/production")
@RequireActiveTenant()
@RequiredBillingFeature("production")
export class ProductionExecutionController {
  constructor(
    @Inject(ProductionExecutionService)
    private readonly executionService: ProductionExecutionService,
  ) {}

  // ==========================================
  // Work Center Dispatch & Scheduling
  // ==========================================

  @Get("work-centers/:workCenterId/dispatch-queue")
  @RequiredOrgPermissions({ production: ["read"] })
  async getWorkCenterDispatchQueue(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("workCenterId") workCenterId: string,
    @Query() query: unknown,
  ) {
    const parsed = dispatchQueueQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid dispatch queue query parameters.",
        issues: parsed.error.issues,
      });
    }

    const rawStatuses = parsed.data.statuses;
    let statuses: ProductionOperationStatus[] | undefined;
    if (typeof rawStatuses === "string") {
      statuses = rawStatuses
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as ProductionOperationStatus[];
    } else if (Array.isArray(rawStatuses)) {
      statuses = rawStatuses;
    }

    return this.executionService.getWorkCenterDispatchQueue(
      tenant,
      workCenterId,
      {
        statuses,
        from: parsed.data.from,
        to: parsed.data.to,
        limit: parsed.data.limit,
      },
    );
  }

  @Post("batches/:batchId/schedule")
  @RequiredOrgPermissions({ production: ["schedule"] })
  async scheduleBatch(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = scheduleBatchSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid batch scheduling payload.",
        issues: parsed.error.issues,
      });
    }
    return this.executionService.scheduleBatch(
      tenant,
      batchId,
      parsed.data,
      req.ip,
    );
  }

  // ==========================================
  // Operations & Time Logs
  // ==========================================

  @Get("batches/:batchId/operations")
  @RequiredOrgPermissions({ production: ["read"] })
  async listOperations(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
  ) {
    return this.executionService.listOperations(tenant, batchId);
  }

  @Get("batches/:batchId/operations/:operationId")
  @RequiredOrgPermissions({ production: ["read"] })
  async getOperation(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Param("operationId") operationId: string,
  ) {
    return this.executionService.getOperation(tenant, batchId, operationId);
  }

  @Post("batches/:batchId/operations/:operationId/start")
  @RequiredOrgPermissions({ production: ["update"] })
  async startOperation(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Param("operationId") operationId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = startOperationSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid start operation payload.",
        issues: parsed.error.issues,
      });
    }
    return this.executionService.startOperation(
      tenant,
      batchId,
      operationId,
      parsed.data.assignedStaffId,
      req.ip,
    );
  }

  @Post("batches/:batchId/operations/:operationId/pause")
  @RequiredOrgPermissions({ production: ["update"] })
  async pauseOperation(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Param("operationId") operationId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.executionService.pauseOperation(
      tenant,
      batchId,
      operationId,
      req.ip,
    );
  }

  @Post("batches/:batchId/operations/:operationId/time-logs")
  @RequiredOrgPermissions({ production: ["update"] })
  async logTime(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Param("operationId") operationId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = logOperationTimeSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid operation time log payload.",
        issues: parsed.error.issues,
      });
    }
    return this.executionService.logTime(
      tenant,
      batchId,
      operationId,
      parsed.data,
      req.ip,
    );
  }

  @Post("batches/:batchId/operations/:operationId/complete")
  @RequiredOrgPermissions({ production: ["update"] })
  async completeOperation(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Param("operationId") operationId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = completeOperationSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid operation completion payload.",
        issues: parsed.error.issues,
      });
    }
    return this.executionService.completeOperation(
      tenant,
      batchId,
      operationId,
      parsed.data,
      req.ip,
    );
  }

  @Get("batches/:batchId/operations/:operationId/files")
  @RequiredOrgPermissions({ production: ["read"] })
  async listOperationFiles(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Param("operationId") operationId: string,
  ) {
    return this.executionService.listOperationFiles(
      tenant,
      batchId,
      operationId,
    );
  }

  @Post("batches/:batchId/operations/:operationId/files")
  @RequiredOrgPermissions({ production: ["update"] })
  async addOperationFile(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Param("operationId") operationId: string,
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ) {
    return this.executionService.addOperationFile(
      tenant,
      batchId,
      operationId,
      req,
      body,
    );
  }

  @Delete("batches/:batchId/operations/:operationId/files/:attachmentId")
  @RequiredOrgPermissions({ production: ["update"] })
  async removeOperationFile(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Param("operationId") operationId: string,
    @Param("attachmentId") attachmentId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.executionService.removeOperationFile(
      tenant,
      batchId,
      operationId,
      attachmentId,
      req.ip,
    );
  }

  // ==========================================
  // QC Checkpoints & Batch Release
  // ==========================================

  @Post("batches/:batchId/qc-checkpoints")
  @RequiredOrgPermissions({ production: ["qc"] })
  async createQcCheckpoint(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createQcCheckpointSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid QC checkpoint payload.",
        issues: parsed.error.issues,
      });
    }
    return this.executionService.createQcCheckpoint(
      tenant,
      batchId,
      parsed.data,
      req.ip,
    );
  }

  @Post("batches/:batchId/qc-checkpoints/:checkpointId/inspect")
  @RequiredOrgPermissions({ production: ["qc"] })
  async inspectQcCheckpoint(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Param("checkpointId") checkpointId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = inspectQcCheckpointSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid QC checkpoint inspection payload.",
        issues: parsed.error.issues,
      });
    }
    return this.executionService.inspectQcCheckpoint(
      tenant,
      batchId,
      checkpointId,
      parsed.data,
      req.ip,
    );
  }

  @Get("batches/:batchId/qc-checkpoints/:checkpointId/files")
  @RequiredOrgPermissions({ production: ["read"] })
  async listQcCheckpointFiles(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Param("checkpointId") checkpointId: string,
  ) {
    return this.executionService.listQcCheckpointFiles(
      tenant,
      batchId,
      checkpointId,
    );
  }

  @Post("batches/:batchId/qc-checkpoints/:checkpointId/files")
  @RequiredOrgPermissions({ production: ["qc"] })
  async addQcCheckpointFile(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Param("checkpointId") checkpointId: string,
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ) {
    return this.executionService.addQcCheckpointFile(
      tenant,
      batchId,
      checkpointId,
      req,
      body,
    );
  }

  @Delete("batches/:batchId/qc-checkpoints/:checkpointId/files/:attachmentId")
  @RequiredOrgPermissions({ production: ["qc"] })
  async removeQcCheckpointFile(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Param("checkpointId") checkpointId: string,
    @Param("attachmentId") attachmentId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.executionService.removeQcCheckpointFile(
      tenant,
      batchId,
      checkpointId,
      attachmentId,
      req.ip,
    );
  }

  @Post("batches/:batchId/qc-release")
  @RequiredOrgPermissions({ production: ["qc"] })
  async qcReleaseBatch(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = qcReleaseBatchSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid QC release payload.",
        issues: parsed.error.issues,
      });
    }
    return this.executionService.qcReleaseBatch(
      tenant,
      batchId,
      parsed.data,
      req.ip,
    );
  }

  // ==========================================
  // Costing, Variance & Electronic Batch Record
  // ==========================================

  @Get("batches/:batchId/costing")
  @RequiredOrgPermissions({ production: ["read"] })
  async getBatchCosting(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
  ) {
    return this.executionService.getBatchCosting(tenant, batchId);
  }

  @Post("batches/:batchId/cost-entries")
  @RequiredOrgPermissions({ production: ["costing"] })
  async addCostEntry(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = addCostEntrySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid production cost entry payload.",
        issues: parsed.error.issues,
      });
    }
    return this.executionService.addCostEntry(
      tenant,
      batchId,
      parsed.data,
      req.ip,
    );
  }

  @Post("batches/:batchId/close")
  @RequiredOrgPermissions({ production: ["costing"] })
  async closeBatch(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.executionService.closeBatch(tenant, batchId, req.ip);
  }

  @Get("batches/:batchId/batch-record")
  @RequiredOrgPermissions({ production: ["read"] })
  async getElectronicBatchRecord(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("batchId") batchId: string,
  ) {
    return this.executionService.getElectronicBatchRecord(tenant, batchId);
  }
}

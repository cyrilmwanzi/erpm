import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  BomIssueMethod,
  BomStatus,
  OverheadAllocationType,
  RoutingStatus,
  SubAssemblyStrategy,
  WorkCenterStatus,
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
import { ProductionEngineeringService } from "./engineering.service.js";

const workCenterStatusEnum = z.enum([
  WorkCenterStatus.ACTIVE,
  WorkCenterStatus.MAINTENANCE,
  WorkCenterStatus.ARCHIVED,
]);

const overheadTypeEnum = z.enum([
  OverheadAllocationType.FIXED_PER_HOUR,
  OverheadAllocationType.PERCENT_OF_LABOR,
  OverheadAllocationType.PER_UNIT,
]);

const createWorkCenterSchema = z.object({
  code: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  locationId: z.string().trim().min(1),
  status: workCenterStatusEnum.optional(),
  dailyCapacityMinutes: z.number().int().min(1).max(1440).optional(),
  hourlyLaborRateCents: z.number().int().min(0).max(100_000_000).optional(),
  hourlyMachineRateCents: z.number().int().min(0).max(100_000_000).optional(),
  overheadRateCents: z.number().int().min(0).max(100_000_000).optional(),
  overheadType: overheadTypeEnum.optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const updateWorkCenterSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  locationId: z.string().trim().min(1).optional(),
  status: workCenterStatusEnum.optional(),
  dailyCapacityMinutes: z.number().int().min(1).max(1440).optional(),
  hourlyLaborRateCents: z.number().int().min(0).max(100_000_000).optional(),
  hourlyMachineRateCents: z.number().int().min(0).max(100_000_000).optional(),
  overheadRateCents: z.number().int().min(0).max(100_000_000).optional(),
  overheadType: overheadTypeEnum.optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const listWorkCentersQuerySchema = z.object({
  locationId: z.string().trim().min(1).optional(),
  status: workCenterStatusEnum.optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const bomLineSchema = z.object({
  lineNumber: z.number().int().min(1).max(10_000).optional(),
  componentItemId: z.string().trim().min(1),
  packId: z.string().trim().min(1).nullable().optional(),
  quantity: z.number().int().min(1).max(10_000_000),
  scrapBps: z.number().int().min(0).max(9999).optional(),
  issueMethod: z
    .enum([BomIssueMethod.MANUAL, BomIssueMethod.BACKFLUSH])
    .optional(),
  subAssemblyStrategy: z
    .enum([
      SubAssemblyStrategy.CONSUME_STOCK_OR_EXPLODE,
      SubAssemblyStrategy.ALWAYS_EXPLODE,
      SubAssemblyStrategy.CONSUME_STOCK_ONLY,
    ])
    .optional(),
  operationSequence: z.number().int().min(1).max(10_000).nullable().optional(),
  isOptional: z.boolean().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

const createBomSchema = z.object({
  code: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  itemId: z.string().trim().min(1),
  packId: z.string().trim().min(1).nullable().optional(),
  version: z.number().int().min(1).max(10_000).optional(),
  yieldQty: z.number().int().min(1).max(10_000_000).optional(),
  isDefault: z.boolean().optional(),
  effectiveFrom: z.string().datetime().nullable().optional(),
  effectiveTo: z.string().datetime().nullable().optional(),
  standardOverheadCents: z.number().int().min(0).max(100_000_000).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  activate: z.boolean().optional(),
  lines: z.array(bomLineSchema).min(1).max(200),
});

const updateBomSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  packId: z.string().trim().min(1).nullable().optional(),
  yieldQty: z.number().int().min(1).max(10_000_000).optional(),
  isDefault: z.boolean().optional(),
  effectiveFrom: z.string().datetime().nullable().optional(),
  effectiveTo: z.string().datetime().nullable().optional(),
  standardOverheadCents: z.number().int().min(0).max(100_000_000).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: z.array(bomLineSchema).min(1).max(200).optional(),
});

const listBomsQuerySchema = z.object({
  itemId: z.string().trim().min(1).optional(),
  status: z
    .enum([BomStatus.DRAFT, BomStatus.ACTIVE, BomStatus.OBSOLETE])
    .optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const explodeBomSchema = z.object({
  quantity: z.coerce.number().int().min(1).max(10_000_000).optional(),
  locationId: z.string().trim().min(1).optional(),
  routingId: z.string().trim().min(1).optional(),
});

const routingOperationSchema = z.object({
  sequence: z.number().int().min(1).max(10_000),
  operationCode: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(1).max(200),
  workCenterId: z.string().trim().min(1),
  setupMinutes: z.number().int().min(0).max(100_000).optional(),
  runMinutesPerUnit: z.number().min(0).max(100_000).optional(),
  requiresQcGate: z.boolean().optional(),
  qcChecklistTemplate: z
    .union([
      z.array(z.record(z.string(), z.unknown())),
      z.record(z.string(), z.unknown()),
    ])
    .nullable()
    .optional(),
  instructions: z.string().trim().max(2000).nullable().optional(),
});

const createRoutingSchema = z.object({
  code: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  itemId: z.string().trim().min(1).nullable().optional(),
  version: z.number().int().min(1).max(10_000).optional(),
  isDefault: z.boolean().optional(),
  effectiveFrom: z.string().datetime().nullable().optional(),
  effectiveTo: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  activate: z.boolean().optional(),
  operations: z.array(routingOperationSchema).min(1).max(100),
});

const updateRoutingSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  itemId: z.string().trim().min(1).nullable().optional(),
  isDefault: z.boolean().optional(),
  effectiveFrom: z.string().datetime().nullable().optional(),
  effectiveTo: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  operations: z.array(routingOperationSchema).min(1).max(100).optional(),
});

const listRoutingsQuerySchema = z.object({
  itemId: z.string().trim().min(1).optional(),
  status: z
    .enum([RoutingStatus.DRAFT, RoutingStatus.ACTIVE, RoutingStatus.OBSOLETE])
    .optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const activateBodySchema = z.object({
  makeDefault: z.boolean().optional(),
});

@Controller("api/v1/production")
@RequireActiveTenant()
@RequiredBillingFeature("production")
export class ProductionEngineeringController {
  constructor(
    @Inject(ProductionEngineeringService)
    private readonly engineeringService: ProductionEngineeringService,
  ) {}

  // ==========================================
  // Work Centers
  // ==========================================

  @Post("work-centers")
  @RequiredOrgPermissions({ production: ["create"] })
  async createWorkCenter(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createWorkCenterSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid work center payload.",
        issues: parsed.error.issues,
      });
    }
    return this.engineeringService.createWorkCenter(tenant, parsed.data, req.ip);
  }

  @Get("work-centers")
  @RequiredOrgPermissions({ production: ["read"] })
  async listWorkCenters(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listWorkCentersQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid work center query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.engineeringService.listWorkCenters(tenant, parsed.data);
  }

  @Get("work-centers/:workCenterId")
  @RequiredOrgPermissions({ production: ["read"] })
  async getWorkCenter(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("workCenterId") workCenterId: string,
  ) {
    return this.engineeringService.getWorkCenter(tenant, workCenterId);
  }

  @Patch("work-centers/:workCenterId")
  @RequiredOrgPermissions({ production: ["update"] })
  async updateWorkCenter(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("workCenterId") workCenterId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateWorkCenterSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid work center update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.engineeringService.updateWorkCenter(
      tenant,
      workCenterId,
      parsed.data,
      req.ip,
    );
  }

  // ==========================================
  // Bills of Materials (Multi-Level BOM)
  // ==========================================

  @Post("boms")
  @RequiredOrgPermissions({ production: ["create"] })
  async createBom(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createBomSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid BOM payload.",
        issues: parsed.error.issues,
      });
    }
    return this.engineeringService.createBom(tenant, parsed.data, req.ip);
  }

  @Get("boms")
  @RequiredOrgPermissions({ production: ["read"] })
  async listBoms(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listBomsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid BOM query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.engineeringService.listBoms(tenant, parsed.data);
  }

  @Get("boms/:bomId")
  @RequiredOrgPermissions({ production: ["read"] })
  async getBom(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("bomId") bomId: string,
  ) {
    return this.engineeringService.getBom(tenant, bomId);
  }

  @Patch("boms/:bomId")
  @RequiredOrgPermissions({ production: ["update"] })
  async updateBom(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("bomId") bomId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateBomSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid BOM update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.engineeringService.updateBom(tenant, bomId, parsed.data, req.ip);
  }

  @Post("boms/:bomId/activate")
  @RequiredOrgPermissions({ production: ["update"] })
  async activateBom(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("bomId") bomId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = activateBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid BOM activation payload.",
        issues: parsed.error.issues,
      });
    }
    return this.engineeringService.activateBom(
      tenant,
      bomId,
      parsed.data.makeDefault,
      req.ip,
    );
  }

  @Post("boms/:bomId/clone-version")
  @RequiredOrgPermissions({ production: ["create"] })
  async cloneBomVersion(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("bomId") bomId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.engineeringService.cloneBomVersion(tenant, bomId, req.ip);
  }

  @Get("boms/:bomId/explode")
  @RequiredOrgPermissions({ production: ["read"] })
  async explodeBomGet(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("bomId") bomId: string,
    @Query() query: unknown,
  ) {
    const parsed = explodeBomSchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid BOM explosion query.",
        issues: parsed.error.issues,
      });
    }
    return this.engineeringService.explodeBom(tenant, bomId, parsed.data);
  }

  @Post("boms/:bomId/explode")
  @RequiredOrgPermissions({ production: ["read"] })
  async explodeBomPost(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("bomId") bomId: string,
    @Body() body: unknown,
  ) {
    const parsed = explodeBomSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid BOM explosion payload.",
        issues: parsed.error.issues,
      });
    }
    return this.engineeringService.explodeBom(tenant, bomId, parsed.data);
  }

  // ==========================================
  // Routings
  // ==========================================

  @Post("routings")
  @RequiredOrgPermissions({ production: ["create"] })
  async createRouting(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createRoutingSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid routing payload.",
        issues: parsed.error.issues,
      });
    }
    return this.engineeringService.createRouting(tenant, parsed.data, req.ip);
  }

  @Get("routings")
  @RequiredOrgPermissions({ production: ["read"] })
  async listRoutings(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listRoutingsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid routing query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.engineeringService.listRoutings(tenant, parsed.data);
  }

  @Get("routings/:routingId")
  @RequiredOrgPermissions({ production: ["read"] })
  async getRouting(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("routingId") routingId: string,
  ) {
    return this.engineeringService.getRouting(tenant, routingId);
  }

  @Patch("routings/:routingId")
  @RequiredOrgPermissions({ production: ["update"] })
  async updateRouting(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("routingId") routingId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateRoutingSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid routing update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.engineeringService.updateRouting(
      tenant,
      routingId,
      parsed.data,
      req.ip,
    );
  }

  @Post("routings/:routingId/activate")
  @RequiredOrgPermissions({ production: ["update"] })
  async activateRouting(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("routingId") routingId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = activateBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid routing activation payload.",
        issues: parsed.error.issues,
      });
    }
    return this.engineeringService.activateRouting(
      tenant,
      routingId,
      parsed.data.makeDefault,
      req.ip,
    );
  }
}

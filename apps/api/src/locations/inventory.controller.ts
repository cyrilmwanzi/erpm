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
import { ItemType, StockMovementType, StockTransferStatus } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { InventoryService } from "./inventory.service.js";

const listBalancesQuerySchema = z.object({
  locationId: z.string().trim().min(1).optional(),
  itemId: z.string().trim().min(1).optional(),
  lowStockOnly: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const listMovementsQuerySchema = z.object({
  locationId: z.string().trim().min(1).optional(),
  itemId: z.string().trim().min(1).optional(),
  type: z
    .enum([
      StockMovementType.RECEIPT,
      StockMovementType.ADJUSTMENT,
      StockMovementType.TRANSFER_OUT,
      StockMovementType.TRANSFER_IN,
      StockMovementType.PRODUCTION_CONSUMPTION,
      StockMovementType.PRODUCTION_OUTPUT,
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const listLotsQuerySchema = z.object({
  locationId: z.string().trim().min(1).optional(),
  itemId: z.string().trim().min(1).optional(),
  supplierId: z.string().trim().min(1).optional(),
  supplierItemId: z.string().trim().min(1).optional(),
  supplierBatchNumber: z.string().trim().min(1).max(100).optional(),
  itemType: z
    .enum([
      ItemType.SELLABLE,
      ItemType.MERCH,
      ItemType.RAW_MATERIAL,
      ItemType.SERVICE,
      ItemType.CONSUMABLE,
    ])
    .optional(),
  lotNumber: z.string().trim().min(1).max(80).optional(),
  expiringBefore: z.string().datetime().optional(),
  includeZero: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const suggestLotsSchema = z.object({
  itemId: z.string().trim().min(1),
  locationId: z.string().trim().min(1),
  strategy: z.enum(["FEFO", "FIFO"]).default("FEFO"),
  packId: z.string().trim().min(1).nullable().optional(),
  packQty: z.number().int().min(0).max(1_000_000).optional(),
  looseBaseQty: z.number().int().min(0).max(10_000_000).optional(),
  baseQty: z.number().int().min(1).max(10_000_000).optional(),
  includeExpired: z.boolean().optional(),
});

const adjustStockSchema = z.object({
  itemId: z.string().trim().min(1),
  locationId: z.string().trim().min(1),
  quantityDelta: z
    .number()
    .int()
    .refine((n) => n !== 0, "quantityDelta cannot be 0."),
  reason: z.string().trim().min(1).max(500),
});

const createTransferSchema = z.object({
  transferNumber: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
  fromLocationId: z.string().trim().min(1),
  toLocationId: z.string().trim().min(1),
  notes: z.string().trim().max(1000).optional(),
  lines: z
    .array(
      z.object({
        itemId: z.string().trim().min(1),
        quantity: z.number().int().min(1).max(1_000_000),
      }),
    )
    .min(1)
    .max(100),
});

const listTransfersQuerySchema = z.object({
  status: z
    .enum([
      StockTransferStatus.DRAFT,
      StockTransferStatus.IN_TRANSIT,
      StockTransferStatus.RECEIVED,
      StockTransferStatus.CANCELLED,
    ])
    .optional(),
  fromLocationId: z.string().trim().min(1).optional(),
  toLocationId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const cancelTransferSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

@Controller("api/v1/inventory")
@RequireActiveOrganization()
export class InventoryController {
  constructor(
    @Inject(InventoryService)
    private readonly inventoryService: InventoryService,
  ) {}

  @Get("balances")
  @RequiredOrgPermissions({ inventory: ["read"] })
  async listBalances(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listBalancesQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid stock balance query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.inventoryService.listBalances(tenant, parsed.data);
  }

  @Get("movements")
  @RequiredOrgPermissions({ inventory: ["read"] })
  async listMovements(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listMovementsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid stock movement query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.inventoryService.listMovements(tenant, parsed.data);
  }

  @Get("lots")
  @RequiredOrgPermissions({ inventory: ["read"] })
  async listLots(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listLotsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid stock lot query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.inventoryService.listLots(tenant, parsed.data);
  }

  @Post("lots/suggest")
  @RequiredOrgPermissions({ inventory: ["read"] })
  async suggestLots(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
  ) {
    const parsed = suggestLotsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid lot allocation suggestion payload.",
        issues: parsed.error.issues,
      });
    }

    return this.inventoryService.suggestLots(tenant, parsed.data);
  }

  @Get("lots/:lotId/traceability")
  @RequiredOrgPermissions({ inventory: ["read"] })
  async getLotTraceability(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("lotId") lotId: string,
  ) {
    return this.inventoryService.getLotTraceability(tenant, lotId);
  }

  @Get("lots/:lotId/files")
  @RequiredOrgPermissions({ inventory: ["read"] })
  async listLotFiles(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("lotId") lotId: string,
  ) {
    return this.inventoryService.listLotFiles(tenant, lotId);
  }

  @Post("lots/:lotId/files")
  @RequiredOrgPermissions({ inventory: ["adjust"] })
  async addLotFile(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("lotId") lotId: string,
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ) {
    return this.inventoryService.addLotFile(tenant, lotId, req, body);
  }

  @Delete("lots/:lotId/files/:attachmentId")
  @RequiredOrgPermissions({ inventory: ["adjust"] })
  async removeLotFile(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("lotId") lotId: string,
    @Param("attachmentId") attachmentId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.inventoryService.removeLotFile(
      tenant,
      lotId,
      attachmentId,
      req.ip,
    );
  }

  @Post("adjustments")
  @RequiredOrgPermissions({ inventory: ["adjust"] })
  async adjustStock(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = adjustStockSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid stock adjustment payload.",
        issues: parsed.error.issues,
      });
    }

    return this.inventoryService.adjustStock(tenant, parsed.data, req.ip);
  }

  @Get("transfers")
  @RequiredOrgPermissions({ inventory: ["read"] })
  async listTransfers(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listTransfersQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid stock transfer query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.inventoryService.listTransfers(tenant, parsed.data);
  }

  @Post("transfers")
  @RequiredOrgPermissions({ inventory: ["transfer"] })
  async createTransfer(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createTransferSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid stock transfer payload.",
        issues: parsed.error.issues,
      });
    }

    return this.inventoryService.createTransfer(tenant, parsed.data, req.ip);
  }

  @Get("transfers/:transferId")
  @RequiredOrgPermissions({ inventory: ["read"] })
  async getTransfer(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("transferId") transferId: string,
  ) {
    return this.inventoryService.getTransfer(tenant, transferId);
  }

  @Post("transfers/:transferId/dispatch")
  @RequiredOrgPermissions({ inventory: ["transfer"] })
  async dispatchTransfer(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("transferId") transferId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.inventoryService.dispatchTransfer(tenant, transferId, req.ip);
  }

  @Post("transfers/:transferId/receive")
  @RequiredOrgPermissions({ inventory: ["transfer"] })
  async receiveTransfer(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("transferId") transferId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.inventoryService.receiveTransfer(tenant, transferId, req.ip);
  }

  @Post("transfers/:transferId/cancel")
  @RequiredOrgPermissions({ inventory: ["transfer"] })
  async cancelTransfer(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("transferId") transferId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = cancelTransferSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid transfer cancellation payload.",
        issues: parsed.error.issues,
      });
    }

    return this.inventoryService.cancelTransfer(
      tenant,
      transferId,
      parsed.data.reason,
      req.ip,
    );
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  ExpiryAlertSeverity,
  ExpiryAlertStatus,
  ExpiryEnforcementMode,
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
import { ExpiryService } from "./expiry.service.js";

const enforcementModeEnum = z.enum([
  ExpiryEnforcementMode.BLOCK_EXPIRED,
  ExpiryEnforcementMode.WARN_ONLY,
]);

const expiryBucketEnum = z.enum([
  "EXPIRED",
  "CRITICAL",
  "WARNING",
  "HEALTHY",
  "NO_EXPIRY",
]);

const alertStatusEnum = z.enum([
  ExpiryAlertStatus.OPEN,
  ExpiryAlertStatus.ACKNOWLEDGED,
  ExpiryAlertStatus.RESOLVED,
  ExpiryAlertStatus.DISMISSED,
]);

const alertSeverityEnum = z.enum([
  ExpiryAlertSeverity.WARNING,
  ExpiryAlertSeverity.CRITICAL,
  ExpiryAlertSeverity.EXPIRED,
]);

const updatePolicySchema = z.object({
  warningDays: z.number().int().min(1).max(3650).optional(),
  criticalDays: z.number().int().min(0).max(3650).optional(),
  enforcementMode: enforcementModeEnum.optional(),
  autoQuarantineExpired: z.boolean().optional(),
  autoQuarantineOnCriticalDays: z.number().int().min(0).max(365).nullable().optional(),
  scanIntervalMinutes: z.number().int().min(5).max(10080).optional(),
  isScannerActive: z.boolean().optional(),
});

const summaryQuerySchema = z.object({
  locationId: z.string().trim().min(1).optional(),
  itemId: z.string().trim().min(1).optional(),
});

const listLotsQuerySchema = z.object({
  locationId: z.string().trim().min(1).optional(),
  itemId: z.string().trim().min(1).optional(),
  bucket: expiryBucketEnum.optional(),
  includeZeroQty: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const listAlertsQuerySchema = z.object({
  status: alertStatusEnum.optional(),
  severity: alertSeverityEnum.optional(),
  locationId: z.string().trim().min(1).optional(),
  itemId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const alertNotesSchema = z.object({
  notes: z.string().trim().max(500).optional(),
});

const quarantineLotSchema = z.object({
  quantity: z.number().int().min(1).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

const writeOffLotSchema = z.object({
  quantity: z.number().int().min(1),
  source: z.enum(["AUTO", "QUARANTINED", "ON_HAND"]).optional(),
  reason: z.string().trim().min(1).max(500),
  disposalMethod: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const listWriteOffsQuerySchema = z.object({
  locationId: z.string().trim().min(1).optional(),
  itemId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const extendExpirySchema = z.object({
  newExpiresAt: z.string().datetime(),
  reason: z.string().trim().min(1).max(500),
});

@Controller("api/v1/inventory/expiry")
@RequireActiveTenant()
@RequiredBillingFeature("expiry")
export class ExpiryController {
  constructor(
    @Inject(ExpiryService) private readonly expiryService: ExpiryService,
  ) {}

  @Get("policy")
  @RequiredOrgPermissions({ inventory: ["read"] })
  async getPolicy(@CurrentTenant() tenant: AuthenticatedTenant) {
    return this.expiryService.getPolicy(tenant);
  }

  @Put("policy")
  @RequiredOrgPermissions({ inventory: ["manageExpiry"] })
  async updatePolicy(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updatePolicySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid stock expiry policy payload.",
        issues: parsed.error.issues,
      });
    }
    return this.expiryService.updatePolicy(tenant, parsed.data, req.ip);
  }

  @Get("summary")
  @RequiredOrgPermissions({ inventory: ["read"] })
  async getSummary(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = summaryQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid expiry summary query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.expiryService.getSummary(tenant, parsed.data);
  }

  @Get("lots")
  @RequiredOrgPermissions({ inventory: ["read"] })
  async listLots(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listLotsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid expiry lots query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.expiryService.listLots(tenant, parsed.data);
  }

  @Post("scan")
  @RequiredOrgPermissions({ inventory: ["manageExpiry"] })
  async runScan(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Req() req: FastifyRequest,
  ) {
    return this.expiryService.runManualScan(tenant, req.ip);
  }

  @Get("alerts")
  @RequiredOrgPermissions({ inventory: ["read"] })
  async listAlerts(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listAlertsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid expiry alerts query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.expiryService.listAlerts(tenant, parsed.data);
  }

  @Post("alerts/:alertId/acknowledge")
  @RequiredOrgPermissions({ inventory: ["manageExpiry"] })
  async acknowledgeAlert(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("alertId") alertId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = alertNotesSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid alert acknowledgment payload.",
        issues: parsed.error.issues,
      });
    }
    return this.expiryService.acknowledgeAlert(
      tenant,
      alertId,
      parsed.data.notes,
      req.ip,
    );
  }

  @Post("alerts/:alertId/resolve")
  @RequiredOrgPermissions({ inventory: ["manageExpiry"] })
  async resolveAlert(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("alertId") alertId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = alertNotesSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid alert resolution payload.",
        issues: parsed.error.issues,
      });
    }
    return this.expiryService.resolveAlert(
      tenant,
      alertId,
      parsed.data.notes,
      req.ip,
    );
  }

  @Post("alerts/:alertId/dismiss")
  @RequiredOrgPermissions({ inventory: ["manageExpiry"] })
  async dismissAlert(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("alertId") alertId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = alertNotesSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid alert dismiss payload.",
        issues: parsed.error.issues,
      });
    }
    return this.expiryService.dismissAlert(
      tenant,
      alertId,
      parsed.data.notes,
      req.ip,
    );
  }

  @Post("lots/:lotId/quarantine")
  @RequiredOrgPermissions({ inventory: ["manageExpiry"] })
  async quarantineLot(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("lotId") lotId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = quarantineLotSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid lot quarantine payload.",
        issues: parsed.error.issues,
      });
    }
    return this.expiryService.quarantineLot(tenant, lotId, parsed.data, req.ip);
  }

  @Post("lots/:lotId/write-off")
  @RequiredOrgPermissions({ inventory: ["writeOff"] })
  async writeOffLot(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("lotId") lotId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = writeOffLotSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid lot write-off payload.",
        issues: parsed.error.issues,
      });
    }
    return this.expiryService.writeOffLot(tenant, lotId, parsed.data, req.ip);
  }

  @Get("write-offs")
  @RequiredOrgPermissions({ inventory: ["read"] })
  async listWriteOffs(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listWriteOffsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid write-offs query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.expiryService.listWriteOffs(tenant, parsed.data);
  }

  @Patch("lots/:lotId/extend-expiry")
  @RequiredOrgPermissions({ inventory: ["manageExpiry"] })
  async extendLotExpiry(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("lotId") lotId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = extendExpirySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid extend lot expiry payload.",
        issues: parsed.error.issues,
      });
    }
    return this.expiryService.extendLotExpiry(tenant, lotId, parsed.data, req.ip);
  }
}

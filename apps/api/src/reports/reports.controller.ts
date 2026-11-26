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
import {
  CommunicationChannel,
  ReportDomain,
  ReportFormat,
  ReportFrequency,
} from "@scace/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentTenant,
  RequireActiveTenant,
  RequiredBillingFeature,
  RequiredOrgPermissions,
  type AuthenticatedTenant,
} from "../tenancy/tenant.decorators.js";
import { ReportsService } from "./reports.service.js";

const reportDomainEnum = z.enum([
  ReportDomain.INVENTORY_EXPIRY,
  ReportDomain.SALES_MPESA,
  ReportDomain.PROCUREMENT_CLAIMS,
  ReportDomain.PRODUCTION_COSTING,
]);

const reportFormatEnum = z.enum([
  ReportFormat.JSON,
  ReportFormat.CSV,
  ReportFormat.PDF,
]);

const reportFrequencyEnum = z.enum([
  ReportFrequency.DAILY,
  ReportFrequency.WEEKLY,
  ReportFrequency.MONTHLY,
]);

const channelEnum = z.enum([
  CommunicationChannel.EMAIL,
  CommunicationChannel.WEBHOOK,
  CommunicationChannel.SMS,
  CommunicationChannel.WHATSAPP,
  CommunicationChannel.IN_APP,
]);

const reportFilterFieldsSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  locationId: z.string().trim().min(1).optional(),
  itemId: z.string().trim().min(1).optional(),
  supplierId: z.string().trim().min(1).optional(),
  channel: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const exportQuerySchema = reportFilterFieldsSchema.extend({
  domain: reportDomainEnum,
  format: reportFormatEnum.default(ReportFormat.CSV),
});

const dispatchReportSchema = z.object({
  domain: reportDomainEnum,
  format: reportFormatEnum.default(ReportFormat.PDF),
  filters: reportFilterFieldsSchema.optional(),
  recipientEmails: z.array(z.string().trim().email()).max(25).optional(),
  channelHints: z.array(channelEnum).min(1).max(5).optional(),
  subject: z.string().trim().min(1).max(200).optional(),
});

const createScheduleSchema = z.object({
  name: z.string().trim().min(1).max(160),
  domain: reportDomainEnum,
  format: reportFormatEnum.default(ReportFormat.PDF),
  frequency: reportFrequencyEnum.default(ReportFrequency.WEEKLY),
  cronHourUtc: z.number().int().min(0).max(23).default(6),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  filters: reportFilterFieldsSchema.nullable().optional(),
  recipientEmails: z.array(z.string().trim().email()).max(25).optional(),
  channelHints: z.array(channelEnum).min(1).max(5).optional(),
  isActive: z.boolean().optional(),
});

const updateScheduleSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  format: reportFormatEnum.optional(),
  frequency: reportFrequencyEnum.optional(),
  cronHourUtc: z.number().int().min(0).max(23).optional(),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  filters: reportFilterFieldsSchema.nullable().optional(),
  recipientEmails: z.array(z.string().trim().email()).max(25).optional(),
  channelHints: z.array(channelEnum).min(1).max(5).optional(),
  isActive: z.boolean().optional(),
});

const listRunsQuerySchema = z.object({
  domain: reportDomainEnum.optional(),
  scheduleId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

@Controller("api/v1/reports")
@RequireActiveTenant()
@RequiredBillingFeature("reports")
export class ReportsController {
  constructor(
    @Inject(ReportsService) private readonly reportsService: ReportsService,
  ) {}

  @Get("inventory-expiry")
  @RequiredOrgPermissions({ report: ["read"] })
  async getInventoryExpiryReport(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = reportFilterFieldsSchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid inventory-expiry report query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.reportsService.queryDomainReport(
      tenant,
      ReportDomain.INVENTORY_EXPIRY,
      parsed.data,
    );
  }

  @Get("sales-mpesa")
  @RequiredOrgPermissions({ report: ["read"] })
  async getSalesMpesaReport(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = reportFilterFieldsSchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid sales-mpesa report query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.reportsService.queryDomainReport(
      tenant,
      ReportDomain.SALES_MPESA,
      parsed.data,
    );
  }

  @Get("procurement-claims")
  @RequiredOrgPermissions({ report: ["read"] })
  async getProcurementClaimsReport(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = reportFilterFieldsSchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid procurement-claims report query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.reportsService.queryDomainReport(
      tenant,
      ReportDomain.PROCUREMENT_CLAIMS,
      parsed.data,
    );
  }

  @Get("production-costing")
  @RequiredOrgPermissions({ report: ["read"] })
  async getProductionCostingReport(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = reportFilterFieldsSchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid production-costing report query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.reportsService.queryDomainReport(
      tenant,
      ReportDomain.PRODUCTION_COSTING,
      parsed.data,
    );
  }

  @Get("export")
  @RequiredOrgPermissions({ report: ["export"] })
  async exportReport(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const parsed = exportQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid report export query parameters.",
        issues: parsed.error.issues,
      });
    }

    const { domain, format, ...filters } = parsed.data;
    const exported = await this.reportsService.exportReport(
      tenant,
      domain,
      format,
      filters,
      req.ip,
    );

    reply.header("Content-Type", exported.contentType);
    reply.header(
      "Content-Disposition",
      `attachment; filename="${exported.filename}"`,
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "private, no-store");
    return reply.send(exported.body);
  }

  @Post("dispatch")
  @RequiredOrgPermissions({ report: ["export"] })
  async dispatchReport(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = dispatchReportSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid report dispatch payload.",
        issues: parsed.error.issues,
      });
    }
    return this.reportsService.dispatchReport(tenant, parsed.data, req.ip);
  }

  @Get("schedules")
  @RequiredOrgPermissions({ report: ["read"] })
  async listSchedules(@CurrentTenant() tenant: AuthenticatedTenant) {
    return this.reportsService.listSchedules(tenant);
  }

  @Post("schedules")
  @RequiredOrgPermissions({ report: ["schedule"] })
  async createSchedule(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createScheduleSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid report schedule payload.",
        issues: parsed.error.issues,
      });
    }
    return this.reportsService.createSchedule(tenant, parsed.data, req.ip);
  }

  @Patch("schedules/:scheduleId")
  @RequiredOrgPermissions({ report: ["schedule"] })
  async updateSchedule(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("scheduleId") scheduleId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateScheduleSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid report schedule update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.reportsService.updateSchedule(
      tenant,
      scheduleId,
      parsed.data,
      req.ip,
    );
  }

  @Delete("schedules/:scheduleId")
  @RequiredOrgPermissions({ report: ["schedule"] })
  async deleteSchedule(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("scheduleId") scheduleId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.reportsService.deleteSchedule(tenant, scheduleId, req.ip);
  }

  @Post("schedules/:scheduleId/run-now")
  @RequiredOrgPermissions({ report: ["schedule"] })
  async runScheduleNow(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("scheduleId") scheduleId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.reportsService.runScheduleNow(tenant, scheduleId, req.ip);
  }

  @Get("runs")
  @RequiredOrgPermissions({ report: ["read"] })
  async listRuns(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listRunsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid report runs query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.reportsService.listRuns(tenant, parsed.data);
  }

  @Get("runs/:runId")
  @RequiredOrgPermissions({ report: ["read"] })
  async getRun(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("runId") runId: string,
  ) {
    return this.reportsService.getRun(tenant, runId);
  }

  @Get("runs/:runId/download")
  @RequiredOrgPermissions({ report: ["export"] })
  async downloadRunArtifact(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("runId") runId: string,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.reportsService.downloadRunArtifact(tenant, runId);
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
}

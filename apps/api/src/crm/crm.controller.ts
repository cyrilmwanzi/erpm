import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import { CrmWebhookStatus, ItemType } from "@scace/db";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentTenant,
  RequireActiveTenant,
  RequiredBillingFeature,
  RequiredOrgPermissions,
  type AuthenticatedTenant,
} from "../tenancy/tenant.decorators.js";
import { CrmBridgeService } from "./crm-bridge.service.js";
import { CrmConnectionService } from "./crm-connection.service.js";
import { CrmProxyService } from "./crm-proxy.service.js";
import { CrmWebhookService } from "./crm-webhook.service.js";

const upsertConnectionSchema = z.object({
  baseUrl: z.string().trim().url().max(500),
  workspaceId: z.string().trim().min(1).max(128).nullable().optional(),
  apiKey: z.string().trim().min(8).max(512).optional(),
  webhookSecret: z.string().trim().min(8).max(512).nullable().optional(),
  isEnabled: z.boolean().optional(),
  sandboxMode: z.boolean().optional(),
});

const listCrmQuerySchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
  stage: z.string().trim().min(1).max(80).optional(),
  status: z.string().trim().min(1).max(80).optional(),
  ownerStaffId: z.string().trim().min(1).optional(),
});

const contactPayloadSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().min(1).max(80).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    email: z.string().trim().email().max(320).optional(),
    phone: z.string().trim().max(40).optional(),
    companyId: z.string().trim().min(1).optional(),
    organizationId: z.string().trim().min(1).optional(),
    ownerStaffId: z.string().trim().min(1).optional(),
    title: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .passthrough();

const companyPayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    domain: z.string().trim().max(200).optional(),
    website: z.string().trim().url().max(300).optional(),
    industry: z.string().trim().max(120).optional(),
    ownerStaffId: z.string().trim().min(1).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .passthrough();

const dealItemInputSchema = z.object({
  itemId: z.string().trim().min(1),
  packId: z.string().trim().min(1).nullable().optional(),
  servicePlanId: z.string().trim().min(1).nullable().optional(),
  priceBookId: z.string().trim().min(1).nullable().optional(),
  customerSegment: z.string().trim().min(1).max(80).nullable().optional(),
  externalAccountId: z.string().trim().min(1).max(128).nullable().optional(),
  promoCode: z.string().trim().min(1).max(64).nullable().optional(),
  externalServiceId: z.string().trim().min(1).nullable().optional(),
  quantity: z.number().int().min(1).max(1_000_000).optional(),
  unitPriceCents: z.number().int().min(0).max(2_000_000_000).optional(),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((v) => v.toUpperCase())
    .optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

const dealPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    stage: z.string().trim().min(1).max(80).optional(),
    status: z.string().trim().min(1).max(80).optional(),
    amount: z.number().min(0).optional(),
    currency: z
      .string()
      .trim()
      .length(3)
      .transform((v) => v.toUpperCase())
      .optional(),
    contactId: z.string().trim().min(1).optional(),
    companyId: z.string().trim().min(1).optional(),
    ownerStaffId: z.string().trim().min(1).optional(),
    expectedCloseDate: z.string().trim().min(1).optional(),
    priceBookId: z.string().trim().min(1).nullable().optional(),
    customerSegment: z.string().trim().min(1).max(80).nullable().optional(),
    externalAccountId: z.string().trim().min(1).max(128).nullable().optional(),
    promoCode: z.string().trim().min(1).max(64).nullable().optional(),
    items: z.array(dealItemInputSchema).max(50).optional(),
  })
  .passthrough();

const servicePayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    price: z.number().min(0).optional(),
    currency: z
      .string()
      .trim()
      .length(3)
      .transform((v) => v.toUpperCase())
      .optional(),
    unit: z.string().trim().max(40).optional(),
  })
  .passthrough();

const taskPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    status: z.string().trim().min(1).max(60).optional(),
    dueAt: z.string().trim().min(1).optional(),
    dealId: z.string().trim().min(1).optional(),
    contactId: z.string().trim().min(1).optional(),
    ownerStaffId: z.string().trim().min(1).optional(),
  })
  .passthrough();

const staffMappingSchema = z.object({
  staffId: z.string().trim().min(1),
  externalUserId: z.string().trim().min(1).max(128),
  externalEmail: z.string().trim().email().max(320).nullable().optional(),
  externalName: z.string().trim().max(120).nullable().optional(),
});

const pushCatalogSchema = z.object({
  itemIds: z.array(z.string().trim().min(1)).max(50).optional(),
  types: z
    .array(
      z.enum([
        ItemType.SELLABLE,
        ItemType.MERCH,
        ItemType.RAW_MATERIAL,
        ItemType.SERVICE,
        ItemType.CONSUMABLE,
      ]),
    )
    .optional(),
});

const listWebhookQuerySchema = z.object({
  eventType: z.string().trim().min(1).max(120).optional(),
  status: z
    .enum([
      CrmWebhookStatus.RECEIVED,
      CrmWebhookStatus.PROCESSED,
      CrmWebhookStatus.FAILED,
      CrmWebhookStatus.IGNORED,
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

@Controller("api/v1/crm")
@RequiredBillingFeature("crm")
export class CrmController {
  constructor(
    @Inject(CrmConnectionService)
    private readonly connectionService: CrmConnectionService,
    @Inject(CrmProxyService) private readonly proxyService: CrmProxyService,
    @Inject(CrmBridgeService) private readonly bridgeService: CrmBridgeService,
    @Inject(CrmWebhookService)
    private readonly webhookService: CrmWebhookService,
  ) {}

  // ==========================================
  // Connection Management (Owner / Admin only)
  // ==========================================

  @Get("connection")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["configure"] })
  async getConnection(@CurrentTenant() tenant: AuthenticatedTenant) {
    return this.connectionService.getConnectionStatus(tenant);
  }

  @Put("connection")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["configure"] })
  async upsertConnection(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = upsertConnectionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CustomerMates connection payload.",
        issues: parsed.error.issues,
      });
    }
    return this.connectionService.upsertConnection(tenant, parsed.data, req.ip);
  }

  @Post("connection/test")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["configure"] })
  async testConnection(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Req() req: FastifyRequest,
  ) {
    return this.connectionService.testConnection(tenant, req.ip);
  }

  @Delete("connection")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["configure"] })
  async deleteConnection(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Req() req: FastifyRequest,
  ) {
    return this.connectionService.deleteConnection(tenant, req.ip);
  }

  // ==========================================
  // Staff Owner Mappings & Catalog Push
  // ==========================================

  @Get("staff-mappings")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["read"] })
  async listStaffMappings(@CurrentTenant() tenant: AuthenticatedTenant) {
    return this.bridgeService.listStaffMappings(tenant);
  }

  @Post("staff-mappings")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["configure"] })
  async upsertStaffMapping(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = staffMappingSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM staff mapping payload.",
        issues: parsed.error.issues,
      });
    }
    return this.bridgeService.upsertStaffMapping(tenant, parsed.data, req.ip);
  }

  @Delete("staff-mappings/:staffId")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["configure"] })
  async deleteStaffMapping(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("staffId") staffId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.bridgeService.deleteStaffMapping(tenant, staffId, req.ip);
  }

  @Post("catalog/push")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["create"] })
  async pushCatalog(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = pushCatalogSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid catalog push payload.",
        issues: parsed.error.issues,
      });
    }
    return this.bridgeService.pushCatalogToCustomerMates(
      tenant,
      parsed.data,
      req.ip,
    );
  }

  // ==========================================
  // Contacts
  // ==========================================

  @Get("contacts")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["read"] })
  async listContacts(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listCrmQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM contact query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.proxyService.listResources(tenant, "contacts", parsed.data);
  }

  @Get("contacts/:id")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["read"] })
  async getContact(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("id") id: string,
  ) {
    return this.proxyService.getResource(tenant, "contacts", id);
  }

  @Post("contacts")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["create"] })
  async createContact(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = contactPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM contact payload.",
        issues: parsed.error.issues,
      });
    }
    return this.proxyService.createResource(
      tenant,
      "contacts",
      parsed.data,
      req.ip,
    );
  }

  @Patch("contacts/:id")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["update"] })
  async updateContact(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = contactPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM contact update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.proxyService.updateResource(
      tenant,
      "contacts",
      id,
      parsed.data,
      req.ip,
    );
  }

  @Delete("contacts/:id")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["delete"] })
  async deleteContact(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.proxyService.deleteResource(tenant, "contacts", id, req.ip);
  }

  // ==========================================
  // Companies (CustomerMates Organizations)
  // ==========================================

  @Get("companies")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["read"] })
  async listCompanies(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listCrmQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM company query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.proxyService.listResources(tenant, "organizations", parsed.data);
  }

  @Get("companies/:id")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["read"] })
  async getCompany(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("id") id: string,
  ) {
    return this.proxyService.getResource(tenant, "organizations", id);
  }

  @Post("companies")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["create"] })
  async createCompany(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = companyPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM company payload.",
        issues: parsed.error.issues,
      });
    }
    return this.proxyService.createResource(
      tenant,
      "organizations",
      parsed.data,
      req.ip,
    );
  }

  @Patch("companies/:id")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["update"] })
  async updateCompany(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = companyPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM company update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.proxyService.updateResource(
      tenant,
      "organizations",
      id,
      parsed.data,
      req.ip,
    );
  }

  @Delete("companies/:id")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["delete"] })
  async deleteCompany(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.proxyService.deleteResource(
      tenant,
      "organizations",
      id,
      req.ip,
    );
  }

  // ==========================================
  // Deals + Deal Catalog Item Links
  // ==========================================

  @Get("deals")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["read"] })
  async listDeals(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listCrmQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM deal query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.proxyService.listResources(tenant, "deals", parsed.data);
  }

  @Get("deals/:id")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["read"] })
  async getDeal(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("id") id: string,
  ) {
    return this.proxyService.getDealWithContext(tenant, id);
  }

  @Post("deals")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["create"] })
  async createDeal(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = dealPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM deal payload.",
        issues: parsed.error.issues,
      });
    }
    return this.proxyService.createResource(tenant, "deals", parsed.data, req.ip);
  }

  @Patch("deals/:id")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["update"] })
  async updateDeal(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = dealPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM deal update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.proxyService.updateResource(
      tenant,
      "deals",
      id,
      parsed.data,
      req.ip,
    );
  }

  @Delete("deals/:id")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["delete"] })
  async deleteDeal(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.proxyService.deleteResource(tenant, "deals", id, req.ip);
  }

  @Get("deals/:dealId/items")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["read"] })
  async listDealItems(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("dealId") dealId: string,
  ) {
    return this.bridgeService.listDealItems(tenant, dealId);
  }

  @Post("deals/:dealId/items")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["update"] })
  async linkDealItem(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("dealId") dealId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = dealItemInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid deal catalog item payload.",
        issues: parsed.error.issues,
      });
    }
    return this.bridgeService.linkItemToDeal(
      tenant,
      dealId,
      parsed.data,
      req.ip,
    );
  }

  @Delete("deals/:dealId/items/:itemId")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["update"] })
  async unlinkDealItem(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("dealId") dealId: string,
    @Param("itemId") itemId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.bridgeService.unlinkItemFromDeal(
      tenant,
      dealId,
      itemId,
      req.ip,
    );
  }

  // ==========================================
  // Services & Tasks
  // ==========================================

  @Get("services")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["read"] })
  async listServices(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listCrmQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM service query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.proxyService.listResources(tenant, "services", parsed.data);
  }

  @Post("services")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["create"] })
  async createService(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = servicePayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM service payload.",
        issues: parsed.error.issues,
      });
    }
    return this.proxyService.createResource(
      tenant,
      "services",
      parsed.data,
      req.ip,
    );
  }

  @Get("tasks")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["read"] })
  async listTasks(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listCrmQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM task query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.proxyService.listResources(tenant, "tasks", parsed.data);
  }

  @Post("tasks")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["create"] })
  async createTask(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = taskPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM task payload.",
        issues: parsed.error.issues,
      });
    }
    return this.proxyService.createResource(tenant, "tasks", parsed.data, req.ip);
  }

  @Patch("tasks/:id")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["update"] })
  async updateTask(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = taskPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM task update payload.",
        issues: parsed.error.issues,
      });
    }
    return this.proxyService.updateResource(
      tenant,
      "tasks",
      id,
      parsed.data,
      req.ip,
    );
  }

  @Delete("tasks/:id")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["delete"] })
  async deleteTask(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.proxyService.deleteResource(tenant, "tasks", id, req.ip);
  }

  // ==========================================
  // Webhooks (Signed Inbound + Event Log)
  // ==========================================

  @Get("webhooks/events")
  @RequireActiveTenant()
  @RequiredOrgPermissions({ crm: ["read"] })
  async listWebhookEvents(
    @CurrentTenant() tenant: AuthenticatedTenant,
    @Query() query: unknown,
  ) {
    const parsed = listWebhookQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM webhook event query parameters.",
        issues: parsed.error.issues,
      });
    }
    return this.webhookService.listWebhookEvents(tenant, parsed.data);
  }

  @Post("webhooks/:organizationId")
  @AllowAnonymous()
  @HttpCode(HttpStatus.OK)
  async ingestWebhook(
    @Param("organizationId") organizationId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest & { crmRawBody?: Buffer; rawBody?: Buffer },
  ) {
    const rawBody =
      req.crmRawBody ??
      req.rawBody ??
      Buffer.from(JSON.stringify(body ?? {}), "utf8");

    return this.webhookService.ingestWebhook(
      organizationId,
      rawBody,
      req.headers,
      body,
      req.ip,
    );
  }
}

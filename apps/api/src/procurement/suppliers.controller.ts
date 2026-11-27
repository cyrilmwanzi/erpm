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
  Put,
  Query,
  Req,
} from "@nestjs/common";
import { SupplierStatus } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { SuppliersService } from "./suppliers.service.js";

const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9._-]+$/, "Code may only contain letters, numbers, dots, underscores, and hyphens.");

const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((v) => v.toUpperCase());

const httpUrlSchema = z
  .string()
  .trim()
  .url()
  .max(300)
  .refine(
    (val) => val.startsWith("https://") || val.startsWith("http://"),
    "Website URL must start with http:// or https://.",
  );

const mutableStatusEnum = z.enum([
  SupplierStatus.ACTIVE,
  SupplierStatus.INACTIVE,
]);

const supplierStatusEnum = z.enum([
  SupplierStatus.ACTIVE,
  SupplierStatus.INACTIVE,
  SupplierStatus.ARCHIVED,
]);

const createSupplierSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(200),
  status: mutableStatusEnum.optional(),
  email: z.string().trim().email().max(320).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  website: httpUrlSchema.nullable().optional(),
  taxId: z.string().trim().max(64).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  currency: currencySchema.optional(),
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  addressLine1: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  state: z.string().trim().max(100).nullable().optional(),
  postalCode: z.string().trim().max(30).nullable().optional(),
  country: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const updateSupplierSchema = createSupplierSchema.partial();

const listSuppliersQuerySchema = z.object({
  status: supplierStatusEnum.optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const archiveSupplierSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

const restoreSupplierSchema = z.object({
  status: mutableStatusEnum.default(SupplierStatus.ACTIVE),
  reason: z.string().trim().min(1).max(500).optional(),
});

const upsertSupplierItemSchema = z.object({
  itemId: z.string().trim().min(1),
  packId: z.string().trim().min(1).nullable().optional(),
  supplierSku: z.string().trim().min(1).max(64).nullable().optional(),
  unitCostCents: z.number().int().min(0).max(2_000_000_000),
  currency: currencySchema.optional(),
  minOrderQty: z.number().int().min(1).max(1_000_000).optional(),
  leadTimeDays: z.number().int().min(0).max(365).nullable().optional(),
  isPreferred: z.boolean().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

@Controller("api/v1/suppliers")
@RequireActiveOrganization()
export class SuppliersController {
  constructor(
    @Inject(SuppliersService)
    private readonly suppliersService: SuppliersService,
  ) {}

  @Post()
  @RequiredOrgPermissions({ supplier: ["create"] })
  async createSupplier(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createSupplierSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid supplier payload.",
        issues: parsed.error.issues,
      });
    }

    return this.suppliersService.createSupplier(tenant, parsed.data, req.ip);
  }

  @Get()
  @RequiredOrgPermissions({ supplier: ["read"] })
  async listSuppliers(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listSuppliersQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid supplier query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.suppliersService.listSuppliers(tenant, parsed.data);
  }

  @Get(":supplierId")
  @RequiredOrgPermissions({ supplier: ["read"] })
  async getSupplier(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("supplierId") supplierId: string,
  ) {
    return this.suppliersService.getSupplier(tenant, supplierId);
  }

  @Patch(":supplierId")
  @RequiredOrgPermissions({ supplier: ["update"] })
  async updateSupplier(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("supplierId") supplierId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateSupplierSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid supplier update payload.",
        issues: parsed.error.issues,
      });
    }

    return this.suppliersService.updateSupplier(
      tenant,
      supplierId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":supplierId/archive")
  @RequiredOrgPermissions({ supplier: ["archive"] })
  async archiveSupplier(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("supplierId") supplierId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = archiveSupplierSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid archive payload.",
        issues: parsed.error.issues,
      });
    }

    return this.suppliersService.archiveSupplier(
      tenant,
      supplierId,
      parsed.data.reason,
      req.ip,
    );
  }

  @Post(":supplierId/restore")
  @RequiredOrgPermissions({ supplier: ["archive"] })
  async restoreSupplier(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("supplierId") supplierId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = restoreSupplierSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid restore payload.",
        issues: parsed.error.issues,
      });
    }

    return this.suppliersService.restoreSupplier(
      tenant,
      supplierId,
      parsed.data.status,
      parsed.data.reason,
      req.ip,
    );
  }

  @Get(":supplierId/items")
  @RequiredOrgPermissions({ supplier: ["read"] })
  async listSupplierItems(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("supplierId") supplierId: string,
  ) {
    return this.suppliersService.listSupplierItems(tenant, supplierId);
  }

  @Put(":supplierId/items")
  @RequiredOrgPermissions({ supplier: ["update"] })
  async upsertSupplierItem(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("supplierId") supplierId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = upsertSupplierItemSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid supplier item mapping payload.",
        issues: parsed.error.issues,
      });
    }

    return this.suppliersService.upsertSupplierItem(
      tenant,
      supplierId,
      parsed.data,
      req.ip,
    );
  }

  @Delete(":supplierId/items/:itemId")
  @RequiredOrgPermissions({ supplier: ["update"] })
  async removeSupplierItem(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("supplierId") supplierId: string,
    @Param("itemId") itemId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.suppliersService.removeSupplierItem(
      tenant,
      supplierId,
      itemId,
      req.ip,
    );
  }
}

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
import { CustomerStatus, CustomerType } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { CustomersService } from "./customers.service.js";

const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((v) => v.toUpperCase());

const createCustomerSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
  type: z.enum([CustomerType.INDIVIDUAL, CustomerType.BUSINESS]).optional(),
  status: z.enum([CustomerStatus.ACTIVE, CustomerStatus.INACTIVE]).optional(),
  name: z.string().trim().min(1).max(200),
  companyName: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  phone: z.string().trim().max(64).nullable().optional(),
  taxId: z.string().trim().max(64).nullable().optional(),
  customerSegment: z.string().trim().max(80).nullable().optional(),
  currency: currencySchema.optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  billingAddressLine1: z.string().trim().max(200).nullable().optional(),
  billingAddressLine2: z.string().trim().max(200).nullable().optional(),
  billingCity: z.string().trim().max(120).nullable().optional(),
  billingState: z.string().trim().max(120).nullable().optional(),
  billingPostalCode: z.string().trim().max(40).nullable().optional(),
  billingCountry: z.string().trim().max(120).nullable().optional(),
  shippingAddressLine1: z.string().trim().max(200).nullable().optional(),
  shippingAddressLine2: z.string().trim().max(200).nullable().optional(),
  shippingCity: z.string().trim().max(120).nullable().optional(),
  shippingState: z.string().trim().max(120).nullable().optional(),
  shippingPostalCode: z.string().trim().max(40).nullable().optional(),
  shippingCountry: z.string().trim().max(120).nullable().optional(),
  externalContactId: z.string().trim().min(1).max(120).nullable().optional(),
  externalCompanyId: z.string().trim().min(1).max(120).nullable().optional(),
  externalAccountId: z.string().trim().min(1).max(120).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const updateCustomerSchema = createCustomerSchema
  .omit({ code: true })
  .partial();

const listCustomersQuerySchema = z.object({
  type: z.enum([CustomerType.INDIVIDUAL, CustomerType.BUSINESS]).optional(),
  status: z
    .enum([
      CustomerStatus.ACTIVE,
      CustomerStatus.INACTIVE,
      CustomerStatus.ARCHIVED,
    ])
    .optional(),
  customerSegment: z.string().trim().min(1).max(80).optional(),
  hasCrmLink: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const restoreCustomerSchema = z.object({
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

const linkCrmSchema = z.object({
  externalContactId: z.string().trim().min(1).max(120).nullable().optional(),
  externalCompanyId: z.string().trim().min(1).max(120).nullable().optional(),
  externalAccountId: z.string().trim().min(1).max(120).nullable().optional(),
  pushToCrm: z.boolean().optional(),
});

const importCrmSchema = z.object({
  externalContactId: z.string().trim().min(1).max(120).optional(),
  externalCompanyId: z.string().trim().min(1).max(120).optional(),
  type: z.enum([CustomerType.INDIVIDUAL, CustomerType.BUSINESS]).optional(),
  customerSegment: z.string().trim().max(80).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
});

@Controller("api/v1/customers")
@RequireActiveOrganization()
export class CustomersController {
  constructor(
    @Inject(CustomersService)
    private readonly customersService: CustomersService,
  ) {}

  @Post()
  @RequiredOrgPermissions({ customer: ["create"] })
  async createCustomer(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createCustomerSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid customer payload.",
        issues: parsed.error.issues,
      });
    }

    return this.customersService.createCustomer(tenant, parsed.data, req.ip);
  }

  @Get()
  @RequiredOrgPermissions({ customer: ["read"] })
  async listCustomers(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listCustomersQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid customer query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.customersService.listCustomers(tenant, parsed.data);
  }

  @Post("crm-import")
  @RequiredOrgPermissions({ customer: ["create"] })
  async importCustomerFromCrm(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = importCrmSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid CRM customer import payload.",
        issues: parsed.error.issues,
      });
    }

    return this.customersService.importCustomerFromCrm(
      tenant,
      parsed.data,
      req.ip,
    );
  }

  @Get(":customerId")
  @RequiredOrgPermissions({ customer: ["read"] })
  async getCustomer(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("customerId") customerId: string,
  ) {
    return this.customersService.getCustomer(tenant, customerId);
  }

  @Patch(":customerId")
  @RequiredOrgPermissions({ customer: ["update"] })
  async updateCustomer(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("customerId") customerId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateCustomerSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid customer update payload.",
        issues: parsed.error.issues,
      });
    }

    return this.customersService.updateCustomer(
      tenant,
      customerId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":customerId/archive")
  @RequiredOrgPermissions({ customer: ["archive"] })
  async archiveCustomer(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("customerId") customerId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.customersService.archiveCustomer(tenant, customerId, req.ip);
  }

  @Post(":customerId/restore")
  @RequiredOrgPermissions({ customer: ["archive"] })
  async restoreCustomer(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("customerId") customerId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = restoreCustomerSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid customer restore payload.",
        issues: parsed.error.issues,
      });
    }

    return this.customersService.restoreCustomer(
      tenant,
      customerId,
      parsed.data.status,
      req.ip,
    );
  }

  @Post(":customerId/crm-link")
  @RequiredOrgPermissions({ customer: ["update"] })
  async linkCustomerToCrm(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("customerId") customerId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = linkCrmSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid customer CRM link payload.",
        issues: parsed.error.issues,
      });
    }

    return this.customersService.linkCustomerToCrm(
      tenant,
      customerId,
      parsed.data,
      req.ip,
    );
  }
}

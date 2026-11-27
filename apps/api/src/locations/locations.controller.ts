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
import { LocationStatus, LocationType } from "@scace/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
} from "../organizations/organization.decorators.js";
import { LocationsService } from "./locations.service.js";

const locationTypeEnum = z.enum([
  LocationType.WAREHOUSE,
  LocationType.RETAIL_STORE,
]);

const locationStatusEnum = z.enum([
  LocationStatus.ACTIVE,
  LocationStatus.INACTIVE,
  LocationStatus.ARCHIVED,
]);

const mutableStatusEnum = z.enum([
  LocationStatus.ACTIVE,
  LocationStatus.INACTIVE,
]);

const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9._-]+$/, "Code may only contain letters, numbers, dots, underscores, and hyphens.");

const createLocationSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(200),
  type: locationTypeEnum,
  status: mutableStatusEnum.optional(),
  isDefault: z.boolean().optional(),
  addressLine1: z.string().trim().max(200).nullable().optional(),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  state: z.string().trim().max(100).nullable().optional(),
  postalCode: z.string().trim().max(30).nullable().optional(),
  country: z.string().trim().max(100).nullable().optional(),
  timezone: z.string().trim().max(100).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  email: z.string().trim().email().max(320).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const updateLocationSchema = createLocationSchema.partial();

const listLocationsQuerySchema = z.object({
  type: locationTypeEnum.optional(),
  status: locationStatusEnum.optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

const archiveLocationSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

const restoreLocationSchema = z.object({
  status: mutableStatusEnum.default(LocationStatus.ACTIVE),
  reason: z.string().trim().min(1).max(500).optional(),
});

@Controller("api/v1/locations")
@RequireActiveOrganization()
export class LocationsController {
  constructor(
    @Inject(LocationsService)
    private readonly locationsService: LocationsService,
  ) {}

  @Post()
  @RequiredOrgPermissions({ location: ["create"] })
  async createLocation(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createLocationSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid location payload.",
        issues: parsed.error.issues,
      });
    }

    return this.locationsService.createLocation(tenant, parsed.data, req.ip);
  }

  @Get()
  @RequiredOrgPermissions({ location: ["read"] })
  async listLocations(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() query: unknown,
  ) {
    const parsed = listLocationsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid location query parameters.",
        issues: parsed.error.issues,
      });
    }

    return this.locationsService.listLocations(tenant, parsed.data);
  }

  @Get(":locationId")
  @RequiredOrgPermissions({ location: ["read"] })
  async getLocation(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("locationId") locationId: string,
  ) {
    return this.locationsService.getLocation(tenant, locationId);
  }

  @Patch(":locationId")
  @RequiredOrgPermissions({ location: ["update"] })
  async updateLocation(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("locationId") locationId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = updateLocationSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid location update payload.",
        issues: parsed.error.issues,
      });
    }

    return this.locationsService.updateLocation(
      tenant,
      locationId,
      parsed.data,
      req.ip,
    );
  }

  @Post(":locationId/archive")
  @RequiredOrgPermissions({ location: ["archive"] })
  async archiveLocation(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("locationId") locationId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = archiveLocationSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid archive payload.",
        issues: parsed.error.issues,
      });
    }

    return this.locationsService.archiveLocation(
      tenant,
      locationId,
      parsed.data.reason,
      req.ip,
    );
  }

  @Post(":locationId/restore")
  @RequiredOrgPermissions({ location: ["archive"] })
  async restoreLocation(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("locationId") locationId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = restoreLocationSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid restore payload.",
        issues: parsed.error.issues,
      });
    }

    return this.locationsService.restoreLocation(
      tenant,
      locationId,
      parsed.data.status,
      parsed.data.reason,
      req.ip,
    );
  }
}

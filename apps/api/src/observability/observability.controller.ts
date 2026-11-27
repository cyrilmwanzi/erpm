import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
} from "@nestjs/common";
import { z } from "zod";
import {
  CurrentOrganization,
  RequireActiveOrganization,
  RequiredOrgPermissions,
  type AuthenticatedOrganization,
  type OrganizationScopedRequest,
} from "../organizations/organization.decorators.js";
import { AnalyticsService } from "./analytics.service.js";
import { SentryService } from "./sentry.service.js";

const flagKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/, {
    message:
      "Feature flag key may only contain letters, numbers, dots, underscores, and hyphens.",
  });

const listFlagsQuerySchema = z.object({
  keys: z
    .string()
    .trim()
    .max(2000)
    .optional(),
});

@Controller("api/v1/observability")
@RequireActiveOrganization()
export class ObservabilityController {
  constructor(
    @Inject(SentryService) private readonly sentryService: SentryService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  @Get("status")
  @RequiredOrgPermissions({ organizationSettings: ["read"] })
  getStatus(@Req() request: OrganizationScopedRequest & { requestId?: string }) {
    return {
      requestId: request.requestId ?? null,
      sentry: this.sentryService.getStatus(),
      posthog: this.analyticsService.getStatus(),
    };
  }

  @Get("feature-flags")
  async getAllFeatureFlags(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Query() rawQuery: unknown,
  ) {
    const parsedQuery = listFlagsQuerySchema.safeParse(rawQuery ?? {});
    if (!parsedQuery.success) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Invalid feature flag query parameters.",
        issues: parsedQuery.error.issues,
      });
    }

    let flagKeys: string[] | undefined;
    if (parsedQuery.data.keys) {
      const splitKeys = parsedQuery.data.keys
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);

      if (splitKeys.length > 50) {
        throw new BadRequestException({
          code: "VALIDATION_ERROR",
          message: "At most 50 feature flag keys can be evaluated per request.",
        });
      }

      for (const candidate of splitKeys) {
        const keyCheck = flagKeySchema.safeParse(candidate);
        if (!keyCheck.success) {
          throw new BadRequestException({
            code: "VALIDATION_ERROR",
            message: `Invalid feature flag key '${candidate}'.`,
            issues: keyCheck.error.issues,
          });
        }
      }

      if (splitKeys.length > 0) {
        flagKeys = splitKeys;
      }
    }

    const evaluated = await this.analyticsService.getAllFlagsAndPayloads({
      distinctId: tenant.userId,
      organizationId: tenant.organizationId,
      flagKeys,
      personProperties: {
        role: tenant.role,
        auth_method: tenant.authMethod ?? "COOKIE_SESSION",
      },
      groupProperties: {
        organization: {
          organization_id: tenant.organizationId,
        },
      },
    });

    return {
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      ...evaluated,
    };
  }

  @Get("feature-flags/:key")
  async getFeatureFlag(
    @CurrentOrganization() tenant: AuthenticatedOrganization,
    @Param("key") rawKey: string,
  ) {
    const parsedKey = flagKeySchema.safeParse(rawKey);
    if (!parsedKey.success) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Invalid feature flag key.",
        issues: parsedKey.error.issues,
      });
    }

    const result = await this.analyticsService.getFeatureFlagResult({
      key: parsedKey.data,
      distinctId: tenant.userId,
      organizationId: tenant.organizationId,
      personProperties: {
        role: tenant.role,
        auth_method: tenant.authMethod ?? "COOKIE_SESSION",
      },
      groupProperties: {
        organization: {
          organization_id: tenant.organizationId,
        },
      },
    });

    return {
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      ...result,
    };
  }
}

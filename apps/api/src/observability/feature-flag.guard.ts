import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { OrganizationScopedRequest } from "../organizations/organization.decorators.js";
import { AnalyticsService } from "./analytics.service.js";
import {
  FEATURE_FLAG_METADATA_KEY,
  type FeatureFlagRequirement,
} from "./feature-flag.decorator.js";

@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement =
      this.reflector.getAllAndOverride<FeatureFlagRequirement | undefined>(
        FEATURE_FLAG_METADATA_KEY,
        [context.getHandler(), context.getClass()],
      );

    if (!requirement) {
      return true;
    }

    const request = context.switchToHttp().getRequest<OrganizationScopedRequest>();
    const organizationId =
      request.organization?.organizationId ??
      request.authContext?.organizationId ??
      request.session?.session?.activeOrganizationId ??
      null;
    const distinctId =
      request.organization?.userId ??
      request.session?.user?.id ??
      (organizationId ? `org:${organizationId}` : "anonymous");

    const enabled = await this.analyticsService.isFeatureEnabled({
      key: requirement.flagKey,
      distinctId,
      organizationId,
      defaultValue: requirement.defaultEnabled ?? false,
      personProperties: request.organization?.role
        ? { role: request.organization.role }
        : undefined,
    });

    if (!enabled) {
      throw new ForbiddenException({
        code: "FEATURE_FLAG_DISABLED",
        message:
          requirement.errorMessage ??
          `Feature '${requirement.flagKey}' is not enabled for this organization.`,
      });
    }

    return true;
  }
}

import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Inject,
  Logger,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { getEnv } from "../config/env.js";
import type { OrganizationScopedRequest } from "../organizations/organization.decorators.js";
import { AnalyticsService } from "./analytics.service.js";
import {
  extractErrorDetails,
  sanitizeRequestId,
  scrubUrlQuery,
} from "./scrubbing.utils.js";
import { SentryService } from "./sentry.service.js";

export type CorrelationRequest = OrganizationScopedRequest & {
  requestId?: string;
  routeOptions?: { url?: string };
};

export interface EnterpriseErrorEnvelope {
  statusCode: number;
  error: string;
  error_description?: string;
  code: string;
  message: string;
  requestId: string;
  sentryEventId: string | null;
  timestamp: string;
  path: string;
  issues?: unknown[];
}

@Catch()
export class EnterpriseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(EnterpriseExceptionFilter.name);

  constructor(
    @Inject(SentryService) private readonly sentryService: SentryService,
    @Inject(AnalyticsService)
    private readonly analyticsService: AnalyticsService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== "http") {
      throw exception;
    }

    const ctx = host.switchToHttp();
    const request = ctx.getRequest<CorrelationRequest>();
    const reply = ctx.getResponse<FastifyReply>();

    const env = getEnv();
    const includeDebugDetails = env.NODE_ENV !== "production";

    const requestId =
      request.requestId ??
      sanitizeRequestId(request.headers["x-request-id"] ?? request.id);

    const normalized = extractErrorDetails(exception, includeDebugDetails);
    const organizationId =
      request.organization?.organizationId ??
      request.authContext?.organizationId ??
      request.session?.session?.activeOrganizationId ??
      null;
    const userId = request.organization?.userId ?? request.session?.user?.id ?? null;
    const role = request.organization?.role ?? null;
    const authMethod =
      request.organization?.authMethod ?? request.authContext?.authMethod ?? null;
    const routePattern =
      request.routeOptions?.url ??
      scrubUrlQuery(request.url.split("?")[0] ?? request.url);
    const cleanPath = scrubUrlQuery(request.url.split("?")[0] ?? request.url);

    const sentryEventId = this.sentryService.captureException(exception, {
      statusCode: normalized.statusCode,
      errorCode: normalized.code,
      requestId,
      organizationId,
      userId,
      role,
      authMethod,
      method: request.method,
      route: routePattern,
      path: cleanPath,
      extra: normalized.issues ? { issues: normalized.issues } : undefined,
    });

    this.analyticsService.captureDomainEvent({
      event: "api.error.occurred",
      distinctId: userId,
      organizationId,
      properties: {
        status_code: normalized.statusCode,
        error_class: normalized.statusCode >= 500 ? "5xx" : "4xx",
        error_code: normalized.code,
        method: request.method,
        route: routePattern,
        path: cleanPath,
        request_id: requestId,
        sentry_event_id: sentryEventId,
        has_validation_issues: Boolean(normalized.issues?.length),
        auth_method: authMethod ?? "ANONYMOUS",
      },
    });

    if (normalized.statusCode >= 500) {
      this.logger.error(
        `[${requestId}] ${request.method} ${cleanPath} -> ${normalized.statusCode} ${normalized.code}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `[${requestId}] ${request.method} ${cleanPath} -> ${normalized.statusCode} ${normalized.code}: ${normalized.message}`,
      );
    }

    const envelope: EnterpriseErrorEnvelope = {
      statusCode: normalized.statusCode,
      error: normalized.error,
      ...(normalized.errorDescription
        ? { error_description: normalized.errorDescription }
        : {}),
      code: normalized.code,
      message: normalized.message,
      requestId,
      sentryEventId,
      timestamp: new Date().toISOString(),
      path: cleanPath,
      ...(normalized.issues ? { issues: normalized.issues } : {}),
    };

    if (!reply.sent) {
      if (normalized.statusCode === 401 && !reply.getHeader("www-authenticate")) {
        const isOAuthTokenEndpoint =
          cleanPath.startsWith("/api/v1/oauth/token") ||
          cleanPath.startsWith("/api/v1/oauth/introspect") ||
          cleanPath.startsWith("/api/v1/oauth/revoke") ||
          cleanPath.startsWith("/api/v1/oauth/device/code");
        const resourceMetadataUrl = `${env.OAUTH_ISSUER_URL}/.well-known/oauth-protected-resource`;
        reply.header(
          "WWW-Authenticate",
          isOAuthTokenEndpoint
            ? 'Basic realm="scace-oauth"'
            : `Bearer resource_metadata="${resourceMetadataUrl}"`,
        );
      }

      void reply
        .header("X-Request-Id", requestId)
        .code(normalized.statusCode)
        .send(envelope);
    }
  }
}

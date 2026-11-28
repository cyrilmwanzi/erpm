import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { HttpException, HttpStatus } from "@nestjs/common";
import type { NodeOptions } from "@sentry/nestjs";

export type SentryErrorEvent = Parameters<
  NonNullable<NodeOptions["beforeSend"]>
>[0];
export type SentryTransactionEvent = Parameters<
  NonNullable<NodeOptions["beforeSendTransaction"]>
>[0];
export type SentryBreadcrumb = Parameters<
  NonNullable<NodeOptions["beforeBreadcrumb"]>
>[0];

const REDACTED = "[REDACTED]";
const BINARY_OMITTED = "[BINARY_OMITTED]";
const MAX_SCRUB_DEPTH = 6;

const SENSITIVE_KEY_PATTERN =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-scace-signature|password|passwd|secret|client_secret|clientsecret|access_token|accesstoken|refresh_token|refreshtoken|id_token|idtoken|api_key|apikey|private_key|privatekey|encryption_key|encryptionkey|webhook_secret|webhooksecret|pat|session_token|sessiontoken|csrf_token|signature|ssn|credit_card|card_number|cvv|cvc|consumer_key|consumerkey|consumer_secret|consumersecret|passkey|initiator_password|initiatorpassword|security_credential|securitycredential|callback_token|callbacktoken|callback_route_token|callbackroutetoken)$/i;

const SENSITIVE_KEY_SUBSTRING_PATTERN =
  /(password|passwd|secret|token|apikey|api_key|authorization|cookie|private_key|encryption_key|credential|passkey|consumer_key|consumerkey)/i;

const SENSITIVE_QUERY_PARAMS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "code",
  "secret",
  "client_secret",
  "api_key",
  "apikey",
  "key",
  "password",
  "passwd",
  "signature",
  "sig",
  "pat",
  "passkey",
  "consumer_key",
  "consumer_secret",
]);

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export function sanitizeRequestId(raw: unknown): string {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (REQUEST_ID_PATTERN.test(trimmed)) {
      return trimmed;
    }
  }
  return randomUUID();
}

export function scrubStringValue(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    .replace(/\bscace_pat_[A-Za-z0-9_-]+/g, "[REDACTED_PAT]")
    .replace(/\bph[csx]_[A-Za-z0-9_-]+/g, "[REDACTED_POSTHOG_KEY]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
      "[REDACTED_JWT]",
    );
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key.trim();
  if (!normalized) {
    return false;
  }
  if (SENSITIVE_KEY_PATTERN.test(normalized)) {
    return true;
  }
  return SENSITIVE_KEY_SUBSTRING_PATTERN.test(normalized);
}

export function scrubObject<T>(
  value: T,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return scrubStringValue(value) as T;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  if (
    Buffer.isBuffer(value) ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  ) {
    return BINARY_OMITTED as unknown as T;
  }

  if (typeof value !== "object") {
    return String(value) as unknown as T;
  }

  if (seen.has(value as object)) {
    return "[CIRCULAR]" as unknown as T;
  }

  if (depth >= MAX_SCRUB_DEPTH) {
    return "[MAX_DEPTH]" as unknown as T;
  }

  seen.add(value as object);

  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item) => scrubObject(item, depth + 1, seen)) as unknown as T;
  }

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(record)) {
    if (isSensitiveKey(key)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = scrubObject(entry, depth + 1, seen);
  }

  return output as T;
}

export function scrubHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }

  const sanitized: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (
      key === "authorization" ||
      key === "proxy-authorization" ||
      key === "cookie" ||
      key === "set-cookie" ||
      key === "x-api-key" ||
      key === "x-scace-signature" ||
      isSensitiveKey(key)
    ) {
      sanitized[rawKey] = REDACTED;
      continue;
    }

    if (Array.isArray(rawVal)) {
      sanitized[rawKey] = rawVal
        .map((item) => scrubStringValue(String(item)))
        .join(", ");
    } else if (rawVal !== undefined && rawVal !== null) {
      sanitized[rawKey] = scrubStringValue(String(rawVal));
    }
  }
  return sanitized;
}

export function scrubUrlQuery(rawUrl: string): string {
  try {
    const isAbsolute = /^https?:\/\//i.test(rawUrl);
    const parsed = new URL(rawUrl, "http://localhost");
    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase()) || isSensitiveKey(key)) {
        parsed.searchParams.set(key, REDACTED);
      }
    }
    return isAbsolute
      ? parsed.toString()
      : `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return scrubStringValue(rawUrl);
  }
}

export function scrubQueryString(
  queryString: unknown,
): string | Record<string, unknown> | undefined {
  if (!queryString) {
    return undefined;
  }
  if (typeof queryString === "string") {
    try {
      const params = new URLSearchParams(queryString);
      for (const key of params.keys()) {
        if (
          SENSITIVE_QUERY_PARAMS.has(key.toLowerCase()) ||
          isSensitiveKey(key)
        ) {
          params.set(key, REDACTED);
        }
      }
      return params.toString();
    } catch {
      return scrubStringValue(queryString);
    }
  }
  if (typeof queryString === "object") {
    return scrubObject(queryString as Record<string, unknown>);
  }
  return undefined;
}

export function sanitizeSentryEvent<
  T extends SentryErrorEvent | SentryTransactionEvent,
>(event: T): T {
  const cloned = { ...event };

  if (cloned.request) {
    cloned.request = {
      ...cloned.request,
      headers: scrubHeaders(
        cloned.request.headers as Record<string, unknown> | undefined,
      ),
      cookies: undefined,
      url: cloned.request.url ? scrubUrlQuery(cloned.request.url) : undefined,
      query_string: scrubQueryString(cloned.request.query_string) as
        | string
        | undefined,
      data:
        cloned.request.data !== undefined
          ? scrubObject(cloned.request.data)
          : undefined,
    };
  }

  if (cloned.user) {
    const safeUser: Record<string, unknown> = {};
    if (cloned.user.id !== undefined) {
      safeUser.id = cloned.user.id;
    }
    if ("segment" in cloned.user && cloned.user.segment !== undefined) {
      safeUser.segment = cloned.user.segment;
    }
    cloned.user = safeUser;
  }

  if (cloned.extra) {
    cloned.extra = scrubObject(cloned.extra);
  }

  if (cloned.contexts) {
    cloned.contexts = scrubObject(cloned.contexts);
  }

  if (cloned.tags) {
    cloned.tags = scrubObject(cloned.tags);
  }

  if (
    "exception" in cloned &&
    cloned.exception &&
    Array.isArray(cloned.exception.values)
  ) {
    cloned.exception = {
      ...cloned.exception,
      values: cloned.exception.values.map((ex) => ({
        ...ex,
        value: ex.value ? scrubStringValue(ex.value) : ex.value,
      })),
    };
  }

  if (cloned.breadcrumbs && Array.isArray(cloned.breadcrumbs)) {
    cloned.breadcrumbs = cloned.breadcrumbs
      .map((bc) => sanitizeSentryBreadcrumb(bc))
      .filter((bc): bc is SentryBreadcrumb => bc !== null);
  }

  return cloned;
}

export function sanitizeSentryBreadcrumb(
  breadcrumb: SentryBreadcrumb,
): SentryBreadcrumb | null {
  const sanitized = { ...breadcrumb };
  if (sanitized.message) {
    sanitized.message = scrubStringValue(sanitized.message);
  }
  if (sanitized.data) {
    const dataCopy = { ...sanitized.data };
    if (typeof dataCopy.url === "string") {
      dataCopy.url = scrubUrlQuery(dataCopy.url);
    }
    sanitized.data = scrubObject(dataCopy);
  }
  return sanitized;
}

export function sanitizeAnalyticsProperties(
  properties?: Record<string, unknown>,
): Record<string, unknown> {
  if (!properties) {
    return {};
  }
  return scrubObject(properties);
}

export interface NormalizedHttpError {
  statusCode: number;
  error: string;
  code: string;
  message: string;
  errorDescription?: string;
  issues?: unknown[];
}

function defaultErrorCodeForStatus(statusCode: number): string {
  switch (statusCode) {
    case HttpStatus.BAD_REQUEST:
      return "BAD_REQUEST";
    case HttpStatus.UNAUTHORIZED:
      return "UNAUTHORIZED";
    case HttpStatus.PAYMENT_REQUIRED:
      return "PAYMENT_REQUIRED";
    case HttpStatus.FORBIDDEN:
      return "FORBIDDEN";
    case HttpStatus.NOT_FOUND:
      return "NOT_FOUND";
    case HttpStatus.CONFLICT:
      return "CONFLICT";
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return "PAYLOAD_TOO_LARGE";
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return "VALIDATION_ERROR";
    case HttpStatus.TOO_MANY_REQUESTS:
      return "RATE_LIMIT_EXCEEDED";
    case HttpStatus.SERVICE_UNAVAILABLE:
      return "SERVICE_UNAVAILABLE";
    default:
      return statusCode >= 500 ? "INTERNAL_SERVER_ERROR" : "HTTP_ERROR";
  }
}

export function extractErrorDetails(
  exception: unknown,
  includeDebugDetails: boolean,
): NormalizedHttpError {
  if (exception instanceof HttpException) {
    const statusCode = exception.getStatus();
    const errorLabel =
      STATUS_CODES[statusCode] ??
      (statusCode >= 500 ? "Internal Server Error" : "Bad Request");
    const response = exception.getResponse();

    if (typeof response === "string") {
      return {
        statusCode,
        error: errorLabel,
        code: defaultErrorCodeForStatus(statusCode),
        message: scrubStringValue(response),
      };
    }

    if (typeof response === "object" && response !== null) {
      const resp = response as Record<string, unknown>;
      const issues = Array.isArray(resp.issues) ? resp.issues : undefined;
      let message: string;
      if (Array.isArray(resp.message)) {
        message = resp.message.map((m) => scrubStringValue(String(m))).join("; ");
      } else if (typeof resp.message === "string" && resp.message.trim().length > 0) {
        message = scrubStringValue(resp.message);
      } else if (resp.status === "degraded") {
        message = "One or more service dependencies are degraded.";
      } else {
        message = scrubStringValue(exception.message || errorLabel);
      }

      const explicitCode =
        typeof resp.code === "string" && resp.code.trim().length > 0
          ? resp.code.trim().toUpperCase()
          : issues
            ? "VALIDATION_ERROR"
            : defaultErrorCodeForStatus(statusCode);

      const errorDescription =
        typeof resp.error_description === "string" &&
        resp.error_description.trim().length > 0
          ? scrubStringValue(resp.error_description)
          : undefined;

      return {
        statusCode,
        error:
          typeof resp.error === "string" && resp.error.trim().length > 0
            ? resp.error
            : errorLabel,
        code: explicitCode,
        message,
        ...(errorDescription ? { errorDescription } : {}),
        ...(issues ? { issues } : {}),
      };
    }

    return {
      statusCode,
      error: errorLabel,
      code: defaultErrorCodeForStatus(statusCode),
      message: scrubStringValue(exception.message || errorLabel),
    };
  }

  if (typeof exception === "object" && exception !== null) {
    const errObj = exception as {
      name?: unknown;
      code?: unknown;
      statusCode?: unknown;
      message?: unknown;
    };

    const errName = typeof errObj.name === "string" ? errObj.name : "";
    const errCode = typeof errObj.code === "string" ? errObj.code : "";

    if (
      errName === "PrismaClientKnownRequestError" ||
      /^P20\d{2}$/.test(errCode)
    ) {
      switch (errCode) {
        case "P2002":
          return {
            statusCode: HttpStatus.CONFLICT,
            error: "Conflict",
            code: "UNIQUE_CONSTRAINT_VIOLATION",
            message: "A record with the provided unique value already exists.",
          };
        case "P2025":
          return {
            statusCode: HttpStatus.NOT_FOUND,
            error: "Not Found",
            code: "RECORD_NOT_FOUND",
            message: "The requested record was not found.",
          };
        case "P2003":
          return {
            statusCode: HttpStatus.BAD_REQUEST,
            error: "Bad Request",
            code: "FOREIGN_KEY_VIOLATION",
            message: "Referenced related record does not exist or cannot be modified.",
          };
        case "P2014":
          return {
            statusCode: HttpStatus.BAD_REQUEST,
            error: "Bad Request",
            code: "RELATION_VIOLATION",
            message: "The requested change violates a required relation constraint.",
          };
        case "P2024":
          return {
            statusCode: HttpStatus.SERVICE_UNAVAILABLE,
            error: "Service Unavailable",
            code: "DATABASE_POOL_TIMEOUT",
            message: "Database connection pool timed out. Please retry shortly.",
          };
        default:
          return {
            statusCode: HttpStatus.BAD_REQUEST,
            error: "Bad Request",
            code: "DATABASE_REQUEST_ERROR",
            message: "The database rejected the request due to invalid data or state.",
          };
      }
    }

    if (errName === "PrismaClientValidationError") {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        error: "Bad Request",
        code: "VALIDATION_ERROR",
        message: "Invalid query or payload parameters.",
      };
    }

    if (
      typeof errObj.statusCode === "number" &&
      errObj.statusCode >= 400 &&
      errObj.statusCode < 600
    ) {
      const statusCode = errObj.statusCode;
      const errorLabel =
        STATUS_CODES[statusCode] ??
        (statusCode >= 500 ? "Internal Server Error" : "Bad Request");
      const rawMessage =
        typeof errObj.message === "string" && errObj.message.trim().length > 0
          ? scrubStringValue(errObj.message)
          : errorLabel;
      const normalizedCode =
        errCode && /^[A-Z0-9_]+$/.test(errCode)
          ? errCode
          : defaultErrorCodeForStatus(statusCode);
      return {
        statusCode,
        error: errorLabel,
        code: normalizedCode,
        message:
          statusCode >= 500 && !includeDebugDetails
            ? "An unexpected internal server error occurred."
            : rawMessage,
      };
    }
  }

  const rawMessage =
    exception instanceof Error && exception.message
      ? scrubStringValue(exception.message)
      : "An unexpected internal server error occurred.";

  return {
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    error: "Internal Server Error",
    code: "INTERNAL_SERVER_ERROR",
    message: includeDebugDetails
      ? rawMessage
      : "An unexpected internal server error occurred.",
  };
}

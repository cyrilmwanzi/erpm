export type KnownApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "VALIDATION_ERROR"
  | "RATE_LIMIT_EXCEEDED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_SERVER_ERROR"
  | "HTTP_ERROR"
  | "UNIQUE_CONSTRAINT_VIOLATION"
  | "RECORD_NOT_FOUND"
  | "FOREIGN_KEY_VIOLATION"
  | "RELATION_VIOLATION"
  | "DATABASE_POOL_TIMEOUT"
  | "DATABASE_REQUEST_ERROR"
  | "FEATURE_FLAG_DISABLED"
  | "NETWORK_ERROR"
  | "TIMEOUT_ERROR"
  | "PARSE_ERROR";

export type ApiErrorCode = KnownApiErrorCode | (string & {});

export interface ValidationIssue {
  code?: string;
  message: string;
  path?: Array<string | number>;
  [key: string]: unknown;
}

export interface ApiErrorEnvelopeBase {
  statusCode: number;
  error: string;
  code: ApiErrorCode;
  message: string;
  requestId: string | null;
  sentryEventId: string | null;
  timestamp: string;
  path: string;
  issues?: ValidationIssue[];
}

export interface ValidationErrorEnvelope extends ApiErrorEnvelopeBase {
  statusCode: 400 | 422;
  code: "VALIDATION_ERROR";
  issues: ValidationIssue[];
}

export interface UnauthorizedErrorEnvelope extends ApiErrorEnvelopeBase {
  statusCode: 401;
  code: "UNAUTHORIZED" | (string & {});
}

export interface ForbiddenErrorEnvelope extends ApiErrorEnvelopeBase {
  statusCode: 403;
  code: "FORBIDDEN" | "FEATURE_FLAG_DISABLED" | (string & {});
}

export interface NotFoundErrorEnvelope extends ApiErrorEnvelopeBase {
  statusCode: 404;
  code: "NOT_FOUND" | "RECORD_NOT_FOUND" | (string & {});
}

export interface ConflictErrorEnvelope extends ApiErrorEnvelopeBase {
  statusCode: 409;
  code: "CONFLICT" | "UNIQUE_CONSTRAINT_VIOLATION" | (string & {});
}

export interface RateLimitErrorEnvelope extends ApiErrorEnvelopeBase {
  statusCode: 429;
  code: "RATE_LIMIT_EXCEEDED" | (string & {});
}

export interface ServerErrorEnvelope extends ApiErrorEnvelopeBase {
  statusCode: 500 | 502 | 503 | 504;
}

export type StandardizedErrorEnvelope =
  | ValidationErrorEnvelope
  | UnauthorizedErrorEnvelope
  | ForbiddenErrorEnvelope
  | NotFoundErrorEnvelope
  | ConflictErrorEnvelope
  | RateLimitErrorEnvelope
  | ServerErrorEnvelope
  | ApiErrorEnvelopeBase;

export interface ScaceApiErrorOptions {
  envelope: StandardizedErrorEnvelope;
  headers?: Record<string, string>;
  rawBody?: unknown;
  cause?: unknown;
}

export class ScaceApiError extends Error {
  readonly statusCode: number;
  readonly error: string;
  readonly code: ApiErrorCode;
  readonly requestId: string | null;
  readonly sentryEventId: string | null;
  readonly timestamp: string;
  readonly path: string;
  readonly issues?: ValidationIssue[];
  readonly envelope: StandardizedErrorEnvelope;
  readonly headers: Record<string, string>;
  readonly rawBody?: unknown;

  constructor(options: ScaceApiErrorOptions) {
    const { envelope, headers = {}, rawBody, cause } = options;
    const suffixParts: string[] = [];
    if (envelope.requestId) {
      suffixParts.push(`requestId=${envelope.requestId}`);
    }
    if (envelope.sentryEventId) {
      suffixParts.push(`sentryEventId=${envelope.sentryEventId}`);
    }
    const suffix = suffixParts.length > 0 ? ` (${suffixParts.join(", ")})` : "";
    super(`[${envelope.statusCode} ${envelope.code}] ${envelope.message}${suffix}`, {
      cause,
    });

    this.name = "ScaceApiError";
    this.statusCode = envelope.statusCode;
    this.error = envelope.error;
    this.code = envelope.code;
    this.requestId = envelope.requestId;
    this.sentryEventId = envelope.sentryEventId;
    this.timestamp = envelope.timestamp;
    this.path = envelope.path;
    this.issues = envelope.issues;
    this.envelope = envelope;
    this.headers = headers;
    this.rawBody = rawBody;

    Object.setPrototypeOf(this, new.target.prototype);
  }

  isValidationError(): boolean {
    return this.code === "VALIDATION_ERROR" || Boolean(this.issues?.length);
  }

  isAuthError(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }

  isNotFound(): boolean {
    return this.statusCode === 404;
  }

  isConflict(): boolean {
    return this.statusCode === 409;
  }

  isServerError(): boolean {
    return this.statusCode >= 500;
  }

  toJSON(): StandardizedErrorEnvelope {
    return this.envelope;
  }
}

export function isScaceApiError(error: unknown): error is ScaceApiError {
  return (
    error instanceof ScaceApiError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "ScaceApiError" &&
      typeof (error as { statusCode?: unknown }).statusCode === "number")
  );
}

export type ScaceResult<T, E extends ScaceApiError = ScaceApiError> =
  | { ok: true; data: T }
  | { ok: false; error: E };

export async function toScaceResult<T>(
  promise: Promise<T>,
): Promise<ScaceResult<T>> {
  try {
    const data = await promise;
    return { ok: true, data };
  } catch (err) {
    if (isScaceApiError(err)) {
      return { ok: false, error: err };
    }
    const message =
      err instanceof Error ? err.message : "Unexpected client error.";
    return {
      ok: false,
      error: new ScaceApiError({
        envelope: {
          statusCode: 0,
          error: "Client Error",
          code: "NETWORK_ERROR",
          message,
          requestId: null,
          sentryEventId: null,
          timestamp: new Date().toISOString(),
          path: "",
        },
        cause: err,
      }),
    };
  }
}

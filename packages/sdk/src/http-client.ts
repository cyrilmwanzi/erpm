import {
  type ApiErrorCode,
  ScaceApiError,
  type StandardizedErrorEnvelope,
  type ValidationIssue,
} from "./errors.js";
import type {
  ScaceAuthConfig,
  ScaceClientConfig,
  SdkBinaryInput,
  SdkBinaryResponse,
  SdkRequestOptions,
} from "./types.js";

export type ResponseKind = "json" | "text" | "binary" | "redirect_or_json";

export interface HttpRequestSpec {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  multipart?: {
    file: SdkBinaryInput;
    filename?: string;
    mimeType?: string;
    fields?: Record<string, unknown>;
  };
  responseKind?: ResponseKind;
  options?: SdkRequestOptions;
  skipAuth?: boolean;
}

function createUuid(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  const hex = (n: number) =>
    Math.floor(Math.random() * Math.pow(16, n))
      .toString(16)
      .padStart(n, "0");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${((8 + Math.floor(Math.random() * 4)).toString(16))}${hex(3)}-${hex(12)}`;
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

function defaultCodeForStatus(statusCode: number): ApiErrorCode {
  switch (statusCode) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 422:
      return "VALIDATION_ERROR";
    case 429:
      return "RATE_LIMIT_EXCEEDED";
    case 503:
      return "SERVICE_UNAVAILABLE";
    default:
      return statusCode >= 500 ? "INTERNAL_SERVER_ERROR" : "HTTP_ERROR";
  }
}

function toBlobPart(input: SdkBinaryInput): BlobPart {
  if (input instanceof Blob) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return input;
  }
  const copy = new Uint8Array(input.byteLength);
  copy.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  return copy.buffer;
}

export class ScaceHttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly defaultCredentials?: RequestCredentials;
  private readonly defaultTimeoutMs?: number;
  private readonly onRequest?: ScaceClientConfig["onRequest"];
  private readonly onError?: ScaceClientConfig["onError"];
  private authConfig: ScaceAuthConfig;
  private organizationId?: string;

  private cachedOAuthToken: {
    accessToken: string;
    expiresAtMs: number;
  } | null = null;
  private inFlightOAuthPromise: Promise<string> | null = null;

  constructor(config: ScaceClientConfig) {
    if (!config?.baseUrl || config.baseUrl.trim().length === 0) {
      throw new Error("createScaceClient requires a non-empty baseUrl.");
    }
    const fetchFn = config.fetch ?? globalThis.fetch;
    if (typeof fetchFn !== "function") {
      throw new Error(
        "No fetch implementation available. Provide config.fetch or use Node 22+ / modern browser.",
      );
    }

    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchFn.bind(globalThis);
    this.authConfig = config.auth ?? { type: "cookie", credentials: "include" };
    this.organizationId = config.organizationId;
    this.defaultHeaders = { ...(config.headers ?? {}) };
    this.defaultCredentials = config.credentials;
    this.defaultTimeoutMs = config.timeoutMs;
    this.onRequest = config.onRequest;
    this.onError = config.onError;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getAuth(): ScaceAuthConfig {
    return this.authConfig;
  }

  setAuth(auth: ScaceAuthConfig): void {
    this.authConfig = auth;
    this.cachedOAuthToken = null;
    this.inFlightOAuthPromise = null;
  }

  setBearerToken(token: string): void {
    this.setAuth({ type: "bearer", token });
  }

  setPat(token: string): void {
    this.setAuth({ type: "pat", token });
  }

  clearAuth(): void {
    this.setAuth({ type: "none" });
  }

  getOrganizationId(): string | undefined {
    return this.organizationId;
  }

  setOrganizationId(organizationId: string | undefined): void {
    this.organizationId = organizationId;
  }

  buildUrl(path: string, query?: Record<string, unknown>): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);

    if (query) {
      for (const [key, rawValue] of Object.entries(query)) {
        if (rawValue === undefined) {
          continue;
        }
        if (rawValue === null) {
          url.searchParams.set(key, "");
          continue;
        }
        if (Array.isArray(rawValue)) {
          for (const item of rawValue) {
            if (item !== undefined && item !== null) {
              url.searchParams.append(key, String(item));
            }
          }
          continue;
        }
        url.searchParams.set(key, String(rawValue));
      }
    }

    return url.toString();
  }

  private async resolveAuthHeaders(skipAuth?: boolean): Promise<{
    headers: Record<string, string>;
    credentials?: RequestCredentials;
  }> {
    if (skipAuth) {
      return { headers: {} };
    }

    switch (this.authConfig.type) {
      case "none":
        return { headers: {} };
      case "pat":
      case "bearer":
        return {
          headers: { Authorization: `Bearer ${this.authConfig.token}` },
        };
      case "apiKey":
        return {
          headers: { "X-API-Key": this.authConfig.token },
        };
      case "cookie":
        return {
          headers: {},
          credentials: this.authConfig.credentials ?? "include",
        };
      case "custom":
        return {
          headers: await this.authConfig.getHeaders(),
        };
      case "oauth2ClientCredentials": {
        const token = await this.getOrFetchOAuth2ClientToken(this.authConfig);
        return {
          headers: { Authorization: `Bearer ${token}` },
        };
      }
    }
  }

  private async getOrFetchOAuth2ClientToken(
    config: Extract<ScaceAuthConfig, { type: "oauth2ClientCredentials" }>,
  ): Promise<string> {
    const now = Date.now();
    if (
      this.cachedOAuthToken &&
      this.cachedOAuthToken.expiresAtMs - 30_000 > now
    ) {
      return this.cachedOAuthToken.accessToken;
    }

    if (this.inFlightOAuthPromise) {
      return this.inFlightOAuthPromise;
    }

    this.inFlightOAuthPromise = (async () => {
      const endpoint = config.tokenEndpoint ?? "/api/v1/oauth/token";
      const response = await this.request<{
        access_token: string;
        expires_in?: number;
      }>({
        method: "POST",
        path: endpoint,
        skipAuth: true,
        body: {
          grant_type: "client_credentials",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          ...(config.scope ? { scope: config.scope } : {}),
        },
      });

      const expiresInMs = Math.max(60, response.expires_in ?? 900) * 1000;
      this.cachedOAuthToken = {
        accessToken: response.access_token,
        expiresAtMs: Date.now() + expiresInMs,
      };
      return response.access_token;
    })();

    try {
      return await this.inFlightOAuthPromise;
    } finally {
      this.inFlightOAuthPromise = null;
    }
  }

  private async emitError(error: ScaceApiError): Promise<never> {
    if (this.onError) {
      await this.onError(error);
    }
    throw error;
  }

  private async parseErrorResponse(
    res: Response,
    fallbackPath: string,
    fallbackRequestId: string,
  ): Promise<ScaceApiError> {
    const headers = normalizeHeaders(res.headers);
    const headerRequestId = headers["x-request-id"] ?? fallbackRequestId;
    const contentType = headers["content-type"] ?? "";
    let rawBody: unknown = null;

    try {
      if (contentType.includes("application/json")) {
        rawBody = await res.json();
      } else {
        const text = await res.text();
        if (text.trim().startsWith("{")) {
          rawBody = JSON.parse(text);
        } else {
          rawBody = text;
        }
      }
    } catch {
      rawBody = null;
    }

    if (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)) {
      const obj = rawBody as Record<string, unknown>;
      const statusCode =
        typeof obj.statusCode === "number" ? obj.statusCode : res.status;
      const code =
        typeof obj.code === "string" && obj.code.length > 0
          ? obj.code
          : typeof obj.error === "string" && /^[a-z0-9_]+$/i.test(obj.error)
            ? obj.error.toUpperCase()
            : defaultCodeForStatus(statusCode);
      const message =
        typeof obj.message === "string" && obj.message.length > 0
          ? obj.message
          : typeof obj.error_description === "string" &&
              obj.error_description.length > 0
            ? obj.error_description
            : res.statusText || "API request failed.";
      const envelope: StandardizedErrorEnvelope = {
        statusCode,
        error:
          typeof obj.error === "string" && obj.error.length > 0
            ? obj.error
            : res.statusText || "Error",
        code,
        message,
        requestId:
          typeof obj.requestId === "string" ? obj.requestId : headerRequestId,
        sentryEventId:
          typeof obj.sentryEventId === "string" ? obj.sentryEventId : null,
        timestamp:
          typeof obj.timestamp === "string"
            ? obj.timestamp
            : new Date().toISOString(),
        path: typeof obj.path === "string" ? obj.path : fallbackPath,
        ...(Array.isArray(obj.issues)
          ? { issues: obj.issues as ValidationIssue[] }
          : {}),
      };

      return new ScaceApiError({ envelope, headers, rawBody });
    }

    const fallbackEnvelope: StandardizedErrorEnvelope = {
      statusCode: res.status,
      error: res.statusText || "Error",
      code: defaultCodeForStatus(res.status),
      message:
        typeof rawBody === "string" && rawBody.trim().length > 0
          ? rawBody.trim().slice(0, 500)
          : res.statusText || `HTTP ${res.status}`,
      requestId: headerRequestId,
      sentryEventId: null,
      timestamp: new Date().toISOString(),
      path: fallbackPath,
    };

    return new ScaceApiError({
      envelope: fallbackEnvelope,
      headers,
      rawBody,
    });
  }

  async request<T>(spec: HttpRequestSpec): Promise<T> {
    const url = this.buildUrl(spec.path, spec.query);
    const parsedUrl = new URL(url);
    const requestId = spec.options?.requestId ?? createUuid();
    const { headers: authHeaders, credentials: authCredentials } =
      await this.resolveAuthHeaders(spec.skipAuth);

    const headers = new Headers();
    for (const [k, v] of Object.entries(this.defaultHeaders)) {
      headers.set(k, v);
    }
    for (const [k, v] of Object.entries(authHeaders)) {
      headers.set(k, v);
    }
    const orgId = spec.options?.organizationId ?? this.organizationId;
    if (orgId) {
      headers.set("X-Organization-Id", orgId);
    }
    headers.set("X-Request-Id", requestId);

    if (spec.options?.headers) {
      for (const [k, v] of Object.entries(spec.options.headers)) {
        headers.set(k, v);
      }
    }

    let bodyInit: BodyInit | undefined;
    if (spec.multipart) {
      const form = new FormData();
      const blob = new Blob([toBlobPart(spec.multipart.file)], {
        type: spec.multipart.mimeType || "application/octet-stream",
      });
      form.append("file", blob, spec.multipart.filename || "upload");
      if (spec.multipart.fields) {
        for (const [k, v] of Object.entries(spec.multipart.fields)) {
          if (v === undefined || v === null) {
            continue;
          }
          if (typeof v === "string") {
            form.append(k, v);
          } else {
            form.append(k, JSON.stringify(v));
          }
        }
      }
      bodyInit = form;
      headers.delete("Content-Type");
    } else if (spec.body !== undefined) {
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      bodyInit = JSON.stringify(spec.body);
    }

    const timeoutMs = spec.options?.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutController =
      timeoutMs && timeoutMs > 0 ? new AbortController() : null;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutController && timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timeoutController.abort(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    let combinedSignal: AbortSignal | undefined =
      spec.options?.signal ?? timeoutController?.signal;
    if (spec.options?.signal && timeoutController) {
      if (typeof AbortSignal.any === "function") {
        combinedSignal = AbortSignal.any([
          spec.options.signal,
          timeoutController.signal,
        ]);
      } else {
        const relay = new AbortController();
        const abortRelay = () => relay.abort();
        spec.options.signal.addEventListener("abort", abortRelay, { once: true });
        timeoutController.signal.addEventListener("abort", abortRelay, {
          once: true,
        });
        combinedSignal = relay.signal;
      }
    }

    if (this.onRequest) {
      await this.onRequest({ method: spec.method, url, requestId });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: spec.method,
        headers,
        body: bodyInit,
        signal: combinedSignal,
        credentials:
          spec.options?.credentials ??
          authCredentials ??
          this.defaultCredentials,
      });
    } catch (err) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      const isTimeout = Boolean(timeoutController?.signal.aborted);
      return this.emitError(
        new ScaceApiError({
          envelope: {
            statusCode: isTimeout ? 408 : 0,
            error: isTimeout ? "Request Timeout" : "Network Error",
            code: isTimeout ? "TIMEOUT_ERROR" : "NETWORK_ERROR",
            message:
              err instanceof Error
                ? err.message
                : "Network failure while calling Scace API.",
            requestId,
            sentryEventId: null,
            timestamp: new Date().toISOString(),
            path: parsedUrl.pathname,
          },
          cause: err,
        }),
      );
    }

    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      const apiError = await this.parseErrorResponse(
        response,
        parsedUrl.pathname,
        requestId,
      );
      return this.emitError(apiError);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const responseKind = spec.responseKind ?? "json";
    if (responseKind === "binary") {
      const ab = await response.arrayBuffer();
      const bytes = new Uint8Array(ab);
      const contentType = response.headers.get("content-type");
      const contentDisposition = response.headers.get("content-disposition");
      const etag = response.headers.get("etag");
      const payload: SdkBinaryResponse = {
        data: bytes,
        contentType,
        contentDisposition,
        etag,
        arrayBuffer: () => ab,
        blob: () =>
          new Blob([ab], {
            type: contentType ?? "application/octet-stream",
          }),
      };
      return payload as T;
    }

    if (responseKind === "text") {
      return (await response.text()) as T;
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("application/json") || contentType.includes("+json")) {
      const text = await response.text();
      if (!text) {
        return undefined as T;
      }
      return JSON.parse(text) as T;
    }

    if (responseKind === "redirect_or_json") {
      const text = await response.text();
      if (!text) {
        return undefined as T;
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    }

    const rawText = await response.text();
    if (!rawText) {
      return undefined as T;
    }
    try {
      return JSON.parse(rawText) as T;
    } catch {
      return rawText as T;
    }
  }
}

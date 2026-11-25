import type { ScaceApiError } from "./errors.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type SdkBinaryInput = Blob | ArrayBuffer | ArrayBufferView;

export interface SdkBinaryResponse {
  data: Uint8Array;
  contentType: string | null;
  contentDisposition: string | null;
  etag: string | null;
  arrayBuffer(): ArrayBuffer;
  blob(): Blob;
}

export interface SdkRequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  requestId?: string;
  organizationId?: string;
  timeoutMs?: number;
  credentials?: RequestCredentials;
}

export type ScaceAuthConfig =
  | { type: "none" }
  | { type: "pat"; token: string }
  | { type: "bearer"; token: string }
  | { type: "apiKey"; token: string }
  | { type: "cookie"; credentials?: RequestCredentials }
  | {
      type: "oauth2ClientCredentials";
      clientId: string;
      clientSecret: string;
      scope?: string;
      tokenEndpoint?: string;
    }
  | {
      type: "custom";
      getHeaders: () =>
        | Record<string, string>
        | Promise<Record<string, string>>;
    };

export interface ScaceRequestHookContext {
  method: string;
  url: string;
  requestId: string;
}

export interface ScaceClientConfig {
  baseUrl: string;
  auth?: ScaceAuthConfig;
  organizationId?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  credentials?: RequestCredentials;
  timeoutMs?: number;
  onRequest?: (context: ScaceRequestHookContext) => void | Promise<void>;
  onError?: (error: ScaceApiError) => void | Promise<void>;
}

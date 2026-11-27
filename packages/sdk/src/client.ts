import {
  type BetterAuthClientNamespace,
  createBetterAuthNamespace,
} from "./auth/better-auth.js";
import { toScaceResult } from "./errors.js";
import {
  type AuthNamespace,
  createGeneratedNamespaces,
  type GeneratedSdkNamespaces,
} from "./generated/namespaces.js";
import { ScaceHttpClient } from "./http-client.js";
import type { ScaceAuthConfig, ScaceClientConfig } from "./types.js";

export type ScaceAuthNamespace = BetterAuthClientNamespace & AuthNamespace;

export type ScaceSdk = Omit<GeneratedSdkNamespaces, "auth"> & {
  /** Unified authentication & identity suite (Better Auth + PATs + OAuth2 + Devices + SSO + Profile). */
  readonly auth: ScaceAuthNamespace;
  /** Underlying zero-dependency fetch transport client. */
  readonly http: ScaceHttpClient;
  /** Wrap any SDK call into a discriminated `{ ok: true; data } | { ok: false; error: ScaceApiError }` result. */
  readonly safe: typeof toScaceResult;
  /** Replace the active authentication configuration at runtime. */
  setAuth(auth: ScaceAuthConfig): void;
  /** Convenience helper to configure Bearer JWT or Better Auth session token. */
  setBearerToken(token: string): void;
  /** Convenience helper to configure a Personal Access Token (`scace_pat_*`). */
  setPat(token: string): void;
  /** Clear active auth credentials (`{ type: "none" }`). */
  clearAuth(): void;
  /** Set or clear the default `X-Organization-Id` header for organization-scoped requests. */
  setOrganizationId(organizationId: string | undefined): void;
};

export function createScaceClient(config: ScaceClientConfig): ScaceSdk {
  const http = new ScaceHttpClient(config);
  const generated = createGeneratedNamespaces(http);
  const betterAuth = createBetterAuthNamespace(http);

  const auth: ScaceAuthNamespace = {
    ...betterAuth,
    ...generated.auth,
  };

  const { auth: _generatedAuth, ...domainNamespaces } = generated;

  return {
    ...domainNamespaces,
    auth,
    http,
    safe: toScaceResult,
    setAuth: (nextAuth) => http.setAuth(nextAuth),
    setBearerToken: (token) => http.setBearerToken(token),
    setPat: (token) => http.setPat(token),
    clearAuth: () => http.clearAuth(),
    setOrganizationId: (organizationId) => http.setOrganizationId(organizationId),
  };
}

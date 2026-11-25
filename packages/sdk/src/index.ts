export { createScaceClient, type ScaceAuthNamespace, type ScaceSdk } from "./client.js";
export {
  ScaceHttpClient,
  type HttpRequestSpec,
  type ResponseKind,
} from "./http-client.js";
export {
  ScaceApiError,
  isScaceApiError,
  toScaceResult,
  type ApiErrorCode,
  type ApiErrorEnvelopeBase,
  type ConflictErrorEnvelope,
  type ForbiddenErrorEnvelope,
  type KnownApiErrorCode,
  type NotFoundErrorEnvelope,
  type RateLimitErrorEnvelope,
  type ScaceApiErrorOptions,
  type ScaceResult,
  type ServerErrorEnvelope,
  type StandardizedErrorEnvelope,
  type UnauthorizedErrorEnvelope,
  type ValidationErrorEnvelope,
  type ValidationIssue,
} from "./errors.js";
export type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ScaceAuthConfig,
  ScaceClientConfig,
  ScaceRequestHookContext,
  SdkBinaryInput,
  SdkBinaryResponse,
  SdkRequestOptions,
} from "./types.js";
export type {
  BetterAuthAuthResult,
  BetterAuthClientNamespace,
  BetterAuthOrganization,
  BetterAuthSessionRecord,
  BetterAuthSessionResponse,
  BetterAuthSignInEmailInput,
  BetterAuthSignUpInput,
  BetterAuthUser,
  CreateOrganizationInput,
  SetActiveOrganizationInput,
} from "./auth/better-auth.js";
export * from "./generated/index.js";

import type { ScaceHttpClient } from "../http-client.js";
import type { JsonValue, SdkRequestOptions } from "../types.js";

export interface BetterAuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BetterAuthSessionRecord {
  id: string;
  userId: string;
  token: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  activeOrganizationId?: string | null;
}

export interface BetterAuthSessionResponse {
  user: BetterAuthUser;
  session: BetterAuthSessionRecord;
}

export interface BetterAuthSignUpInput {
  name: string;
  email: string;
  password: string;
  image?: string;
  callbackURL?: string;
  rememberMe?: boolean;
}

export interface BetterAuthSignInEmailInput {
  email: string;
  password: string;
  rememberMe?: boolean;
  callbackURL?: string;
}

export interface BetterAuthAuthResult {
  redirect?: boolean;
  token?: string | null;
  url?: string;
  user: BetterAuthUser;
}

export interface BetterAuthOrganization {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
  metadata?: Record<string, unknown> | string | null;
  createdAt: string;
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
  logo?: string;
  metadata?: Record<string, JsonValue>;
  keepCurrentActiveOrganization?: boolean;
}

export interface SetActiveOrganizationInput {
  organizationId?: string | null;
  organizationSlug?: string;
}

export interface BetterAuthClientNamespace {
  /** Check Better Auth health (`/api/auth/ok`). */
  ok(options?: SdkRequestOptions): Promise<{ ok: boolean }>;

  /** Register a new user account with email and password. */
  signUpWithEmail(
    input: BetterAuthSignUpInput,
    options?: SdkRequestOptions & { autoApplyToken?: boolean },
  ): Promise<BetterAuthAuthResult>;

  /** Sign in with email and password. Optionally applies the returned bearer token automatically. */
  signInWithEmail(
    input: BetterAuthSignInEmailInput,
    options?: SdkRequestOptions & { autoApplyToken?: boolean },
  ): Promise<BetterAuthAuthResult>;

  /** Sign out the active Better Auth session. */
  signOut(options?: SdkRequestOptions): Promise<{ success: boolean }>;

  /** Get the currently authenticated user and session (`GET /api/auth/get-session`). */
  getSession(
    options?: SdkRequestOptions,
  ): Promise<BetterAuthSessionResponse | null>;

  /** Initiate social or enterprise OIDC sign-in (`POST /api/auth/sign-in/social`). */
  signInSocial(
    input: {
      provider: string;
      callbackURL?: string;
      errorCallbackURL?: string;
      newUserCallbackURL?: string;
      disableRedirect?: boolean;
      scopes?: string[];
    },
    options?: SdkRequestOptions,
  ): Promise<{ url?: string; redirect: boolean; token?: string; user?: BetterAuthUser }>;

  /** Change the authenticated user's password. */
  changePassword(
    input: {
      currentPassword: string;
      newPassword: string;
      revokeOtherSessions?: boolean;
    },
    options?: SdkRequestOptions,
  ): Promise<{ token?: string | null; user: BetterAuthUser }>;

  /** Trigger a password reset email. */
  requestPasswordReset(
    input: { email: string; redirectTo?: string },
    options?: SdkRequestOptions,
  ): Promise<{ status: boolean; message?: string }>;

  /** Complete password reset with a verification token. */
  resetPassword(
    input: { newPassword: string; token: string },
    options?: SdkRequestOptions,
  ): Promise<{ status: boolean }>;

  /** Send or resend an email verification link. */
  sendVerificationEmail(
    input: { email: string; callbackURL?: string },
    options?: SdkRequestOptions,
  ): Promise<{ status: boolean }>;

  /** Verify an email address using a verification token. */
  verifyEmail(
    query: { token: string; callbackURL?: string },
    options?: SdkRequestOptions,
  ): Promise<{ user: BetterAuthUser; status: boolean }>;

  /** Create a new Better Auth organization (`POST /api/auth/organization/create`). */
  createOrganization(
    input: CreateOrganizationInput,
    options?: SdkRequestOptions,
  ): Promise<BetterAuthOrganization>;

  /** Set the active organization on the current session (`POST /api/auth/organization/set-active`). */
  setActiveOrganization(
    input: SetActiveOrganizationInput,
    options?: SdkRequestOptions,
  ): Promise<BetterAuthOrganization | null>;

  /** List organizations the authenticated user belongs to (`GET /api/auth/organization/list`). */
  listOrganizations(options?: SdkRequestOptions): Promise<BetterAuthOrganization[]>;

  /** Fetch full organization details including members and invitations. */
  getFullOrganization(
    query?: {
      organizationId?: string;
      organizationSlug?: string;
      membersLimit?: number;
    },
    options?: SdkRequestOptions,
  ): Promise<BetterAuthOrganization & { members: unknown[]; invitations: unknown[] }>;

  /** Update an organization's name, slug, logo, or metadata. */
  updateOrganization(
    input: {
      organizationId?: string;
      data: {
        name?: string;
        slug?: string;
        logo?: string;
        metadata?: Record<string, JsonValue>;
      };
    },
    options?: SdkRequestOptions,
  ): Promise<BetterAuthOrganization>;

  /** Delete an organization by ID. */
  deleteOrganization(
    input: { organizationId: string },
    options?: SdkRequestOptions,
  ): Promise<BetterAuthOrganization | null>;

  /** Apply a bearer session token, PAT (`scace_pat_*`), or OAuth2 access token to future SDK calls. */
  useToken(token: string): void;

  /** Switch the SDK's default `X-Organization-Id` header context. */
  useOrganization(organizationId: string | undefined): void;
}

export function createBetterAuthNamespace(
  http: ScaceHttpClient,
): BetterAuthClientNamespace {
  return {
    ok: (options) =>
      http.request({
        method: "GET",
        path: "/api/auth/ok",
        skipAuth: true,
        options,
      }),

    signUpWithEmail: async (input, options) => {
      const result = await http.request<BetterAuthAuthResult>({
        method: "POST",
        path: "/api/auth/sign-up/email",
        body: input,
        skipAuth: true,
        options,
      });
      if (options?.autoApplyToken && result?.token) {
        http.setBearerToken(result.token);
      }
      return result;
    },

    signInWithEmail: async (input, options) => {
      const result = await http.request<BetterAuthAuthResult>({
        method: "POST",
        path: "/api/auth/sign-in/email",
        body: input,
        skipAuth: true,
        options,
      });
      if (options?.autoApplyToken && result?.token) {
        http.setBearerToken(result.token);
      }
      return result;
    },

    signOut: (options) =>
      http.request({
        method: "POST",
        path: "/api/auth/sign-out",
        body: {},
        options,
      }),

    getSession: (options) =>
      http.request({
        method: "GET",
        path: "/api/auth/get-session",
        options,
      }),

    signInSocial: (input, options) =>
      http.request({
        method: "POST",
        path: "/api/auth/sign-in/social",
        body: input,
        skipAuth: true,
        options,
      }),

    changePassword: (input, options) =>
      http.request({
        method: "POST",
        path: "/api/auth/change-password",
        body: input,
        options,
      }),

    requestPasswordReset: (input, options) =>
      http.request({
        method: "POST",
        path: "/api/auth/request-password-reset",
        body: input,
        skipAuth: true,
        options,
      }),

    resetPassword: (input, options) =>
      http.request({
        method: "POST",
        path: "/api/auth/reset-password",
        body: input,
        skipAuth: true,
        options,
      }),

    sendVerificationEmail: (input, options) =>
      http.request({
        method: "POST",
        path: "/api/auth/send-verification-email",
        body: input,
        skipAuth: true,
        options,
      }),

    verifyEmail: (query, options) =>
      http.request({
        method: "GET",
        path: "/api/auth/verify-email",
        query,
        skipAuth: true,
        options,
      }),

    createOrganization: (input, options) =>
      http.request({
        method: "POST",
        path: "/api/auth/organization/create",
        body: input,
        options,
      }),

    setActiveOrganization: async (input, options) => {
      const org = await http.request<BetterAuthOrganization | null>({
        method: "POST",
        path: "/api/auth/organization/set-active",
        body: input,
        options,
      });
      if (org?.id) {
        http.setOrganizationId(org.id);
      } else if (input.organizationId === null) {
        http.setOrganizationId(undefined);
      }
      return org;
    },

    listOrganizations: (options) =>
      http.request({
        method: "GET",
        path: "/api/auth/organization/list",
        options,
      }),

    getFullOrganization: (query, options) =>
      http.request({
        method: "GET",
        path: "/api/auth/organization/get-full-organization",
        query,
        options,
      }),

    updateOrganization: (input, options) =>
      http.request({
        method: "POST",
        path: "/api/auth/organization/update",
        body: input,
        options,
      }),

    deleteOrganization: (input, options) =>
      http.request({
        method: "POST",
        path: "/api/auth/organization/delete",
        body: input,
        options,
      }),

    useToken: (token) => {
      if (token.startsWith("scace_pat_")) {
        http.setPat(token);
      } else {
        http.setBearerToken(token);
      }
    },

    useOrganization: (organizationId) => {
      http.setOrganizationId(organizationId);
    },
  };
}

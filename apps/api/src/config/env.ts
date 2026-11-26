import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: resolve(process.cwd(), "../../.env") });
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://scace:scace_dev_password@localhost:5432/scace_db?schema=public"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  REDIS_KEY_PREFIX: z.string().default("scace:"),
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:3000,http://localhost:5173"),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z
    .string()
    .trim()
    .min(1)
    .default("Scace <onboarding@resend.dev>"),
  RUSTFS_ENDPOINT: z.string().url().default("http://localhost:9000"),
  RUSTFS_PUBLIC_ENDPOINT: z.string().url().optional(),
  RUSTFS_REGION: z.string().trim().min(1).default("us-east-1"),
  RUSTFS_ACCESS_KEY: z.string().optional(),
  RUSTFS_SECRET_KEY: z.string().optional(),
  RUSTFS_BUCKET_PREFIX: z
    .string()
    .trim()
    .min(2)
    .max(24)
    .regex(/^[a-z0-9-]+$/)
    .default("scace-org-"),
  STORAGE_DEFAULT_QUOTA_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1_073_741_824),
  STORAGE_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(104_857_600),
  STORAGE_PRESIGN_EXPIRES_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(900),
  CRM_ENCRYPTION_KEY: z.string().optional(),
  CRM_ALLOW_PRIVATE_URLS: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  CRM_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(10000),
  APP_URL: z.string().url().optional(),
  AUTH_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  OAUTH_ISSUER_URL: z.string().url().optional(),
  OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86400)
    .default(900),
  OAUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(31536000)
    .default(2592000),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_OAUTH_CLIENT_ID: z.string().optional(),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_OAUTH_TENANT_ID: z.string().default("common"),
  GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
  OIDC_SSO_CLIENT_ID: z.string().optional(),
  OIDC_SSO_CLIENT_SECRET: z.string().optional(),
  OIDC_SSO_ISSUER_URL: z.string().url().optional(),
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1.0),
  SENTRY_CAPTURE_4XX: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().url().default("https://us.i.posthog.com"),
  POSTHOG_PERSONAL_API_KEY: z.string().optional(),
  POSTHOG_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  PAYMENTS_ENCRYPTION_KEY: z.string().optional(),
  MPESA_PUBLIC_CALLBACK_BASE_URL: z.string().url().optional(),
  MPESA_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(15000),
  COMMUNICATION_WEBHOOK_ENCRYPTION_KEY: z.string().optional(),
  COMMUNICATION_ALLOW_PRIVATE_WEBHOOKS: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  COMMUNICATION_WEBHOOK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(30000)
    .default(10000),
  EXPIRY_SCANNER_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  REPORT_SCHEDULER_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  OUTBOX_DISPATCHER_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  SYSTEM_ADMIN_EMAILS: z.string().optional(),
  BILLING_DEFAULT_TRIAL_DAYS: z.coerce.number().int().min(0).max(365).default(14),
  BILLING_DEFAULT_GRACE_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  BILLING_AUTO_PROVISION_TRIAL: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  BILLING_ENFORCEMENT_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  BILLING_ENCRYPTION_KEY: z.string().optional(),
});

export type AppEnv = Omit<
  z.infer<typeof envSchema>,
  | "BETTER_AUTH_SECRET"
  | "CORS_ALLOWED_ORIGINS"
  | "RESEND_API_KEY"
  | "RUSTFS_ACCESS_KEY"
  | "RUSTFS_SECRET_KEY"
  | "RUSTFS_PUBLIC_ENDPOINT"
  | "CRM_ENCRYPTION_KEY"
  | "CRM_ALLOW_PRIVATE_URLS"
  | "APP_URL"
  | "AUTH_TOKEN_ENCRYPTION_KEY"
  | "OAUTH_ISSUER_URL"
  | "GOOGLE_OAUTH_CLIENT_ID"
  | "GOOGLE_OAUTH_CLIENT_SECRET"
  | "MICROSOFT_OAUTH_CLIENT_ID"
  | "MICROSOFT_OAUTH_CLIENT_SECRET"
  | "GITHUB_OAUTH_CLIENT_ID"
  | "GITHUB_OAUTH_CLIENT_SECRET"
  | "OIDC_SSO_CLIENT_ID"
  | "OIDC_SSO_CLIENT_SECRET"
  | "OIDC_SSO_ISSUER_URL"
  | "SENTRY_DSN"
  | "SENTRY_ENVIRONMENT"
  | "SENTRY_RELEASE"
  | "SENTRY_CAPTURE_4XX"
  | "POSTHOG_API_KEY"
  | "POSTHOG_PERSONAL_API_KEY"
  | "POSTHOG_ENABLED"
  | "PAYMENTS_ENCRYPTION_KEY"
  | "MPESA_PUBLIC_CALLBACK_BASE_URL"
  | "SYSTEM_ADMIN_EMAILS"
  | "BILLING_AUTO_PROVISION_TRIAL"
  | "BILLING_ENFORCEMENT_ENABLED"
  | "BILLING_ENCRYPTION_KEY"
> & {
  BETTER_AUTH_SECRET: string;
  CORS_ALLOWED_ORIGINS: string[];
  RESEND_API_KEY: string | null;
  RUSTFS_ACCESS_KEY: string | null;
  RUSTFS_SECRET_KEY: string | null;
  RUSTFS_PUBLIC_ENDPOINT: string;
  CRM_ENCRYPTION_KEY: string | null;
  CRM_ALLOW_PRIVATE_URLS: boolean;
  APP_URL: string;
  AUTH_TOKEN_ENCRYPTION_KEY: string | null;
  OAUTH_ISSUER_URL: string;
  GOOGLE_OAUTH_CLIENT_ID: string | null;
  GOOGLE_OAUTH_CLIENT_SECRET: string | null;
  MICROSOFT_OAUTH_CLIENT_ID: string | null;
  MICROSOFT_OAUTH_CLIENT_SECRET: string | null;
  GITHUB_OAUTH_CLIENT_ID: string | null;
  GITHUB_OAUTH_CLIENT_SECRET: string | null;
  OIDC_SSO_CLIENT_ID: string | null;
  OIDC_SSO_CLIENT_SECRET: string | null;
  OIDC_SSO_ISSUER_URL: string | null;
  SENTRY_DSN: string | null;
  SENTRY_ENVIRONMENT: string;
  SENTRY_RELEASE: string | null;
  SENTRY_CAPTURE_4XX: boolean;
  POSTHOG_API_KEY: string | null;
  POSTHOG_PERSONAL_API_KEY: string | null;
  POSTHOG_ENABLED: boolean;
  PAYMENTS_ENCRYPTION_KEY: string | null;
  MPESA_PUBLIC_CALLBACK_BASE_URL: string;
  SYSTEM_ADMIN_EMAILS: string[];
  BILLING_AUTO_PROVISION_TRIAL: boolean;
  BILLING_ENFORCEMENT_ENABLED: boolean;
  BILLING_ENCRYPTION_KEY: string | null;
};

let cachedEnv: AppEnv | null = null;
const ephemeralDevSecret = randomBytes(32).toString("hex");

function trimOptional(val: string | undefined): string | null {
  return val && val.trim().length > 0 ? val.trim() : null;
}

export function getEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const parsed = envSchema.parse(process.env);
  const nginxPort = process.env.NGINX_PORT ? Number(process.env.NGINX_PORT) : undefined;
  const resolvedPort =
    nginxPort && parsed.PORT === nginxPort
      ? Number(process.env.DEFAULT_APP_PORT || 3000)
      : parsed.PORT;

  if (
    parsed.NODE_ENV === "production" &&
    (!parsed.BETTER_AUTH_SECRET || parsed.BETTER_AUTH_SECRET.length < 32)
  ) {
    console.warn(
      "[AI Studio] BETTER_AUTH_SECRET not configured (>=32 chars) — using ephemeral fallback secret.",
    );
  }

  const resendApiKey = trimOptional(parsed.RESEND_API_KEY);

  if (parsed.NODE_ENV === "production" && !resendApiKey) {
    console.warn(
      "[AI Studio] RESEND_API_KEY not configured — email delivery will log to console fallback.",
    );
  }

  const rustfsAccessKey = trimOptional(parsed.RUSTFS_ACCESS_KEY);
  const rustfsSecretKey = trimOptional(parsed.RUSTFS_SECRET_KEY);

  const allowedOrigins = parsed.CORS_ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0 && origin !== "*");

  const crmEncryptionKey = trimOptional(parsed.CRM_ENCRYPTION_KEY);
  const appUrl = (trimOptional(parsed.APP_URL) ?? parsed.BETTER_AUTH_URL).replace(/\/+$/, "");
  const oauthIssuerUrl = (trimOptional(parsed.OAUTH_ISSUER_URL) ?? appUrl).replace(/\/+$/, "");

  cachedEnv = {
    ...parsed,
    PORT: resolvedPort,
    HOST: "0.0.0.0",
    BETTER_AUTH_SECRET:
      parsed.BETTER_AUTH_SECRET && parsed.BETTER_AUTH_SECRET.length > 0
        ? parsed.BETTER_AUTH_SECRET
        : ephemeralDevSecret,
    CORS_ALLOWED_ORIGINS: allowedOrigins,
    RESEND_API_KEY: resendApiKey,
    RUSTFS_ACCESS_KEY: rustfsAccessKey,
    RUSTFS_SECRET_KEY: rustfsSecretKey,
    RUSTFS_PUBLIC_ENDPOINT: parsed.RUSTFS_PUBLIC_ENDPOINT ?? parsed.RUSTFS_ENDPOINT,
    CRM_ENCRYPTION_KEY: crmEncryptionKey,
    CRM_ALLOW_PRIVATE_URLS: parsed.CRM_ALLOW_PRIVATE_URLS ?? false,
    APP_URL: appUrl,
    AUTH_TOKEN_ENCRYPTION_KEY: trimOptional(parsed.AUTH_TOKEN_ENCRYPTION_KEY),
    OAUTH_ISSUER_URL: oauthIssuerUrl,
    GOOGLE_OAUTH_CLIENT_ID: trimOptional(parsed.GOOGLE_OAUTH_CLIENT_ID),
    GOOGLE_OAUTH_CLIENT_SECRET: trimOptional(parsed.GOOGLE_OAUTH_CLIENT_SECRET),
    MICROSOFT_OAUTH_CLIENT_ID: trimOptional(parsed.MICROSOFT_OAUTH_CLIENT_ID),
    MICROSOFT_OAUTH_CLIENT_SECRET: trimOptional(parsed.MICROSOFT_OAUTH_CLIENT_SECRET),
    GITHUB_OAUTH_CLIENT_ID: trimOptional(parsed.GITHUB_OAUTH_CLIENT_ID),
    GITHUB_OAUTH_CLIENT_SECRET: trimOptional(parsed.GITHUB_OAUTH_CLIENT_SECRET),
    OIDC_SSO_CLIENT_ID: trimOptional(parsed.OIDC_SSO_CLIENT_ID),
    OIDC_SSO_CLIENT_SECRET: trimOptional(parsed.OIDC_SSO_CLIENT_SECRET),
    OIDC_SSO_ISSUER_URL: trimOptional(parsed.OIDC_SSO_ISSUER_URL),
    SENTRY_DSN: trimOptional(parsed.SENTRY_DSN),
    SENTRY_ENVIRONMENT:
      trimOptional(parsed.SENTRY_ENVIRONMENT) ?? parsed.NODE_ENV,
    SENTRY_RELEASE: trimOptional(parsed.SENTRY_RELEASE),
    SENTRY_CAPTURE_4XX: parsed.SENTRY_CAPTURE_4XX ?? true,
    POSTHOG_API_KEY: trimOptional(parsed.POSTHOG_API_KEY),
    POSTHOG_HOST: parsed.POSTHOG_HOST.replace(/\/+$/, ""),
    POSTHOG_PERSONAL_API_KEY: trimOptional(parsed.POSTHOG_PERSONAL_API_KEY),
    POSTHOG_ENABLED:
      (parsed.POSTHOG_ENABLED ?? true) &&
      trimOptional(parsed.POSTHOG_API_KEY) !== null,
    PAYMENTS_ENCRYPTION_KEY: trimOptional(parsed.PAYMENTS_ENCRYPTION_KEY),
    MPESA_PUBLIC_CALLBACK_BASE_URL: (
      trimOptional(parsed.MPESA_PUBLIC_CALLBACK_BASE_URL) ?? appUrl
    ).replace(/\/+$/, ""),
    MPESA_REQUEST_TIMEOUT_MS: parsed.MPESA_REQUEST_TIMEOUT_MS,
    SYSTEM_ADMIN_EMAILS: (parsed.SYSTEM_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
    BILLING_DEFAULT_TRIAL_DAYS: parsed.BILLING_DEFAULT_TRIAL_DAYS,
    BILLING_DEFAULT_GRACE_DAYS: parsed.BILLING_DEFAULT_GRACE_DAYS,
    BILLING_AUTO_PROVISION_TRIAL: parsed.BILLING_AUTO_PROVISION_TRIAL ?? true,
    BILLING_ENFORCEMENT_ENABLED: parsed.BILLING_ENFORCEMENT_ENABLED ?? true,
    BILLING_ENCRYPTION_KEY: trimOptional(parsed.BILLING_ENCRYPTION_KEY),
  };

  return cachedEnv;
}

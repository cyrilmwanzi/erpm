import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { getEnv, type AppEnv } from "../config/env.js";

function deriveBillingCipherKey(env: AppEnv): Buffer {
  const material =
    env.BILLING_ENCRYPTION_KEY ??
    env.PAYMENTS_ENCRYPTION_KEY ??
    `scace-billing:${env.BETTER_AUTH_SECRET}`;
  return createHash("sha256").update(material).digest();
}

export function encryptBillingSecret(plaintext: string): string {
  const env = getEnv();
  const key = deriveBillingCipherKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("scace-billing-v1", "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptBillingSecret(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unsupported billing secret ciphertext format.");
  }
  const [, ivHex, tagHex, dataHex] = parts;
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error("Malformed billing secret ciphertext.");
  }
  const env = getEnv();
  const key = deriveBillingCipherKey(env);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAAD(Buffer.from("scace-billing-v1", "utf8"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function maskBillingSecretTail(
  raw: string | null | undefined,
  visibleChars = 4,
): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length <= visibleChars) {
    return "****";
  }
  return `****${trimmed.slice(-visibleChars)}`;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function addBillingCycleDuration(
  date: Date,
  billingCycle: "MONTHLY" | "ANNUAL",
): Date {
  const next = new Date(date.getTime());
  if (billingCycle === "ANNUAL") {
    next.setUTCFullYear(next.getUTCFullYear() + 1);
  } else {
    next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return next;
}

export function computeBillingInvoiceAmounts(params: {
  baseAmountCents: number;
  discountPercent?: number | null;
  taxRateBps?: number | null;
}): {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
} {
  const subtotalCents = Math.max(0, Math.round(params.baseAmountCents));
  const clampedDiscountPct = Math.min(
    100,
    Math.max(0, Math.round(params.discountPercent ?? 0)),
  );
  const discountCents = Math.round((subtotalCents * clampedDiscountPct) / 100);
  const taxableCents = Math.max(0, subtotalCents - discountCents);
  const clampedTaxBps = Math.max(0, Math.round(params.taxRateBps ?? 0));
  const taxCents = Math.round((taxableCents * clampedTaxBps) / 10_000);
  const totalCents = taxableCents + taxCents;

  return {
    subtotalCents,
    discountCents,
    taxCents,
    totalCents,
  };
}

export function normalizeFeaturesMap(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

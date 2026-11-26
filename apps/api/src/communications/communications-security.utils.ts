import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { BadRequestException } from "@nestjs/common";
import { getEnv, type AppEnv } from "../config/env.js";

function deriveCommunicationCipherKey(env: AppEnv): Buffer {
  const material =
    env.COMMUNICATION_WEBHOOK_ENCRYPTION_KEY ??
    `scace-comm:${env.BETTER_AUTH_SECRET}`;
  return createHash("sha256").update(material).digest();
}

export function encryptCommunicationSecret(plaintext: string): string {
  const env = getEnv();
  const key = deriveCommunicationCipherKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("scace-comm-v1", "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptCommunicationSecret(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unsupported communication secret ciphertext format.");
  }
  const [, ivHex, tagHex, dataHex] = parts;
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error("Malformed communication secret ciphertext.");
  }
  const env = getEnv();
  const key = deriveCommunicationCipherKey(env);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAAD(Buffer.from("scace-comm-v1", "utf8"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function generateWebhookSigningSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

export function maskSecretTail(raw: string | null | undefined): string {
  if (!raw) {
    return "****";
  }
  const trimmed = raw.trim();
  if (trimmed.length <= 4) {
    return "****";
  }
  return `****${trimmed.slice(-4)}`;
}

export function signWebhookPayload(
  secret: string,
  timestampSec: number,
  bodyString: string,
): string {
  const signedContent = `${timestampSec}.${bodyString}`;
  const digest = createHmac("sha256", secret)
    .update(signedContent, "utf8")
    .digest("hex");
  return `t=${timestampSec},v1=${digest}`;
}

function ipv4ToInt(ip: string): number {
  return (
    ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0
  );
}

export function isBlockedIpAddress(
  ip: string,
  allowPrivateUrls: boolean,
): { blocked: boolean; reason?: string } {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mappedV4 = normalized.startsWith("::ffff:")
    ? normalized.slice(7)
    : normalized;

  const version = isIP(mappedV4);
  if (version === 4) {
    const n = ipv4ToInt(mappedV4);
    const inRange = (cidrBase: string, bits: number) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(cidrBase) & mask);
    };

    if (inRange("169.254.0.0", 16) || inRange("0.0.0.0", 8)) {
      return {
        blocked: true,
        reason: "Link-local and cloud metadata IP addresses are forbidden.",
      };
    }

    if (!allowPrivateUrls) {
      if (
        inRange("127.0.0.0", 8) ||
        inRange("10.0.0.0", 8) ||
        inRange("172.16.0.0", 12) ||
        inRange("192.168.0.0", 16) ||
        inRange("100.64.0.0", 10)
      ) {
        return {
          blocked: true,
          reason: "Loopback and private network IP addresses are not allowed.",
        };
      }
    }
    return { blocked: false };
  }

  if (version === 6) {
    if (
      normalized === "::" ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    ) {
      return {
        blocked: true,
        reason: "Link-local IPv6 addresses are forbidden.",
      };
    }
    if (!allowPrivateUrls) {
      if (
        normalized === "::1" ||
        normalized.startsWith("fc") ||
        normalized.startsWith("fd")
      ) {
        return {
          blocked: true,
          reason: "Loopback and private IPv6 addresses are not allowed.",
        };
      }
    }
    return { blocked: false };
  }

  return { blocked: false };
}

export function validateWebhookDestinationUrl(
  rawUrl: string,
  allowPrivateUrls: boolean,
  isProduction: boolean,
): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new BadRequestException("Webhook URL must be a valid URL.");
  }

  if (parsed.username || parsed.password) {
    throw new BadRequestException(
      "Webhook URL must not contain embedded credentials.",
    );
  }
  if (parsed.hash) {
    throw new BadRequestException("Webhook URL must not contain URL fragments.");
  }

  const protocol = parsed.protocol.toLowerCase();
  if (isProduction && !allowPrivateUrls) {
    if (protocol !== "https:") {
      throw new BadRequestException(
        "Webhook URL must use https:// in production.",
      );
    }
  } else if (protocol !== "https:" && protocol !== "http:") {
    throw new BadRequestException(
      "Webhook URL must use http:// or https://.",
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !allowPrivateUrls &&
    (hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal"))
  ) {
    throw new BadRequestException(
      "Localhost and internal domain names are not allowed for webhook URLs.",
    );
  }

  if (isIP(hostname)) {
    const check = isBlockedIpAddress(hostname, allowPrivateUrls);
    if (check.blocked) {
      throw new BadRequestException(
        check.reason ?? "Webhook IP address is forbidden.",
      );
    }
  }

  return parsed.toString();
}

export async function assertSafeResolvedWebhookHost(
  rawUrl: string,
  allowPrivateUrls: boolean,
): Promise<void> {
  const parsed = new URL(rawUrl);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (isIP(hostname)) {
    const check = isBlockedIpAddress(hostname, allowPrivateUrls);
    if (check.blocked) {
      throw new BadRequestException(
        check.reason ?? "Resolved webhook IP address is forbidden.",
      );
    }
    return;
  }

  const records = await lookup(hostname, { all: true });
  for (const rec of records) {
    const check = isBlockedIpAddress(rec.address, allowPrivateUrls);
    if (check.blocked) {
      throw new BadRequestException(
        check.reason ??
          `Resolved IP address (${rec.address}) is forbidden for outbound webhooks.`,
      );
    }
  }
}

export function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface TelemetryProjectKeyRecord {
  keyHash: string;
  keyPrefix: string;
  keySuffix: string;
}

export function generateProjectKey(): string {
  return `proj_${randomBytes(18).toString("base64url")}`;
}

export function hashProjectKey(projectKey: string): string {
  return createHash("sha256").update(projectKey.trim(), "utf8").digest("hex");
}

export function createProjectKeyRecord(projectKey: string): TelemetryProjectKeyRecord {
  const trimmed = projectKey.trim();
  return {
    keyHash: hashProjectKey(trimmed),
    keyPrefix: trimmed.slice(0, Math.min(8, trimmed.length)),
    keySuffix: trimmed.slice(Math.max(0, trimmed.length - 4))
  };
}

export function projectKeyPreview(prefix: string, suffix: string): string {
  return `${prefix}...${suffix}`;
}

export function signSessionValue(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("base64url");
}

export function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

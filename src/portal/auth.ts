import { randomBytes } from "node:crypto";
import { constantTimeEquals, signSessionValue } from "../telemetry/project-key.js";

const SESSION_COOKIE_NAME = "telemetry_portal_session";
const SESSION_SUBJECT = "telemetry-admin";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

export interface PortalSession {
  expiresAtMs: number;
}

export function portalSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

export function createPortalSession(secret: string, nowMs = Date.now()): { value: string; session: PortalSession } {
  const expiresAtMs = nowMs + SESSION_TTL_MS;
  const nonce = randomBytes(8).toString("hex");
  const payload = `${SESSION_SUBJECT}|${expiresAtMs}|${nonce}`;
  const signature = signSessionValue(payload, secret);
  return {
    value: `${payload}|${signature}`,
    session: { expiresAtMs }
  };
}

export function verifyPortalSession(rawCookieValue: string | null | undefined, secret: string, nowMs = Date.now()): PortalSession | null {
  if (!rawCookieValue) {
    return null;
  }
  const parts = rawCookieValue.split("|");
  if (parts.length !== 4) {
    return null;
  }
  const [subject, expiresAtRaw, nonce, signature] = parts;
  if (subject !== SESSION_SUBJECT || !expiresAtRaw || !nonce || !signature) {
    return null;
  }
  const payload = `${subject}|${expiresAtRaw}|${nonce}`;
  const expectedSignature = signSessionValue(payload, secret);
  if (!constantTimeEquals(signature, expectedSignature)) {
    return null;
  }
  const expiresAtMs = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return null;
  }
  return { expiresAtMs };
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }
  const parsed: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey?.trim();
    if (!key) {
      continue;
    }
    parsed[key] = rest.join("=").trim();
  }
  return parsed;
}

export function buildSessionCookie(value: string): string {
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax`;
}

export function buildClearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

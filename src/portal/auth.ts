import { createHash, randomBytes } from "node:crypto";
import { constantTimeEquals, signSessionValue } from "../telemetry/project-key.js";

const SESSION_COOKIE_NAME = "telemetry_portal_session";
const OAUTH_STATE_COOKIE_NAME = "telemetry_portal_oauth_state";
const SESSION_SUBJECT = "telemetry-user";
const OAUTH_STATE_SUBJECT = "telemetry-oauth-state";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const OAUTH_STATE_TTL_MS = 1000 * 60 * 10;

export interface PortalSession {
  discordUserId: string;
  username: string;
  avatarHash: string | null;
  csrfToken: string;
  expiresAtMs: number;
}

export function portalSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

export function oauthStateCookieName(): string {
  return OAUTH_STATE_COOKIE_NAME;
}

export function createPortalSession(input: {
  discordUserId: string;
  username: string;
  avatarHash?: string | null;
  secret: string;
  nowMs?: number;
}): { value: string; session: PortalSession } {
  const nowMs = input.nowMs ?? Date.now();
  const expiresAtMs = nowMs + SESSION_TTL_MS;
  const csrfToken = randomToken(18);
  const payloadParts = [
    SESSION_SUBJECT,
    input.discordUserId,
    base64url(input.username),
    input.avatarHash ? base64url(input.avatarHash) : "-",
    csrfToken,
    String(expiresAtMs)
  ];
  const payload = payloadParts.join("|");
  const signature = signSessionValue(payload, input.secret);
  return {
    value: `${payload}|${signature}`,
    session: {
      discordUserId: input.discordUserId,
      username: input.username,
      avatarHash: input.avatarHash ?? null,
      csrfToken,
      expiresAtMs
    }
  };
}

export function verifyPortalSession(rawCookieValue: string | null | undefined, secret: string, nowMs = Date.now()): PortalSession | null {
  if (!rawCookieValue) {
    return null;
  }
  const parts = rawCookieValue.split("|");
  if (parts.length !== 7) {
    return null;
  }
  const [subject, discordUserId, encodedUsername, encodedAvatarHash, csrfToken, expiresAtRaw, signature] = parts;
  if (!subject || !discordUserId || !encodedUsername || !csrfToken || !expiresAtRaw || !signature) {
    return null;
  }
  if (subject !== SESSION_SUBJECT) {
    return null;
  }
  const payload = parts.slice(0, 6).join("|");
  const expectedSignature = signSessionValue(payload, secret);
  if (!constantTimeEquals(signature, expectedSignature)) {
    return null;
  }
  const expiresAtMs = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return null;
  }
  return {
    discordUserId,
    username: decodeBase64url(encodedUsername),
    avatarHash: !encodedAvatarHash || encodedAvatarHash === "-" ? null : decodeBase64url(encodedAvatarHash),
    csrfToken,
    expiresAtMs
  };
}

export function createOAuthState(secret: string, nowMs = Date.now()): { value: string; nonce: string } {
  const expiresAtMs = nowMs + OAUTH_STATE_TTL_MS;
  const nonce = randomToken(18);
  const payload = `${OAUTH_STATE_SUBJECT}|${nonce}|${expiresAtMs}`;
  const signature = signSessionValue(payload, secret);
  return {
    value: `${payload}|${signature}`,
    nonce
  };
}

export function verifyOAuthState(rawCookieValue: string | null | undefined, providedState: string | null | undefined, secret: string, nowMs = Date.now()): boolean {
  if (!rawCookieValue || !providedState) {
    return false;
  }
  const parts = rawCookieValue.split("|");
  if (parts.length !== 4) {
    return false;
  }
  const [subject, nonce, expiresAtRaw, signature] = parts;
  if (subject !== OAUTH_STATE_SUBJECT || !nonce || !expiresAtRaw || !signature) {
    return false;
  }
  const payload = `${subject}|${nonce}|${expiresAtRaw}`;
  const expectedSignature = signSessionValue(payload, secret);
  if (!constantTimeEquals(signature, expectedSignature)) {
    return false;
  }
  const expiresAtMs = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return false;
  }
  return constantTimeEquals(providedState, nonce);
}

export function buildSessionCookie(value: string, options: { secure: boolean; path: string }): string {
  return `${SESSION_COOKIE_NAME}=${value}; Path=${options.path}; HttpOnly; SameSite=Lax${options.secure ? "; Secure" : ""}`;
}

export function buildClearedSessionCookie(options: { secure: boolean; path: string }): string {
  return `${SESSION_COOKIE_NAME}=; Path=${options.path}; HttpOnly; SameSite=Lax; Max-Age=0${options.secure ? "; Secure" : ""}`;
}

export function buildOAuthStateCookie(value: string, options: { secure: boolean; path: string }): string {
  return `${OAUTH_STATE_COOKIE_NAME}=${value}; Path=${options.path}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(OAUTH_STATE_TTL_MS / 1000)}${options.secure ? "; Secure" : ""}`;
}

export function buildClearedOAuthStateCookie(options: { secure: boolean; path: string }): string {
  return `${OAUTH_STATE_COOKIE_NAME}=; Path=${options.path}; HttpOnly; SameSite=Lax; Max-Age=0${options.secure ? "; Secure" : ""}`;
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

export function buildCsrfHiddenInput(session: PortalSession): string {
  return `<input type="hidden" name="csrfToken" value="${escapeHtmlAttribute(session.csrfToken)}" />`;
}

export function verifyCsrfToken(session: PortalSession | null, submittedToken: string | null | undefined): boolean {
  if (!session || !submittedToken) {
    return false;
  }
  return constantTimeEquals(session.csrfToken, submittedToken);
}

export function buildOAuthAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", "identify guilds");
  url.searchParams.set("state", params.state);
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function exchangeDiscordCode(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<{ accessToken: string }> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri
  });
  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) {
    throw new Error(`Discord token exchange failed with status ${response.status}`);
  }
  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Discord token exchange response did not include an access token.");
  }
  return { accessToken: json.access_token };
}

export async function fetchDiscordIdentity(accessToken: string): Promise<{ discordUserId: string; username: string; avatarHash: string | null }> {
  const response = await fetch("https://discord.com/api/users/@me", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`Discord identity fetch failed with status ${response.status}`);
  }
  const json = (await response.json()) as { id?: string; username?: string; avatar?: string | null };
  if (!json.id || !json.username) {
    throw new Error("Discord identity response was missing required fields.");
  }
  return {
    discordUserId: json.id,
    username: json.username,
    avatarHash: json.avatar ?? null
  };
}

export function splitCsvList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

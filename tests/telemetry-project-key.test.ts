import { describe, expect, it } from "vitest";
import {
  createProjectKeyRecord,
  generateProjectKey,
  projectKeyPreview,
  signSessionValue
} from "../src/telemetry/project-key.js";
import {
  buildSessionCookie,
  createPortalSession,
  parseCookieHeader,
  verifyPortalSession
} from "../src/portal/auth.js";

describe("telemetry project key helpers", () => {
  it("generates distinct project keys with stable previews and hashes", () => {
    const key = generateProjectKey();
    expect(key.startsWith("proj_")).toBe(true);

    const record = createProjectKeyRecord(key);
    expect(record.keyHash).toHaveLength(64);
    expect(projectKeyPreview(record.keyPrefix, record.keySuffix)).toContain("...");
  });

  it("creates verifiable portal sessions", () => {
    const secret = signSessionValue("seed", "secret");
    const session = createPortalSession({
      discordUserId: "1234567890",
      username: "Alechilles",
      secret,
      nowMs: 1_000
    });
    const cookie = buildSessionCookie(session.value, { secure: false, path: "/portal" });
    const parsed = parseCookieHeader(cookie);

    expect(verifyPortalSession(parsed.telemetry_portal_session, secret, 1_001)).not.toBeNull();
    expect(verifyPortalSession(parsed.telemetry_portal_session, secret, session.session.expiresAtMs + 1)).toBeNull();
  });
});

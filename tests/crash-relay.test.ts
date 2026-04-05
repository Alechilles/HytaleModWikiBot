import { describe, expect, it } from "vitest";
import { crashRelayInternals } from "../src/telemetry/crash-relay.js";

describe("CrashTelemetryRelay internals", () => {
  it("normalizes configured relay paths", () => {
    expect(crashRelayInternals.normalizeRelayPath("/tamework/crash-report")).toBe("/tamework/crash-report");
    expect(crashRelayInternals.normalizeRelayPath("tamework/crash-report")).toBe("/tamework/crash-report");
    expect(crashRelayInternals.normalizeRelayPath("   ")).toBe("/tamework/crash-report");
  });

  it("extracts URL pathnames safely", () => {
    expect(crashRelayInternals.extractPathname("/tamework/crash-report?x=1")).toBe("/tamework/crash-report");
    expect(crashRelayInternals.extractPathname(undefined)).toBe("/");
  });

  it("builds a Discord-friendly crash message", () => {
    const envelope = {
      reportId: "abc123",
      source: "uncaught_exception",
      fingerprint: "deadbeef",
      capturedAtUtc: "2026-04-05T20:00:00Z",
      pluginIdentifier: "Alechilles:Alec's Tamework!",
      pluginVersion: "2.7.3",
      threadName: "WorldThread",
      worldName: "TempleTest",
      worldRemovalReason: "EXCEPTIONAL",
      throwable: {
        type: "java.lang.IllegalStateException",
        message: "Unexpected state",
        stack: [
          "com.alechilles.alecstamework.SomeClass.method(SomeClass.java:42)",
          "com.hypixel.hytale.server.core.universe.world.World.tick(World.java:451)"
        ]
      }
    };

    const rawJson = JSON.stringify(envelope);
    const message = crashRelayInternals.buildCrashRelayMessage(envelope, rawJson, {
      mentionRoleId: "1234",
      includeJsonAttachment: true,
      stackLines: 2
    });

    expect(message.content).toContain("Tamework crash report received");
    expect(message.content).toContain("`deadbeef`");
    expect(message.content).toContain("```txt");
    expect(message.attachmentName).toBe("tamework-crash-deadbeef.json");
    expect(message.attachmentJson).toBe(rawJson);
  });

  it("authorizes bearer and x-api-key headers", () => {
    const expected = "secret-token";

    const bearerAuthorized = crashRelayInternals.isAuthorized(
      {
        headers: { authorization: "Bearer secret-token" }
      } as any,
      expected
    );
    expect(bearerAuthorized).toBe(true);

    const apiKeyAuthorized = crashRelayInternals.isAuthorized(
      {
        headers: { "x-api-key": "secret-token" }
      } as any,
      expected
    );
    expect(apiKeyAuthorized).toBe(true);

    const denied = crashRelayInternals.isAuthorized(
      {
        headers: { authorization: "Bearer wrong" }
      } as any,
      expected
    );
    expect(denied).toBe(false);
  });
});

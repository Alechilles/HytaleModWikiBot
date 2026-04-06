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

  it("accepts full Tamework crash payloads with extra fields", () => {
    const payload = {
      schemaVersion: 1,
      reportId: "abc123",
      source: "uncaught_exception",
      fingerprint: "deadbeef",
      capturedAtUtc: "2026-04-05T20:00:00Z",
      pluginIdentifier: "Alechilles:Alec's Tamework!",
      pluginVersion: "2.7.3",
      threadName: "WorldThread",
      worldName: "TempleTest",
      worldRemovalReason: "EXCEPTIONAL",
      worldFailurePluginIdentifier: "Alechilles:Alec's Tamework!",
      attribution: {
        identifiedPlugin: "Alechilles:Alec's Tamework!",
        matchedPluginIdentifier: true,
        matchedStackPrefix: true
      },
      throwable: {
        type: "java.lang.IllegalStateException",
        message: "Unexpected state",
        stack: [
          "com.alechilles.alecstamework.SomeClass.method(SomeClass.java:42)",
          "com.hypixel.hytale.server.core.universe.world.World.tick(World.java:451)"
        ],
        causes: [
          {
            type: "java.lang.RuntimeException",
            message: "inner",
            stack: ["com.alechilles.alecstamework.Inner.run(Inner.java:7)"]
          }
        ]
      },
      runtime: {
        javaVersion: "21",
        runtimeVersion: "21.0.6+8",
        osName: "Linux",
        osVersion: "6.12",
        osArch: "amd64"
      }
    };

    const result = crashRelayInternals.crashReportSchema.safeParse(payload);
    expect(result.success).toBe(true);
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

  it("parses CSV blocklists and normalizes IPs", () => {
    const entries = crashRelayInternals.parseCsvSet(" 192.168.1.10,::FFFF:10.0.0.1 ,, DeadBeef ");
    expect(entries.has("192.168.1.10")).toBe(true);
    expect(entries.has("::ffff:10.0.0.1")).toBe(true);
    expect(entries.has("deadbeef")).toBe(true);

    expect(crashRelayInternals.normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
  });

  it("derives stable fingerprint when explicit fingerprint is missing", () => {
    const fingerprintFromField = crashRelayInternals.deriveFingerprint({
      fingerprint: "Dead Beef!!"
    } as any);
    expect(fingerprintFromField).toBe("deadbeef");

    const derivedOne = crashRelayInternals.deriveFingerprint({
      pluginIdentifier: "Alechilles:Alec's Tamework!",
      throwable: {
        type: "java.lang.IllegalStateException",
        message: "Unexpected state",
        stack: ["Foo.bar(Foo.java:42)"]
      }
    } as any);
    const derivedTwo = crashRelayInternals.deriveFingerprint({
      pluginIdentifier: "Alechilles:Alec's Tamework!",
      throwable: {
        type: "java.lang.IllegalStateException",
        message: "Unexpected state",
        stack: ["Foo.bar(Foo.java:42)"]
      }
    } as any);

    expect(derivedOne).toHaveLength(16);
    expect(derivedOne).toBe(derivedTwo);
  });

  it("enforces windowed rate limits", () => {
    const counters = new Map<string, { count: number; resetAtMs: number }>();
    const now = 1_000;

    const first = crashRelayInternals.takeWindowedRateLimit(counters, "ip:1.2.3.4", 2, 60, now);
    const second = crashRelayInternals.takeWindowedRateLimit(counters, "ip:1.2.3.4", 2, 60, now + 1);
    const third = crashRelayInternals.takeWindowedRateLimit(counters, "ip:1.2.3.4", 2, 60, now + 2);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThan(0);
  });
});

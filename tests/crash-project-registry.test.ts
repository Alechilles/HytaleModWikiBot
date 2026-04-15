import { describe, expect, it } from "vitest";
import { CrashRelayProjectRegistry } from "../src/telemetry/crash-project-registry.js";

describe("CrashRelayProjectRegistry", () => {
  it("indexes projects by public project key", () => {
    const registry = CrashRelayProjectRegistry.fromProjects([
      {
        projectId: "alecs-tamework",
        displayName: "Alec's Tamework!",
        publicProjectKey: "pub_tamework",
        enabled: true,
        rateLimitPerMinute: 60,
        maxPayloadBytes: 262_144,
        fingerprintCooldownSeconds: 300,
        attachJson: true,
        stackLines: 8,
        discord: {
          channelId: "123",
          guildId: "456"
        }
      }
    ]);

    const project = registry.findByProjectKey("pub_tamework");
    expect(project?.projectId).toBe("alecs-tamework");
    expect(registry.enabledProjectCount()).toBe(1);
  });

  it("rejects duplicate public project keys", () => {
    expect(() =>
      CrashRelayProjectRegistry.fromProjects([
        {
          projectId: "one",
          displayName: "One",
          publicProjectKey: "dup",
          enabled: true,
          rateLimitPerMinute: 60,
          maxPayloadBytes: 262_144,
          fingerprintCooldownSeconds: 300,
          attachJson: true,
          stackLines: 8,
          discord: { channelId: "1" }
        },
        {
          projectId: "two",
          displayName: "Two",
          publicProjectKey: "dup",
          enabled: true,
          rateLimitPerMinute: 60,
          maxPayloadBytes: 262_144,
          fingerprintCooldownSeconds: 300,
          attachJson: true,
          stackLines: 8,
          discord: { channelId: "2" }
        }
      ])
    ).toThrow(/Duplicate crash relay publicProjectKey/);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildFingerprintThreadName,
  buildThreadOpenerMessage,
  isCrashAlertPayload,
  telemetryAlertJobPayloadSchema
} from "../src/telemetry/alert-job.js";

describe("telemetry alert delivery helpers", () => {
  it("validates alert job payloads", () => {
    const payload = telemetryAlertJobPayloadSchema.parse({
      version: 1,
      destination: { channelId: "123", mentionRoleId: "456" },
      project: { projectId: "alecs-tamework", displayName: "Alec's Tamework!" },
      crash: { reportId: "rep-1", fingerprint: "deadbeef", throwableType: "java.lang.IllegalStateException" },
      discordMessage: { content: "Crash report received.", attachmentJson: "{}", attachmentName: "report.json" }
    });

    expect(payload.project.projectId).toBe("alecs-tamework");
    expect(payload.discordMessage.attachmentName).toBe("report.json");
    expect(isCrashAlertPayload(payload)).toBe(true);
  });

  it("validates manual report alert job payloads", () => {
    const payload = telemetryAlertJobPayloadSchema.parse({
      version: 1,
      destination: { channelId: "123", mentionRoleId: null },
      project: { projectId: "alecs-tamework", displayName: "Alec's Tamework!" },
      manualReport: { reportId: "manual-1", reportKind: "suggestion", title: "Add a config toggle" },
      discordMessage: { content: "Manual report received.", attachmentJson: "{}", attachmentName: "report.json" }
    });

    expect(payload.manualReport?.reportKind).toBe("suggestion");
    expect(isCrashAlertPayload(payload)).toBe(false);
  });

  it("rejects alert job payloads without alert details", () => {
    expect(() =>
      telemetryAlertJobPayloadSchema.parse({
        version: 1,
        destination: { channelId: "123" },
        project: { projectId: "alecs-tamework", displayName: "Alec's Tamework!" },
        discordMessage: { content: "Alert received." }
      })
    ).toThrow("Expected crash or manual report alert details.");
  });

  it("builds bounded fingerprint thread names", () => {
    const name = buildFingerprintThreadName(
      "DEAD-BEEF_1234567890",
      "java.lang.IllegalStateException: Unexpected world thread state",
      "alecs-tamework"
    );

    expect(name).toContain("crash-");
    expect(name).toContain("alecs-tamework");
    expect(name.length).toBeLessThanOrEqual(100);
  });

  it("builds thread opener content from a job payload", () => {
    const payload = telemetryAlertJobPayloadSchema.parse({
      version: 1,
      destination: { channelId: "123" },
      project: { projectId: "alecs-tamework", displayName: "Alec's Tamework!" },
      crash: { reportId: "rep-1", fingerprint: "deadbeef", throwableType: "java.lang.IllegalStateException" },
      discordMessage: { content: "Crash report received." }
    });
    if (!isCrashAlertPayload(payload)) {
      throw new Error("Expected crash alert payload.");
    }

    const content = buildThreadOpenerMessage(payload);

    expect(content).toContain("Crash fingerprint thread created.");
    expect(content).toContain("`deadbeef`");
  });
});

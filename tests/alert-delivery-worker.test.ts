import { describe, expect, it } from "vitest";
import {
  buildFingerprintThreadName,
  buildThreadOpenerMessage,
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
    const content = buildThreadOpenerMessage(
      telemetryAlertJobPayloadSchema.parse({
        version: 1,
        destination: { channelId: "123" },
        project: { projectId: "alecs-tamework", displayName: "Alec's Tamework!" },
        crash: { reportId: "rep-1", fingerprint: "deadbeef", throwableType: "java.lang.IllegalStateException" },
        discordMessage: { content: "Crash report received." }
      })
    );

    expect(content).toContain("Crash fingerprint thread created.");
    expect(content).toContain("`deadbeef`");
  });
});

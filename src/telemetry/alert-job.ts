import { z } from "zod";

export const telemetryAlertJobPayloadSchema = z.object({
  version: z.literal(1),
  destination: z.object({
    channelId: z.string().trim().min(1),
    mentionRoleId: z.string().trim().min(1).nullable().optional()
  }),
  project: z.object({
    projectId: z.string().trim().min(1),
    displayName: z.string().trim().min(1)
  }),
  crash: z.object({
    reportId: z.string().trim().min(1),
    fingerprint: z.string().trim().min(1),
    throwableType: z.string().trim().min(1)
  }),
  discordMessage: z.object({
    content: z.string().min(1),
    attachmentJson: z.string().min(1).optional(),
    attachmentName: z.string().min(1).optional()
  })
});

export type TelemetryAlertJobPayload = z.infer<typeof telemetryAlertJobPayloadSchema>;

export function buildFingerprintThreadName(fingerprint: string, throwableType: string, projectId: string): string {
  const projectToken = safeThreadToken(projectId).slice(0, 24) || "project";
  const fingerprintToken = safeFileToken(fingerprint.toLowerCase()).slice(0, 32) || "unknown";
  const throwableToken = safeThreadToken(throwableType).slice(0, 60);
  const prefix = `crash-${projectToken}-${fingerprintToken}`;
  const baseName = throwableToken ? `${prefix}-${throwableToken}` : prefix;
  return truncate(baseName, 100);
}

export function buildThreadOpenerMessage(payload: TelemetryAlertJobPayload): string {
  return [
    "Crash fingerprint thread created.",
    `project: \`${safeInline(payload.project.displayName)}\``,
    `fingerprint: \`${safeInline(payload.crash.fingerprint)}\``,
    `throwable: \`${safeInline(payload.crash.throwableType)}\``
  ].join("\n");
}

function safeInline(value: string): string {
  return value.replace(/`/g, "'");
}

function safeFileToken(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "");
  return normalized.length > 0 ? normalized : "unknown";
}

function safeThreadToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

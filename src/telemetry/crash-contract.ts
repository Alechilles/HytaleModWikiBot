import { z } from "zod";

const crashBreadcrumbSchema = z
  .object({
    atUtc: z.string().trim().min(1).max(80).optional(),
    category: z.string().trim().min(1).max(120).optional(),
    detail: z.string().trim().min(1).max(2_000).optional()
  })
  .passthrough();

const crashCauseSchema = z
  .object({
    type: z.string().trim().min(1).max(240).optional(),
    message: z.string().trim().min(1).max(2_000).optional(),
    stack: z.array(z.string().max(1_000)).max(200).optional()
  })
  .passthrough();

const crashThrowableSchema = z
  .object({
    type: z.string().trim().min(1).max(240).optional(),
    message: z.string().trim().min(1).max(2_000).optional(),
    stack: z.array(z.string().max(1_000)).max(200).optional(),
    causes: z.array(crashCauseSchema).max(20).optional()
  })
  .passthrough()
  .optional();

export const crashReportSchema = z
  .object({
    schemaVersion: z.number().int().positive().optional(),
    eventType: z.string().trim().min(1).max(80).optional(),
    reportId: z.string().trim().min(1).max(200).optional(),
    projectId: z.string().trim().min(1).max(200).optional(),
    projectDisplayName: z.string().trim().min(1).max(240).optional(),
    source: z.string().trim().min(1).max(120).optional(),
    fingerprint: z.string().trim().min(1).max(200).optional(),
    capturedAtUtc: z.string().trim().min(1).max(80).optional(),
    lastCapturedAtUtc: z.string().trim().min(1).max(80).optional(),
    occurrenceCount: z.number().int().positive().max(1_000_000).optional(),
    pluginIdentifier: z.string().trim().min(1).max(200).optional(),
    pluginVersion: z.string().trim().min(1).max(120).optional(),
    threadName: z.string().trim().min(1).max(200).optional(),
    worldName: z.string().trim().min(1).max(200).nullable().optional(),
    worldRemovalReason: z.string().trim().min(1).max(200).nullable().optional(),
    worldFailurePluginIdentifier: z.string().trim().min(1).max(200).nullable().optional(),
    attribution: z.record(z.string(), z.unknown()).optional(),
    breadcrumbs: z.array(crashBreadcrumbSchema).max(100).optional(),
    throwable: crashThrowableSchema,
    runtime: z.record(z.string(), z.unknown()).optional()
  })
  .passthrough()
  .refine(
    (value) =>
      Boolean(
        value.fingerprint ||
          value.throwable?.type ||
          value.throwable?.message ||
          (value.throwable?.stack != null && value.throwable.stack.length > 0)
      ),
    { message: "missing-crash-identifiers" }
  );

export type CrashReportEnvelope = z.infer<typeof crashReportSchema>;

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { WikiBot } from "../discord/bot.js";
import type { CrashThreadRepository } from "../db/repositories/crash-thread-repo.js";
import { shortHash } from "../utils.js";

const GLOBAL_LIMIT_KEY = "__global__";

const crashThrowableSchema = z
  .object({
    type: z.string().trim().min(1).max(240).optional(),
    message: z.string().trim().min(1).max(2_000).optional(),
    stack: z.array(z.string().max(1_000)).max(200).optional()
  })
  .passthrough()
  .optional();

const crashReportSchema = z
  .object({
    reportId: z.string().trim().min(1).max(200).optional(),
    source: z.string().trim().min(1).max(120).optional(),
    fingerprint: z.string().trim().min(1).max(200).optional(),
    capturedAtUtc: z.string().trim().min(1).max(80).optional(),
    pluginIdentifier: z.string().trim().min(1).max(200).optional(),
    pluginVersion: z.string().trim().min(1).max(120).optional(),
    threadName: z.string().trim().min(1).max(200).optional(),
    worldName: z.string().trim().min(1).max(200).nullable().optional(),
    worldRemovalReason: z.string().trim().min(1).max(200).nullable().optional(),
    worldFailurePluginIdentifier: z.string().trim().min(1).max(200).nullable().optional(),
    throwable: crashThrowableSchema
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

type CrashReportEnvelope = z.infer<typeof crashReportSchema>;

interface CrashRelayDependencies {
  config: AppConfig;
  logger: Logger;
  bot: WikiBot;
  crashThreadRepo: CrashThreadRepository;
}

interface CrashRelayMessage {
  content: string;
  attachmentJson?: string;
  attachmentName?: string;
}

interface WindowCounterState {
  count: number;
  resetAtMs: number;
}

interface FingerprintState {
  fingerprint: string;
  pluginIdentifier: string;
  throwableType: string;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  suppressUntilMs: number;
  suppressedCount: number;
}

interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec: number;
}

class PayloadTooLargeError extends Error {}

export class CrashTelemetryRelay {
  private server: Server | null = null;
  private summaryTimer: NodeJS.Timeout | null = null;
  private flushInProgress = false;
  private readonly path: string;
  private readonly blockedIps: Set<string>;
  private readonly blockedFingerprints: Set<string>;
  private readonly ipRateLimits = new Map<string, WindowCounterState>();
  private readonly globalRateLimits = new Map<string, WindowCounterState>();
  private readonly fingerprintStates = new Map<string, FingerprintState>();
  private readonly fingerprintCooldownMs: number;
  private readonly summaryIntervalMs: number;

  public constructor(private readonly deps: CrashRelayDependencies) {
    this.path = normalizeRelayPath(this.deps.config.CRASH_RELAY_PATH);
    this.blockedIps = parseCsvSet(this.deps.config.CRASH_RELAY_BLOCKED_IPS);
    this.blockedFingerprints = parseCsvSet(this.deps.config.CRASH_RELAY_BLOCKED_FINGERPRINTS);
    this.fingerprintCooldownMs = this.deps.config.CRASH_RELAY_FINGERPRINT_COOLDOWN_SECONDS * 1_000;
    this.summaryIntervalMs = this.deps.config.CRASH_RELAY_SUMMARY_INTERVAL_SECONDS * 1_000;
  }

  public async start(): Promise<void> {
    if (!this.deps.config.CRASH_RELAY_ENABLED) {
      return;
    }

    if (this.server) {
      return;
    }

    if (!this.deps.config.CRASH_RELAY_DISCORD_CHANNEL_ID) {
      throw new Error("CRASH_RELAY_DISCORD_CHANNEL_ID is required when CRASH_RELAY_ENABLED=true");
    }

    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error("Crash relay server was not created."));
        return;
      }

      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };

      const onListening = () => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.deps.config.CRASH_RELAY_PORT, this.deps.config.CRASH_RELAY_BIND_HOST);
    });

    this.summaryTimer = setInterval(() => {
      void this.flushSuppressedSummaries();
    }, this.summaryIntervalMs);
    this.summaryTimer.unref();

    this.deps.logger.info(
      {
        host: this.deps.config.CRASH_RELAY_BIND_HOST,
        port: this.deps.config.CRASH_RELAY_PORT,
        path: this.path,
        channelId: this.deps.config.CRASH_RELAY_DISCORD_CHANNEL_ID,
        authTokenConfigured: Boolean(this.deps.config.CRASH_RELAY_AUTH_TOKEN),
        blockedIpCount: this.blockedIps.size,
        blockedFingerprintCount: this.blockedFingerprints.size
      },
      "Crash telemetry relay started"
    );
  }

  public async stop(): Promise<void> {
    const active = this.server;
    this.server = null;

    if (this.summaryTimer) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
    }

    if (!active) {
      return;
    }

    await new Promise<void>((resolve) => {
      active.close(() => resolve());
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method?.toUpperCase() ?? "";
    const requestPath = extractPathname(request.url);

    if (requestPath !== this.path) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }

    if (method === "GET") {
      writeJson(response, 200, { ok: true });
      return;
    }

    if (method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return;
    }

    if (!isAuthorized(request, this.deps.config.CRASH_RELAY_AUTH_TOKEN)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const normalizedIp = normalizeIp(request.socket.remoteAddress);
    if (this.blockedIps.has(normalizedIp)) {
      writeJson(response, 403, { error: "blocked_ip" });
      return;
    }

    const globalDecision = takeWindowedRateLimit(
      this.globalRateLimits,
      GLOBAL_LIMIT_KEY,
      this.deps.config.CRASH_RELAY_GLOBAL_RATE_LIMIT_MAX,
      this.deps.config.CRASH_RELAY_GLOBAL_RATE_LIMIT_WINDOW_SECONDS,
      Date.now()
    );
    if (!globalDecision.allowed) {
      this.deps.logger.warn(
        { scope: "global", retryAfterSec: globalDecision.retryAfterSec },
        "Crash telemetry request rate-limited"
      );
      writeRateLimited(response, globalDecision.retryAfterSec, "global");
      return;
    }

    const ipDecision = takeWindowedRateLimit(
      this.ipRateLimits,
      normalizedIp,
      this.deps.config.CRASH_RELAY_IP_RATE_LIMIT_MAX,
      this.deps.config.CRASH_RELAY_IP_RATE_LIMIT_WINDOW_SECONDS,
      Date.now()
    );
    if (!ipDecision.allowed) {
      this.deps.logger.warn(
        { scope: "ip", ip: normalizedIp, retryAfterSec: ipDecision.retryAfterSec },
        "Crash telemetry request rate-limited"
      );
      writeRateLimited(response, ipDecision.retryAfterSec, "ip");
      return;
    }

    try {
      const rawBody = await readBody(request, this.deps.config.CRASH_RELAY_MAX_BODY_BYTES);
      const parsedUnknown = JSON.parse(rawBody) as unknown;
      const parseResult = crashReportSchema.safeParse(parsedUnknown);
      if (!parseResult.success) {
        writeJson(response, 422, {
          error: "invalid_payload",
          details: parseResult.error.issues.map((issue) => issue.message).slice(0, 3)
        });
        return;
      }

      const parsed = parseResult.data;
      const fingerprint = deriveFingerprint(parsed);

      if (this.blockedFingerprints.has(fingerprint.toLowerCase())) {
        writeJson(response, 403, { error: "blocked_fingerprint" });
        return;
      }

      const duplicateDecision = this.registerFingerprintObservation(fingerprint, parsed, Date.now());
      if (!duplicateDecision.shouldPostNow) {
        writeJson(response, 202, {
          ok: true,
          suppressed: true,
          fingerprint
        });
        return;
      }

      const channelId = this.deps.config.CRASH_RELAY_DISCORD_CHANNEL_ID;
      if (!channelId) {
        throw new Error("CRASH_RELAY_DISCORD_CHANNEL_ID is required when CRASH_RELAY_ENABLED=true");
      }

      const message = buildCrashRelayMessage({ ...parsed, fingerprint }, rawBody, {
        includeJsonAttachment: this.deps.config.CRASH_RELAY_ATTACH_JSON,
        stackLines: this.deps.config.CRASH_RELAY_STACK_LINES,
        ...(this.deps.config.CRASH_RELAY_MENTION_ROLE_ID
          ? { mentionRoleId: this.deps.config.CRASH_RELAY_MENTION_ROLE_ID }
          : {})
      });

      await this.postToFingerprintThread({
        channelId,
        fingerprint,
        throwableType: fallback(parsed.throwable?.type, "unknown"),
        message
      });

      writeJson(response, 202, { ok: true, fingerprint });
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        writeJson(response, 413, { error: "payload_too_large" });
        return;
      }

      if (error instanceof SyntaxError) {
        writeJson(response, 400, { error: "invalid_json" });
        return;
      }

      this.deps.logger.error(
        {
          err: error,
          path: requestPath,
          remoteAddress: request.socket.remoteAddress
        },
        "Failed to process incoming crash telemetry report"
      );
      writeJson(response, 500, { error: "relay_failed" });
    }
  }

  private async postToFingerprintThread(params: {
    channelId: string;
    fingerprint: string;
    throwableType: string;
    message: CrashRelayMessage;
  }): Promise<void> {
    const destination = await this.resolveOrCreateFingerprintThreadId({
      channelId: params.channelId,
      fingerprint: params.fingerprint,
      throwableType: params.throwableType
    });

    const sent = await this.tryPostMessageToThread(destination.threadId, params.message, {
      fingerprint: params.fingerprint,
      scope: destination.created ? "new" : "existing"
    });
    if (sent) {
      return;
    }

    const replacementThreadId = await this.createAndPersistFingerprintThread({
      channelId: params.channelId,
      fingerprint: params.fingerprint,
      throwableType: params.throwableType,
      reasonSuffix: `replace ${destination.threadId}`
    });

    await this.deps.bot.sendMessageToThread(
      params.message.attachmentJson
        ? {
            threadId: replacementThreadId,
            content: params.message.content,
            attachmentJson: params.message.attachmentJson,
            attachmentName: params.message.attachmentName ?? "tamework-crash-report.json"
          }
        : {
            threadId: replacementThreadId,
            content: params.message.content
          }
    );
  }

  private async tryPostMessageToThread(
    threadId: string,
    message: CrashRelayMessage,
    context: { fingerprint: string; scope: "existing" | "new" }
  ): Promise<boolean> {
    try {
      await this.deps.bot.sendMessageToThread(
        message.attachmentJson
          ? {
              threadId,
              content: message.content,
              attachmentJson: message.attachmentJson,
              attachmentName: message.attachmentName ?? "tamework-crash-report.json"
            }
          : {
              threadId,
              content: message.content
            }
      );
      return true;
    } catch (error) {
      this.deps.logger.warn(
        {
          err: error,
          scope: context.scope,
          threadId,
          fingerprint: context.fingerprint
        },
        "Failed to post crash relay message to fingerprint thread"
      );
      return false;
    }
  }

  private async resolveOrCreateFingerprintThreadId(params: {
    channelId: string;
    fingerprint: string;
    throwableType: string;
  }): Promise<{ threadId: string; created: boolean }> {
    const mappedThreadId = await this.deps.crashThreadRepo.getThreadId(params.channelId, params.fingerprint);
    if (mappedThreadId) {
      return { threadId: mappedThreadId, created: false };
    }

    const threadId = await this.createAndPersistFingerprintThread({
      channelId: params.channelId,
      fingerprint: params.fingerprint,
      throwableType: params.throwableType,
      reasonSuffix: "new"
    });

    return { threadId, created: true };
  }

  private async createAndPersistFingerprintThread(params: {
    channelId: string;
    fingerprint: string;
    throwableType: string;
    reasonSuffix: string;
  }): Promise<string> {
    const threadName = buildFingerprintThreadName(params.fingerprint, params.throwableType);
    const openerContent = buildThreadOpenerMessage(params.fingerprint, params.throwableType);
    const created = await this.deps.bot.createCrashThread({
      channelId: params.channelId,
      threadName,
      openerContent
    });

    await this.deps.crashThreadRepo.upsertThreadId(params.channelId, params.fingerprint, created.threadId);
    this.deps.logger.info(
      {
        channelId: params.channelId,
        threadId: created.threadId,
        fingerprint: params.fingerprint,
        reason: params.reasonSuffix
      },
      "Upserted crash fingerprint thread mapping"
    );
    return created.threadId;
  }

  private registerFingerprintObservation(
    fingerprint: string,
    envelope: CrashReportEnvelope,
    nowMs: number
  ): { shouldPostNow: boolean } {
    const existing = this.fingerprintStates.get(fingerprint);
    if (!existing || nowMs >= existing.suppressUntilMs) {
      if (existing && existing.suppressedCount > 0) {
        void this.postSuppressedSummary(existing);
      }

      this.fingerprintStates.set(fingerprint, {
        fingerprint,
        pluginIdentifier: fallback(envelope.pluginIdentifier, "unknown"),
        throwableType: fallback(envelope.throwable?.type, "unknown"),
        firstSeenAtMs: nowMs,
        lastSeenAtMs: nowMs,
        suppressUntilMs: nowMs + this.fingerprintCooldownMs,
        suppressedCount: 0
      });

      return { shouldPostNow: true };
    }

    existing.lastSeenAtMs = nowMs;
    existing.suppressedCount += 1;
    return { shouldPostNow: false };
  }

  private async flushSuppressedSummaries(): Promise<void> {
    if (this.flushInProgress || !this.deps.config.CRASH_RELAY_ENABLED) {
      return;
    }

    this.flushInProgress = true;
    try {
      const nowMs = Date.now();
      for (const [fingerprint, state] of this.fingerprintStates.entries()) {
        if (nowMs < state.suppressUntilMs) {
          continue;
        }

        if (state.suppressedCount === 0) {
          this.fingerprintStates.delete(fingerprint);
          continue;
        }

        const sent = await this.postSuppressedSummary(state);
        if (sent) {
          this.fingerprintStates.delete(fingerprint);
        } else {
          state.suppressUntilMs = nowMs + this.summaryIntervalMs;
        }
      }
    } catch (error) {
      this.deps.logger.error({ err: error }, "Crash relay summary flush failed");
    } finally {
      this.flushInProgress = false;
    }
  }

  private async postSuppressedSummary(state: FingerprintState): Promise<boolean> {
    const channelId = this.deps.config.CRASH_RELAY_DISCORD_CHANNEL_ID;
    if (!channelId) {
      return false;
    }

    const cooldownSeconds = this.deps.config.CRASH_RELAY_FINGERPRINT_COOLDOWN_SECONDS;
    const content =
      `Suppressed ${state.suppressedCount} duplicate crash reports in the last ${cooldownSeconds}s.\n` +
      `fingerprint: \`${safeInline(state.fingerprint)}\`\n` +
      `plugin: \`${safeInline(state.pluginIdentifier)}\`\n` +
      `throwable: \`${safeInline(state.throwableType)}\``;

    try {
      await this.postToFingerprintThread({
        channelId,
        fingerprint: state.fingerprint,
        throwableType: state.throwableType,
        message: { content }
      });
      this.deps.logger.info(
        {
          fingerprint: state.fingerprint,
          suppressedCount: state.suppressedCount,
          firstSeenAt: new Date(state.firstSeenAtMs).toISOString(),
          lastSeenAt: new Date(state.lastSeenAtMs).toISOString()
        },
        "Posted crash relay duplicate summary"
      );
      return true;
    } catch (error) {
      this.deps.logger.warn(
        { err: error, fingerprint: state.fingerprint, suppressedCount: state.suppressedCount },
        "Failed to post crash relay duplicate summary"
      );
      return false;
    }
  }
}

function buildFingerprintThreadName(fingerprint: string, throwableType: string): string {
  const fingerprintToken = safeFileToken(fingerprint.toLowerCase()).slice(0, 32) || "unknown";
  const throwableToken = safeThreadToken(throwableType).slice(0, 60);
  const baseName = throwableToken
    ? `crash-${fingerprintToken}-${throwableToken}`
    : `crash-${fingerprintToken}`;
  return truncate(baseName, 100);
}

function buildThreadOpenerMessage(fingerprint: string, throwableType: string): string {
  return [
    "Crash fingerprint thread created.",
    `fingerprint: \`${safeInline(fingerprint)}\``,
    `throwable: \`${safeInline(throwableType || "unknown")}\``
  ].join("\n");
}

function buildCrashRelayMessage(
  envelope: CrashReportEnvelope,
  rawJson: string,
  options: {
    mentionRoleId?: string;
    includeJsonAttachment: boolean;
    stackLines: number;
  }
): CrashRelayMessage {
  const mention = options.mentionRoleId ? `<@&${options.mentionRoleId}> ` : "";
  const reportId = fallback(envelope.reportId, "unknown");
  const fingerprint = fallback(envelope.fingerprint, "unknown");
  const source = fallback(envelope.source, "unknown");
  const pluginIdentifier = fallback(envelope.pluginIdentifier, "unknown");
  const pluginVersion = fallback(envelope.pluginVersion, "unknown");
  const capturedAt = fallback(envelope.capturedAtUtc, "unknown");
  const threadName = fallback(envelope.threadName, "unknown");
  const throwableType = fallback(envelope.throwable?.type, "unknown");
  const throwableMessage = fallback(envelope.throwable?.message, "<empty>");

  const stackPreview = (envelope.throwable?.stack ?? [])
    .slice(0, Math.max(1, options.stackLines))
    .map((line) => truncate(stripCodeFence(line), 220))
    .join("\n");

  const worldContext = [
    envelope.worldName ? `world=${safeInline(envelope.worldName)}` : null,
    envelope.worldRemovalReason ? `reason=${safeInline(envelope.worldRemovalReason)}` : null,
    envelope.worldFailurePluginIdentifier
      ? `failurePlugin=${safeInline(envelope.worldFailurePluginIdentifier)}`
      : null
  ]
    .filter((value): value is string => Boolean(value))
    .join(", ");

  const lines: string[] = [
    `${mention}Tamework crash report received.`,
    `reportId: \`${safeInline(reportId)}\``,
    `fingerprint: \`${safeInline(fingerprint)}\``,
    `source: \`${safeInline(source)}\``,
    `capturedAtUtc: \`${safeInline(capturedAt)}\``,
    `plugin: \`${safeInline(pluginIdentifier)}\` (\`${safeInline(pluginVersion)}\`)`,
    `thread: \`${safeInline(threadName)}\``,
    worldContext ? `world: ${worldContext}` : "world: <none>",
    `throwable: \`${safeInline(throwableType)}\` - ${truncate(safeInline(throwableMessage), 300)}`,
    "stack (top frames):",
    "```txt",
    stackPreview || "<no stack frames>",
    "```"
  ];

  let content = lines.join("\n");
  if (content.length > 1900) {
    const overflow = content.length - 1900;
    const shortenedStack = truncate(stackPreview || "<no stack frames>", Math.max(80, 500 - overflow));
    lines[11] = shortenedStack;
    content = lines.join("\n");
    if (content.length > 1900) {
      content = truncate(content, 1900);
    }
  }

  const message: CrashRelayMessage = {
    content
  };

  if (options.includeJsonAttachment) {
    message.attachmentJson = rawJson;
    message.attachmentName = `tamework-crash-${safeFileToken(fingerprint)}.json`;
  }

  return message;
}

function fallback(value: string | null | undefined, fallbackValue: string): string {
  if (!value || !value.trim()) {
    return fallbackValue;
  }
  return value.trim();
}

function parseCsvSet(value: string | undefined): Set<string> {
  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

function normalizeIp(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }

  return value.replace(/^::ffff:/i, "").trim().toLowerCase();
}

function deriveFingerprint(envelope: CrashReportEnvelope): string {
  if (envelope.fingerprint?.trim()) {
    return safeFileToken(envelope.fingerprint.trim().toLowerCase());
  }

  const stackTop = envelope.throwable?.stack?.[0] ?? "";
  return shortHash([
    fallback(envelope.pluginIdentifier, "unknown"),
    fallback(envelope.throwable?.type, "unknown"),
    fallback(envelope.throwable?.message, "unknown"),
    stackTop
  ]);
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

function stripCodeFence(value: string): string {
  return value.replace(/```/g, "``'");
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

function normalizeRelayPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/tamework/crash-report";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function extractPathname(url: string | undefined): string {
  if (!url) {
    return "/";
  }

  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function isAuthorized(request: IncomingMessage, expectedToken: string | undefined): boolean {
  if (!expectedToken) {
    return true;
  }

  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const bearer = authHeader.slice("Bearer ".length).trim();
    if (bearer === expectedToken) {
      return true;
    }
  }

  const apiKeyHeader = request.headers["x-api-key"];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  return apiKey?.trim() === expectedToken;
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        reject(new PayloadTooLargeError(`Payload exceeds ${maxBytes} bytes`));
        request.destroy();
        return;
      }

      chunks.push(buffer);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", (error) => {
      reject(error);
    });
  });
}

function writeJson(response: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload)}\n`);
}

function writeRateLimited(response: ServerResponse, retryAfterSec: number, scope: "global" | "ip"): void {
  response.statusCode = 429;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Retry-After", String(Math.max(1, retryAfterSec)));
  response.end(
    `${JSON.stringify({
      error: "rate_limited",
      scope,
      retryAfterSec: Math.max(1, retryAfterSec)
    })}\n`
  );
}

function takeWindowedRateLimit(
  stateMap: Map<string, WindowCounterState>,
  key: string,
  maxRequests: number,
  windowSeconds: number,
  nowMs: number
): RateLimitDecision {
  const windowMs = windowSeconds * 1_000;
  const existing = stateMap.get(key);
  if (!existing || nowMs >= existing.resetAtMs) {
    stateMap.set(key, { count: 1, resetAtMs: nowMs + windowMs });
    return { allowed: true, retryAfterSec: 0 };
  }

  if (existing.count >= maxRequests) {
    return { allowed: false, retryAfterSec: Math.ceil((existing.resetAtMs - nowMs) / 1_000) };
  }

  existing.count += 1;
  return { allowed: true, retryAfterSec: 0 };
}

export const crashRelayInternals = {
  buildCrashRelayMessage,
  buildFingerprintThreadName,
  crashReportSchema,
  isAuthorized,
  normalizeRelayPath,
  extractPathname,
  parseCsvSet,
  normalizeIp,
  deriveFingerprint,
  takeWindowedRateLimit
};

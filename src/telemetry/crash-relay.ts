import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { WikiBot } from "../discord/bot.js";

const MAX_BODY_BYTES = 1_000_000;

interface CrashReportEnvelope {
  reportId?: string;
  source?: string;
  fingerprint?: string;
  capturedAtUtc?: string;
  pluginIdentifier?: string;
  pluginVersion?: string;
  threadName?: string;
  worldName?: string | null;
  worldRemovalReason?: string | null;
  worldFailurePluginIdentifier?: string | null;
  throwable?: {
    type?: string;
    message?: string;
    stack?: string[];
  };
}

interface CrashRelayDependencies {
  config: AppConfig;
  logger: Logger;
  bot: WikiBot;
}

interface CrashRelayMessage {
  content: string;
  attachmentJson?: string;
  attachmentName?: string;
}

export class CrashTelemetryRelay {
  private server: Server | null = null;
  private readonly path: string;

  public constructor(private readonly deps: CrashRelayDependencies) {
    this.path = normalizeRelayPath(this.deps.config.CRASH_RELAY_PATH);
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

    this.deps.logger.info(
      {
        host: this.deps.config.CRASH_RELAY_BIND_HOST,
        port: this.deps.config.CRASH_RELAY_PORT,
        path: this.path,
        channelId: this.deps.config.CRASH_RELAY_DISCORD_CHANNEL_ID,
        authTokenConfigured: Boolean(this.deps.config.CRASH_RELAY_AUTH_TOKEN)
      },
      "Crash telemetry relay started"
    );
  }

  public async stop(): Promise<void> {
    const active = this.server;
    this.server = null;
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

    try {
      const rawBody = await readBody(request, MAX_BODY_BYTES);
      const parsed = JSON.parse(rawBody) as CrashReportEnvelope;
      const channelId = this.deps.config.CRASH_RELAY_DISCORD_CHANNEL_ID;
      if (!channelId) {
        throw new Error("CRASH_RELAY_DISCORD_CHANNEL_ID is required when CRASH_RELAY_ENABLED=true");
      }

      const message = buildCrashRelayMessage(parsed, rawBody, {
        includeJsonAttachment: this.deps.config.CRASH_RELAY_ATTACH_JSON,
        stackLines: this.deps.config.CRASH_RELAY_STACK_LINES,
        ...(this.deps.config.CRASH_RELAY_MENTION_ROLE_ID
          ? { mentionRoleId: this.deps.config.CRASH_RELAY_MENTION_ROLE_ID }
          : {})
      });

      await this.deps.bot.sendMessageToChannel(
        message.attachmentJson
          ? {
              channelId,
              content: message.content,
              attachmentJson: message.attachmentJson,
              attachmentName: message.attachmentName ?? "tamework-crash-report.json"
            }
          : {
              channelId,
              content: message.content
            }
      );

      writeJson(response, 202, { ok: true });
    } catch (error) {
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

function safeInline(value: string): string {
  return value.replace(/`/g, "'");
}

function safeFileToken(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "");
  return normalized.length > 0 ? normalized : "unknown";
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
        reject(new Error(`Payload exceeds ${maxBytes} bytes`));
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

export const crashRelayInternals = {
  buildCrashRelayMessage,
  isAuthorized,
  normalizeRelayPath,
  extractPathname
};

import type { AppConfig } from "../config.js";
import type { CrashThreadRepository } from "../db/repositories/crash-thread-repo.js";
import type { TelemetryAlertJobRepository } from "../db/repositories/telemetry-alert-job-repo.js";
import type { Logger } from "../logger.js";
import type { WikiBot } from "../discord/bot.js";
import {
  buildFingerprintThreadName,
  buildThreadOpenerMessage,
  telemetryAlertJobPayloadSchema,
  type TelemetryAlertJobPayload
} from "./alert-job.js";

interface AlertDeliveryWorkerDependencies {
  config: AppConfig;
  logger: Logger;
  bot: WikiBot;
  crashThreadRepo: CrashThreadRepository;
  alertJobRepo: TelemetryAlertJobRepository;
}

export class TelemetryAlertDeliveryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly workerId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  public constructor(private readonly deps: AlertDeliveryWorkerDependencies) {}

  public async start(): Promise<void> {
    if (!this.deps.config.TELEMETRY_ALERT_DELIVERY_ENABLED || this.timer) {
      return;
    }

    await this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.deps.config.TELEMETRY_ALERT_DELIVERY_POLL_INTERVAL_MS);
    this.timer.unref();

    this.deps.logger.info(
      {
        workerId: this.workerId,
        intervalMs: this.deps.config.TELEMETRY_ALERT_DELIVERY_POLL_INTERVAL_MS,
        batchSize: this.deps.config.TELEMETRY_ALERT_DELIVERY_BATCH_SIZE
      },
      "Telemetry alert delivery worker started"
    );
  }

  public async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const jobs = await this.deps.alertJobRepo.claimPendingJobs({
        batchSize: this.deps.config.TELEMETRY_ALERT_DELIVERY_BATCH_SIZE,
        workerId: this.workerId,
        claimTimeoutSeconds: this.deps.config.TELEMETRY_ALERT_DELIVERY_CLAIM_TIMEOUT_SECONDS
      });

      for (const job of jobs) {
        await this.processJob(job);
      }
    } catch (error) {
      this.deps.logger.error({ err: error }, "Telemetry alert delivery poll failed");
    } finally {
      this.running = false;
    }
  }

  private async processJob(job: {
    id: number;
    projectId: string;
    fingerprint: string;
    attemptCount: number;
    payload: unknown;
  }): Promise<void> {
    try {
      const payload = telemetryAlertJobPayloadSchema.parse(job.payload);
      const threadId = await this.resolveOrCreateThread(payload);
      await this.deps.bot.sendMessageToThread(
        payload.discordMessage.attachmentJson
          ? {
              threadId,
              content: payload.discordMessage.content,
              attachmentJson: payload.discordMessage.attachmentJson,
              ...(payload.discordMessage.attachmentName
                ? { attachmentName: payload.discordMessage.attachmentName }
                : {})
            }
          : {
              threadId,
              content: payload.discordMessage.content
            }
      );
      await this.deps.alertJobRepo.markDelivered(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.alertJobRepo.markFailed({
        id: job.id,
        errorMessage: message,
        attemptCount: job.attemptCount,
        maxAttempts: this.deps.config.TELEMETRY_ALERT_DELIVERY_MAX_ATTEMPTS,
        retryDelaySeconds: this.deps.config.TELEMETRY_ALERT_DELIVERY_RETRY_DELAY_SECONDS
      });
      this.deps.logger.warn({ err: error, jobId: job.id }, "Telemetry alert delivery failed");
    }
  }

  private async resolveOrCreateThread(payload: TelemetryAlertJobPayload): Promise<string> {
    const mappedThreadId = await this.deps.crashThreadRepo.getThreadId(
      payload.destination.channelId,
      payload.project.projectId,
      payload.crash.fingerprint
    );
    if (mappedThreadId) {
      return mappedThreadId;
    }

    const created = await this.deps.bot.createCrashThread({
      channelId: payload.destination.channelId,
      threadName: buildFingerprintThreadName(
        payload.crash.fingerprint,
        payload.crash.throwableType,
        payload.project.projectId
      ),
      openerContent: buildThreadOpenerMessage(payload)
    });

    await this.deps.crashThreadRepo.upsertThreadId(
      payload.destination.channelId,
      payload.project.projectId,
      payload.crash.fingerprint,
      created.threadId
    );

    return created.threadId;
  }
}

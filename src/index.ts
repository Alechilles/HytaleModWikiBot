import "dotenv/config";
import cron from "node-cron";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createPool } from "./db/pool.js";
import { AliasRepository } from "./db/repositories/alias-repo.js";
import { CacheRepository } from "./db/repositories/cache-repo.js";
import { CrashThreadRepository } from "./db/repositories/crash-thread-repo.js";
import { GuildSettingsRepository } from "./db/repositories/guild-settings-repo.js";
import { QueryLogRepository } from "./db/repositories/query-log-repo.js";
import { TelemetryProjectRepository } from "./db/repositories/telemetry-project-repo.js";
import { TelemetryReportRepository } from "./db/repositories/telemetry-report-repo.js";
import { WikiClient } from "./services/wiki-client.js";
import { WikiIndexer } from "./services/wiki-indexer.js";
import { WikiLookupService } from "./services/wiki-lookup.js";
import { WikiAutocompleteService } from "./services/wiki-autocomplete.js";
import { InMemoryRateLimiter } from "./services/rate-limiter.js";
import { ExpiringTokenStore } from "./services/token-store.js";
import { WikiBot } from "./discord/bot.js";
import { CrashTelemetryRelay } from "./telemetry/crash-relay.js";
import { TelemetryPortalServer } from "./portal/server.js";
import type { ButtonPayload } from "./types/contracts.js";

async function main() {
  const config = loadConfig(process.env);
  const logger = createLogger(config.LOG_LEVEL);
  const pool = createPool(config.DATABASE_URL);

  const aliasRepo = new AliasRepository(pool);
  const cacheRepo = new CacheRepository(pool);
  const crashThreadRepo = new CrashThreadRepository(pool);
  const guildSettingsRepo = new GuildSettingsRepository(pool);
  const queryLogRepo = new QueryLogRepository(pool);
  const telemetryProjectRepo = new TelemetryProjectRepository(pool);
  const telemetryReportRepo = new TelemetryReportRepository(pool);

  const wikiClient = new WikiClient(config.WIKI_BASE_URL, config.WIKI_API_KEY);
  const contentSearchEnabled = config.WIKI_CONTENT_SEARCH_ENABLED && Boolean(config.WIKI_API_KEY);
  if (config.WIKI_CONTENT_SEARCH_ENABLED && !contentSearchEnabled) {
    logger.warn("WIKI_CONTENT_SEARCH_ENABLED=true but WIKI_API_KEY is missing; content search is disabled");
  }

  const wikiIndexer = new WikiIndexer(cacheRepo, wikiClient, logger, config.LOOKUP_STALE_HOURS);
  const lookupService = new WikiLookupService(
    aliasRepo,
    cacheRepo,
    guildSettingsRepo,
    wikiIndexer,
    wikiClient,
    config.LOOKUP_SIMILARITY_THRESHOLD,
    logger,
    contentSearchEnabled,
    config.WIKI_CONTENT_SEARCH_LIMIT
  );
  const autocompleteService = new WikiAutocompleteService(aliasRepo, cacheRepo, guildSettingsRepo, lookupService);

  const rateLimiter = new InMemoryRateLimiter();
  const buttonTokenStore = new ExpiringTokenStore<ButtonPayload>(config.BUTTON_TOKEN_TTL_SECONDS);

  const bot = new WikiBot({
    config,
    logger,
    aliasRepo,
    guildSettingsRepo,
    queryLogRepo,
    lookupService,
    autocompleteService,
    rateLimiter,
    buttonTokenStore
  });
  const crashRelay = new CrashTelemetryRelay({
    config,
    logger,
    bot,
    crashThreadRepo,
    telemetryProjectRepo,
    telemetryReportRepo
  });
  const telemetryPortal = new TelemetryPortalServer({
    config,
    logger,
    telemetryProjectRepo,
    telemetryReportRepo
  });

  cron.schedule(config.WIKI_REFRESH_CRON, () => {
    logger.info({ cron: config.WIKI_REFRESH_CRON }, "Starting scheduled full wiki refresh");
    void wikiIndexer.refreshAllMods().catch((error) => {
      logger.error({ err: error }, "Scheduled refresh failed");
    });
  });

  // Warm cache opportunistically on startup without blocking bot readiness.
  void wikiIndexer.refreshAllMods().catch((error) => {
    logger.error({ err: error }, "Startup refresh failed");
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    await telemetryPortal.stop();
    await crashRelay.stop();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await bot.start();
  await crashRelay.start();
  await telemetryPortal.start();
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});

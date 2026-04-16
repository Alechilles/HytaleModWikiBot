import { z } from "zod";

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }

    if (["0", "false", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean());

const optionalNonEmptyString = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  return value;
}, z.string().min(1).optional());

const configSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),
  DATABASE_URL: z.string().url(),
  WIKI_BASE_URL: z.string().url().default("https://wiki.hytalemodding.dev"),
  WIKI_API_KEY: optionalNonEmptyString,
  WIKI_CONTENT_SEARCH_ENABLED: booleanFromEnv.default(false),
  WIKI_CONTENT_SEARCH_LIMIT: z.coerce.number().int().min(1).max(25).default(10),
  WIKI_REFRESH_CRON: z.string().default("0 3 * * *"),
  LOOKUP_STALE_HOURS: z.coerce.number().int().positive().default(24),
  LOOKUP_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.58),
  BUTTON_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_USER_MAX: z.coerce.number().int().positive().default(6),
  RATE_LIMIT_USER_WINDOW_SECONDS: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_GUILD_MAX: z.coerce.number().int().positive().default(40),
  RATE_LIMIT_GUILD_WINDOW_SECONDS: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTOCOMPLETE_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_AUTOCOMPLETE_WINDOW_SECONDS: z.coerce.number().int().positive().default(10),
  TELEMETRY_ALERT_DELIVERY_ENABLED: booleanFromEnv.default(false),
  TELEMETRY_ALERT_DELIVERY_POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(5_000),
  TELEMETRY_ALERT_DELIVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  TELEMETRY_ALERT_DELIVERY_RETRY_DELAY_SECONDS: z.coerce.number().int().min(1).default(30),
  TELEMETRY_ALERT_DELIVERY_CLAIM_TIMEOUT_SECONDS: z.coerce.number().int().min(5).default(300),
  TELEMETRY_ALERT_DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
  LOG_LEVEL: z.string().default("info")
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return configSchema.parse(env);
}

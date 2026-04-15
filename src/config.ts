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
  CRASH_RELAY_ENABLED: booleanFromEnv.default(false),
  CRASH_RELAY_BIND_HOST: z.string().default("0.0.0.0"),
  CRASH_RELAY_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  CRASH_RELAY_PATH: z.string().default("/tamework/crash-report"),
  CRASH_RELAY_PROJECTS_PATH: z.string().default("/api/v1/ingest/crash"),
  CRASH_RELAY_PROJECTS_FILE: optionalNonEmptyString,
  CRASH_RELAY_AUTH_TOKEN: optionalNonEmptyString,
  CRASH_RELAY_DISCORD_CHANNEL_ID: optionalNonEmptyString,
  CRASH_RELAY_MENTION_ROLE_ID: optionalNonEmptyString,
  CRASH_RELAY_ATTACH_JSON: booleanFromEnv.default(true),
  CRASH_RELAY_STACK_LINES: z.coerce.number().int().min(1).max(20).default(8),
  CRASH_RELAY_MAX_BODY_BYTES: z.coerce.number().int().min(1_024).max(5_000_000).default(262_144),
  CRASH_RELAY_IP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  CRASH_RELAY_IP_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  CRASH_RELAY_GLOBAL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  CRASH_RELAY_GLOBAL_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  CRASH_RELAY_FINGERPRINT_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(300),
  CRASH_RELAY_SUMMARY_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(30),
  CRASH_RELAY_BLOCKED_IPS: optionalNonEmptyString,
  CRASH_RELAY_BLOCKED_FINGERPRINTS: optionalNonEmptyString,
  LOG_LEVEL: z.string().default("info")
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return configSchema.parse(env);
}

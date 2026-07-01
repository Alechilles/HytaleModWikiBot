import { describe, expect, it } from "vitest";

import { loadConfig, resolveTelemetryAlertDatabaseUrl } from "../src/config.js";

describe("bot config", () => {
  it("uses the bot database for alert delivery when no telemetry alert database is configured", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "discord-token",
      DISCORD_APPLICATION_ID: "application-id",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/hytale_mod_wiki_bot"
    } as NodeJS.ProcessEnv);

    expect(resolveTelemetryAlertDatabaseUrl(config)).toBe("postgres://postgres:postgres@localhost:5432/hytale_mod_wiki_bot");
  });

  it("allows telemetry alert delivery to read from the platform database", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "discord-token",
      DISCORD_APPLICATION_ID: "application-id",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/hytale_mod_wiki_bot",
      TELEMETRY_ALERT_DATABASE_URL: "postgres://postgres:postgres@localhost:5432/alecs_telemetry_platform_prod"
    } as NodeJS.ProcessEnv);

    expect(resolveTelemetryAlertDatabaseUrl(config)).toBe("postgres://postgres:postgres@localhost:5432/alecs_telemetry_platform_prod");
  });
});

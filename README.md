# HytaleModWikiBot

Discord bot for `wiki.hytalemodding.dev`, with optional telemetry alert delivery from the shared Alec's Telemetry Postgres database.

## Scope

- Owns the wiki lookup bot, slash commands, cache/indexing, aliases, defaults, and guild settings.
- Optionally consumes pending `telemetry_alert_jobs` rows from the shared Postgres DB and delivers them to Discord threads.
- Does not own telemetry ingest, portal, project keys, memberships, audit log, or telemetry schema migrations anymore.
- `AlecsTelemetryPlatform` is now the canonical telemetry backend and portal.

## Requirements

- Node.js 20+
- Postgres 14+
- Discord application + bot token

## Setup

1. Copy `.env.example` to `.env`.
2. Fill:
   - `DISCORD_TOKEN`
   - `DISCORD_APPLICATION_ID`
   - `DATABASE_URL`
3. Optional wiki search envs remain available as before.
4. Optional telemetry delivery envs:
   - `TELEMETRY_ALERT_DELIVERY_ENABLED`
   - `TELEMETRY_ALERT_DELIVERY_POLL_INTERVAL_MS`
   - `TELEMETRY_ALERT_DELIVERY_BATCH_SIZE`
   - `TELEMETRY_ALERT_DELIVERY_RETRY_DELAY_SECONDS`
   - `TELEMETRY_ALERT_DELIVERY_CLAIM_TIMEOUT_SECONDS`
   - `TELEMETRY_ALERT_DELIVERY_MAX_ATTEMPTS`
5. For shared/dev/prod deployments, point `DATABASE_URL` at the same Postgres instance used by `AlecsTelemetryPlatform` when telemetry delivery is enabled.
   - Note: the local `docker compose` setup still overrides `DATABASE_URL` to its bundled Postgres container.
6. Run `npm install`.
7. Run `npm run migrate`.
8. Register commands with `npm run register:commands -- --scope global`.
9. Start with `npm run dev`.

## Docker

`docker compose up --build -d`

## Telemetry Delivery Contract

- Delivery is DB-backed only.
- The platform enqueues rows into `telemetry_alert_jobs`.
- This bot claims pending jobs, creates or reuses fingerprint threads, posts alerts, and marks jobs delivered or failed.
- Discord channel, guild, and mention routing remains platform-owned data in `telemetry_project_discord_routes`.

## Validation

```bash
npm run check
npm test
```

# HytaleModWikiBot

Discord bot for `wiki.hytalemodding.dev` with guild-scoped aliases and slash-command wiki lookup.

## Legal

- Terms of Service: [TERMS_OF_SERVICE.md](./TERMS_OF_SERVICE.md)
- Privacy Policy: [PRIVACY_POLICY.md](./PRIVACY_POLICY.md)

## Implemented Features

- `/wiki query mod public`
- `/wiki-alias set/remove/list`
- `/wiki-default add/remove/list/set/clear`
- `/wiki-config visibility`
- `/wiki-config embeds`
- Per-guild alias/default resolution order:
  - Supports multiple default mods for non-prefixed queries
  1. Explicit `mod`
  2. First query token alias
  3. Guild default mods (searched in configured order)
- Page lookup order:
  1. Direct slug guess
  2. Exact title
  3. Fuzzy ranking with did-you-mean fallback
- Autocomplete:
  - mod suggestions (aliases + mod cache)
  - query suggestions scoped to resolved mod
- Buttons on responses:
  - `Open`
  - `Copy URL`
  - `Other matches`
- Embed previews are disabled by default (clean markdown links); can be toggled per guild
- Per-user/per-guild command rate limits and autocomplete throttle
- Nightly full wiki cache refresh + on-demand background mod warm
- Optional API-backed page content search with automatic fallback to cached title/slug matching
- Structured query logging to Postgres

## Requirements

- Node.js 20+
- Postgres 14+
- Discord application + bot token

## Setup

1. Copy env template:

```bash
cp .env.example .env
```

2. Fill required variables in `.env`:

- `DISCORD_TOKEN`
- `DISCORD_APPLICATION_ID`
- `DATABASE_URL`
- `POSTGRES_BIND_PORT` (for Docker host binding; default `5432`)
- Optional crash relay settings (for Tamework crash telemetry -> Discord):
  - `CRASH_RELAY_ENABLED` (`true`/`false`, default `false`)
  - `CRASH_RELAY_BIND_HOST` (default `0.0.0.0`)
  - `CRASH_RELAY_PORT` (default `8787`)
  - `CRASH_RELAY_PATH` (default `/tamework/crash-report`)
  - `CRASH_RELAY_AUTH_TOKEN` (shared secret expected in `Authorization: Bearer ...` or `X-API-Key`)
  - `CRASH_RELAY_DISCORD_CHANNEL_ID` (target channel for crash alerts; required when relay enabled)
  - `CRASH_RELAY_MENTION_ROLE_ID` (optional role mention on each alert)
  - `CRASH_RELAY_ATTACH_JSON` (`true`/`false`, attach raw JSON report)
  - `CRASH_RELAY_STACK_LINES` (default `8`, stack frames included in message body)
- Optional (for API content search after wiki merge):
  - `WIKI_API_KEY`
  - `WIKI_CONTENT_SEARCH_ENABLED` (`true`/`false`)
  - `WIKI_CONTENT_SEARCH_LIMIT` (1-25)

3. Install dependencies:

```bash
npm install
```

4. Run migrations:

```bash
npm run migrate
```

5. Register slash commands:

```bash
npm run register:commands -- --scope global
```

For fast dev iteration in one server:

```bash
npm run register:commands -- --scope guild --guild-id <discord-guild-id>
```

6. Start bot:

```bash
npm run dev
```

## Docker (VPS)

```bash
docker compose up --build -d
```

The compose bot service runs migrations and then starts the bot process.
Command registration is handled separately (CI/manual), not at container startup.

## Tamework Crash Relay

When enabled, the bot can expose an HTTP endpoint that accepts Tamework crash telemetry reports and forwards them to a Discord channel.

1. Set these bot env vars:
   - `CRASH_RELAY_ENABLED=true`
   - `CRASH_RELAY_AUTH_TOKEN=<strong-random-secret>`
   - `CRASH_RELAY_DISCORD_CHANNEL_ID=<discord-channel-id>`
   - Optionally adjust `CRASH_RELAY_PORT` / `CRASH_RELAY_PATH`
2. Restart the bot stack:
   - `docker compose up -d --build`
3. Point Tamework telemetry to the relay endpoint in `tamework-crash-telemetry.txt`:
   - `enabled=true`
   - `endpoint=https://<your-vps-domain-or-ip>:<CRASH_RELAY_PORT><CRASH_RELAY_PATH>`
   - `api_key=<same secret as CRASH_RELAY_AUTH_TOKEN>`

Payload handling notes:
- `GET <CRASH_RELAY_PATH>` returns `{"ok":true}` for quick checks.
- `POST <CRASH_RELAY_PATH>` requires the configured auth token when set.
- Non-2xx processing outcomes return failure status so Tamework keeps reports queued for retry.

## GitHub Actions VPS Deploy

Workflow files:

- `.github/workflows/deploy-vps.yml` (production lane)
- `.github/workflows/deploy-vps-dev.yml` (dev/staging lane)

Production workflow deploys on:

- pushes to `main`
- manual trigger (`workflow_dispatch`)

Required repo secrets:

- `VPS_HOST` (example: `178.156.251.66`)
- `VPS_USER` (example: `deploy`)
- `VPS_SSH_KEY` (private key for the deploy user)

Deployment target path on server:

- `/srv/apps/discord-bot`

Dev workflow deploys on:

- pushes to `dev`
- manual trigger (`workflow_dispatch`)

Required repo secrets:

- `VPS_DEV_HOST` (can be same host as production)
- `VPS_DEV_USER` (can be same user as production)
- `VPS_DEV_SSH_KEY` (can be same private key as production)
- `DEV_COMMAND_GUILD_ID` (one test guild ID for fast command updates in dev)

Dev deployment target path on server:

- `/srv/apps/discord-bot-dev`

Workflows sync repo files (excluding `.env`) and run:

```bash
docker compose up -d --build
```

Command registration behavior:

- Production workflow registers commands globally (`--scope global`).
- Dev workflow registers commands to `DEV_COMMAND_GUILD_ID` (`--scope guild --guild-id ...`).

## Dev/Staging Bot Setup

To test features before shipping to `main`, run a second bot instance:

1. Create a second Discord application + bot in the Discord Developer Portal.
2. Generate a separate token and use the test app ID in `/srv/apps/discord-bot-dev/.env`.
3. Invite the test bot to your test server.
4. Set a different Postgres host port in the dev `.env` so prod/dev can run side-by-side on one VPS, for example:
   - `POSTGRES_BIND_PORT=5433`
5. If you run host-side Node scripts in the dev checkout, match that port in `DATABASE_URL`, for example:
   - `DATABASE_URL=postgres://postgres:postgres@localhost:5433/hytale_mod_wiki_bot`
6. Compose already injects a container-side `DATABASE_URL` for the bot service using the internal `postgres` service.
7. Push to `dev` (or run the dev workflow manually) to publish staging.

## Testing

```bash
npm run check
npm test
```

## Notes

- v1 is designed for single-instance deployment.
- Cache refresh schedule is controlled by `WIKI_REFRESH_CRON`.
- Alias overwrite requires explicit force: `/wiki-alias set ... force:true`.
- If API content search is enabled but key is missing/unusable, the bot falls back to current cached matching behavior.

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
- `DISCORD_GUILD_ID` (required for command registration script)
- `DATABASE_URL`
- `POSTGRES_BIND_PORT` (for Docker host binding; default `5432`)
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

5. Register slash commands to your guild:

```bash
npm run register:commands
```

6. Start bot:

```bash
npm run dev
```

## Docker (VPS)

```bash
docker compose up --build -d
```

The compose bot service registers guild commands, runs migrations, and then starts the bot process.
Make sure `DISCORD_GUILD_ID` is set in `.env` when running via Docker.

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

Dev deployment target path on server:

- `/srv/apps/discord-bot-dev`

Workflows sync repo files (excluding `.env`) and run:

```bash
docker compose up -d --build
```

## Dev/Staging Bot Setup

To test features before shipping to `main`, run a second bot instance:

1. Create a second Discord application + bot in the Discord Developer Portal.
2. Generate a separate token and use the test app ID/guild ID in `/srv/apps/discord-bot-dev/.env`.
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

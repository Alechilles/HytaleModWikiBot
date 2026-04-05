# HytaleModWikiBot

Discord bot for `wiki.hytalemodding.dev` with guild-scoped aliases and slash-command wiki lookup.

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

Workflow file: `.github/workflows/deploy-vps.yml`

It deploys on:

- pushes to `main`
- manual trigger (`workflow_dispatch`)

Required repo secrets:

- `VPS_HOST` (example: `178.156.251.66`)
- `VPS_USER` (example: `deploy`)
- `VPS_SSH_KEY` (private key for the deploy user)

Deployment target path on server:

- `/srv/apps/discord-bot`

The workflow syncs repo files (excluding `.env`) and runs:

```bash
docker compose up -d --build
```

## Testing

```bash
npm run check
npm test
```

## Notes

- v1 is designed for single-instance deployment.
- Cache refresh schedule is controlled by `WIKI_REFRESH_CRON`.
- Alias overwrite requires explicit force: `/wiki-alias set ... force:true`.

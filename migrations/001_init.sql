CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id text PRIMARY KEY,
  default_mod_slug text NULL,
  visibility_mode text NOT NULL DEFAULT 'ephemeral' CHECK (visibility_mode IN ('ephemeral', 'public')),
  embed_mode text NOT NULL DEFAULT 'disabled' CHECK (embed_mode IN ('enabled', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mod_aliases (
  guild_id text NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
  alias text NOT NULL,
  mod_slug text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, alias),
  CONSTRAINT alias_format_chk CHECK (alias ~ '^[a-z0-9][a-z0-9_-]{0,31}$')
);

CREATE TABLE IF NOT EXISTS mod_index_cache (
  mod_slug text PRIMARY KEY,
  mod_name text NOT NULL,
  owner_name text NULL,
  source_url text NOT NULL,
  last_indexed_at timestamptz NOT NULL DEFAULT now(),
  raw_json jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS page_index_cache (
  mod_slug text NOT NULL REFERENCES mod_index_cache(mod_slug) ON DELETE CASCADE,
  page_slug text NOT NULL,
  title text NOT NULL,
  normalized_title text NOT NULL,
  url text NOT NULL,
  parent_slug text NULL,
  depth integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mod_slug, page_slug)
);

CREATE INDEX IF NOT EXISTS page_index_cache_mod_title_idx
ON page_index_cache(mod_slug, normalized_title);

CREATE TABLE IF NOT EXISTS query_log (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL,
  user_id text NOT NULL,
  raw_query text NOT NULL,
  resolved_mod_slug text NULL,
  resolved_page_slug text NULL,
  outcome text NOT NULL,
  latency_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_default_mods (
  guild_id text NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
  mod_slug text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, mod_slug)
);

CREATE INDEX IF NOT EXISTS guild_default_mods_position_idx
ON guild_default_mods(guild_id, position);

CREATE TABLE IF NOT EXISTS telemetry_projects (
  project_id text PRIMARY KEY,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  rate_limit_per_minute integer NOT NULL DEFAULT 60,
  max_payload_bytes integer NOT NULL DEFAULT 262144,
  fingerprint_cooldown_seconds integer NOT NULL DEFAULT 300,
  attach_json boolean NOT NULL DEFAULT true,
  stack_lines integer NOT NULL DEFAULT 8,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (rate_limit_per_minute > 0),
  CHECK (max_payload_bytes >= 1024),
  CHECK (fingerprint_cooldown_seconds > 0),
  CHECK (stack_lines >= 1 AND stack_lines <= 20)
);

CREATE TABLE IF NOT EXISTS telemetry_project_keys (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL REFERENCES telemetry_projects(project_id) ON DELETE CASCADE,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  key_suffix text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS telemetry_project_keys_one_active_idx
ON telemetry_project_keys(project_id)
WHERE active = true;

CREATE TABLE IF NOT EXISTS telemetry_project_discord_routes (
  project_id text PRIMARY KEY REFERENCES telemetry_projects(project_id) ON DELETE CASCADE,
  guild_id text NULL,
  channel_id text NOT NULL,
  mention_role_id text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telemetry_crash_groups (
  project_id text NOT NULL REFERENCES telemetry_projects(project_id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  occurrence_count bigint NOT NULL DEFAULT 0,
  latest_report_id text NULL,
  latest_source text NULL,
  latest_plugin_identifier text NULL,
  latest_plugin_version text NULL,
  latest_exception_type text NULL,
  latest_exception_message text NULL,
  latest_hytale_build text NULL,
  latest_server_version text NULL,
  latest_world_name text NULL,
  latest_alert_suppressed boolean NOT NULL DEFAULT false,
  latest_alert_dispatched boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS telemetry_crash_reports (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL REFERENCES telemetry_projects(project_id) ON DELETE CASCADE,
  report_id text NOT NULL,
  fingerprint text NOT NULL,
  source text NULL,
  captured_at timestamptz NULL,
  last_captured_at timestamptz NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  occurrence_count integer NOT NULL DEFAULT 1,
  plugin_identifier text NULL,
  plugin_version text NULL,
  thread_name text NULL,
  exception_type text NULL,
  exception_message text NULL,
  world_name text NULL,
  hytale_build text NULL,
  server_version text NULL,
  alert_suppressed boolean NOT NULL DEFAULT false,
  alert_dispatched boolean NOT NULL DEFAULT false,
  raw_json jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS telemetry_crash_reports_project_received_idx
ON telemetry_crash_reports(project_id, received_at DESC);

CREATE INDEX IF NOT EXISTS telemetry_crash_reports_project_fingerprint_idx
ON telemetry_crash_reports(project_id, fingerprint, received_at DESC);

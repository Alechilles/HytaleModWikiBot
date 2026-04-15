CREATE TABLE IF NOT EXISTS telemetry_portal_users (
  discord_user_id text PRIMARY KEY,
  username text NOT NULL,
  avatar_hash text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telemetry_project_memberships (
  project_id text NOT NULL REFERENCES telemetry_projects(project_id) ON DELETE CASCADE,
  discord_user_id text NOT NULL REFERENCES telemetry_portal_users(discord_user_id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'maintainer', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, discord_user_id)
);

CREATE INDEX IF NOT EXISTS telemetry_project_memberships_user_idx
ON telemetry_project_memberships(discord_user_id, role);

CREATE TABLE IF NOT EXISTS telemetry_audit_log (
  id bigserial PRIMARY KEY,
  actor_discord_user_id text NULL,
  project_id text NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

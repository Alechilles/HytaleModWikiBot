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

INSERT INTO guild_default_mods (guild_id, mod_slug, position)
SELECT gs.guild_id, gs.default_mod_slug, 0
FROM guild_settings gs
WHERE gs.default_mod_slug IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM guild_default_mods gdm
    WHERE gdm.guild_id = gs.guild_id
      AND gdm.mod_slug = gs.default_mod_slug
  );

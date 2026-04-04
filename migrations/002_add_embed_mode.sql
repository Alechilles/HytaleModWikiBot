ALTER TABLE guild_settings
  ADD COLUMN IF NOT EXISTS embed_mode text NOT NULL DEFAULT 'disabled';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'guild_settings_embed_mode_chk'
  ) THEN
    ALTER TABLE guild_settings
      ADD CONSTRAINT guild_settings_embed_mode_chk
      CHECK (embed_mode IN ('enabled', 'disabled'));
  END IF;
END $$;

ALTER TABLE crash_fingerprint_threads
ADD COLUMN IF NOT EXISTS project_id text NOT NULL DEFAULT 'legacy';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'crash_fingerprint_threads'
      AND constraint_type = 'PRIMARY KEY'
      AND constraint_name = 'crash_fingerprint_threads_pkey'
  ) THEN
    ALTER TABLE crash_fingerprint_threads DROP CONSTRAINT crash_fingerprint_threads_pkey;
  END IF;
END $$;

ALTER TABLE crash_fingerprint_threads
ADD CONSTRAINT crash_fingerprint_threads_pkey PRIMARY KEY (channel_id, project_id, fingerprint);

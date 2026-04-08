CREATE TABLE IF NOT EXISTS crash_fingerprint_threads (
  channel_id text NOT NULL,
  fingerprint text NOT NULL,
  thread_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS crash_fingerprint_threads_thread_id_idx
ON crash_fingerprint_threads(thread_id);

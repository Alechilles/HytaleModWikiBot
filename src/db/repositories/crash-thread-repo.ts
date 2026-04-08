import type { Pool } from "pg";

export class CrashThreadRepository {
  public constructor(private readonly pool: Pool) {}

  public async getThreadId(channelId: string, fingerprint: string): Promise<string | null> {
    const result = await this.pool.query(
      `
      SELECT thread_id
      FROM crash_fingerprint_threads
      WHERE channel_id = $1 AND fingerprint = $2
      `,
      [channelId, normalizeFingerprint(fingerprint)]
    );

    return result.rows[0]?.thread_id ?? null;
  }

  public async upsertThreadId(channelId: string, fingerprint: string, threadId: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO crash_fingerprint_threads (channel_id, fingerprint, thread_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (channel_id, fingerprint)
      DO UPDATE SET
        thread_id = EXCLUDED.thread_id,
        updated_at = now()
      `,
      [channelId, normalizeFingerprint(fingerprint), threadId]
    );
  }
}

function normalizeFingerprint(value: string): string {
  return value.trim().toLowerCase();
}

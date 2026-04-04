import type { Pool } from "pg";

export type QueryOutcome = "found" | "did_you_mean" | "no_match" | "mod_not_resolved" | "missing_query";

export class QueryLogRepository {
  public constructor(private readonly pool: Pool) {}

  public async insert(params: {
    guildId: string;
    userId: string;
    rawQuery: string;
    resolvedModSlug: string | null;
    resolvedPageSlug: string | null;
    outcome: QueryOutcome;
    latencyMs: number;
  }): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO query_log (
        guild_id,
        user_id,
        raw_query,
        resolved_mod_slug,
        resolved_page_slug,
        outcome,
        latency_ms,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, now())
      `,
      [
        params.guildId,
        params.userId,
        params.rawQuery,
        params.resolvedModSlug,
        params.resolvedPageSlug,
        params.outcome,
        params.latencyMs
      ]
    );
  }
}

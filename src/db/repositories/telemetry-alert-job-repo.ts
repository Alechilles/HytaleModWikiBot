import type { Pool } from "pg";
import type { TelemetryAlertJobPayload } from "../../telemetry/alert-job.js";

export interface TelemetryAlertJobRow {
  id: number;
  projectId: string;
  fingerprint: string;
  attemptCount: number;
  payload: TelemetryAlertJobPayload;
}

export class TelemetryAlertJobRepository {
  public constructor(private readonly pool: Pool) {}

  public async claimPendingJobs(params: {
    batchSize: number;
    workerId: string;
    claimTimeoutSeconds: number;
  }): Promise<TelemetryAlertJobRow[]> {
    const result = await this.pool.query(
      `
      WITH next_jobs AS (
        SELECT id
        FROM telemetry_alert_jobs
        WHERE available_at <= now()
          AND (
            status = 'pending'
            OR (status = 'processing' AND claimed_at < now() - make_interval(secs => $3::int))
          )
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE telemetry_alert_jobs AS jobs
      SET
        status = 'processing',
        claimed_at = now(),
        claimed_by = $2,
        attempt_count = jobs.attempt_count + 1,
        updated_at = now()
      FROM next_jobs
      WHERE jobs.id = next_jobs.id
      RETURNING jobs.id, jobs.project_id, jobs.fingerprint, jobs.attempt_count, jobs.payload
      `,
      [params.batchSize, params.workerId, params.claimTimeoutSeconds]
    );

    return result.rows.map((row) => ({
      id: Number(row.id),
      projectId: row.project_id,
      fingerprint: row.fingerprint,
      attemptCount: Number(row.attempt_count),
      payload: row.payload
    }));
  }

  public async markDelivered(id: number): Promise<void> {
    await this.pool.query(
      `
      UPDATE telemetry_alert_jobs
      SET status = 'delivered', delivered_at = now(), last_error = null, updated_at = now()
      WHERE id = $1
      `,
      [id]
    );
  }

  public async markFailed(params: {
    id: number;
    errorMessage: string;
    attemptCount: number;
    maxAttempts: number;
    retryDelaySeconds: number;
  }): Promise<void> {
    const status = params.attemptCount >= params.maxAttempts ? "failed" : "pending";
    await this.pool.query(
      `
      UPDATE telemetry_alert_jobs
      SET
        status = $2,
        available_at = CASE WHEN $2 = 'pending' THEN now() + make_interval(secs => $3::int) ELSE available_at END,
        last_error = $4,
        updated_at = now()
      WHERE id = $1
      `,
      [params.id, status, params.retryDelaySeconds, params.errorMessage.slice(0, 2_000)]
    );
  }
}

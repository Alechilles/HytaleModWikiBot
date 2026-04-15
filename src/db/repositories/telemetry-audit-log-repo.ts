import type { Pool } from "pg";

export interface AuditLogEntry {
  actorDiscordUserId?: string | null;
  projectId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
}

export class TelemetryAuditLogRepository {
  public constructor(private readonly pool: Pool) {}

  public async append(entry: AuditLogEntry): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO telemetry_audit_log (actor_discord_user_id, project_id, action, target_type, target_id, details)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `,
      [
        entry.actorDiscordUserId ?? null,
        entry.projectId ?? null,
        entry.action,
        entry.targetType,
        entry.targetId ?? null,
        JSON.stringify(entry.details ?? {})
      ]
    );
  }
}

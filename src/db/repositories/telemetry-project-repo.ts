import type { Pool } from "pg";
import type { CrashRelayProjectConfig } from "../../telemetry/crash-project-registry.js";
import {
  createProjectKeyRecord,
  generateProjectKey,
  projectKeyPreview,
  type TelemetryProjectKeyRecord
} from "../../telemetry/project-key.js";

export interface TelemetryProjectSummary {
  projectId: string;
  displayName: string;
  enabled: boolean;
  rateLimitPerMinute: number;
  maxPayloadBytes: number;
  fingerprintCooldownSeconds: number;
  attachJson: boolean;
  stackLines: number;
  channelId: string | null;
  guildId: string | null;
  mentionRoleId: string | null;
  activeKeyPreview: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TelemetryProjectDetail extends TelemetryProjectSummary {
  activeKeyCreatedAt: string | null;
}

export interface CreateTelemetryProjectInput {
  projectId: string;
  displayName: string;
  enabled?: boolean;
  rateLimitPerMinute?: number;
  maxPayloadBytes?: number;
  fingerprintCooldownSeconds?: number;
  attachJson?: boolean;
  stackLines?: number;
  guildId?: string | null;
  channelId: string;
  mentionRoleId?: string | null;
}

export class TelemetryProjectRepository {
  public constructor(private readonly pool: Pool) {}

  public async countProjects(): Promise<number> {
    const result = await this.pool.query(`SELECT COUNT(*)::int AS count FROM telemetry_projects`);
    return Number(result.rows[0]?.count ?? 0);
  }

  public async listProjects(): Promise<TelemetryProjectSummary[]> {
    const result = await this.pool.query(
      `
      SELECT
        p.project_id,
        p.display_name,
        p.enabled,
        p.rate_limit_per_minute,
        p.max_payload_bytes,
        p.fingerprint_cooldown_seconds,
        p.attach_json,
        p.stack_lines,
        p.created_at,
        p.updated_at,
        r.guild_id,
        r.channel_id,
        r.mention_role_id,
        k.key_prefix,
        k.key_suffix
      FROM telemetry_projects p
      LEFT JOIN telemetry_project_discord_routes r ON r.project_id = p.project_id
      LEFT JOIN telemetry_project_keys k ON k.project_id = p.project_id AND k.active = true
      ORDER BY p.display_name ASC, p.project_id ASC
      `
    );

    return result.rows.map((row) => this.mapProjectRow(row));
  }

  public async listProjectsByIds(projectIds: string[]): Promise<TelemetryProjectSummary[]> {
    if (projectIds.length === 0) {
      return [];
    }
    const result = await this.pool.query(
      `
      SELECT
        p.project_id,
        p.display_name,
        p.enabled,
        p.rate_limit_per_minute,
        p.max_payload_bytes,
        p.fingerprint_cooldown_seconds,
        p.attach_json,
        p.stack_lines,
        p.created_at,
        p.updated_at,
        r.guild_id,
        r.channel_id,
        r.mention_role_id,
        k.key_prefix,
        k.key_suffix
      FROM telemetry_projects p
      LEFT JOIN telemetry_project_discord_routes r ON r.project_id = p.project_id
      LEFT JOIN telemetry_project_keys k ON k.project_id = p.project_id AND k.active = true
      WHERE p.project_id = ANY($1::text[])
      ORDER BY p.display_name ASC, p.project_id ASC
      `,
      [projectIds]
    );
    return result.rows.map((row) => this.mapProjectRow(row));
  }

  public async getProject(projectId: string): Promise<TelemetryProjectDetail | null> {
    const result = await this.pool.query(
      `
      SELECT
        p.project_id,
        p.display_name,
        p.enabled,
        p.rate_limit_per_minute,
        p.max_payload_bytes,
        p.fingerprint_cooldown_seconds,
        p.attach_json,
        p.stack_lines,
        p.created_at,
        p.updated_at,
        r.guild_id,
        r.channel_id,
        r.mention_role_id,
        k.key_prefix,
        k.key_suffix,
        k.created_at AS active_key_created_at
      FROM telemetry_projects p
      LEFT JOIN telemetry_project_discord_routes r ON r.project_id = p.project_id
      LEFT JOIN telemetry_project_keys k ON k.project_id = p.project_id AND k.active = true
      WHERE p.project_id = $1
      `,
      [projectId]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const project = this.mapProjectRow(row);
    return {
      ...project,
      activeKeyCreatedAt: row.active_key_created_at?.toISOString?.() ?? row.active_key_created_at ?? null
    };
  }

  public async resolveHostedProjectByKey(projectKey: string): Promise<CrashRelayProjectConfig | null> {
    const keyRecord = createProjectKeyRecord(projectKey);
    const result = await this.pool.query(
      `
      SELECT
        p.project_id,
        p.display_name,
        p.enabled,
        p.rate_limit_per_minute,
        p.max_payload_bytes,
        p.fingerprint_cooldown_seconds,
        p.attach_json,
        p.stack_lines,
        r.guild_id,
        r.channel_id,
        r.mention_role_id
      FROM telemetry_projects p
      INNER JOIN telemetry_project_keys k
        ON k.project_id = p.project_id
       AND k.active = true
      INNER JOIN telemetry_project_discord_routes r
        ON r.project_id = p.project_id
      WHERE k.key_hash = $1
      `,
      [keyRecord.keyHash]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      projectId: row.project_id,
      displayName: row.display_name,
      publicProjectKey: projectKey,
      enabled: row.enabled,
      rateLimitPerMinute: row.rate_limit_per_minute,
      maxPayloadBytes: row.max_payload_bytes,
      fingerprintCooldownSeconds: row.fingerprint_cooldown_seconds,
      attachJson: row.attach_json,
      stackLines: row.stack_lines,
      discord: {
        channelId: row.channel_id,
        ...(row.guild_id ? { guildId: row.guild_id } : {}),
        ...(row.mention_role_id ? { mentionRoleId: row.mention_role_id } : {})
      }
    };
  }

  public async createProject(input: CreateTelemetryProjectInput): Promise<{ project: TelemetryProjectDetail; projectKey: string }> {
    const projectKey = generateProjectKey();
    const keyRecord = createProjectKeyRecord(projectKey);

    await this.pool.query("BEGIN");
    try {
      await this.pool.query(
        `
        INSERT INTO telemetry_projects (
          project_id,
          display_name,
          enabled,
          rate_limit_per_minute,
          max_payload_bytes,
          fingerprint_cooldown_seconds,
          attach_json,
          stack_lines
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          input.projectId,
          input.displayName,
          input.enabled ?? true,
          input.rateLimitPerMinute ?? 60,
          input.maxPayloadBytes ?? 262_144,
          input.fingerprintCooldownSeconds ?? 300,
          input.attachJson ?? true,
          input.stackLines ?? 8
        ]
      );

      await this.pool.query(
        `
        INSERT INTO telemetry_project_discord_routes (project_id, guild_id, channel_id, mention_role_id)
        VALUES ($1, $2, $3, $4)
        `,
        [input.projectId, input.guildId ?? null, input.channelId, input.mentionRoleId ?? null]
      );

      await this.insertProjectKey(input.projectId, keyRecord);
      await this.pool.query("COMMIT");
    } catch (error) {
      await this.pool.query("ROLLBACK");
      throw error;
    }

    const project = await this.getProject(input.projectId);
    if (!project) {
      throw new Error(`Created telemetry project ${input.projectId} could not be reloaded.`);
    }
    return { project, projectKey };
  }

  public async rotateProjectKey(projectId: string): Promise<{ projectKey: string; preview: string }> {
    const projectKey = generateProjectKey();
    const keyRecord = createProjectKeyRecord(projectKey);

    await this.pool.query("BEGIN");
    try {
      await this.pool.query(
        `
        UPDATE telemetry_project_keys
        SET active = false, rotated_at = now()
        WHERE project_id = $1 AND active = true
        `,
        [projectId]
      );
      await this.insertProjectKey(projectId, keyRecord);
      await this.pool.query("COMMIT");
    } catch (error) {
      await this.pool.query("ROLLBACK");
      throw error;
    }

    return {
      projectKey,
      preview: projectKeyPreview(keyRecord.keyPrefix, keyRecord.keySuffix)
    };
  }

  public async updateDiscordRoute(projectId: string, input: { guildId?: string | null; channelId: string; mentionRoleId?: string | null }): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO telemetry_project_discord_routes (project_id, guild_id, channel_id, mention_role_id, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (project_id)
      DO UPDATE SET
        guild_id = EXCLUDED.guild_id,
        channel_id = EXCLUDED.channel_id,
        mention_role_id = EXCLUDED.mention_role_id,
        updated_at = now()
      `,
      [projectId, input.guildId ?? null, input.channelId, input.mentionRoleId ?? null]
    );
  }

  private async insertProjectKey(projectId: string, keyRecord: TelemetryProjectKeyRecord): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO telemetry_project_keys (project_id, key_hash, key_prefix, key_suffix, active)
      VALUES ($1, $2, $3, $4, true)
      `,
      [projectId, keyRecord.keyHash, keyRecord.keyPrefix, keyRecord.keySuffix]
    );
  }

  private mapProjectRow(row: any): TelemetryProjectSummary {
    return {
      projectId: row.project_id,
      displayName: row.display_name,
      enabled: row.enabled,
      rateLimitPerMinute: row.rate_limit_per_minute,
      maxPayloadBytes: row.max_payload_bytes,
      fingerprintCooldownSeconds: row.fingerprint_cooldown_seconds,
      attachJson: row.attach_json,
      stackLines: row.stack_lines,
      channelId: row.channel_id ?? null,
      guildId: row.guild_id ?? null,
      mentionRoleId: row.mention_role_id ?? null,
      activeKeyPreview: row.key_prefix && row.key_suffix ? projectKeyPreview(row.key_prefix, row.key_suffix) : null,
      createdAt: row.created_at?.toISOString?.() ?? row.created_at,
      updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at
    };
  }
}

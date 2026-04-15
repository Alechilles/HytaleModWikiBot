import type { Pool } from "pg";

export type TelemetryPortalRole = "owner" | "admin" | "maintainer" | "viewer";

export interface TelemetryPortalUser {
  discordUserId: string;
  username: string;
  avatarHash: string | null;
}

export interface TelemetryMembership {
  projectId: string;
  discordUserId: string;
  role: TelemetryPortalRole;
}

export class TelemetryMembershipRepository {
  public constructor(private readonly pool: Pool) {}

  public async upsertUser(user: TelemetryPortalUser): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO telemetry_portal_users (discord_user_id, username, avatar_hash, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (discord_user_id)
      DO UPDATE SET
        username = EXCLUDED.username,
        avatar_hash = EXCLUDED.avatar_hash,
        updated_at = now()
      `,
      [user.discordUserId, user.username, user.avatarHash]
    );
  }

  public async ensureBootstrapMemberships(user: TelemetryPortalUser, bootstrapProjectIds: string[]): Promise<void> {
    await this.upsertUser(user);
    for (const projectId of bootstrapProjectIds) {
      await this.pool.query(
        `
        INSERT INTO telemetry_project_memberships (project_id, discord_user_id, role, updated_at)
        VALUES ($1, $2, 'owner', now())
        ON CONFLICT (project_id, discord_user_id)
        DO NOTHING
        `,
        [projectId, user.discordUserId]
      );
    }
  }

  public async listUserMemberships(discordUserId: string): Promise<TelemetryMembership[]> {
    const result = await this.pool.query(
      `
      SELECT project_id, discord_user_id, role
      FROM telemetry_project_memberships
      WHERE discord_user_id = $1
      ORDER BY project_id ASC
      `,
      [discordUserId]
    );
    return result.rows.map((row) => ({
      projectId: row.project_id,
      discordUserId: row.discord_user_id,
      role: row.role
    }));
  }

  public async getMembership(projectId: string, discordUserId: string): Promise<TelemetryMembership | null> {
    const result = await this.pool.query(
      `
      SELECT project_id, discord_user_id, role
      FROM telemetry_project_memberships
      WHERE project_id = $1 AND discord_user_id = $2
      `,
      [projectId, discordUserId]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      projectId: row.project_id,
      discordUserId: row.discord_user_id,
      role: row.role
    };
  }
}

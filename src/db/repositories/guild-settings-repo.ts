import type { Pool } from "pg";
import type { EmbedMode, GuildSettings, VisibilityMode } from "../../types/contracts.js";

export class GuildSettingsRepository {
  public constructor(private readonly pool: Pool) {}

  private async ensureGuildRow(guildId: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO guild_settings (guild_id)
      VALUES ($1)
      ON CONFLICT (guild_id) DO NOTHING
      `,
      [guildId]
    );
  }

  public async getSettings(guildId: string): Promise<GuildSettings | null> {
    const result = await this.pool.query(
      `
      SELECT guild_id, default_mod_slug, visibility_mode, embed_mode
      FROM guild_settings
      WHERE guild_id = $1
      `,
      [guildId]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      guildId: row.guild_id,
      defaultModSlug: row.default_mod_slug,
      visibilityMode: row.visibility_mode,
      embedMode: row.embed_mode
    };
  }

  public async getDefaultModSlug(guildId: string): Promise<string | null> {
    const defaults = await this.getDefaultModSlugs(guildId);
    if (defaults.length > 0) {
      return defaults[0] ?? null;
    }

    const result = await this.pool.query(
      `SELECT default_mod_slug FROM guild_settings WHERE guild_id = $1`,
      [guildId]
    );

    return result.rows[0]?.default_mod_slug ?? null;
  }

  public async getDefaultModSlugs(guildId: string): Promise<string[]> {
    const result = await this.pool.query(
      `
      SELECT mod_slug
      FROM guild_default_mods
      WHERE guild_id = $1
      ORDER BY position ASC, updated_at ASC
      `,
      [guildId]
    );

    return result.rows.map((row) => row.mod_slug as string);
  }

  public async setDefaultModSlug(guildId: string, modSlug: string): Promise<void> {
    await this.ensureGuildRow(guildId);

    await this.pool.query(
      `
      DELETE FROM guild_default_mods
      WHERE guild_id = $1
      `,
      [guildId]
    );

    await this.pool.query(
      `
      INSERT INTO guild_default_mods (guild_id, mod_slug, position)
      VALUES ($1, $2, 0)
      ON CONFLICT (guild_id, mod_slug)
      DO UPDATE SET
        position = EXCLUDED.position,
        updated_at = now()
      `,
      [guildId, modSlug]
    );

    await this.syncPrimaryDefault(guildId);
  }

  public async addDefaultModSlug(guildId: string, modSlug: string): Promise<{ added: boolean }> {
    await this.ensureGuildRow(guildId);

    const existing = await this.pool.query(
      `
      SELECT 1
      FROM guild_default_mods
      WHERE guild_id = $1 AND mod_slug = $2
      `,
      [guildId, modSlug]
    );

    if ((existing.rowCount ?? 0) > 0) {
      return { added: false };
    }

    const maxPosResult = await this.pool.query(
      `
      SELECT COALESCE(MAX(position), -1) + 1 AS next_position
      FROM guild_default_mods
      WHERE guild_id = $1
      `,
      [guildId]
    );
    const nextPosition = Number(maxPosResult.rows[0]?.next_position ?? 0);

    await this.pool.query(
      `
      INSERT INTO guild_default_mods (guild_id, mod_slug, position)
      VALUES ($1, $2, $3)
      `,
      [guildId, modSlug, nextPosition]
    );

    await this.syncPrimaryDefault(guildId);

    return { added: true };
  }

  public async removeDefaultModSlug(guildId: string, modSlug: string): Promise<boolean> {
    const result = await this.pool.query(
      `
      DELETE FROM guild_default_mods
      WHERE guild_id = $1 AND mod_slug = $2
      `,
      [guildId, modSlug]
    );

    await this.resequenceDefaults(guildId);
    await this.syncPrimaryDefault(guildId);

    return (result.rowCount ?? 0) > 0;
  }

  public async clearDefaultModSlug(guildId: string): Promise<void> {
    await this.ensureGuildRow(guildId);

    await this.pool.query(
      `
      DELETE FROM guild_default_mods
      WHERE guild_id = $1
      `,
      [guildId]
    );

    await this.pool.query(
      `
      INSERT INTO guild_settings (guild_id, default_mod_slug)
      VALUES ($1, NULL)
      ON CONFLICT (guild_id)
      DO UPDATE SET
        default_mod_slug = NULL,
        updated_at = now()
      `,
      [guildId]
    );
  }

  public async getVisibilityMode(guildId: string): Promise<VisibilityMode> {
    const result = await this.pool.query(
      `SELECT visibility_mode FROM guild_settings WHERE guild_id = $1`,
      [guildId]
    );

    return result.rows[0]?.visibility_mode ?? "ephemeral";
  }

  public async getEmbedMode(guildId: string): Promise<EmbedMode> {
    const result = await this.pool.query(
      `SELECT embed_mode FROM guild_settings WHERE guild_id = $1`,
      [guildId]
    );

    return result.rows[0]?.embed_mode ?? "disabled";
  }

  public async setVisibilityMode(guildId: string, mode: VisibilityMode): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO guild_settings (guild_id, visibility_mode)
      VALUES ($1, $2)
      ON CONFLICT (guild_id)
      DO UPDATE SET
        visibility_mode = EXCLUDED.visibility_mode,
        updated_at = now()
      `,
      [guildId, mode]
    );
  }

  public async setEmbedMode(guildId: string, mode: EmbedMode): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO guild_settings (guild_id, embed_mode)
      VALUES ($1, $2)
      ON CONFLICT (guild_id)
      DO UPDATE SET
        embed_mode = EXCLUDED.embed_mode,
        updated_at = now()
      `,
      [guildId, mode]
    );
  }

  private async resequenceDefaults(guildId: string): Promise<void> {
    const current = await this.pool.query(
      `
      SELECT mod_slug
      FROM guild_default_mods
      WHERE guild_id = $1
      ORDER BY position ASC, updated_at ASC
      `,
      [guildId]
    );

    let position = 0;
    for (const row of current.rows) {
      await this.pool.query(
        `
        UPDATE guild_default_mods
        SET position = $3, updated_at = now()
        WHERE guild_id = $1 AND mod_slug = $2
        `,
        [guildId, row.mod_slug, position]
      );
      position += 1;
    }
  }

  private async syncPrimaryDefault(guildId: string): Promise<void> {
    const defaults = await this.getDefaultModSlugs(guildId);
    const primary = defaults[0] ?? null;

    await this.pool.query(
      `
      INSERT INTO guild_settings (guild_id, default_mod_slug)
      VALUES ($1, $2)
      ON CONFLICT (guild_id)
      DO UPDATE SET
        default_mod_slug = EXCLUDED.default_mod_slug,
        updated_at = now()
      `,
      [guildId, primary]
    );
  }
}

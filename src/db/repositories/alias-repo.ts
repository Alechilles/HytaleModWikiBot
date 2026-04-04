import type { Pool } from "pg";
import type { ModAlias } from "../../types/contracts.js";

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class AliasConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AliasConflictError";
  }
}

export class AliasRepository {
  public constructor(private readonly pool: Pool) {}

  public static validateAlias(alias: string): boolean {
    return ALIAS_PATTERN.test(alias);
  }

  public async getModSlugByAlias(guildId: string, alias: string): Promise<string | null> {
    const result = await this.pool.query(
      `
      SELECT mod_slug
      FROM mod_aliases
      WHERE guild_id = $1 AND alias = $2
      `,
      [guildId, alias]
    );

    return result.rows[0]?.mod_slug ?? null;
  }

  public async setAlias(params: {
    guildId: string;
    alias: string;
    modSlug: string;
    createdBy: string;
    force: boolean;
  }): Promise<{ created: boolean; overwritten: boolean }> {
    const normalizedAlias = params.alias.toLowerCase();

    if (!AliasRepository.validateAlias(normalizedAlias)) {
      throw new Error("Alias must match ^[a-z0-9][a-z0-9_-]{0,31}$");
    }

    const existing = await this.pool.query(
      `
      SELECT mod_slug
      FROM mod_aliases
      WHERE guild_id = $1 AND alias = $2
      `,
      [params.guildId, normalizedAlias]
    );

    const existingSlug: string | undefined = existing.rows[0]?.mod_slug;

    if (existingSlug && existingSlug !== params.modSlug && !params.force) {
      throw new AliasConflictError(
        `Alias ${normalizedAlias} already points to ${existingSlug}; set force=true to overwrite.`
      );
    }

    await this.pool.query(
      `
      INSERT INTO guild_settings (guild_id)
      VALUES ($1)
      ON CONFLICT (guild_id) DO NOTHING
      `,
      [params.guildId]
    );

    await this.pool.query(
      `
      INSERT INTO mod_aliases (guild_id, alias, mod_slug, created_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (guild_id, alias)
      DO UPDATE SET
        mod_slug = EXCLUDED.mod_slug,
        created_by = EXCLUDED.created_by,
        updated_at = now()
      `,
      [params.guildId, normalizedAlias, params.modSlug, params.createdBy]
    );

    return {
      created: !existingSlug,
      overwritten: Boolean(existingSlug && existingSlug !== params.modSlug)
    };
  }

  public async removeAlias(guildId: string, alias: string): Promise<boolean> {
    const result = await this.pool.query(
      `
      DELETE FROM mod_aliases
      WHERE guild_id = $1 AND alias = $2
      `,
      [guildId, alias.toLowerCase()]
    );

    return (result.rowCount ?? 0) > 0;
  }

  public async listAliases(guildId: string): Promise<ModAlias[]> {
    const result = await this.pool.query(
      `
      SELECT guild_id, alias, mod_slug, created_by, updated_at
      FROM mod_aliases
      WHERE guild_id = $1
      ORDER BY alias ASC
      `,
      [guildId]
    );

    return result.rows.map((row) => ({
      guildId: row.guild_id,
      alias: row.alias,
      modSlug: row.mod_slug,
      createdBy: row.created_by,
      updatedAt: row.updated_at
    }));
  }
}

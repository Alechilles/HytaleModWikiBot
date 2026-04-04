import type { Pool } from "pg";
import type { ModSummary, PageRecord } from "../../types/contracts.js";
import { normalizeText, similarityScore } from "../../utils.js";

export class CacheRepository {
  public constructor(private readonly pool: Pool) {}

  public async upsertMod(params: {
    slug: string;
    name: string;
    ownerName: string | null;
    sourceUrl: string;
    rawJson: unknown;
  }): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO mod_index_cache (mod_slug, mod_name, owner_name, source_url, raw_json, last_indexed_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, now())
      ON CONFLICT (mod_slug)
      DO UPDATE SET
        mod_name = EXCLUDED.mod_name,
        owner_name = EXCLUDED.owner_name,
        source_url = EXCLUDED.source_url,
        raw_json = EXCLUDED.raw_json,
        last_indexed_at = now()
      `,
      [params.slug, params.name, params.ownerName, params.sourceUrl, JSON.stringify(params.rawJson)]
    );
  }

  public async upsertPages(modSlug: string, pages: PageRecord[]): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM page_index_cache WHERE mod_slug = $1`, [modSlug]);

      for (const page of pages) {
        await client.query(
          `
          INSERT INTO page_index_cache (
            mod_slug,
            page_slug,
            title,
            normalized_title,
            url,
            parent_slug,
            depth,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, now())
          `,
          [
            page.modSlug,
            page.pageSlug,
            page.title,
            page.normalizedTitle,
            page.url,
            page.parentSlug,
            page.depth
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async getModBySlug(slug: string): Promise<ModSummary | null> {
    const result = await this.pool.query(
      `
      SELECT mod_slug, mod_name, owner_name, source_url, last_indexed_at
      FROM mod_index_cache
      WHERE mod_slug = $1
      `,
      [slug]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      slug: row.mod_slug,
      name: row.mod_name,
      ownerName: row.owner_name,
      sourceUrl: row.source_url,
      lastIndexedAt: row.last_indexed_at
    };
  }

  public async listAllModSlugs(): Promise<string[]> {
    const result = await this.pool.query(`SELECT mod_slug FROM mod_index_cache ORDER BY mod_slug ASC`);
    return result.rows.map((row) => row.mod_slug as string);
  }

  public async getModLastIndexedAt(slug: string): Promise<Date | null> {
    const result = await this.pool.query(
      `SELECT last_indexed_at FROM mod_index_cache WHERE mod_slug = $1`,
      [slug]
    );

    const value: string | undefined = result.rows[0]?.last_indexed_at;
    return value ? new Date(value) : null;
  }

  public async searchMods(input: string, limit: number): Promise<ModSummary[]> {
    const normalized = normalizeText(input);
    const result = await this.pool.query(
      `
      SELECT mod_slug, mod_name, owner_name, source_url, last_indexed_at
      FROM mod_index_cache
      WHERE mod_slug ILIKE $1 OR mod_name ILIKE $1
      ORDER BY mod_name ASC
      LIMIT $2
      `,
      [`%${normalized.replace(/\s+/g, "%")}%`, limit]
    );

    return result.rows.map((row) => ({
      slug: row.mod_slug,
      name: row.mod_name,
      ownerName: row.owner_name,
      sourceUrl: row.source_url,
      lastIndexedAt: row.last_indexed_at
    }));
  }

  public async listPagesByModSlug(modSlug: string): Promise<PageRecord[]> {
    const result = await this.pool.query(
      `
      SELECT mod_slug, page_slug, title, normalized_title, url, parent_slug, depth, updated_at
      FROM page_index_cache
      WHERE mod_slug = $1
      ORDER BY depth ASC, title ASC
      `,
      [modSlug]
    );

    return result.rows.map((row) => ({
      modSlug: row.mod_slug,
      pageSlug: row.page_slug,
      title: row.title,
      normalizedTitle: row.normalized_title,
      url: row.url,
      parentSlug: row.parent_slug,
      depth: row.depth,
      updatedAt: row.updated_at
    }));
  }

  public async findPageByExactSlug(modSlug: string, pageSlug: string): Promise<PageRecord | null> {
    const result = await this.pool.query(
      `
      SELECT mod_slug, page_slug, title, normalized_title, url, parent_slug, depth, updated_at
      FROM page_index_cache
      WHERE mod_slug = $1 AND page_slug = $2
      `,
      [modSlug, pageSlug]
    );

    const row = result.rows[0];
    return row
      ? {
          modSlug: row.mod_slug,
          pageSlug: row.page_slug,
          title: row.title,
          normalizedTitle: row.normalized_title,
          url: row.url,
          parentSlug: row.parent_slug,
          depth: row.depth,
          updatedAt: row.updated_at
        }
      : null;
  }

  public async findPageByExactTitle(modSlug: string, title: string): Promise<PageRecord | null> {
    const normalizedTitle = normalizeText(title);
    const result = await this.pool.query(
      `
      SELECT mod_slug, page_slug, title, normalized_title, url, parent_slug, depth, updated_at
      FROM page_index_cache
      WHERE mod_slug = $1 AND normalized_title = $2
      LIMIT 1
      `,
      [modSlug, normalizedTitle]
    );

    const row = result.rows[0];
    return row
      ? {
          modSlug: row.mod_slug,
          pageSlug: row.page_slug,
          title: row.title,
          normalizedTitle: row.normalized_title,
          url: row.url,
          parentSlug: row.parent_slug,
          depth: row.depth,
          updatedAt: row.updated_at
        }
      : null;
  }

  public async searchPages(modSlug: string, query: string, limit: number): Promise<PageRecord[]> {
    const normalized = normalizeText(query);
    const pages = await this.listPagesByModSlug(modSlug);

    const scored = pages
      .map((page) => {
        const base = Math.max(
          similarityScore(normalized, page.normalizedTitle),
          similarityScore(normalized, page.pageSlug)
        );
        const containsBonus =
          page.normalizedTitle.includes(normalized) || page.pageSlug.includes(normalized.replace(/\s+/g, "-"))
            ? 0.2
            : 0;
        return {
          page,
          score: Math.min(1, base + containsBonus)
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .filter((entry) => entry.score > 0);

    return scored.map((entry) => entry.page);
  }
}

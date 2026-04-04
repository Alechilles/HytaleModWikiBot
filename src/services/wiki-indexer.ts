import type { Logger } from "../logger.js";
import { normalizeText } from "../utils.js";
import type { PageRecord } from "../types/contracts.js";
import { CacheRepository } from "../db/repositories/cache-repo.js";
import { WikiClient, type WikiPageNode } from "./wiki-client.js";

export class WikiIndexer {
  private readonly inFlight = new Map<string, Promise<void>>();

  public constructor(
    private readonly cacheRepo: CacheRepository,
    private readonly wikiClient: WikiClient,
    private readonly logger: Logger,
    private readonly staleHours: number
  ) {}

  public async refreshAllMods(): Promise<void> {
    const startedAt = Date.now();
    const mods = await this.wikiClient.fetchAllMods();

    for (const mod of mods) {
      await this.refreshMod(mod.slug);
    }

    this.logger.info(
      {
        modCount: mods.length,
        durationMs: Date.now() - startedAt
      },
      "Completed full wiki refresh"
    );
  }

  public async refreshMod(modSlug: string): Promise<void> {
    const existing = this.inFlight.get(modSlug);
    if (existing) {
      return existing;
    }

    const promise = this.refreshModInternal(modSlug)
      .catch((error) => {
        this.logger.error({ modSlug, err: error }, "Failed mod refresh");
        throw error;
      })
      .finally(() => {
        this.inFlight.delete(modSlug);
      });

    this.inFlight.set(modSlug, promise);
    return promise;
  }

  public async refreshModInBackground(modSlug: string): Promise<void> {
    void this.refreshMod(modSlug).catch((error) => {
      this.logger.error({ modSlug, err: error }, "Background mod refresh failed");
    });
  }

  public async ensureFresh(modSlug: string): Promise<{ stale: boolean; missing: boolean }> {
    const indexedAt = await this.cacheRepo.getModLastIndexedAt(modSlug);
    const missing = !indexedAt;

    if (missing) {
      await this.refreshModInBackground(modSlug);
      return { stale: true, missing: true };
    }

    const ageHours = (Date.now() - indexedAt.getTime()) / (1000 * 60 * 60);
    const stale = ageHours >= this.staleHours;

    if (stale) {
      await this.refreshModInBackground(modSlug);
    }

    return { stale, missing: false };
  }

  private async refreshModInternal(modSlug: string): Promise<void> {
    const startedAt = Date.now();
    const detail = await this.wikiClient.fetchModDetails(modSlug);
    const pages = this.flattenPages(detail.slug, detail.rootPages);

    await this.cacheRepo.upsertMod({
      slug: detail.slug,
      name: detail.name,
      ownerName: detail.ownerName,
      sourceUrl: `${this.wikiClient.getBaseUrl()}/mod/${detail.slug}`,
      rawJson: detail.raw
    });
    await this.cacheRepo.upsertPages(detail.slug, pages);

    this.logger.info(
      {
        modSlug,
        pageCount: pages.length,
        durationMs: Date.now() - startedAt
      },
      "Refreshed mod wiki index"
    );
  }

  private flattenPages(modSlug: string, nodes: WikiPageNode[]): PageRecord[] {
    const output: PageRecord[] = [];

    const visit = (node: WikiPageNode, depth: number, parentSlug: string | null): void => {
      output.push({
        modSlug,
        pageSlug: node.slug,
        title: node.title,
        normalizedTitle: normalizeText(node.title),
        url: `${this.wikiClient.getBaseUrl()}/mod/${modSlug}/${node.slug}`,
        parentSlug,
        depth,
        updatedAt: new Date().toISOString()
      });

      for (const child of node.children ?? []) {
        visit(child, depth + 1, node.slug);
      }
    };

    for (const node of nodes) {
      visit(node, 0, null);
    }

    return output;
  }
}

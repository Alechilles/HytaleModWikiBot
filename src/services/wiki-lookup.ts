import type { Logger } from "../logger.js";
import { AliasRepository } from "../db/repositories/alias-repo.js";
import { CacheRepository } from "../db/repositories/cache-repo.js";
import { GuildSettingsRepository } from "../db/repositories/guild-settings-repo.js";
import type { CandidatePage, WikiLookupInput, WikiLookupResult } from "../types/contracts.js";
import { normalizeText, similarityScore, slugify } from "../utils.js";
import { WikiClient, type WikiContentSearchResult } from "./wiki-client.js";
import { WikiIndexer } from "./wiki-indexer.js";

interface ResolvedLookupScope {
  modSlugs: string[];
  pageQuery: string;
}

export class WikiLookupService {
  public constructor(
    private readonly aliasRepo: AliasRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly guildSettingsRepo: GuildSettingsRepository,
    private readonly indexer: WikiIndexer,
    private readonly wikiClient: WikiClient,
    private readonly similarityThreshold: number,
    private readonly logger: Logger,
    private readonly contentSearchEnabled = false,
    private readonly contentSearchLimit = 10
  ) {}

  public async resolveModIdentifier(guildId: string, rawInput: string): Promise<string | null> {
    const input = rawInput.trim();
    if (!input) {
      return null;
    }

    const lower = input.toLowerCase();
    const aliasMatch = await this.aliasRepo.getModSlugByAlias(guildId, lower);
    if (aliasMatch) {
      return aliasMatch;
    }

    const exactBySlug = await this.cacheRepo.getModBySlug(lower);
    if (exactBySlug) {
      return exactBySlug.slug;
    }

    const slugCandidate = slugify(input);
    if (slugCandidate) {
      const bySlugified = await this.cacheRepo.getModBySlug(slugCandidate);
      if (bySlugified) {
        return bySlugified.slug;
      }
    }

    const candidates = await this.cacheRepo.searchMods(input, 10);
    if (candidates.length === 0) {
      return null;
    }

    const normalizedInput = normalizeText(input);
    const exactName = candidates.find((candidate) => normalizeText(candidate.name) === normalizedInput);
    if (exactName) {
      return exactName.slug;
    }

    return candidates[0]?.slug ?? null;
  }

  public async lookup(input: WikiLookupInput): Promise<WikiLookupResult> {
    const trimmedQuery = input.query.trim();
    if (!trimmedQuery) {
      return {
        status: "missing_query",
        resolvedModSlug: null,
        resolvedUrl: null,
        resolvedTitle: null,
        explanation: "Provide a query like `ah beast taming reference` or set a default mod.",
        candidates: []
      };
    }

    const parsed = await this.resolveModsAndQuery(input.guildId, trimmedQuery, input.explicitModInput);
    if (parsed.modSlugs.length === 0) {
      return {
        status: "mod_not_resolved",
        resolvedModSlug: null,
        resolvedUrl: null,
        resolvedTitle: null,
        explanation: "Could not resolve mod. Use `mod:` or configure aliases/default mods.",
        candidates: []
      };
    }

    const orderedMods = Array.from(new Set(parsed.modSlugs));
    await Promise.all(orderedMods.map((modSlug) => this.indexer.ensureFresh(modSlug)));

    if (!parsed.pageQuery) {
      if (orderedMods.length === 1) {
        const onlyMod = orderedMods[0] as string;
        return {
          status: "found",
          resolvedModSlug: onlyMod,
          resolvedUrl: `${this.wikiClient.getBaseUrl()}/mod/${onlyMod}`,
          resolvedTitle: null,
          explanation: "Opened the mod wiki root page.",
          candidates: []
        };
      }

      return {
        status: "no_match",
        resolvedModSlug: orderedMods[0] ?? null,
        resolvedUrl: null,
        resolvedTitle: null,
        explanation: "Add a page query after the command to search across default mods.",
        candidates: []
      };
    }

    const directSlug = slugify(parsed.pageQuery);

    for (const modSlug of orderedMods) {
      if (directSlug) {
        const exactPage = await this.cacheRepo.findPageByExactSlug(modSlug, directSlug);
        if (exactPage) {
          return {
            status: "found",
            resolvedModSlug: modSlug,
            resolvedUrl: exactPage.url,
            resolvedTitle: exactPage.title,
            explanation: "Resolved exact page slug.",
            candidates: []
          };
        }
      }

      const exactTitle = await this.cacheRepo.findPageByExactTitle(modSlug, parsed.pageQuery);
      if (exactTitle) {
        return {
          status: "found",
          resolvedModSlug: modSlug,
          resolvedUrl: exactTitle.url,
          resolvedTitle: exactTitle.title,
          explanation: "Resolved exact page title.",
          candidates: []
        };
      }
    }

    const candidates: CandidatePage[] = [];

    for (const modSlug of orderedMods) {
      const pages = await this.cacheRepo.listPagesByModSlug(modSlug);
      if (pages.length === 0) {
        this.logger.warn({ modSlug }, "No pages cached for mod; background refresh requested");

        if (directSlug) {
          const fallbackUrl = `${this.wikiClient.getBaseUrl()}/mod/${modSlug}/${directSlug}`;
          if (await this.wikiClient.pageExists(fallbackUrl)) {
            return {
              status: "found",
              resolvedModSlug: modSlug,
              resolvedUrl: fallbackUrl,
              resolvedTitle: null,
              explanation: "Resolved by direct URL fallback while cache warms.",
              candidates: []
            };
          }
        }

        continue;
      }

      candidates.push(...this.rankCandidates(modSlug, pages, parsed.pageQuery));
    }

    const topCandidates = candidates.sort((a, b) => b.score - a.score).slice(0, 5);
    const top = topCandidates[0];
    if (top && top.score >= this.similarityThreshold) {
      return {
        status: "did_you_mean",
        resolvedModSlug: top.modSlug,
        resolvedUrl: top.url,
        resolvedTitle: top.title,
        explanation: `Did you mean ${top.title}?`,
        candidates: topCandidates.slice(1, 4)
      };
    }

    if (this.contentSearchEnabled) {
      const contentCandidates = await this.searchByContent(orderedMods, parsed.pageQuery);
      const contentTop = contentCandidates[0];
      if (contentTop) {
        return {
          status: "did_you_mean",
          resolvedModSlug: contentTop.modSlug,
          resolvedUrl: contentTop.url,
          resolvedTitle: contentTop.title,
          explanation: `Matched page content: ${contentTop.title}`,
          candidates: contentCandidates.slice(1, 4)
        };
      }
    }

    if (!top) {
      return {
        status: "no_match",
        resolvedModSlug: orderedMods[0] ?? null,
        resolvedUrl: null,
        resolvedTitle: null,
        explanation: "No matching wiki page found.",
        candidates: []
      };
    }

    return {
      status: "no_match",
      resolvedModSlug: top.modSlug,
      resolvedUrl: null,
      resolvedTitle: null,
      explanation: "No confident match found.",
      candidates: topCandidates.slice(0, 3)
    };
  }

  private rankCandidates(
    modSlug: string,
    pages: Array<{ pageSlug: string; title: string; normalizedTitle: string; url: string }>,
    pageQuery: string
  ): CandidatePage[] {
    const normalizedQuery = normalizeText(pageQuery);
    const querySlug = slugify(pageQuery);

    return pages
      .map((page) => {
        const slugScore = similarityScore(querySlug, page.pageSlug);
        const titleScore = similarityScore(normalizedQuery, page.normalizedTitle);
        const containsBonus =
          page.normalizedTitle.includes(normalizedQuery) || page.pageSlug.includes(querySlug) ? 0.2 : 0;

        let score = Math.max(slugScore, titleScore) + containsBonus;
        if (page.pageSlug === querySlug) {
          score += 0.4;
        }

        if (page.normalizedTitle === normalizedQuery) {
          score += 0.5;
        }

        return {
          modSlug,
          pageSlug: page.pageSlug,
          title: page.title,
          url: page.url,
          score: Math.min(1, score)
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  private async searchByContent(modSlugs: string[], pageQuery: string): Promise<CandidatePage[]> {
    const rawCandidates: CandidatePage[] = [];

    for (const modSlug of modSlugs) {
      try {
        const results = await this.wikiClient.searchModPages(modSlug, pageQuery, this.contentSearchLimit);
        rawCandidates.push(
          ...results.map((result, index) => ({
            modSlug: result.modSlug,
            pageSlug: result.pageSlug,
            title: result.title,
            url: result.url,
            score: this.scoreContentCandidate(pageQuery, result, index)
          }))
        );
      } catch (error) {
        this.logger.warn({ modSlug, err: error }, "Content search request failed; using cached matching fallback");
      }
    }

    const deduped = new Map<string, CandidatePage>();

    for (const candidate of rawCandidates) {
      const existing = deduped.get(candidate.url);
      if (!existing || candidate.score > existing.score) {
        deduped.set(candidate.url, candidate);
      }
    }

    return Array.from(deduped.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  private scoreContentCandidate(pageQuery: string, result: WikiContentSearchResult, index: number): number {
    const normalizedQuery = normalizeText(pageQuery);
    const querySlug = slugify(pageQuery);
    const titleScore = similarityScore(normalizedQuery, normalizeText(result.title));
    const slugScore = similarityScore(querySlug, result.pageSlug);
    const rankBase = Math.max(0.35, 0.75 - index * 0.08);
    const normalizedSnippet = normalizeText(result.snippet);
    const snippetBonus = normalizedQuery && normalizedSnippet.includes(normalizedQuery) ? 0.15 : 0;

    let score = Math.max(rankBase, titleScore, slugScore) + snippetBonus;
    if (normalizeText(result.title) === normalizedQuery || result.pageSlug === querySlug) {
      score += 0.2;
    }

    return Math.min(1, score);
  }

  private async resolveModsAndQuery(
    guildId: string,
    query: string,
    explicitModInput?: string
  ): Promise<ResolvedLookupScope> {
    if (explicitModInput?.trim()) {
      const modSlug = await this.resolveModIdentifier(guildId, explicitModInput);
      return {
        modSlugs: modSlug ? [modSlug] : [],
        pageQuery: query.trim()
      };
    }

    const tokens = query.trim().split(/\s+/).filter(Boolean);
    const aliasToken = tokens[0]?.toLowerCase();
    if (aliasToken) {
      const modFromAlias = await this.aliasRepo.getModSlugByAlias(guildId, aliasToken);
      if (modFromAlias) {
        return {
          modSlugs: [modFromAlias],
          pageQuery: tokens.slice(1).join(" ").trim()
        };
      }
    }

    const defaultMods = await this.guildSettingsRepo.getDefaultModSlugs(guildId);
    return {
      modSlugs: defaultMods,
      pageQuery: query.trim()
    };
  }
}

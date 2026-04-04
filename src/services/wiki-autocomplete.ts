import { AliasRepository } from "../db/repositories/alias-repo.js";
import { CacheRepository } from "../db/repositories/cache-repo.js";
import { GuildSettingsRepository } from "../db/repositories/guild-settings-repo.js";
import type { AutocompleteResult, PageRecord } from "../types/contracts.js";
import { normalizeText, slugify } from "../utils.js";
import { WikiLookupService } from "./wiki-lookup.js";

const MAX_CHOICES = 25;
const MAX_FIELD_LENGTH = 100;

function truncate(input: string): string {
  return input.length <= MAX_FIELD_LENGTH ? input : input.slice(0, MAX_FIELD_LENGTH);
}

export class WikiAutocompleteService {
  public constructor(
    private readonly aliasRepo: AliasRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly guildSettingsRepo: GuildSettingsRepository,
    private readonly lookupService: WikiLookupService
  ) {}

  public async autocompleteMod(guildId: string, value: string): Promise<AutocompleteResult[]> {
    const normalized = value.trim().toLowerCase();
    const aliasMatches = (await this.aliasRepo.listAliases(guildId))
      .filter((entry) => entry.alias.includes(normalized) || entry.modSlug.includes(normalized))
      .slice(0, 10)
      .map((entry) => ({
        name: truncate(`${entry.alias} -> ${entry.modSlug}`),
        value: truncate(entry.alias),
        score: 1,
        source: "alias" as const
      }));

    const modMatches = await this.cacheRepo.searchMods(value, 15);
    const modResults = modMatches.map((mod, index) => ({
      name: truncate(`${mod.name} (${mod.slug})`),
      value: truncate(mod.slug),
      score: 1 - index * 0.01,
      source: "mod" as const
    }));

    return this.deduplicate([...aliasMatches, ...modResults]).slice(0, MAX_CHOICES);
  }

  public async autocompleteQuery(params: {
    guildId: string;
    typedQuery: string;
    explicitModInput?: string;
  }): Promise<AutocompleteResult[]> {
    const typed = params.typedQuery.trim();
    const explicitMod = params.explicitModInput?.trim();

    if (!typed && !explicitMod) {
      const aliases = await this.aliasRepo.listAliases(params.guildId);
      return aliases.slice(0, MAX_CHOICES).map((entry) => ({
        name: truncate(`${entry.alias} …`),
        value: truncate(`${entry.alias} `),
        score: 1,
        source: "alias"
      }));
    }

    if (explicitMod) {
      const modSlug = await this.lookupService.resolveModIdentifier(params.guildId, explicitMod);
      if (!modSlug) {
        return [];
      }

      return this.buildPageSuggestions(modSlug, typed, undefined);
    }

    const tokens = typed.split(/\s+/).filter(Boolean);
    const aliasToken = tokens[0]?.toLowerCase();

    if (aliasToken) {
      const aliasMod = await this.aliasRepo.getModSlugByAlias(params.guildId, aliasToken);
      if (aliasMod) {
        const remainder = tokens.slice(1).join(" ");
        return this.buildPageSuggestions(aliasMod, remainder, aliasToken);
      }
    }

    const defaultMods = await this.guildSettingsRepo.getDefaultModSlugs(params.guildId);
    if (defaultMods.length === 1) {
      return this.buildPageSuggestions(defaultMods[0] as string, typed, undefined);
    }

    if (defaultMods.length > 1) {
      return this.buildPageSuggestionsForMods(defaultMods, typed);
    }

    const aliases = await this.aliasRepo.listAliases(params.guildId);
    return aliases
      .filter((entry) => entry.alias.startsWith(aliasToken ?? "") || entry.alias.includes(typed.toLowerCase()))
      .slice(0, MAX_CHOICES)
      .map((entry) => ({
        name: truncate(`${entry.alias} …`),
        value: truncate(`${entry.alias} `),
        score: 0.8,
        source: "alias"
      }));
  }

  private async buildPageSuggestions(
    modSlug: string,
    query: string,
    aliasPrefix?: string
  ): Promise<AutocompleteResult[]> {
    const pages = await this.cacheRepo.listPagesByModSlug(modSlug);
    if (pages.length === 0) {
      return [];
    }

    const ranked = this.rankPages(pages, query).slice(0, MAX_CHOICES);

    return ranked.map((entry) => {
      const value = aliasPrefix ? `${aliasPrefix} ${entry.page.title}` : entry.page.title;
      return {
        name: truncate(entry.page.title),
        value: truncate(value),
        score: entry.score,
        source: "page"
      };
    });
  }

  private async buildPageSuggestionsForMods(modSlugs: string[], query: string): Promise<AutocompleteResult[]> {
    const output: AutocompleteResult[] = [];

    for (const modSlug of modSlugs) {
      const pages = await this.cacheRepo.listPagesByModSlug(modSlug);
      const ranked = this.rankPages(pages, query).slice(0, 8);

      for (const entry of ranked) {
        output.push({
          name: truncate(`${entry.page.title} (${modSlug})`),
          value: truncate(entry.page.title),
          score: entry.score,
          source: "page"
        });
      }
    }

    return this.deduplicate(output)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CHOICES);
  }

  private rankPages(pages: PageRecord[], query: string): Array<{ page: PageRecord; score: number }> {
    const normalizedQuery = normalizeText(query);
    const slugQuery = slugify(query);

    if (!normalizedQuery) {
      return pages.slice(0, MAX_CHOICES).map((page, index) => ({
        page,
        score: 1 - index * 0.01
      }));
    }

    return pages
      .map((page) => {
        const titleHit = page.normalizedTitle.includes(normalizedQuery) ? 0.7 : 0;
        const slugHit = page.pageSlug.includes(slugQuery) ? 0.6 : 0;
        const tokenOverlap = normalizeText(page.title)
          .split(" ")
          .filter((token) => normalizedQuery.includes(token)).length;

        return {
          page,
          score: titleHit + slugHit + tokenOverlap * 0.05
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  private deduplicate(items: AutocompleteResult[]): AutocompleteResult[] {
    const seen = new Set<string>();
    const output: AutocompleteResult[] = [];

    for (const item of items) {
      if (seen.has(item.value)) {
        continue;
      }
      seen.add(item.value);
      output.push(item);
    }

    return output;
  }
}

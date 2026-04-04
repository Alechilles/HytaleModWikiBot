import { describe, expect, it } from "vitest";
import { WikiLookupService } from "../src/services/wiki-lookup.js";

function createLookupService(overrides?: {
  aliasMap?: Record<string, string>;
  defaultMod?: string | null;
  defaultMods?: string[];
}) {
  const aliasMap = overrides?.aliasMap ?? { ah: "alecs-animal-husbandry" };
  const defaultMods = overrides?.defaultMods ?? (overrides?.defaultMod ? [overrides.defaultMod] : []);

  const pages = [
    {
      modSlug: "alecs-animal-husbandry",
      pageSlug: "beast-taming-reference",
      title: "Beast Taming Reference",
      normalizedTitle: "beast taming reference",
      url: "https://wiki.hytalemodding.dev/mod/alecs-animal-husbandry/beast-taming-reference",
      parentSlug: null,
      depth: 0,
      updatedAt: new Date().toISOString()
    },
    {
      modSlug: "alecs-animal-husbandry",
      pageSlug: "livestock-taming-reference",
      title: "Livestock Taming Reference",
      normalizedTitle: "livestock taming reference",
      url: "https://wiki.hytalemodding.dev/mod/alecs-animal-husbandry/livestock-taming-reference",
      parentSlug: null,
      depth: 0,
      updatedAt: new Date().toISOString()
    },
    {
      modSlug: "alecs-tamework",
      pageSlug: "command-items",
      title: "Command Items",
      normalizedTitle: "command items",
      url: "https://wiki.hytalemodding.dev/mod/alecs-tamework/command-items",
      parentSlug: null,
      depth: 0,
      updatedAt: new Date().toISOString()
    }
  ];

  const aliasRepo = {
    getModSlugByAlias: async (_guildId: string, alias: string) => aliasMap[alias] ?? null,
    listAliases: async () =>
      Object.entries(aliasMap).map(([alias, modSlug]) => ({
        guildId: "1",
        alias,
        modSlug,
        createdBy: "2",
        updatedAt: new Date().toISOString()
      }))
  };

  const cacheRepo = {
    getModBySlug: async (slug: string) =>
      slug === "alecs-animal-husbandry" || slug === "alecs-tamework"
        ? {
            slug,
            name: slug === "alecs-animal-husbandry" ? "Alec's Animal Husbandry!" : "Alec's Tamework",
            ownerName: "Alec",
            sourceUrl: `https://wiki.hytalemodding.dev/mod/${slug}`,
            lastIndexedAt: new Date().toISOString()
          }
        : null,
    searchMods: async () => [],
    findPageByExactSlug: async (modSlug: string, pageSlug: string) =>
      pages.find((page) => page.modSlug === modSlug && page.pageSlug === pageSlug) ?? null,
    findPageByExactTitle: async (modSlug: string, title: string) =>
      pages.find((page) => page.modSlug === modSlug && page.normalizedTitle === title.toLowerCase()) ?? null,
    listPagesByModSlug: async (modSlug: string) => pages.filter((page) => page.modSlug === modSlug),
    getModLastIndexedAt: async () => new Date()
  };

  const guildSettingsRepo = {
    getDefaultModSlug: async () => defaultMods[0] ?? null,
    getDefaultModSlugs: async () => defaultMods
  };

  const indexer = {
    ensureFresh: async () => ({ stale: false, missing: false })
  };

  const wikiClient = {
    getBaseUrl: () => "https://wiki.hytalemodding.dev",
    pageExists: async () => false
  };

  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };

  return new WikiLookupService(
    aliasRepo as any,
    cacheRepo as any,
    guildSettingsRepo as any,
    indexer as any,
    wikiClient as any,
    0.58,
    logger as any
  );
}

describe("WikiLookupService", () => {
  it("resolves alias + query to exact canonical URL", async () => {
    const service = createLookupService();
    const result = await service.lookup({
      guildId: "1",
      userId: "2",
      query: "ah beast taming reference"
    });

    expect(result.status).toBe("found");
    expect(result.resolvedUrl).toBe(
      "https://wiki.hytalemodding.dev/mod/alecs-animal-husbandry/beast-taming-reference"
    );
  });

  it("uses guild default mod when alias is not present", async () => {
    const service = createLookupService({ aliasMap: {}, defaultMod: "alecs-animal-husbandry" });
    const result = await service.lookup({
      guildId: "1",
      userId: "2",
      query: "beast taming reference"
    });

    expect(result.status).toBe("found");
    expect(result.resolvedModSlug).toBe("alecs-animal-husbandry");
  });

  it("returns did_you_mean for strong fuzzy candidate", async () => {
    const service = createLookupService({ aliasMap: {}, defaultMods: ["alecs-animal-husbandry"] });
    const result = await service.lookup({
      guildId: "1",
      userId: "2",
      query: "beast taming"
    });

    expect(result.status).toBe("did_you_mean");
    expect(result.resolvedUrl).toContain("beast-taming-reference");
  });

  it("returns mod_not_resolved when no alias and no default", async () => {
    const service = createLookupService({ aliasMap: {}, defaultMod: null });
    const result = await service.lookup({
      guildId: "1",
      userId: "2",
      query: "beast taming reference"
    });

    expect(result.status).toBe("mod_not_resolved");
  });

  it("searches across multiple defaults for non-prefixed query", async () => {
    const service = createLookupService({ aliasMap: {}, defaultMods: ["alecs-animal-husbandry", "alecs-tamework"] });
    const result = await service.lookup({
      guildId: "1",
      userId: "2",
      query: "command items"
    });

    expect(result.status).toBe("found");
    expect(result.resolvedModSlug).toBe("alecs-tamework");
    expect(result.resolvedUrl).toBe("https://wiki.hytalemodding.dev/mod/alecs-tamework/command-items");
  });
});

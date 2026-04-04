import { describe, expect, it } from "vitest";
import { WikiIndexer } from "../src/services/wiki-indexer.js";

describe("WikiIndexer", () => {
  it("ingests all mods and flattens nested page trees", async () => {
    const modUpserts: string[] = [];
    const pageUpserts: Array<{ slug: string; pages: number }> = [];

    const cacheRepo = {
      getModLastIndexedAt: async () => new Date(),
      upsertMod: async (mod: { slug: string }) => {
        modUpserts.push(mod.slug);
      },
      upsertPages: async (slug: string, pages: Array<{ pageSlug: string }>) => {
        pageUpserts.push({ slug, pages: pages.length });
      }
    };

    const wikiClient = {
      fetchAllMods: async () => [
        { slug: "alecs-animal-husbandry", name: "AH", ownerName: "Alec" },
        { slug: "alecs-tamework", name: "AT", ownerName: "Alec" }
      ],
      fetchModDetails: async (slug: string) => ({
        slug,
        name: slug,
        ownerName: "Alec",
        rootPages: [
          {
            slug: "home",
            title: "Home",
            children: [{ slug: "beast-taming-reference", title: "Beast Taming Reference", children: [] }]
          }
        ],
        raw: { slug }
      }),
      getBaseUrl: () => "https://wiki.hytalemodding.dev"
    };

    const logger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    };

    const indexer = new WikiIndexer(cacheRepo as any, wikiClient as any, logger as any, 24);
    await indexer.refreshAllMods();

    expect(modUpserts).toEqual(["alecs-animal-husbandry", "alecs-tamework"]);
    expect(pageUpserts).toEqual([
      { slug: "alecs-animal-husbandry", pages: 2 },
      { slug: "alecs-tamework", pages: 2 }
    ]);
  });
});

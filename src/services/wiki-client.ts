import he from "he";

interface InertiaEnvelope {
  props?: {
    mods?: {
      data?: Array<{ slug: string; name: string; owner?: { name?: string } }>;
      current_page?: number;
      last_page?: number;
    };
    mod?: {
      slug: string;
      name: string;
      owner?: { name?: string };
      root_pages?: WikiPageNode[];
    };
  };
}

export interface WikiPageNode {
  slug: string;
  title: string;
  children?: WikiPageNode[];
}

export interface WikiModSummary {
  slug: string;
  name: string;
  ownerName: string | null;
}

export interface WikiModDetail {
  slug: string;
  name: string;
  ownerName: string | null;
  rootPages: WikiPageNode[];
  raw: unknown;
}

export interface WikiContentSearchResult {
  modSlug: string;
  pageSlug: string;
  title: string;
  url: string;
  snippet: string;
}

export class WikiClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string
  ) {}

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public async fetchAllMods(): Promise<WikiModSummary[]> {
    const collected: WikiModSummary[] = [];
    let page = 1;
    let lastPage = 1;

    do {
      const payload = await this.fetchModsPage(page);
      collected.push(...payload.mods);
      lastPage = payload.lastPage;
      page += 1;
    } while (page <= lastPage);

    return collected;
  }

  public async fetchModsPage(page: number): Promise<{ mods: WikiModSummary[]; lastPage: number }> {
    const url = new URL("/mods", this.baseUrl);
    url.searchParams.set("page", String(page));

    const html = await this.getText(url.toString());
    const inertia = this.extractInertiaPayload(html);

    const rawMods = inertia.props?.mods?.data ?? [];
    const mods = rawMods.map((mod) => ({
      slug: mod.slug,
      name: mod.name,
      ownerName: mod.owner?.name ?? null
    }));

    return {
      mods,
      lastPage: inertia.props?.mods?.last_page ?? page
    };
  }

  public async fetchModDetails(modSlug: string): Promise<WikiModDetail> {
    const url = `${this.baseUrl}/mod/${modSlug}`;
    const html = await this.getText(url);
    const inertia = this.extractInertiaPayload(html);
    const mod = inertia.props?.mod;

    if (!mod || !mod.slug) {
      throw new Error(`Invalid mod payload for ${modSlug}`);
    }

    return {
      slug: mod.slug,
      name: mod.name,
      ownerName: mod.owner?.name ?? null,
      rootPages: mod.root_pages ?? [],
      raw: inertia
    };
  }

  public async pageExists(url: string): Promise<boolean> {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "HytaleModWikiBot/0.1"
      }
    });

    return response.status === 200;
  }

  public async searchModPages(modSlug: string, query: string, limit = 10): Promise<WikiContentSearchResult[]> {
    if (!this.apiKey) {
      return [];
    }

    const url = new URL(`/api/mods/${encodeURIComponent(modSlug)}/pages/search`, this.baseUrl);
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(limit));

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": "HytaleModWikiBot/0.1",
        Authorization: `Bearer ${this.apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error(`Wiki content search failed: ${response.status} ${url.toString()}`);
    }

    const payload = (await response.json()) as { results?: unknown[] };
    const rawResults = Array.isArray(payload.results) ? payload.results : [];

    return rawResults
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        const typed = entry as Record<string, unknown>;
        const pageSlug = typeof typed.slug === "string" ? typed.slug : null;
        const title = typeof typed.title === "string" ? typed.title : null;
        const urlValue = typeof typed.url === "string" ? typed.url : null;
        if (!pageSlug || !title || !urlValue) {
          return null;
        }

        return {
          modSlug,
          pageSlug,
          title,
          url: urlValue,
          snippet: typeof typed.snippet === "string" ? typed.snippet : ""
        } satisfies WikiContentSearchResult;
      })
      .filter((entry): entry is WikiContentSearchResult => entry !== null);
  }

  private async getText(url: string): Promise<string> {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "HytaleModWikiBot/0.1"
      }
    });

    if (!response.ok) {
      throw new Error(`Wiki request failed: ${response.status} ${url}`);
    }

    return await response.text();
  }

  private extractInertiaPayload(html: string): InertiaEnvelope {
    const match = html.match(/data-page="([\s\S]*?)"/i);
    if (!match) {
      throw new Error("Inertia data-page payload not found");
    }

    const payload = match[1];
    if (!payload) {
      throw new Error("Inertia payload capture was empty");
    }

    const decoded = he.decode(payload);
    return JSON.parse(decoded) as InertiaEnvelope;
  }
}

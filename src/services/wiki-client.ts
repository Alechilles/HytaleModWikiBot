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

export class WikiClient {
  public constructor(private readonly baseUrl: string) {}

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

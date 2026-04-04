export type VisibilityMode = "ephemeral" | "public";
export type EmbedMode = "enabled" | "disabled";

export interface GuildSettings {
  guildId: string;
  defaultModSlug: string | null;
  visibilityMode: VisibilityMode;
  embedMode: EmbedMode;
}

export interface ModAlias {
  guildId: string;
  alias: string;
  modSlug: string;
  createdBy: string;
  updatedAt: string;
}

export interface ModSummary {
  slug: string;
  name: string;
  ownerName: string | null;
  sourceUrl: string;
  lastIndexedAt: string;
}

export interface PageRecord {
  modSlug: string;
  pageSlug: string;
  title: string;
  normalizedTitle: string;
  url: string;
  parentSlug: string | null;
  depth: number;
  updatedAt: string;
}

export interface CandidatePage {
  modSlug: string;
  pageSlug: string;
  title: string;
  url: string;
  score: number;
}

export interface WikiLookupInput {
  guildId: string;
  userId: string;
  query: string;
  explicitModInput?: string;
}

export type WikiLookupStatus =
  | "found"
  | "did_you_mean"
  | "no_match"
  | "mod_not_resolved"
  | "missing_query";

export interface WikiLookupResult {
  status: WikiLookupStatus;
  resolvedModSlug: string | null;
  resolvedUrl: string | null;
  resolvedTitle: string | null;
  explanation: string;
  candidates: CandidatePage[];
}

export interface AutocompleteResult {
  name: string;
  value: string;
  score: number;
  source: "alias" | "mod" | "page" | "query";
}

export type RateLimitScope = "user" | "guild" | "autocomplete";

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec: number;
  scope: RateLimitScope;
}

export interface ButtonPayload {
  url: string;
  candidates: CandidatePage[];
  createdAt: number;
}

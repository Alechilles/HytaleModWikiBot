import { createHash } from "node:crypto";

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ");
}

export function splitWords(input: string): string[] {
  return normalizeText(input).split(" ").filter(Boolean);
}

export function similarityScore(a: string, b: string): number {
  const left = splitWords(a);
  const right = splitWords(b);

  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let overlap = 0;

  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap += 1;
    }
  }

  const jaccard = overlap / (leftSet.size + rightSet.size - overlap);

  const aSlug = slugify(a);
  const bSlug = slugify(b);
  const prefixBonus = aSlug.startsWith(bSlug) || bSlug.startsWith(aSlug) ? 0.1 : 0;

  return Math.min(1, jaccard + prefixBonus);
}

export function shortHash(parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
  return hash.slice(0, 16);
}

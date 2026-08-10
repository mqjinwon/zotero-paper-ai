import type { Claim } from "./types";

export const NORMALIZE_SYSTEM = [
  "You normalize research-paper claims for retrieval.",
  "Translate each claim to English (text_en) for matching an English paper.",
  "Preserve technical terms, acronyms, and numeric tokens exactly.",
  "If the claim is already English, text_en may equal the original.",
  "Respond with JSON only, no markdown fences:",
  '{"claims":[{"id":"c1","text_en":"…","must_terms":[],"numbers":[]}]}',
].join(" ");

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

/** Merge LLM normalize batch onto claims by id (or order fallback). */
export function applyNormalizeResult(
  claims: Claim[],
  raw: unknown,
): Claim[] {
  if (!claims.length) return [];
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const arr = Array.isArray(obj.claims)
    ? obj.claims
    : Array.isArray(raw)
      ? raw
      : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = String(o.id || "").trim();
    if (id) byId.set(id, o);
  }

  return claims.map((c, i) => {
    const o = byId.get(c.id) || (arr[i] as Record<string, unknown> | undefined);
    if (!o || typeof o !== "object") return { ...c };
    const textEn = String(o.text_en ?? o.textEn ?? c.textEn ?? c.text)
      .trim()
      .slice(0, 400);
    const mustTerms = asStringArray(o.must_terms ?? o.mustTerms);
    const numbers = asStringArray(o.numbers);
    return {
      ...c,
      textEn: textEn || c.textEn || c.text,
      mustTerms: mustTerms.length ? mustTerms : c.mustTerms,
      numbers: numbers.length ? numbers : c.numbers,
    };
  });
}

export function buildNormalizeSystem(): string {
  return NORMALIZE_SYSTEM;
}

export function buildNormalizeUser(claims: Claim[]): string {
  const payload = claims.map((c) => ({
    id: c.id,
    text: c.text,
    type: c.type,
    must_terms: c.mustTerms,
    numbers: c.numbers,
  }));
  return [
    "Normalize these claims for English paper retrieval.",
    "Return JSON with the same claim ids:",
    JSON.stringify({ claims: payload }, null, 2),
  ].join("\n");
}

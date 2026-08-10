import { extractClaimSpans } from "../groundAnswer";
import type { Claim, ClaimType } from "./types";

const TYPES = new Set<ClaimType>([
  "method",
  "result",
  "definition",
  "comparison",
  "other",
]);

function asType(v: unknown): ClaimType {
  const s = String(v || "other").toLowerCase() as ClaimType;
  return TYPES.has(s) ? s : "other";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

export function parseClaimsJson(raw: unknown, maxClaims = 8): Claim[] {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const arr = Array.isArray(obj.claims)
    ? obj.claims
    : Array.isArray(raw)
      ? raw
      : [];
  const out: Claim[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const text = String(o.text || o.claim || "").trim();
    if (text.length < 8) continue;
    const id = `c${out.length + 1}`;
    out.push({
      id,
      text: text.slice(0, 400),
      textEn: String(o.text_en || o.textEn || text)
        .trim()
        .slice(0, 400),
      type: asType(o.type),
      mustTerms: asStringArray(o.must_terms ?? o.mustTerms),
      numbers: asStringArray(o.numbers),
    });
    if (out.length >= maxClaims) break;
  }
  return out;
}

export function claimsFromAnswerRules(
  answer: string,
  maxClaims = 8,
): Claim[] {
  const spans = extractClaimSpans(answer, { minChars: 12 }).slice(0, maxClaims);
  return spans.map((text, i) => ({
    id: `c${i + 1}`,
    text,
    textEn: text,
    type: "other" as const,
    mustTerms: [],
    numbers: [],
  }));
}

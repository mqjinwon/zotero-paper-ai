/**
 * Pick child/abstract chunks as LLM candidates (token budget + section bias).
 */

import type { IndexedChunk, PaperIndex } from "../types";
import { estimateTokens } from "../chunk";

export interface CandidatePassage {
  id: string;
  section: string;
  text: string;
  pageStart?: number;
  paraStart?: number;
  sentStart?: number;
}

const BIAS: Array<{ re: RegExp; w: number }> = [
  { re: /abstract/i, w: 3 },
  { re: /introduction/i, w: 2.5 },
  { re: /conclusion/i, w: 2.5 },
  { re: /contribution|novel/i, w: 2.2 },
  { re: /method|approach|experiment/i, w: 2 },
  { re: /result|finding/i, w: 2 },
  { re: /limitation|discussion/i, w: 1.8 },
  { re: /related/i, w: 0.6 },
  { re: /reference/i, w: 0.2 },
];

function sectionWeight(section: string): number {
  let w = 1;
  for (const b of BIAS) {
    if (b.re.test(section)) w = Math.max(w, b.w);
  }
  return w;
}

/**
 * Select up to `maxPassages` search units for classification.
 * Prefers shorter children with section bias; skips tiny/boilerplate.
 */
export function selectCandidatePassages(
  index: PaperIndex,
  opts?: { maxPassages?: number; maxTokens?: number },
): CandidatePassage[] {
  const maxPassages = opts?.maxPassages ?? 28;
  const maxTokens = opts?.maxTokens ?? 6000;

  const units = index.chunks.filter(
    (c) =>
      (c.kind === "child" || c.kind === "abstract") &&
      (c.text || "").trim().length >= 40,
  );

  const scored = units
    .map((c) => {
      const text = c.text.trim();
      const tok = estimateTokens(text);
      // Prefer mid-length informative units
      const lengthScore =
        tok < 40 ? 0.5 : tok < 120 ? 1.2 : tok < 280 ? 1 : 0.7;
      const score = sectionWeight(c.section) * lengthScore;
      return { c, score, tok };
    })
    .sort((a, b) => b.score - a.score);

  const out: CandidatePassage[] = [];
  let used = 0;
  const seen = new Set<string>();

  for (const { c, tok } of scored) {
    if (out.length >= maxPassages) break;
    if (used + tok > maxTokens) continue;
    const key = c.text.slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toCandidate(c));
    used += tok;
  }

  return out;
}

function toCandidate(c: IndexedChunk): CandidatePassage {
  return {
    id: c.id,
    section: c.section,
    text: c.text.trim(),
    pageStart: c.pageStart,
    paraStart: c.paraStart,
    sentStart: c.sentStart,
  };
}

/** Flat text block for the classifier prompt. */
export function formatCandidatesForPrompt(
  candidates: CandidatePassage[],
): string {
  return candidates
    .map((c, i) => {
      const loc = [
        c.section,
        c.paraStart != null ? `¶${c.paraStart}` : "",
        c.sentStart != null ? `s${c.sentStart}` : "",
        c.pageStart != null ? `p.${c.pageStart}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `### C${i + 1} [${c.id}] ${loc}\n${c.text}`;
    })
    .join("\n\n");
}

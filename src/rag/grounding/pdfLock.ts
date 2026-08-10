import { pickLinkPhrase } from "../groundAnswer";
import type { Claim, Judgment, LockedEvidence } from "./types";

export interface LocateHit {
  pageIndex: number;
  pageLabel: string;
  rects: number[][];
  matchedText: string;
}

/** Progressive needle variants for PDF.js locate (fail-closed). */
export function buildNeedleVariants(sentence: string): string[] {
  const full = sentence.replace(/\s+/g, " ").trim();
  const out: string[] = [];
  if (full) out.push(full);
  // hyphen heal
  const healed = full.replace(/(\w)-\s+(\w)/g, "$1$2");
  if (healed !== full) out.push(healed);
  // progressive shorten by sentence clauses
  const parts = full.split(/(?<=[,:;])\s+/);
  if (parts.length > 1) {
    let acc = parts[0];
    for (let i = 1; i < parts.length; i++) {
      acc = `${acc} ${parts[i]}`.trim();
      if (acc.length >= 28) out.push(acc);
    }
  }
  // longest prefix windows
  for (const len of [160, 100, 64]) {
    if (full.length > len) out.push(full.slice(0, len).trim());
  }
  // dedupe
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = s.toLowerCase();
    if (seen.has(k) || s.length < 12) return false;
    seen.add(k);
    return true;
  });
}

function resolveAnswerPhrase(claim: Claim, paper: string): string {
  const fromText = pickLinkPhrase(claim.text, paper);
  if (
    fromText &&
    claim.text.toLowerCase().includes(fromText.toLowerCase())
  ) {
    return fromText;
  }
  const fromEn = pickLinkPhrase(claim.textEn, paper);
  if (
    fromEn &&
    claim.text.toLowerCase().includes(fromEn.toLowerCase())
  ) {
    return fromEn;
  }
  // Surface from claim.text even when tokens only match English paper
  const slice = claim.text.slice(0, Math.min(80, claim.text.length)).trim();
  return slice.length >= 3 ? slice : claim.text.slice(0, 60);
}

/**
 * Only emit LockedEvidence when judge says support AND locate succeeds.
 */
export async function lockJudgmentToPdf(opts: {
  claim: Claim;
  judgment: Judgment;
  locate: (quote: string) => Promise<LocateHit | null>;
}): Promise<LockedEvidence | null> {
  if (opts.judgment.label !== "support" || !opts.judgment.paperSentence) {
    return null;
  }
  const paper = opts.judgment.paperSentence;
  for (const needle of buildNeedleVariants(paper)) {
    let hit: LocateHit | null = null;
    try {
      hit = await opts.locate(needle);
    } catch {
      hit = null;
    }
    if (!hit) continue;
    // require a real locate hit (page and/or rects)
    const hasPage = hit.pageIndex != null && Number.isFinite(hit.pageIndex);
    const hasRects = Array.isArray(hit.rects) && hit.rects.length > 0;
    if (!hasPage && !hasRects) continue;

    const answerPhrase = resolveAnswerPhrase(opts.claim, paper);
    return {
      claimId: opts.claim.id,
      answerPhrase,
      paperSentence: paper,
      // 1-based page label for data-page / #paperai-page-N (matches legacy)
      pageStart: hasPage ? hit.pageIndex + 1 : undefined,
      section: undefined,
      rects: hasRects ? hit.rects : undefined,
      locateOk: true,
      source: "hq-locked",
    };
  }
  return null;
}

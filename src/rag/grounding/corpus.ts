import type { PaperSentence } from "../groundAnswer";

/** Evidence-like chunks used when full paper sentences are unavailable. */
type EvidenceLike = {
  chunk?: {
    id?: string;
    anchorText?: string;
    text?: string;
    pageStart?: number;
    pageEnd?: number;
    section?: string;
  };
  contextText?: string;
};

/**
 * Prefer full paperSentences; if empty, map retrieved evidence into
 * PaperSentence rows (≥28 chars, clip 420) for post-hoc grounding.
 */
export function buildGroundingCorpus(
  paperSentences: PaperSentence[] | undefined | null,
  evidence?: EvidenceLike[] | null,
): PaperSentence[] {
  const fromPaper = paperSentences || [];
  if (fromPaper.length) return fromPaper;

  if (!evidence?.length) return [];

  return evidence
    .map((e) => {
      const text = (
        e.chunk?.anchorText ||
        e.chunk?.text ||
        e.contextText ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      if (text.length < 28) return null;
      return {
        text: text.length > 420 ? `${text.slice(0, 419).trim()}…` : text,
        pageStart: e.chunk?.pageStart,
        pageEnd: e.chunk?.pageEnd,
        section: e.chunk?.section,
        chunkId: e.chunk?.id,
      } as PaperSentence;
    })
    .filter(Boolean) as PaperSentence[];
}

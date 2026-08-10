/**
 * Map legacy PaperSentence[] (+ evidence chunk ids) → grounding PaperSentenceRef[].
 */

import type { PaperSentence } from "../groundAnswer";
import type { PaperSentenceRef } from "./types";

/** Map PaperSentence[] + evidence chunk ids → grounding refs. */
export function toSentenceRefs(
  sents: PaperSentence[],
  evidenceChunkIds: Set<string> = new Set(),
): PaperSentenceRef[] {
  return sents.map((s, i) => ({
    id: s.chunkId ? `${s.chunkId}:${i}` : `s${i}`,
    text: s.text,
    pageStart: s.pageStart,
    pageEnd: s.pageEnd,
    section: s.section,
    chunkId: s.chunkId,
    fromEvidence: !!(s.chunkId && evidenceChunkIds.has(s.chunkId)),
  }));
}

/** True when items already look like PaperSentenceRef (have string id). */
export function isPaperSentenceRefArray(
  sents: Array<PaperSentence | PaperSentenceRef>,
): sents is PaperSentenceRef[] {
  if (!sents.length) return true;
  const first = sents[0] as PaperSentenceRef;
  return typeof first.id === "string" && first.id.length > 0;
}

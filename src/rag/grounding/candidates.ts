import { buildBm25, bm25Scores } from "../bm25";
import { cosine } from "../embed";
import { rrfFuse } from "./rrf";
import type { Candidate, Claim, PaperSentenceRef } from "./types";

export interface RetrieveCandidatesOpts {
  topN?: number; // default 15
  embedClaim?: number[] | null;
  /** If set, use these embeddings aligned to corpus indices (same length) */
  corpusEmbeddings?: Array<number[] | undefined> | null;
}

export function retrieveCandidates(
  claim: Claim,
  corpus: PaperSentenceRef[],
  opts?: RetrieveCandidatesOpts,
): Candidate[] {
  const topN = opts?.topN ?? 15;
  if (!corpus.length) return [];

  const query = [claim.textEn || claim.text, ...claim.mustTerms]
    .filter(Boolean)
    .join(" ");
  const bm25 = buildBm25(corpus.map((s) => s.text));
  const scores = bm25Scores(bm25, query);
  const bm25Ranked = scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .map((x) => corpus[x.i].id);

  const lists: string[][] = [bm25Ranked];
  let usedDense = false;
  const denseScore = new Map<string, number>();

  if (
    opts?.embedClaim?.length &&
    opts.corpusEmbeddings?.length === corpus.length
  ) {
    const ranked = corpus
      .map((s, i) => {
        const emb = opts.corpusEmbeddings![i];
        const sc = emb?.length ? cosine(opts.embedClaim!, emb) : -1;
        return { id: s.id, sc };
      })
      .filter((x) => x.sc >= 0)
      .sort((a, b) => b.sc - a.sc);
    ranked.forEach((x) => denseScore.set(x.id, x.sc));
    lists.push(ranked.map((x) => x.id));
    usedDense = true;
  }

  // Evidence prior list: all fromEvidence first (stable order)
  const priorList = corpus.filter((s) => s.fromEvidence).map((s) => s.id);
  if (priorList.length) lists.push(priorList);

  const fused = rrfFuse(lists);
  const byId = new Map(corpus.map((s) => [s.id, s]));
  const bm25ById = new Map(scores.map((s, i) => [corpus[i].id, s] as const));

  const out: Candidate[] = [];
  for (const { id, score } of fused) {
    const sentence = byId.get(id);
    if (!sentence) continue;
    const scorePrior = sentence.fromEvidence ? 1 : 0;
    out.push({
      sentence,
      scoreFusion: score + scorePrior * 0.02,
      scoreBm25: bm25ById.get(id) || 0,
      scoreDense: denseScore.get(id),
      scorePrior,
    });
    if (out.length >= topN) break;
  }
  // Re-sort after prior nudge
  out.sort((a, b) => b.scoreFusion - a.scoreFusion);
  void usedDense;
  return out;
}

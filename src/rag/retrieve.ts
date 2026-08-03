/**
 * BM25 / hybrid retrieval with parent expansion and short-doc stuffing.
 * Single pipeline — use forceBm25 for tests / no-embed path.
 */

import { buildBm25, bm25Scores } from "./bm25";
import {
  cosine,
  embedTexts,
  hybridScores,
  normalizeScores,
  type EmbedConfig,
} from "./embed";
import { citeOf, formatContextBlock } from "./context";
import type {
  EffectiveRetrievalMode,
  IndexedChunk,
  PaperIndex,
  RagQueryResult,
  RetrievedEvidence,
} from "./types";

function parentMap(index: PaperIndex): Map<string, IndexedChunk> {
  const m = new Map<string, IndexedChunk>();
  for (const c of index.chunks) {
    if (c.kind === "parent" || (c.kind === "abstract" && !c.parentId)) {
      m.set(c.id, c);
    }
  }
  return m;
}

export function getParents(index: PaperIndex): IndexedChunk[] {
  return index.chunks.filter(
    (c) => c.kind === "parent" || (c.kind === "abstract" && !c.parentId),
  );
}

export function getSearchUnits(index: PaperIndex): IndexedChunk[] {
  return index.chunks.filter(
    (c) => c.kind === "child" || c.kind === "abstract",
  );
}

export interface RetrieveOptions {
  topK?: number;
  selectionBoost?: string;
  /** Force BM25 even if index has embeddings / hybrid mode */
  forceBm25?: boolean;
  effectiveMode?: EffectiveRetrievalMode;
  embedCfg?: EmbedConfig | null;
  /**
   * When total parent tokens ≤ this, stuff all parents.
   * Use 0 to disable stuffing (force ranking) — useful in tests.
   */
  stuffTokenLimit?: number;
  queryBias?: string;
  /** Precomputed query embedding (skip embed API). */
  queryEmbedding?: number[];
}

export function scoreBm25Only(
  searchUnits: IndexedChunk[],
  query: string,
): number[] {
  if (!searchUnits.length) return [];
  const bm25 = buildBm25(searchUnits.map((c) => c.text));
  return normalizeScores(bm25Scores(bm25, query));
}

export function scoreHybrid(
  searchUnits: IndexedChunk[],
  query: string,
  queryEmbedding: number[],
): { scores: number[]; usedDense: boolean } {
  const bm = scoreBm25Only(searchUnits, query);
  const denseRaw = searchUnits.map((c) =>
    c.embedding?.length ? cosine(queryEmbedding, c.embedding) : 0,
  );
  const usedDense = denseRaw.some((x) => x > 0);
  if (!usedDense) {
    return { scores: bm, usedDense: false };
  }
  const dense = normalizeScores(denseRaw);
  return { scores: hybridScores(dense, bm), usedDense: true };
}

function emptyResult(): RagQueryResult {
  return {
    mode: "empty",
    evidence: [],
    contextBlock: "",
    stats: {
      chunkCount: 0,
      retrieved: 0,
      usedDense: false,
      usedBm25: false,
    },
  };
}

function stuffParents(
  index: PaperIndex,
  parents: IndexedChunk[],
): RagQueryResult {
  const evidence: RetrievedEvidence[] = parents.map((c, i) => ({
    chunk: c,
    score: 1 - i * 0.001,
    contextText: c.text,
    cite: citeOf(c),
  }));
  return {
    mode: "stuff",
    evidence,
    contextBlock: formatContextBlock(evidence, index.title),
    stats: {
      chunkCount: index.chunks.length,
      retrieved: evidence.length,
      usedDense: false,
      usedBm25: false,
    },
  };
}

function pinSection(
  searchUnits: IndexedChunk[],
  parentsById: Map<string, IndexedChunk>,
  picked: RetrievedEvidence[],
  seenParent: Set<string>,
  sectionRe: RegExp,
  score: number,
  topK: number,
  unshift: boolean,
): void {
  const unit = searchUnits.find(
    (c) => c.kind === "abstract" || sectionRe.test(c.section),
  );
  if (!unit) return;
  if (
    picked.some(
      (p) =>
        p.chunk.id === unit.id ||
        sectionRe.test(p.chunk.section) ||
        (unit.parentId != null &&
          p.chunk.parentId === unit.parentId &&
          sectionRe.test(p.cite)),
    )
  ) {
    return;
  }
  const parent = unit.parentId ? parentsById.get(unit.parentId) : undefined;
  const key = parent?.id || unit.id;
  if (seenParent.has(key)) return;
  seenParent.add(key);
  const ev: RetrievedEvidence = {
    chunk: unit,
    score,
    contextText: parent?.text || unit.text,
    cite: citeOf(parent || unit),
  };
  if (unshift) picked.unshift(ev);
  else picked.push(ev);
  while (picked.length > topK) picked.pop();
}

function expandTopK(
  index: PaperIndex,
  searchUnits: IndexedChunk[],
  scores: number[],
  topK: number,
  overview: boolean,
): RetrievedEvidence[] {
  const ranked = searchUnits
    .map((c, i) => ({ c, s: scores[i] ?? 0 }))
    .sort((a, b) => b.s - a.s);

  const parentsById = parentMap(index);
  const picked: RetrievedEvidence[] = [];
  const seenParent = new Set<string>();
  const hasPositive = ranked.some((r) => r.s > 0);

  for (const { c, s } of ranked) {
    if (picked.length >= topK) break;
    // Skip zero-score tail once we already have hits (less noise)
    if (hasPositive && s <= 0) continue;
    const parent = c.parentId ? parentsById.get(c.parentId) : undefined;
    const contextText = parent?.text || c.text;
    const key = parent?.id || c.id;
    if (seenParent.has(key) && parent) continue;
    seenParent.add(key);
    picked.push({
      chunk: c,
      score: s,
      contextText,
      cite: citeOf(parent || c),
    });
  }

  // Overview / empty-hit safety: always ground in abstract (+ conclusion)
  if (overview || !picked.length) {
    pinSection(
      searchUnits,
      parentsById,
      picked,
      seenParent,
      /abstract/i,
      1,
      topK,
      true,
    );
  }
  if (overview) {
    pinSection(
      searchUnits,
      parentsById,
      picked,
      seenParent,
      /conclusion/i,
      0.95,
      topK,
      false,
    );
  }

  return picked;
}

function applyQueryPriors(
  searchUnits: IndexedChunk[],
  scores: number[],
  q: string,
  selectionBoost?: string,
): boolean {
  const qLow = q.toLowerCase();
  const overview =
    /summar|overview|contribution|abstract|결론|요약|기여|tl;?dr|main\s+idea/.test(
      qLow,
    );
  const methodQ =
    /method|approach|algorithm|architect|pipeline|구현|방법|알고리즘|how\s+(do|does|is|are)/i.test(
      qLow,
    );
  const resultQ =
    /result|experiment|evaluat|ablation|benchmark|성능|실험|결과/.test(qLow);

  for (let i = 0; i < searchUnits.length; i++) {
    const sec = searchUnits[i].section.toLowerCase();
    const text = searchUnits[i].text;
    if (overview && /abstract|conclusion|introduction/.test(sec)) {
      scores[i] += 0.12;
    }
    if (methodQ && /method|approach|algorithm|model|system/.test(sec)) {
      scores[i] += 0.1;
    }
    if (resultQ && /experiment|result|evaluat|ablation/.test(sec)) {
      scores[i] += 0.1;
    }
    // Selection: try several windows so long quotes still match a child
    if (selectionBoost && selectionBoost.trim().length >= 8) {
      const raw = selectionBoost.replace(/\s+/g, " ").trim();
      const windows = [
        raw.slice(0, 80),
        raw.slice(0, 40),
        raw.length > 40 ? raw.slice(40, 100) : "",
        raw.length > 20 ? raw.slice(-40) : "",
      ].filter((w) => w.length >= 8);
      const hit = windows.some((w) => text.includes(w));
      if (hit) scores[i] += 0.22;
      else {
        // softer: shared distinctive tokens
        const selToks = raw
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 4)
          .slice(0, 12);
        if (selToks.length) {
          const low = text.toLowerCase();
          const n = selToks.filter((t) => low.includes(t)).length;
          if (n >= 2) scores[i] += 0.08 * Math.min(n, 5);
        }
      }
    }
  }
  return overview;
}

/**
 * Core retrieve. Prefer forceBm25 + stuffTokenLimit:0 in unit tests.
 */
export async function retrieve(
  index: PaperIndex,
  query: string,
  opts?: RetrieveOptions,
): Promise<RagQueryResult> {
  const topK = opts?.topK ?? 12;
  // Default 14000; explicit 0 disables stuff
  const stuffLimit =
    opts?.stuffTokenLimit === undefined ? 14000 : opts.stuffTokenLimit;

  if (!index.chunks.length) return emptyResult();

  const parents = getParents(index);
  const totalParentTokens =
    index.parentTokenEstimate ||
    parents.reduce((s, c) => s + c.tokenEstimate, 0);

  if (stuffLimit > 0 && totalParentTokens <= stuffLimit) {
    return stuffParents(index, parents);
  }

  const searchUnits = getSearchUnits(index);
  const qParts = [query, opts?.selectionBoost || "", opts?.queryBias || ""];
  const q = qParts.filter(Boolean).join("\n");

  let scores: number[];
  let usedDense = false;

  const wantHybrid =
    !opts?.forceBm25 &&
    (opts?.effectiveMode === "hybrid" ||
      (opts?.effectiveMode == null &&
        index.retrievalModeUsed === "hybrid" &&
        searchUnits.some((c) => c.embedding?.length)));

  if (wantHybrid && opts?.queryEmbedding?.length) {
    const hybrid = scoreHybrid(searchUnits, q, opts.queryEmbedding);
    scores = hybrid.scores;
    usedDense = hybrid.usedDense;
  } else if (wantHybrid && opts?.embedCfg?.apiKey) {
    try {
      const [qEmb] = await embedTexts([q.slice(0, 8000)], opts.embedCfg);
      const hybrid = scoreHybrid(searchUnits, q, qEmb);
      scores = hybrid.scores;
      usedDense = hybrid.usedDense;
    } catch {
      scores = scoreBm25Only(searchUnits, q);
      usedDense = false;
    }
  } else {
    scores = scoreBm25Only(searchUnits, q);
    usedDense = false;
  }

  const overview = applyQueryPriors(
    searchUnits,
    scores,
    q,
    opts?.selectionBoost,
  );
  const picked = expandTopK(index, searchUnits, scores, topK, overview);

  return {
    mode: "rag",
    evidence: picked,
    contextBlock: formatContextBlock(picked, index.title),
    stats: {
      chunkCount: index.chunks.length,
      retrieved: picked.length,
      usedDense,
      usedBm25: true,
    },
  };
}

/**
 * Sync BM25-only convenience for tests — same pipeline, forceBm25 + no network.
 */
export function retrieveBm25Sync(
  index: PaperIndex,
  query: string,
  opts?: { topK?: number; stuffTokenLimit?: number },
): RagQueryResult {
  // Default stuffTokenLimit 0 so ranking tests are not short-circuited by stuff.
  const stuffTokenLimit =
    opts?.stuffTokenLimit === undefined ? 0 : opts.stuffTokenLimit;
  // retrieve is async only for embed fetch; forceBm25 path is sync-compatible
  // but we keep async API — use deasync via known BM25-only path inline:
  const topK = opts?.topK ?? 12;
  if (!index.chunks.length) return emptyResult();

  const parents = getParents(index);
  const totalParentTokens =
    index.parentTokenEstimate ||
    parents.reduce((s, c) => s + c.tokenEstimate, 0);
  if (stuffTokenLimit > 0 && totalParentTokens <= stuffTokenLimit) {
    return stuffParents(index, parents);
  }

  const searchUnits = getSearchUnits(index);
  const scores = scoreBm25Only(searchUnits, query);
  const overview = applyQueryPriors(searchUnits, scores, query);
  const picked = expandTopK(index, searchUnits, scores, topK, overview);
  return {
    mode: "rag",
    evidence: picked,
    contextBlock: formatContextBlock(picked, index.title),
    stats: {
      chunkCount: index.chunks.length,
      retrieved: picked.length,
      usedDense: false,
      usedBm25: true,
    },
  };
}

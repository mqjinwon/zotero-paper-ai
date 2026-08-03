/**
 * Lightweight BM25 for local keyword retrieval (zero-key path).
 * No native deps; pure TypeScript.
 */

/**
 * Light academic tokenizer: keep multi-char words, digit runs, and
 * alpha↔digit splits (e.g. "L1", "mpc2") so method names score better.
 */
export function tokenize(text: string): string[] {
  const soft = text
    .toLowerCase()
    // split letter↔digit boundaries common in papers (q1, L2, ResNet50)
    .replace(/([a-z가-힣])(\d)/gi, "$1 $2")
    .replace(/(\d)([a-z가-힣])/gi, "$1 $2")
    .replace(/[^a-z0-9가-힣\s]+/gi, " ");
  return soft
    .split(/\s+/)
    .filter((t) => t.length > 1 || /^\d+$/.test(t));
}

export interface Bm25Index {
  docTokens: string[][];
  docLen: number[];
  avgdl: number;
  df: Map<string, number>;
  N: number;
}

export function buildBm25(docs: string[]): Bm25Index {
  const docTokens = docs.map(tokenize);
  const docLen = docTokens.map((t) => t.length);
  const avgdl =
    docLen.reduce((a, b) => a + b, 0) / Math.max(1, docLen.length);
  const df = new Map<string, number>();
  for (const toks of docTokens) {
    const seen = new Set(toks);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  return { docTokens, docLen, avgdl, df, N: docs.length };
}

export function bm25Scores(
  index: Bm25Index,
  query: string,
  k1 = 1.2,
  b = 0.75,
): number[] {
  const q = tokenize(query);
  const scores = new Array(index.N).fill(0);
  for (let i = 0; i < index.N; i++) {
    const tfMap = new Map<string, number>();
    for (const t of index.docTokens[i]) {
      tfMap.set(t, (tfMap.get(t) || 0) + 1);
    }
    let s = 0;
    for (const term of q) {
      const tf = tfMap.get(term) || 0;
      if (!tf) continue;
      const n = index.df.get(term) || 0;
      const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
      const dl = index.docLen[i] || 1;
      const denom = tf + k1 * (1 - b + b * (dl / (index.avgdl || 1)));
      s += idf * ((tf * (k1 + 1)) / denom);
    }
    scores[i] = s;
  }
  return scores;
}

/** Rank doc indices by BM25 score descending. */
export function bm25Rank(
  docs: string[],
  query: string,
): Array<{ index: number; score: number }> {
  const index = buildBm25(docs);
  const scores = bm25Scores(index, query);
  return scores
    .map((score, i) => ({ index: i, score }))
    .sort((a, b) => b.score - a.score);
}

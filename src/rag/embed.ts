/**
 * Optional OpenAI-compatible embeddings HTTP client.
 * Not available via Grok/Codex chat OAuth — user configures separately.
 */

export interface EmbedConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export function defaultOpenAIBaseUrl(): string {
  return "https://api.openai.com/v1";
}

export async function embedTexts(
  texts: string[],
  cfg: EmbedConfig,
): Promise<number[][]> {
  if (!cfg.apiKey?.trim()) {
    throw new Error("No embedding API key configured");
  }
  const base = (cfg.baseUrl || defaultOpenAIBaseUrl()).replace(/\/$/, "");
  const url = `${base}/embeddings`;
  const fetchImpl = cfg.fetchImpl || fetch.bind(globalThis);

  const batchSize = 32;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map((t) => t.slice(0, 8000));
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        input: batch,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Embedding API ${resp.status}: ${err.slice(0, 300)}`);
    }
    const json = (await resp.json()) as {
      data?: Array<{ embedding: number[]; index: number }>;
    };
    const data = (json.data || []).slice().sort((a, b) => a.index - b.index);
    for (const d of data) out.push(d.embedding);
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Min-max normalize to [0,1]. */
export function normalizeScores(arr: number[]): number[] {
  if (!arr.length) return [];
  const max = Math.max(...arr);
  const min = Math.min(...arr);
  const span = max - min || 1e-9;
  return arr.map((x) => (x - min) / span);
}

/** Hybrid fusion per v2 spec: 0.6 dense + 0.4 bm25. */
export function hybridScores(
  denseNorm: number[],
  bm25Norm: number[],
): number[] {
  const n = Math.max(denseNorm.length, bm25Norm.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = 0.6 * (denseNorm[i] || 0) + 0.4 * (bm25Norm[i] || 0);
  }
  return out;
}

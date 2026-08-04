/**
 * LLM classification of candidate passages into auto-highlight categories.
 */

import type { FileStore } from "../../auth/fileStore";
import { resolveFeatureConfig } from "../../llm/featureConfig";
import { getOrCreateClient } from "../../llm/fastTranslate";
import { diag } from "../../utils/diagnostics";
import {
  AUTO_HIGHLIGHT_ORDER,
  AUTO_MIN_QUOTE_CHARS,
  getAutoMaxPerCategory,
  getAutoMaxTotal,
  isAutoHighlightCategory,
  type AutoHighlightCategory,
} from "./taxonomy";
import { formatCandidatesForPrompt, type CandidatePassage } from "./select";

export interface ClassifiedHighlight {
  category: AutoHighlightCategory;
  quote: string;
  reason: string;
  sourceId?: string;
  /** 1-based page hint from source chunk when available */
  pageStart?: number;
}

function buildSystemPrompt(targetLang: string): string {
  const maxPer = getAutoMaxPerCategory();
  const maxTotal = getAutoMaxTotal();
  return (
    `You are a research reading coach. Reply with JSON only (no markdown fences).\n` +
    `Language for "reason" field: ${targetLang}.\n` +
    "Task: from the given paper passages, select the most important short quotes for active reading.\n" +
    "Categories (exactly these ids):\n" +
    "- claim: main claims, results, quantitative findings\n" +
    "- method: definitions, experimental setup, algorithms, procedures\n" +
    "- novelty: contributions, what is new vs prior work\n" +
    "- caveat: limitations, assumptions, threats to validity\n" +
    "Rules:\n" +
    `- At most ${maxPer} items per category, at most ${maxTotal} total.\n` +
    `- Each "quote" MUST be an exact contiguous substring copied from a passage (min ${AUTO_MIN_QUOTE_CHARS} chars).\n` +
    "- Prefer 1–3 sentences per quote; do not invent text.\n" +
    '- Output: {"items":[{"category":"claim","quote":"...","reason":"≤12 words","sourceId":"chunk-id optional"}]}\n'
  );
}

function extractJsonObject(raw: string): unknown {
  const t = (raw || "").trim();
  if (!t) throw new Error("empty classifier response");
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    return JSON.parse(fence[1].trim());
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(t.slice(start, end + 1));
  }
  throw new Error("classifier response is not JSON");
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Keep only quotes that appear in the candidate corpus. */
export function filterGroundedQuotes(
  items: ClassifiedHighlight[],
  candidates: CandidatePassage[],
): ClassifiedHighlight[] {
  const corpus = candidates.map((c) => ({
    id: c.id,
    norm: normalizeWs(c.text).toLowerCase(),
    raw: c.text,
  }));

  const out: ClassifiedHighlight[] = [];
  const perCat: Record<string, number> = {};

  for (const it of items) {
    if (!isAutoHighlightCategory(it.category)) continue;
    let quote = normalizeWs(it.quote || "");
    if (quote.length < AUTO_MIN_QUOTE_CHARS) continue;

    const qLow = quote.toLowerCase();
    let ok = false;
    let sourceId = it.sourceId;
    let pageStart = it.pageStart;
    for (let ci = 0; ci < corpus.length; ci++) {
      const c = corpus[ci];
      if (c.norm.includes(qLow)) {
        ok = true;
        sourceId = sourceId || c.id;
        if (pageStart == null) {
          pageStart = candidates[ci]?.pageStart;
        }
        break;
      }
    }
    if (!ok) continue;

    const maxPer = getAutoMaxPerCategory();
    const maxTotal = getAutoMaxTotal();
    const n = perCat[it.category] || 0;
    if (n >= maxPer) continue;
    if (out.length >= maxTotal) break;
    perCat[it.category] = n + 1;
    out.push({
      category: it.category,
      quote,
      reason: String(it.reason || "").slice(0, 80),
      sourceId,
      pageStart,
    });
  }
  return out;
}

export function parseClassifierResponse(
  raw: string,
  candidates: CandidatePassage[],
): ClassifiedHighlight[] {
  const data = extractJsonObject(raw) as { items?: unknown };
  const arr = Array.isArray(data?.items) ? data.items : [];
  const mapped: ClassifiedHighlight[] = [];
  for (const row of arr) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const category = String(o.category || "");
    if (!isAutoHighlightCategory(category)) continue;
    mapped.push({
      category,
      quote: String(o.quote || ""),
      reason: String(o.reason || ""),
      sourceId: o.sourceId != null ? String(o.sourceId) : undefined,
    });
  }
  // Prefer stable category order
  mapped.sort(
    (a, b) =>
      AUTO_HIGHLIGHT_ORDER.indexOf(a.category) -
      AUTO_HIGHLIGHT_ORDER.indexOf(b.category),
  );
  return filterGroundedQuotes(mapped, candidates);
}

export async function classifyPassages(opts: {
  store: FileStore;
  candidates: CandidatePassage[];
  onStatus?: (s: string) => void;
}): Promise<ClassifiedHighlight[]> {
  if (!opts.candidates.length) {
    throw new Error("분류할 후보 문단이 없습니다. 먼저 논문을 인덱싱하세요.");
  }
  opts.onStatus?.("중요 구간 분류 중…");
  const cfg = resolveFeatureConfig("chat");
  const client = getOrCreateClient(opts.store, cfg);
  const user =
    "Passages:\n\n" +
    formatCandidatesForPrompt(opts.candidates) +
    "\n\nReturn JSON only.";

  const raw = await client.complete({
    model: cfg.model,
    messages: [
      { role: "system", content: buildSystemPrompt(cfg.targetLang || "ko") },
      { role: "user", content: user },
    ],
    reasoningEffort: cfg.reasoningEffort,
  });

  diag("autoHL", "classifier raw len", raw.length);
  const items = parseClassifierResponse(raw, opts.candidates);
  diag("autoHL", "classified", {
    n: items.length,
    by: Object.fromEntries(
      AUTO_HIGHLIGHT_ORDER.map((c) => [
        c,
        items.filter((i) => i.category === c).length,
      ]),
    ),
  });
  if (!items.length) {
    throw new Error(
      "모델이 유효한 인용 구간을 반환하지 않았습니다. 다시 시도하거나 인덱싱을 확인하세요.",
    );
  }
  return items;
}

/**
 * Whole-paper 3–5 bullet summary (panel top).
 * Reuses chat provider/model; RAG retrieval for grounding.
 */

import type { FileStore } from "../auth/fileStore";
import { resolveFeatureConfig } from "../llm/featureConfig";
import { getOrCreateClient } from "../llm/fastTranslate";
import {
  buildSummarySystemPrompt,
  buildSummaryUserPayload,
  PAPER_SUMMARY_RAG_QUERY,
} from "../llm/prompts";
import { attachRagContext } from "./paperTask";
import { getOpenPaperRef, type OpenPaperRef } from "../rag/paperRef";
import { readRagPrefs } from "../rag/prefs";
import type { RagPrefs } from "../rag/types";
import { diag } from "../utils/diagnostics";

export interface PaperSummaryResult {
  markdown: string;
  usedRag: boolean;
  provider: string;
  model: string;
  indexLabel: string;
}

export async function runPaperSummary(opts: {
  store: FileStore;
  paper?: OpenPaperRef | null;
  onDelta?: (t: string) => void;
  onStatus?: (s: string) => void;
  ragPrefs?: Partial<RagPrefs>;
  fetchImpl?: typeof fetch;
}): Promise<PaperSummaryResult> {
  const paper = opts.paper !== undefined ? opts.paper : getOpenPaperRef();
  if (!paper?.itemKey) {
    throw new Error(
      "열린 PDF를 찾지 못했습니다. PDF 탭을 선택한 뒤 다시 시도하세요.",
    );
  }

  const cfg = resolveFeatureConfig("chat");
  const ragPrefs = { ...readRagPrefs(), ...opts.ragPrefs };

  opts.onStatus?.("논문 근거 검색 중…");
  // Use chat mode so shouldUseRag allows retrieval.
  const rag = await attachRagContext({
    mode: "chat",
    store: opts.store,
    query: PAPER_SUMMARY_RAG_QUERY,
    ragPrefs: {
      ...ragPrefs,
      // Prefer a bit more context for global summary
      ragTopK: Math.max(ragPrefs.ragTopK || 12, 16),
    },
    paper,
    onStatus: opts.onStatus,
    fetchImpl: opts.fetchImpl,
  });

  opts.onStatus?.("요약 생성 중…");
  const client = getOrCreateClient(opts.store, cfg);
  const system = buildSummarySystemPrompt(cfg.targetLang || "ko");
  const user = buildSummaryUserPayload({
    paperTitle: paper.title,
    context: rag.contextBlock,
  });

  diag("summary", "request", {
    itemKey: paper.itemKey,
    provider: cfg.provider,
    model: cfg.model,
    usedRag: rag.usedRag,
    ctxLen: rag.contextBlock.length,
  });

  const markdown = (
    await client.complete({
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      reasoningEffort: cfg.reasoningEffort,
      onDelta: opts.onDelta,
    })
  ).trim();

  if (!markdown) {
    throw new Error("모델이 빈 요약을 반환했습니다. 다시 시도하세요.");
  }

  return {
    markdown,
    usedRag: rag.usedRag,
    provider: cfg.provider,
    model: cfg.model,
    indexLabel: rag.indexLabel,
  };
}

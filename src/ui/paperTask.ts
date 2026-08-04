/**
 * Single paper-task orchestration: optional RAG context + LLM/translate.
 * Panel UI and menu/shortcuts both call this — no duplicated RAG blocks.
 */

import type { FileStore } from "../auth/fileStore";
import { resolveFeatureConfig } from "../llm/featureConfig";
import { fastTranslate, getOrCreateClient } from "../llm/fastTranslate";
import { isVisionMode, runTask } from "../llm/router";
import type { ImagePayload, TaskMode } from "../llm/types";
import { shouldUseRag } from "../rag/config";
import {
  groundAnswerToPaper,
  sentencesFromIndex,
  type PaperSentence,
} from "../rag/groundAnswer";
import { queryPaper } from "../rag/index";
import { getOpenPaperRef, type OpenPaperRef } from "../rag/paperRef";
import { readRagPrefs } from "../rag/prefs";
import type { ExtractInput } from "../rag/extract";
import type { ExtractedDoc, RagPrefs, RetrievedEvidence } from "../rag/types";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  /** Optional image shown in panel history (data URL or payload). */
  imageDataUrl?: string;
  imageCaption?: string;
}

export interface PaperTaskInput {
  mode: TaskMode;
  store: FileStore;
  selection?: string;
  question?: string;
  image?: ImagePayload;
  /** Prior turns (excluding the in-flight user/assistant pair). */
  history?: ChatTurn[];
  onDelta?: (t: string) => void;
  onStatus?: (s: string) => void;
  /** Prefs override (tests). */
  ragPrefs?: Partial<RagPrefs>;
  /** Injected paper ref (tests / offline). */
  paper?: OpenPaperRef | null;
  /** Injected extract skips Zotero fulltext (tests). */
  extract?: ExtractInput | ExtractedDoc;
  fetchImpl?: typeof fetch;
  /** When false, never call queryPaper (tests for translate path). */
  allowRag?: boolean;
  /**
   * Pre-built evidence (e.g. figure captions + discussions + RAG).
   * When set, skips attachRagContext and injects this as model context.
   */
  prefetchedContext?: string;
}

export interface PaperTaskResult {
  answer: string;
  /** Non-empty when RAG evidence was attached. */
  ragFooter: string;
  /** Index button label hint after lazy index, if any. */
  indexLabel: string;
  /** Whether queryPaper was invoked. */
  usedRag: boolean;
  /** Context block passed to the model (empty if none). */
  contextBlock: string;
  provider: string;
  model: string;
}

function defaultQueryForMode(mode: TaskMode): string {
  if (mode === "figure-explain") {
    return "Explain this figure in the context of the paper";
  }
  return "";
}

function indexLabelFrom(
  retrievalModeUsed: string,
  searchUnitCount: number,
): string {
  const mode = retrievalModeUsed === "hybrid" ? "hybrid" : "BM25";
  return `인덱싱 완료 · ${mode} · ${searchUnitCount} chunks`;
}

/**
 * Attach full-paper RAG context when mode + prefs allow.
 * Translate / drag-explain never call queryPaper.
 */
export async function attachRagContext(opts: {
  mode: TaskMode;
  store: FileStore;
  query: string;
  selection?: string;
  ragPrefs: RagPrefs;
  paper?: OpenPaperRef | null;
  extract?: ExtractInput | ExtractedDoc;
  onStatus?: (s: string) => void;
  fetchImpl?: typeof fetch;
  allowRag?: boolean;
}): Promise<{
  contextBlock: string;
  ragFooter: string;
  evidence: RetrievedEvidence[];
  /** Full-index sentences for post-hoc grounding (not RAG cite slots). */
  paperSentences: PaperSentence[];
  indexLabel: string;
  usedRag: boolean;
}> {
  const empty = {
    contextBlock: "",
    ragFooter: "",
    evidence: [] as RetrievedEvidence[],
    paperSentences: [] as PaperSentence[],
    indexLabel: "",
    usedRag: false,
  };
  if (opts.allowRag === false) return empty;
  if (!shouldUseRag(opts.ragPrefs.ragEnabled, opts.mode)) return empty;
  if (!opts.query.trim()) return empty;

  const paper = opts.paper !== undefined ? opts.paper : getOpenPaperRef();
  if (!opts.extract && !paper?.itemKey) return empty;

  opts.onStatus?.("논문 전체 인덱싱 / 검색 중…");
  try {
    const rag = await queryPaper({
      store: opts.store,
      query: opts.query,
      prefs: opts.ragPrefs,
      extract: opts.extract,
      itemKey: paper?.itemKey,
      itemID: paper?.itemID,
      title: paper?.title,
      selectionBoost: opts.selection || undefined,
      taskMode: opts.mode,
      onStatus: opts.onStatus,
      fetchImpl: opts.fetchImpl,
    });
    const n = rag.index.chunks.filter(
      (c) => c.kind === "child" || c.kind === "abstract",
    ).length;
    return {
      contextBlock: rag.contextBlock || "",
      ragFooter: "",
      evidence: rag.evidence || [],
      paperSentences: sentencesFromIndex(rag.index),
      indexLabel: indexLabelFrom(rag.index.retrievalModeUsed, n),
      usedRag: true,
    };
  } catch (e) {
    opts.onStatus?.(
      `RAG 경고: ${e instanceof Error ? e.message : String(e)} — 근거 없이 답변합니다`,
    );
    return empty;
  }
}

/**
 * Canonical task entry: translate fast-path or RAG+LLM.
 */
export async function runPaperTask(
  input: PaperTaskInput,
): Promise<PaperTaskResult> {
  const mode = input.mode;
  const cfg = resolveFeatureConfig(mode);
  const selection = (input.selection || "").trim();
  const question = (input.question || "").trim();
  const ragPrefs = { ...readRagPrefs(), ...input.ragPrefs };

  // translate: never RAG
  if (mode === "translate" && selection) {
    input.onStatus?.("번역 중…");
    const answer = await fastTranslate(input.store, cfg, selection, {
      onDelta: input.onDelta,
    });
    return {
      answer,
      ragFooter: "",
      indexLabel: "",
      usedRag: false,
      contextBlock: "",
      provider: cfg.provider,
      model: cfg.model,
    };
  }

  const qText = question || selection || defaultQueryForMode(mode);

  const prefetched = (input.prefetchedContext || "").trim();
  const rag = prefetched
    ? {
        contextBlock: prefetched,
        ragFooter: "",
        evidence: [] as RetrievedEvidence[],
        paperSentences: [] as PaperSentence[],
        indexLabel: "",
        usedRag: true,
      }
    : await attachRagContext({
        mode,
        store: input.store,
        query: qText,
        selection: selection || undefined,
        ragPrefs,
        paper: input.paper,
        extract: input.extract,
        onStatus: input.onStatus,
        fetchImpl: input.fetchImpl,
        allowRag: input.allowRag,
      });

  input.onStatus?.("응답 생성 중…");
  const client = getOrCreateClient(input.store, cfg);
  let answer = await runTask(client, {
    mode,
    model: cfg.model,
    targetLang: cfg.targetLang,
    selection: selection || undefined,
    paperTitle:
      mode === "chat" || isVisionMode(mode)
        ? input.paper?.title || undefined
        : undefined,
    context: rag.contextBlock || undefined,
    question:
      mode === "chat" || isVisionMode(mode) ? question || undefined : undefined,
    image: input.image,
    history: mode === "chat" ? input.history : undefined,
    onDelta: input.onDelta,
    reasoningEffort: cfg.reasoningEffort,
  });

  let ragFooter = "";
  // Post-hoc: match answer claims → real paper sentences (not RAG cite ids)
  const paperSents = rag.paperSentences || [];
  if (answer && paperSents.length) {
    input.onStatus?.("답변 ↔ 논문 문장 정렬 중…");
    const grounded = groundAnswerToPaper(answer, paperSents);
    answer = grounded.answer;
    ragFooter = grounded.ragFooter;
    input.onStatus?.(
      grounded.matched
        ? `근거 링크 ${grounded.matched}/${grounded.claims} 문장 매칭`
        : `근거 링크 없음 (문장 매칭 임계값 미달 · 후보 ${grounded.claims})`,
    );
  } else if (answer && rag.evidence?.length) {
    // Fallback: only retrieved evidence text as sentence corpus
    const sents: PaperSentence[] = rag.evidence
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
        } as PaperSentence;
      })
      .filter(Boolean) as PaperSentence[];
    if (sents.length) {
      const grounded = groundAnswerToPaper(answer, sents);
      answer = grounded.answer;
      ragFooter = grounded.ragFooter;
    }
  }

  return {
    answer,
    ragFooter,
    indexLabel: rag.indexLabel,
    usedRag: rag.usedRag,
    contextBlock: rag.contextBlock,
    provider: cfg.provider,
    model: cfg.model,
  };
}

/** User-visible text for history bubble (request + context shown together). */
export function formatUserVisible(
  mode: TaskMode,
  opts: {
    question?: string;
    selection?: string;
    hasImage?: boolean;
    imageSource?: string;
    figureHints?: string[];
  },
): string {
  const question = (opts.question || "").trim();
  const selection = (opts.selection || "").trim();
  if (mode === "chat") return question || selection;
  if (mode === "figure-explain") {
    const lines = ["🖼 그림/표 설명 요청"];
    if (opts.hasImage) {
      lines.push(
        `· 이미지: 포함됨${opts.imageSource ? ` (${opts.imageSource})` : ""}`,
      );
    } else {
      lines.push("· 이미지: 없음 (텍스트만)");
    }
    if (selection) lines.push(`· PDF 선택/캡션:\n${selection.slice(0, 500)}`);
    if (question) lines.push(`· 질문: ${question}`);
    if (opts.figureHints?.length) {
      lines.push(
        `· 논문 내 figure 언급: ${opts.figureHints.slice(0, 5).join("; ")}`,
      );
    }
    if (!question && !selection) {
      lines.push("· (현재 페이지/선택 영역 이미지 기준 설명)");
    }
    return lines.join("\n");
  }
  if (mode === "translate") return `번역: ${selection.slice(0, 160)}`;
  if (mode === "explain") return `설명: ${selection.slice(0, 160)}`;
  return selection.slice(0, 160);
}

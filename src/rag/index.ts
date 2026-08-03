/**
 * RAG orchestrator: ensureIndex + queryPaper.
 * Always builds BM25 search units; optional dense when prefs require it.
 */

import type { FileStore } from "../auth/fileStore";
import { chunkDocument, estimateTokens, CHUNK_POLICY } from "./chunk";
import {
  mergeRagPrefs,
  resolveEffectiveMode,
  resolveEmbedConfig,
  shouldUseRag,
} from "./config";
import { evidenceFooter, withEvidenceAnswer } from "./context";
import { enrichEvidenceWithPages } from "./enrichPages";
import { embedTexts } from "./embed";
import {
  buildExtractedDoc,
  EmptyExtractError,
  extractPaperFromZotero,
  type ExtractInput,
} from "./extract";
import { retrieve, type RetrieveOptions } from "./retrieve";
import { loadIndex, saveIndex } from "./store";
import type {
  ExtractedDoc,
  IndexedChunk,
  PaperIndex,
  RagPrefs,
  RagQueryResult,
  RagTaskMode,
} from "./types";
import { isRagMode } from "./types";

export {
  EmptyExtractError,
  isRagMode,
  shouldUseRag,
  evidenceFooter,
  withEvidenceAnswer,
  enrichEvidenceWithPages,
};
export type { RagPrefs, RagQueryResult, PaperIndex, ExtractedDoc };

const inflight = new Map<string, Promise<PaperIndex>>();

export interface EnsureIndexOptions {
  store: FileStore;
  prefs?: Partial<RagPrefs>;
  /** Pure path: pre-built extract (tests / non-Zotero). */
  extract?: ExtractInput | ExtractedDoc;
  /** Zotero path */
  itemKey?: string;
  itemID?: number;
  title?: string;
  onStatus?: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

function isExtractedDoc(x: ExtractInput | ExtractedDoc): x is ExtractedDoc {
  return (
    typeof (x as ExtractedDoc).pdfHash === "string" &&
    typeof (x as ExtractedDoc).fullText === "string" &&
    (x as ExtractedDoc).fullText.length > 0
  );
}

/**
 * Build a PaperIndex from an extracted document (always BM25 units;
 * embed when effective mode is hybrid).
 */
export async function buildIndexFromDoc(
  doc: ExtractedDoc,
  prefs: RagPrefs,
  opts?: { fetchImpl?: typeof fetch },
): Promise<PaperIndex> {
  if (!doc.fullText?.trim()) {
    throw new EmptyExtractError(doc.paperId);
  }

  const effective = resolveEffectiveMode(
    prefs.ragRetrievalMode,
    prefs.embeddingProvider,
    prefs.embeddingApiKey,
  );

  const chunks = chunkDocument(doc);
  if (!chunks.length) {
    throw new EmptyExtractError(doc.paperId);
  }

  const parents = chunks.filter(
    (c) => c.kind === "parent" || (c.kind === "abstract" && !c.parentId),
  );
  const parentTokenEstimate = parents.reduce(
    (s, c) => s + c.tokenEstimate,
    0,
  );

  const indexed: IndexedChunk[] = chunks.map((c) => ({ ...c }));

  let embedProvider = null as PaperIndex["embedProvider"];
  let embedModel = null as string | null;

  if (effective === "hybrid") {
    const embedCfg = resolveEmbedConfig(prefs);
    if (!embedCfg) {
      throw new Error(
        "Hybrid indexing needs valid embedding credentials (embeddingProvider + embeddingApiKey).",
      );
    }
    if (opts?.fetchImpl) embedCfg.fetchImpl = opts.fetchImpl;
    const searchUnits = indexed.filter(
      (c) => c.kind === "child" || c.kind === "abstract",
    );
    const texts = searchUnits.map((c) => c.text);
    const vectors = await embedTexts(texts, embedCfg);
    for (let i = 0; i < searchUnits.length; i++) {
      searchUnits[i].embedding = vectors[i];
    }
    embedProvider = prefs.embeddingProvider;
    embedModel = embedCfg.model;
  }

  return {
    version: 1,
    paperId: doc.paperId,
    pdfHash: doc.pdfHash,
    title: doc.title,
    createdAt: new Date().toISOString(),
    chunkPolicy: CHUNK_POLICY,
    retrievalModeUsed: effective,
    embedProvider,
    embedModel,
    chunks: indexed,
    parentTokenEstimate,
  };
}

/**
 * Load or build+persist paper index.
 */
export async function ensureIndex(
  opts: EnsureIndexOptions,
): Promise<PaperIndex> {
  const prefs = mergeRagPrefs(opts.prefs);
  opts.onStatus?.("논문 전체 인덱싱 중…");

  let doc: ExtractedDoc;
  if (opts.extract) {
    doc = isExtractedDoc(opts.extract)
      ? opts.extract
      : buildExtractedDoc(opts.extract);
  } else if (opts.itemKey) {
    doc = await extractPaperFromZotero({
      itemKey: opts.itemKey,
      itemID: opts.itemID,
      title: opts.title,
    });
  } else {
    throw new Error("ensureIndex requires extract or itemKey");
  }

  const cacheKey = `${doc.paperId}:${doc.pdfHash}`;
  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const work = (async () => {
    const cached = await loadIndex(opts.store, doc.paperId, doc.pdfHash);
    if (cached && cached.chunkPolicy === CHUNK_POLICY) {
      let want: ReturnType<typeof resolveEffectiveMode>;
      try {
        want = resolveEffectiveMode(
          prefs.ragRetrievalMode,
          prefs.embeddingProvider,
          prefs.embeddingApiKey,
        );
      } catch {
        // hybrid required but credentials missing
        if (prefs.ragRetrievalMode === "auto") {
          opts.onStatus?.("인덱스 로드 완료 (BM25)");
          return cached;
        }
        throw new Error(
          "Cached index unusable for hybrid mode; fix embedding credentials.",
        );
      }
      // Rebuild only when prefs demand hybrid but cache is BM25-only.
      const mustRebuildHybrid =
        want === "hybrid" && cached.retrievalModeUsed !== "hybrid";
      if (!mustRebuildHybrid) {
        opts.onStatus?.(
          want === "bm25" ? "인덱스 로드 완료 (BM25)" : "인덱스 로드 완료",
        );
        return cached;
      }
    }

    const index = await buildIndexFromDoc(doc, prefs, {
      fetchImpl: opts.fetchImpl,
    });
    await saveIndex(opts.store, index);
    opts.onStatus?.("인덱싱 완료");
    return index;
  })();

  inflight.set(cacheKey, work);
  try {
    return await work;
  } finally {
    inflight.delete(cacheKey);
  }
}

export interface QueryPaperOptions {
  store: FileStore;
  query: string;
  prefs?: Partial<RagPrefs>;
  extract?: ExtractInput | ExtractedDoc;
  itemKey?: string;
  itemID?: number;
  title?: string;
  selectionBoost?: string;
  /** figure / equation bias terms */
  taskMode?: RagTaskMode | string;
  onStatus?: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

/**
 * ensureIndex + retrieve for a user question.
 */
export async function queryPaper(
  opts: QueryPaperOptions,
): Promise<RagQueryResult & { index: PaperIndex }> {
  const prefs = mergeRagPrefs(opts.prefs);
  const index = await ensureIndex({
    store: opts.store,
    prefs,
    extract: opts.extract,
    itemKey: opts.itemKey,
    itemID: opts.itemID,
    title: opts.title,
    onStatus: opts.onStatus,
    fetchImpl: opts.fetchImpl,
  });

  const effective = resolveEffectiveMode(
    prefs.ragRetrievalMode,
    prefs.embeddingProvider,
    prefs.embeddingApiKey,
  );
  const embedCfg =
    effective === "hybrid" ? resolveEmbedConfig(prefs) : null;
  if (embedCfg && opts.fetchImpl) embedCfg.fetchImpl = opts.fetchImpl;

  let queryBias = "";
  if (opts.taskMode === "figure-explain") {
    queryBias = "figure caption table chart diagram plot axis";
  }

  const retrieveOpts: RetrieveOptions = {
    topK: prefs.ragTopK,
    stuffTokenLimit: prefs.ragStuffTokenLimit,
    selectionBoost: opts.selectionBoost,
    effectiveMode: effective,
    embedCfg,
    queryBias,
  };

  const result = await retrieve(index, opts.query, retrieveOpts);
  return { ...result, index };
}

export { getOpenPaperRef, paperRefOf } from "./paperRef";
export type { OpenPaperRef } from "./paperRef";
/** @deprecated use getOpenPaperRef */
export { getOpenPaperRef as resolveOpenPaperMeta } from "./paperRef";

/** Estimate tokens helper re-export for tests. */
export { estimateTokens, chunkDocument };

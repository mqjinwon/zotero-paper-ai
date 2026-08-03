/** RAG domain types for single-paper indexing and retrieval (v2). */

export type RagRetrievalMode = "auto" | "bm25" | "hybrid";
export type EmbeddingProvider = "none" | "openai" | "openai-compatible";
/** Effective retrieval mode after resolving auto + credentials. */
export type EffectiveRetrievalMode = "bm25" | "hybrid";

export interface TextSpan {
  text: string;
  page?: number;
}

export interface ExtractedDoc {
  paperId: string;
  title: string;
  /** Full plain text (for short-doc stuffing fallback). */
  fullText: string;
  /** Page-ordered spans when available. */
  pages: Array<{ page: number; text: string }>;
  source: "zotero-fulltext" | "reader" | "file-text" | "stub" | "empty";
  pdfHash: string;
}

export interface Chunk {
  id: string;
  text: string;
  section: string;
  pageStart?: number;
  pageEnd?: number;
  /** parent chunk id for expansion */
  parentId?: string;
  kind: "child" | "parent" | "abstract";
  tokenEstimate: number;
}

export interface IndexedChunk extends Chunk {
  embedding?: number[];
}

export interface PaperIndex {
  version: 1;
  paperId: string;
  pdfHash: string;
  title: string;
  createdAt: string;
  chunkPolicy: string;
  /** Effective mode used when building this index. */
  retrievalModeUsed: EffectiveRetrievalMode;
  embedProvider: EmbeddingProvider | null;
  embedModel: string | null;
  chunks: IndexedChunk[];
  /** Total estimated tokens of parent bodies (for stuff decision). */
  parentTokenEstimate: number;
}

export interface RetrievedEvidence {
  chunk: IndexedChunk;
  score: number;
  /** Expanded parent text used in generation context */
  contextText: string;
  cite: string;
}

export interface RagQueryResult {
  mode: "rag" | "stuff" | "empty";
  evidence: RetrievedEvidence[];
  /** Ready-to-inject block for the LLM user/system message */
  contextBlock: string;
  stats: {
    chunkCount: number;
    retrieved: number;
    usedDense: boolean;
    usedBm25: boolean;
  };
}

export interface RagPrefs {
  ragEnabled: boolean;
  ragRetrievalMode: RagRetrievalMode;
  ragTopK: number;
  ragStuffTokenLimit: number;
  embeddingProvider: EmbeddingProvider;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
}

export const DEFAULT_RAG_PREFS: RagPrefs = {
  ragEnabled: true,
  ragRetrievalMode: "auto",
  /** More parents in context → higher recall for multi-aspect questions */
  ragTopK: 12,
  /**
   * Parent-token budget for full-paper stuffing (skip retrieval).
   * ~12–15 page conference papers often land under this with section parents.
   */
  ragStuffTokenLimit: 14000,
  embeddingProvider: "none",
  embeddingBaseUrl: "",
  embeddingApiKey: "",
  embeddingModel: "text-embedding-3-small",
};

/** Bump when chunk defaults change so caches rebuild. */
export const CHUNK_POLICY = "section-parent-child-v3-pages";
export const INDEX_VERSION = 1 as const;

/** Modes that use full-paper RAG evidence. */
export const RAG_MODES = ["chat", "explain", "figure-explain"] as const;

export type RagTaskMode = (typeof RAG_MODES)[number];

export function isRagMode(mode: string): mode is RagTaskMode {
  return (RAG_MODES as readonly string[]).includes(mode);
}

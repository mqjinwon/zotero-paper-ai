/**
 * Read RAG prefs from Zotero preference store.
 */

import { getPref } from "../utils/prefs";
import type { EmbeddingProvider, RagPrefs, RagRetrievalMode } from "./types";
import { DEFAULT_RAG_PREFS } from "./types";

function prefStr(key: string, fallback = ""): string {
  try {
    const v = getPref(key as never);
    if (v == null || v === "") return fallback;
    return String(v).trim();
  } catch {
    return fallback;
  }
}

function prefBool(key: string, fallback: boolean): boolean {
  try {
    const v = getPref(key as never);
    if (typeof v === "boolean") return v;
    if (v == null || v === "") return fallback;
    return String(v) === "true" || v === 1;
  } catch {
    return fallback;
  }
}

function prefInt(key: string, fallback: number): number {
  try {
    const v = getPref(key as never);
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function parseRetrievalMode(raw: string): RagRetrievalMode {
  if (raw === "bm25" || raw === "hybrid" || raw === "auto") return raw;
  return DEFAULT_RAG_PREFS.ragRetrievalMode;
}

function parseEmbedProvider(raw: string): EmbeddingProvider {
  if (raw === "none" || raw === "openai" || raw === "openai-compatible") {
    return raw;
  }
  return DEFAULT_RAG_PREFS.embeddingProvider;
}

/** Live prefs from Zotero. Falls back to defaults outside Zotero. */
export function readRagPrefs(): RagPrefs {
  try {
    return {
      ragEnabled: prefBool("ragEnabled", DEFAULT_RAG_PREFS.ragEnabled),
      ragRetrievalMode: parseRetrievalMode(
        prefStr("ragRetrievalMode", DEFAULT_RAG_PREFS.ragRetrievalMode),
      ),
      // Promote previous ship defaults (8 / 6000) to accuracy-tuned defaults.
      // Custom values (e.g. 10, 8000) are left unchanged.
      ragTopK: (() => {
        const n = prefInt("ragTopK", DEFAULT_RAG_PREFS.ragTopK);
        return n === 8 ? DEFAULT_RAG_PREFS.ragTopK : n;
      })(),
      ragStuffTokenLimit: (() => {
        const n = prefInt(
          "ragStuffTokenLimit",
          DEFAULT_RAG_PREFS.ragStuffTokenLimit,
        );
        return n === 6000 ? DEFAULT_RAG_PREFS.ragStuffTokenLimit : n;
      })(),
      embeddingProvider: parseEmbedProvider(
        prefStr("embeddingProvider", DEFAULT_RAG_PREFS.embeddingProvider),
      ),
      embeddingBaseUrl: prefStr(
        "embeddingBaseUrl",
        DEFAULT_RAG_PREFS.embeddingBaseUrl,
      ),
      embeddingApiKey: prefStr(
        "embeddingApiKey",
        DEFAULT_RAG_PREFS.embeddingApiKey,
      ),
      embeddingModel: prefStr(
        "embeddingModel",
        DEFAULT_RAG_PREFS.embeddingModel,
      ),
    };
  } catch {
    return { ...DEFAULT_RAG_PREFS };
  }
}

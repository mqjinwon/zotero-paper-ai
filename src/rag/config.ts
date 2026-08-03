/**
 * Pure RAG preference / mode resolution (no Zotero globals).
 */

import type {
  EffectiveRetrievalMode,
  EmbeddingProvider,
  RagPrefs,
  RagRetrievalMode,
} from "./types";
import { DEFAULT_RAG_PREFS } from "./types";
import { defaultOpenAIBaseUrl, type EmbedConfig } from "./embed";

export type { EmbedConfig };

export function hasEmbedCredentials(
  provider: EmbeddingProvider,
  apiKey: string,
): boolean {
  if (provider === "none") return false;
  return Boolean(apiKey?.trim());
}

/**
 * Resolve effective retrieval mode from prefs.
 * - auto → hybrid if embed credentials valid, else bm25
 * - bm25 → always bm25
 * - hybrid → requires credentials (throws clear error if missing)
 */
export function resolveEffectiveMode(
  mode: RagRetrievalMode,
  provider: EmbeddingProvider,
  apiKey: string,
): EffectiveRetrievalMode {
  const creds = hasEmbedCredentials(provider, apiKey);
  if (mode === "bm25") return "bm25";
  if (mode === "hybrid") {
    if (!creds) {
      throw new Error(
        "RAG hybrid mode requires an embeddings provider and API key. " +
          "Set embeddingProvider to openai or openai-compatible and provide embeddingApiKey, " +
          "or switch ragRetrievalMode to auto/bm25 (BM25 works without keys).",
      );
    }
    return "hybrid";
  }
  // auto
  return creds ? "hybrid" : "bm25";
}

export function resolveEmbedConfig(prefs: RagPrefs): EmbedConfig | null {
  if (!hasEmbedCredentials(prefs.embeddingProvider, prefs.embeddingApiKey)) {
    return null;
  }
  let baseUrl = (prefs.embeddingBaseUrl || "").trim();
  if (!baseUrl) {
    if (
      prefs.embeddingProvider === "openai" ||
      prefs.embeddingProvider === "openai-compatible"
    ) {
      baseUrl = defaultOpenAIBaseUrl();
    }
  }
  return {
    baseUrl,
    apiKey: prefs.embeddingApiKey.trim(),
    model: (prefs.embeddingModel || "text-embedding-3-small").trim(),
  };
}

export function mergeRagPrefs(partial?: Partial<RagPrefs>): RagPrefs {
  return { ...DEFAULT_RAG_PREFS, ...partial };
}

export function shouldUseRag(
  ragEnabled: boolean,
  mode: string,
  ragModes: readonly string[] = ["chat", "explain", "figure-explain"],
): boolean {
  return ragEnabled && ragModes.includes(mode);
}

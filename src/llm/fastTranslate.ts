/**
 * Minimal translate path: warm token + tiny prompt + immediate fetch.
 * Avoids chat history, paper metadata, and heavy system prompts.
 */

import type { FileStore } from "../auth/fileStore";
import type { LLMClient, PluginLLMConfig } from "./types";
import { createClient } from "./router";

/**
 * Sole translate path (selection popup / auto-translate / paperTask).
 * Keep tiny: latency-sensitive; no RAG, no history.
 */
const FAST_SYSTEM =
  "Academic translator. Translate into the target language only — no notes, no preamble. " +
  "Preserve meaning, technical terms, symbols, and citation markers. " +
  "Keep math as LaTeX $...$ or $$...$$.";

/** Client pool keyed by provider+base+auth (model is per-request). */
const clientPool = new Map<string, LLMClient>();

function clientPoolKey(cfg: PluginLLMConfig): string {
  return [
    cfg.provider,
    cfg.grokApiKey ? "key" : "oauth",
    cfg.grokBaseUrl,
    cfg.grokAuthPath,
    cfg.codexAuthPath,
  ].join("|");
}

export function getOrCreateClient(
  store: FileStore,
  cfg: PluginLLMConfig,
): LLMClient {
  const k = clientPoolKey(cfg);
  const hit = clientPool.get(k);
  if (hit) return hit;
  const client = createClient(store, cfg);
  clientPool.set(k, client);
  return client;
}

/** Prefetch OAuth token so the next translate only waits on the network. */
export async function warmLLM(
  store: FileStore,
  cfg: PluginLLMConfig,
): Promise<void> {
  const client = getOrCreateClient(store, cfg);
  // Tiny no-op complete is too expensive; just resolve auth via a throwaway call path.
  // Grok/Codex clients resolve token on complete — fire a micro complete and abort?
  // Better: import get token directly.
  try {
    if (cfg.provider === "grok") {
      const { getGrokAccessToken } = await import("../auth/grokOAuth");
      if (cfg.grokApiKey?.trim()) {
        /* api key — nothing to warm */
      } else {
        await getGrokAccessToken(store, {
          authPath: cfg.grokAuthPath || undefined,
        });
      }
    } else {
      const { getCodexCredentials } = await import("../auth/codexOAuth");
      await getCodexCredentials(store, {
        authPath: cfg.codexAuthPath || undefined,
      });
    }
  } catch {
    /* warm best-effort */
  }
  void client;
}

export async function fastTranslate(
  store: FileStore,
  cfg: PluginLLMConfig,
  text: string,
  opts?: {
    onDelta?: (t: string) => void;
    signal?: AbortSignal;
  },
): Promise<string> {
  const client = getOrCreateClient(store, cfg);
  const lang = cfg.targetLang || "ko";
  return client.complete({
    model: cfg.model,
    messages: [
      {
        role: "system",
        content: `${FAST_SYSTEM} Target language: ${lang}.`,
      },
      { role: "user", content: text },
    ],
    onDelta: opts?.onDelta,
    signal: opts?.signal,
    reasoningEffort: cfg.reasoningEffort,
  });
}

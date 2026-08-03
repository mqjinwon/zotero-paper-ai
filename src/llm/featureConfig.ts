/**
 * Per-feature provider / model / base URL / reasoning resolution.
 * Empty per-feature fields fall back to global prefs.
 */

import { getPref } from "../utils/prefs";
import type {
  PluginLLMConfig,
  ProviderId,
  ReasoningEffort,
  TaskMode,
} from "./types";
import { defaultModelFor } from "./router";

export type FeatureId = TaskMode;

export const FEATURES: FeatureId[] = [
  "translate",
  "explain",
  "chat",
  "figure-explain",
];

export const FEATURE_LABELS: Record<FeatureId, string> = {
  translate: "Translate",
  explain: "Explain",
  chat: "Chat / Q&A",
  "figure-explain": "Figure",
};

export const REASONING_EFFORTS: ReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
];

/** Pref key suffixes mapped from feature id */
const PREF_KEYS: Record<
  FeatureId,
  { provider: string; model: string; baseUrl: string; reasoning: string }
> = {
  translate: {
    provider: "translateProvider",
    model: "translateModel",
    baseUrl: "translateBaseUrl",
    reasoning: "translateReasoning",
  },
  explain: {
    provider: "explainProvider",
    model: "explainModel",
    baseUrl: "explainBaseUrl",
    reasoning: "explainReasoning",
  },
  chat: {
    provider: "chatProvider",
    model: "chatModel",
    baseUrl: "chatBaseUrl",
    reasoning: "chatReasoning",
  },
  "figure-explain": {
    provider: "figureProvider",
    model: "figureModel",
    baseUrl: "figureBaseUrl",
    reasoning: "figureReasoning",
  },
};

function prefStr(key: string): string {
  try {
    return String(getPref(key as never) ?? "").trim();
  } catch {
    return "";
  }
}

function parseProvider(raw: string, fallback: ProviderId): ProviderId {
  if (raw === "openai-codex" || raw === "codex") return "openai-codex";
  if (raw === "grok") return "grok";
  return fallback;
}

export function parseReasoningEffort(
  raw: string,
  fallback: ReasoningEffort = "medium",
): ReasoningEffort {
  const v = raw.trim().toLowerCase();
  if (v === "none" || v === "low" || v === "medium" || v === "high") return v;
  return fallback;
}

/** Built-in defaults when both feature and global model are empty. */
export function defaultModelForFeature(
  feature: FeatureId,
  provider: ProviderId,
): string {
  if (provider === "openai-codex") return "gpt-5.4";
  return "grok-4.5";
}

/** Default reasoning when prefs empty. */
export function defaultReasoningForFeature(feature: FeatureId): ReasoningEffort {
  return feature === "translate" ? "low" : "medium";
}

export function readGlobalBase(): {
  provider: ProviderId;
  model: string;
  targetLang: string;
  grokApiKey: string;
  grokBaseUrl: string;
  grokAuthPath: string;
  codexAuthPath: string;
  reasoningEffort: ReasoningEffort;
} {
  const provider = parseProvider(prefStr("provider"), "grok");
  return {
    provider,
    model: prefStr("model") || "grok-4.5",
    targetLang: prefStr("targetLang") || "ko",
    grokApiKey: prefStr("grokApiKey"),
    grokBaseUrl: prefStr("grokBaseUrl") || "https://api.x.ai/v1",
    grokAuthPath: prefStr("grokAuthPath"),
    codexAuthPath: prefStr("codexAuthPath"),
    reasoningEffort: parseReasoningEffort(prefStr("reasoningEffort"), "medium"),
  };
}

/**
 * Resolve LLM config for a single feature (translate / explain / chat / …).
 * Per-feature provider/model/baseUrl/reasoning override globals when non-empty.
 */
export function resolveFeatureConfig(feature: FeatureId): PluginLLMConfig {
  const g = readGlobalBase();
  const keys = PREF_KEYS[feature];
  const featProvider = prefStr(keys.provider);
  const featModel = prefStr(keys.model);
  const featBase = prefStr(keys.baseUrl);
  const featReasoning = prefStr(keys.reasoning);

  const provider = parseProvider(featProvider, g.provider);
  const model =
    featModel ||
    g.model ||
    defaultModelForFeature(feature, provider);

  // Base URL: feature override → global → provider default
  const grokBaseUrl = featBase || g.grokBaseUrl || "https://api.x.ai/v1";

  const reasoningEffort = featReasoning
    ? parseReasoningEffort(featReasoning, defaultReasoningForFeature(feature))
    : g.reasoningEffort || defaultReasoningForFeature(feature);

  return {
    provider,
    model,
    targetLang: g.targetLang,
    grokApiKey: g.grokApiKey,
    grokBaseUrl,
    grokAuthPath: g.grokAuthPath,
    codexAuthPath: g.codexAuthPath,
    feature,
    reasoningEffort,
  };
}

/** Pure helper for unit tests (no Zotero prefs). */
export function mergeFeatureConfig(
  globalCfg: {
    provider: ProviderId;
    model: string;
    targetLang: string;
    grokApiKey: string;
    grokBaseUrl: string;
    grokAuthPath: string;
    codexAuthPath: string;
    reasoningEffort?: ReasoningEffort;
  },
  feature: FeatureId,
  overrides: {
    provider?: string;
    model?: string;
    baseUrl?: string;
    reasoning?: string;
  },
): PluginLLMConfig {
  const provider = parseProvider(
    overrides.provider || "",
    globalCfg.provider,
  );
  const model =
    (overrides.model || "").trim() ||
    globalCfg.model ||
    defaultModelForFeature(feature, provider);
  const reasoningEffort = overrides.reasoning?.trim()
    ? parseReasoningEffort(
        overrides.reasoning,
        defaultReasoningForFeature(feature),
      )
    : globalCfg.reasoningEffort || defaultReasoningForFeature(feature);
  return {
    provider,
    model,
    targetLang: globalCfg.targetLang,
    grokApiKey: globalCfg.grokApiKey,
    grokBaseUrl:
      (overrides.baseUrl || "").trim() ||
      globalCfg.grokBaseUrl ||
      "https://api.x.ai/v1",
    grokAuthPath: globalCfg.grokAuthPath,
    codexAuthPath: globalCfg.codexAuthPath,
    feature,
    reasoningEffort,
  };
}

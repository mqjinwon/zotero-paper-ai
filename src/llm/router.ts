import type { FileStore } from "../auth/fileStore";
import { CodexClient } from "./codexClient";
import { GrokClient } from "./grokClient";
import { buildMultimodalMessages } from "./multimodal";
import { buildSystemPrompt, buildUserPayload } from "./prompts";
import type {
  ImagePayload,
  LLMClient,
  PluginLLMConfig,
  ProviderId,
  TaskMode,
} from "./types";
import { messageHasImage } from "./types";

export function createClient(
  store: FileStore,
  config: PluginLLMConfig,
  fetchImpl?: typeof fetch,
): LLMClient {
  if (config.provider === "openai-codex") {
    return new CodexClient({
      store,
      authPath: config.codexAuthPath || undefined,
      defaultModel: config.model || "gpt-5.4",
      fetchImpl,
    });
  }
  return new GrokClient({
    store,
    apiKey: config.grokApiKey || undefined,
    authPath: config.grokAuthPath || undefined,
    baseUrl: config.grokBaseUrl || "https://api.x.ai/v1",
    defaultModel: config.model || "grok-4.5",
    fetchImpl,
  });
}

export async function runTask(
  client: LLMClient,
  opts: {
    mode: TaskMode;
    targetLang: string;
    /** Explicit model id (per-feature). Required for correct multi-model routing. */
    model?: string;
    selection?: string;
    paperTitle?: string;
    context?: string;
    question?: string;
    image?: ImagePayload;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    onDelta?: (t: string) => void;
    signal?: AbortSignal;
    reasoningEffort?: import("./types").ReasoningEffort;
  },
): Promise<string> {
  if (opts.mode === "translate") {
    throw new Error(
      'Translate uses fastTranslate only — do not call runTask({ mode: "translate" }).',
    );
  }

  const needsImage = opts.mode === "figure-explain";

  const messages =
    needsImage || opts.image
      ? buildMultimodalMessages({
          mode: opts.mode,
          targetLang: opts.targetLang,
          selection: opts.selection,
          paperTitle: opts.paperTitle,
          context: opts.context,
          question: opts.question,
          image: opts.image,
          history: opts.history,
        })
      : [
          {
            role: "system" as const,
            content: buildSystemPrompt(opts.mode, opts.targetLang),
          },
          ...(opts.history || []).map((m) => ({
            role: m.role,
            content: m.content,
          })),
          {
            role: "user" as const,
            content: buildUserPayload({
              mode: opts.mode,
              selection: opts.selection,
              paperTitle: opts.paperTitle,
              context: opts.context,
              question: opts.question,
            }),
          },
        ];

  if (
    opts.mode === "figure-explain" &&
    !opts.image?.base64 &&
    !opts.selection
  ) {
    throw new Error(
      "Figure explain needs an image crop or selected text. " +
        "Use Select Area on the PDF, or select caption text near the figure.",
    );
  }

  if (messageHasImage(messages) && client.id === "openai-codex") {
    // Codex Responses path in this plugin is text-only; fail clearly.
    throw new Error(
      "Image/figure explain requires Grok (vision). " +
        "Switch provider to Grok in Paper AI preferences, or set a Grok API key.",
    );
  }

  return client.complete({
    model: opts.model,
    messages,
    onDelta: opts.onDelta,
    signal: opts.signal,
    reasoningEffort: opts.reasoningEffort,
  });
}

export function defaultModelFor(provider: ProviderId): string {
  return provider === "openai-codex" ? "gpt-5.4" : "grok-4.5";
}

export function isVisionMode(mode: TaskMode): boolean {
  return mode === "figure-explain";
}

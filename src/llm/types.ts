export type ProviderId = "grok" | "openai-codex";

export type TaskMode = "translate" | "explain" | "chat" | "figure-explain";

/** OpenAI-compatible multimodal content part. */
export type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "auto" | "low" | "high" };
    };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /** Plain string or multimodal parts (user messages may include images). */
  content: string | ContentPart[];
}

export interface ImagePayload {
  /** Raw base64 without data: prefix */
  base64: string;
  mimeType: string;
}

/** xAI reasoning_effort. grok-4.5 cannot use "none" (coerced to low). */
export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface CompleteOptions {
  model?: string;
  messages: ChatMessage[];
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  /** Grok only — omitted for Codex / when unset */
  reasoningEffort?: ReasoningEffort;
}

export interface LLMClient {
  readonly id: ProviderId;
  complete(opts: CompleteOptions): Promise<string>;
}

export interface PluginLLMConfig {
  provider: ProviderId;
  model: string;
  targetLang: string;
  grokApiKey: string;
  grokBaseUrl: string;
  grokAuthPath: string;
  codexAuthPath: string;
  /** Which feature this config was resolved for (optional, for logging). */
  feature?: TaskMode;
  /** Grok reasoning depth for this feature */
  reasoningEffort?: ReasoningEffort;
}

export function messageHasImage(messages: ChatMessage[]): boolean {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      if (m.content.some((p) => p.type === "image_url")) return true;
    }
  }
  return false;
}

export function contentToPlainText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

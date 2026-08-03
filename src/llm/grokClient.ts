import type { FileStore } from "../auth/fileStore";
import { getGrokAccessToken } from "../auth/grokOAuth";
import type { CompleteOptions, LLMClient, ReasoningEffort } from "./types";

export interface GrokClientOptions {
  store: FileStore;
  apiKey?: string;
  authPath?: string;
  baseUrl?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Normalize reasoning_effort for the target model.
 * grok-4.5 rejects "none" — coerce to "low".
 */
export function resolveGrokReasoningEffort(
  model: string,
  effort?: ReasoningEffort,
): ReasoningEffort | undefined {
  if (!effort) return undefined;
  const m = model.toLowerCase();
  // Flagship 4.5: cannot disable reasoning
  if (effort === "none" && (m.includes("grok-4.5") || m.includes("grok-4-5"))) {
    return "low";
  }
  return effort;
}

export class GrokClient implements LLMClient {
  readonly id = "grok" as const;
  private store: FileStore;
  private apiKey?: string;
  private authPath?: string;
  private baseUrl: string;
  private defaultModel: string;
  private fetchImpl: typeof fetch;

  constructor(opts: GrokClientOptions) {
    this.store = opts.store;
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.authPath = opts.authPath?.trim() || undefined;
    this.baseUrl = (opts.baseUrl || "https://api.x.ai/v1").replace(/\/$/, "");
    this.defaultModel = opts.defaultModel || "grok-4.5";
    this.fetchImpl = opts.fetchImpl || fetch.bind(globalThis);
  }

  private async resolveToken(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    return getGrokAccessToken(this.store, {
      authPath: this.authPath,
      fetchImpl: this.fetchImpl,
    });
  }

  async complete(opts: CompleteOptions): Promise<string> {
    const token = await this.resolveToken();
    const model = opts.model || this.defaultModel;
    const url = `${this.baseUrl}/chat/completions`;
    const body: Record<string, unknown> = {
      model,
      stream: true,
      messages: opts.messages,
      // Faster, more deterministic for translation
      temperature: 0.2,
    };
    const effort = resolveGrokReasoningEffort(model, opts.reasoningEffort);
    if (effort) {
      body.reasoning_effort = effort;
    }
    const resp = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(
        `Grok API error ${resp.status}: ${errText.slice(0, 400)}`,
      );
    }
    if (!resp.body) {
      // Fallback non-stream parse
      const json = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return json.choices?.[0]?.message?.content?.trim() || "";
    }
    return consumeOpenAIChatSSE(resp, opts.onDelta);
  }
}

export async function consumeOpenAIChatSSE(
  resp: Response,
  onDelta?: (t: string) => void,
): Promise<string> {
  // Prefer streaming; fall back to full text if body reader is unavailable.
  const body = resp.body;
  if (!body || typeof (body as ReadableStream<Uint8Array>).getReader !== "function") {
    const full = await resp.text();
    return parseOpenAIChatSSEText(full, onDelta);
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder: { decode: (i?: BufferSource, o?: { stream?: boolean }) => string } =
    new (globalThis as unknown as { TextDecoder: new (label?: string) => {
      decode: (i?: BufferSource, o?: { stream?: boolean }) => string;
    } }).TextDecoder("utf-8");
  let buffer = "";
  let out = "";
  while (true) {
    // zotero-types stream reader typings are incomplete
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: { done: boolean; value?: Uint8Array } = await (reader as any).read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const event = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = event.choices?.[0]?.delta?.content;
        if (delta) {
          out += delta;
          onDelta?.(delta);
        }
      } catch {
        /* skip */
      }
    }
  }
  return out.trim();
}

function parseOpenAIChatSSEText(
  payload: string,
  onDelta?: (t: string) => void,
): string {
  let out = "";
  for (const line of payload.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const delta = event.choices?.[0]?.delta?.content;
      if (delta) {
        out += delta;
        onDelta?.(delta);
      }
    } catch {
      /* skip */
    }
  }
  return out.trim();
}

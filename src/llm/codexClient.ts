import type { FileStore } from "../auth/fileStore";
import { getCodexCredentials } from "../auth/codexOAuth";
import type { CompleteOptions, LLMClient } from "./types";
import { contentToPlainText, messageHasImage } from "./types";

export interface CodexClientOptions {
  store: FileStore;
  authPath?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
}

export class CodexClient implements LLMClient {
  readonly id = "openai-codex" as const;
  private store: FileStore;
  private authPath?: string;
  private defaultModel: string;
  private fetchImpl: typeof fetch;

  constructor(opts: CodexClientOptions) {
    this.store = opts.store;
    this.authPath = opts.authPath?.trim() || undefined;
    this.defaultModel = opts.defaultModel || "gpt-5.4";
    this.fetchImpl = opts.fetchImpl || fetch.bind(globalThis);
  }

  async complete(opts: CompleteOptions): Promise<string> {
    if (messageHasImage(opts.messages)) {
      throw new Error(
        "Image/figure explain requires Grok (vision). " +
          "Switch provider to Grok in Paper AI preferences.",
      );
    }
    const creds = await getCodexCredentials(this.store, {
      authPath: this.authPath,
      fetchImpl: this.fetchImpl,
    });
    const model = opts.model || this.defaultModel;

    let instructions =
      "You are a helpful research assistant. Answer clearly and accurately.";
    const inputItems: Array<{
      role: string;
      content: Array<{ type: string; text: string }>;
    }> = [];

    for (const msg of opts.messages) {
      if (msg.role === "system") {
        instructions = contentToPlainText(msg.content);
        continue;
      }
      inputItems.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: [
          {
            type: "input_text",
            text: contentToPlainText(msg.content),
          },
        ],
      });
    }
    if (!inputItems.length) {
      inputItems.push({
        role: "user",
        content: [{ type: "input_text", text: "" }],
      });
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${creds.accessToken}`,
      "OpenAI-Beta": "responses=experimental",
      originator: "paperai",
      "User-Agent": "paperai",
      accept: "text/event-stream",
      "content-type": "application/json",
    };
    if (creds.accountId) {
      headers["chatgpt-account-id"] = creds.accountId;
    }

    const body = {
      model,
      store: false,
      stream: true,
      instructions,
      input: inputItems,
      text: { verbosity: "low" },
    };

    const resp = await this.fetchImpl(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts.signal,
      },
    );
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(
        `Codex Responses API error ${resp.status}: ${errText.slice(0, 400)}`,
      );
    }
    return consumeCodexSSE(resp, opts.onDelta);
  }
}

export async function consumeCodexSSE(
  resp: Response,
  onDelta?: (t: string) => void,
): Promise<string> {
  if (!resp.body) {
    throw new Error("Codex response has no body");
  }
  const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
  const decoder: { decode: (i?: BufferSource, o?: { stream?: boolean }) => string } =
    new (globalThis as unknown as { TextDecoder: new (label?: string) => {
      decode: (i?: BufferSource, o?: { stream?: boolean }) => string;
    } }).TextDecoder("utf-8");
  let buffer = "";
  let collected = "";
  while (true) {
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
          type?: string;
          delta?: string;
          text?: string;
        };
        if (event.type === "response.output_text.delta" && event.delta) {
          collected += event.delta;
          onDelta?.(event.delta);
        } else if (event.type === "response.output_text.done" && event.text) {
          return String(event.text).trim();
        } else if (event.type === "response.failed") {
          throw new Error(`Codex response failed: ${JSON.stringify(event)}`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Codex response failed")) {
          throw e;
        }
      }
    }
  }
  return collected.trim();
}

/**
 * Pure multimodal message builders (Node-testable).
 * OpenAI vision / xAI Grok chat.completions image_url format.
 */

import type { ChatMessage, ContentPart, ImagePayload } from "./types";
import {
  buildSystemPrompt,
  buildUserPayload,
  type PromptMode,
} from "./prompts";

export function imageToDataUrl(image: ImagePayload): string {
  const mime = image.mimeType || "image/png";
  const b64 = image.base64.replace(/^data:[^;]+;base64,/, "");
  return `data:${mime};base64,${b64}`;
}

export function buildUserContentParts(opts: {
  text: string;
  image?: ImagePayload;
}): ContentPart[] {
  const parts: ContentPart[] = [{ type: "text", text: opts.text }];
  if (opts.image?.base64) {
    parts.push({
      type: "image_url",
      image_url: {
        url: imageToDataUrl(opts.image),
        detail: "high",
      },
    });
  }
  return parts;
}

export function buildMultimodalMessages(opts: {
  /** Vision/RAG modes only — never "translate". */
  mode: PromptMode;
  targetLang: string;
  selection?: string;
  paperTitle?: string;
  context?: string;
  question?: string;
  image?: ImagePayload;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}): ChatMessage[] {
  const system = buildSystemPrompt(opts.mode, opts.targetLang);
  const text = buildUserPayload({
    mode: opts.mode,
    selection: opts.selection,
    paperTitle: opts.paperTitle,
    context: opts.context,
    question: opts.question,
    hasImage: Boolean(opts.image?.base64),
  });

  const messages: ChatMessage[] = [{ role: "system", content: system }];
  for (const h of opts.history || []) {
    messages.push({ role: h.role, content: h.content });
  }

  if (opts.image?.base64) {
    messages.push({
      role: "user",
      content: buildUserContentParts({ text, image: opts.image }),
    });
  } else {
    messages.push({ role: "user", content: text });
  }
  return messages;
}

/** 1×1 transparent PNG (valid base64 fixture for tests). */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function tinyPngPayload(): ImagePayload {
  return { base64: TINY_PNG_BASE64, mimeType: "image/png" };
}

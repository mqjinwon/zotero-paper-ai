import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMultimodalMessages,
  buildUserContentParts,
  imageToDataUrl,
  tinyPngPayload,
  TINY_PNG_BASE64,
} from "../../src/llm/multimodal.ts";
import {
  buildSystemPrompt,
  buildUserPayload,
  MATH_PRESERVE,
} from "../../src/llm/prompts.ts";
import {
  isVisionMode,
  runTask,
  defaultModelFor,
} from "../../src/llm/router.ts";
import type { ChatMessage, LLMClient } from "../../src/llm/types.ts";
import { messageHasImage } from "../../src/llm/types.ts";
import {
  bytesToBase64,
  dataUrlToImagePayload,
} from "../../src/ui/imageCapture.ts";
import { renderMarkdown } from "../../src/ui/markdown.ts";
import {
  cacheKey,
  getCachedToken,
  setCachedToken,
  clearTokenCache,
} from "../../src/auth/tokenCache.ts";

describe("phase2 figure prompts", () => {
  it("figure-explain system prompt covers figures and math delimiters", () => {
    const s = buildSystemPrompt("figure-explain", "ko");
    assert.match(s, /figure|table|co-reader/i);
    assert.match(s, /LaTeX|\$/);
    assert.ok(s.includes("$$") || s.includes("$") || s.includes("LaTeX"));
    assert.ok(s.includes("LaTeX") || s.includes(MATH_PRESERVE.slice(0, 20)));
  });

  it("user payload marks attached image for figure mode", () => {
    const u = buildUserPayload({
      mode: "figure-explain",
      paperTitle: "ResNet paper",
      hasImage: true,
    });
    assert.match(u, /ResNet/);
    assert.match(u, /image/i);
    assert.match(u, /figure/i);
  });
});

describe("phase2 multimodal builders", () => {
  it("builds image_url data URL from payload", () => {
    const img = tinyPngPayload();
    const url = imageToDataUrl(img);
    assert.equal(url.startsWith("data:image/png;base64,"), true);
    assert.ok(url.includes(TINY_PNG_BASE64));
  });

  it("buildUserContentParts includes text + image_url", () => {
    const parts = buildUserContentParts({
      text: "Explain this figure",
      image: tinyPngPayload(),
    });
    assert.equal(parts.length, 2);
    assert.equal(parts[0].type, "text");
    assert.equal(parts[1].type, "image_url");
    if (parts[1].type === "image_url") {
      assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
    }
  });

  it("buildMultimodalMessages for figure includes system math + image content", () => {
    const messages = buildMultimodalMessages({
      mode: "figure-explain",
      targetLang: "ko",
      paperTitle: "Demo",
      image: tinyPngPayload(),
    });
    assert.equal(messages[0].role, "system");
    assert.equal(typeof messages[0].content, "string");
    assert.match(String(messages[0].content), /\$\.\.\.\$|LaTeX/);
    const user = messages[messages.length - 1];
    assert.equal(user.role, "user");
    assert.ok(Array.isArray(user.content));
    assert.equal(messageHasImage(messages), true);
    const parts = user.content as Array<{ type: string }>;
    assert.ok(parts.some((p) => p.type === "image_url"));
    assert.ok(parts.some((p) => p.type === "text"));
  });
});

describe("phase2 imageCapture pure helpers", () => {
  it("bytesToBase64 round-trips tiny PNG bytes", () => {
    const buf = Buffer.from(TINY_PNG_BASE64, "base64");
    const b64 = bytesToBase64(new Uint8Array(buf));
    assert.equal(b64, TINY_PNG_BASE64);
  });

  it("dataUrlToImagePayload parses data URL", () => {
    const url = `data:image/png;base64,${TINY_PNG_BASE64}`;
    const p = dataUrlToImagePayload(url);
    assert.ok(p);
    assert.equal(p!.mimeType, "image/png");
    assert.equal(p!.base64, TINY_PNG_BASE64);
  });
});

describe("phase2 runTask routing", () => {
  it("isVisionMode flags figure only", () => {
    assert.equal(isVisionMode("figure-explain"), true);
    assert.equal(isVisionMode("explain"), false);
    assert.equal(isVisionMode("chat"), false);
  });

  it("runTask sends multimodal messages to client for figure+image", async () => {
    let seen: ChatMessage[] | null = null;
    const client: LLMClient = {
      id: "grok",
      async complete(opts) {
        seen = opts.messages;
        return "Figure shows $$y=x^2$$ trend.";
      },
    };
    const out = await runTask(client, {
      mode: "figure-explain",
      targetLang: "en",
      paperTitle: "Test",
      image: tinyPngPayload(),
    });
    assert.ok(seen);
    assert.equal(messageHasImage(seen!), true);
    assert.match(out, /\$\$y=x\^2\$\$/);
    // KaTeX path still works on model output
    assert.match(renderMarkdown(out), /katex/);
  });

  it("runTask rejects vision image on codex client path", async () => {
    const client: LLMClient = {
      id: "openai-codex",
      async complete() {
        return "should not run";
      },
    };
    await assert.rejects(
      () =>
        runTask(client, {
          mode: "figure-explain",
          targetLang: "en",
          image: tinyPngPayload(),
        }),
      /Grok|vision/i,
    );
  });

  it("runTask fails clearly when figure mode has no image and no selection", async () => {
    const client: LLMClient = {
      id: "grok",
      async complete() {
        return "nope";
      },
    };
    await assert.rejects(
      () =>
        runTask(client, {
          mode: "figure-explain",
          targetLang: "ko",
        }),
      /image|selection/i,
    );
  });
});

describe("latency helpers", () => {
  it("default Grok model is grok-4.5", () => {
    assert.equal(defaultModelFor("grok"), "grok-4.5");
  });

  it("token cache returns hit without re-fetch", () => {
    clearTokenCache();
    const key = cacheKey("grok", "/tmp/auth.json");
    assert.equal(getCachedToken(key), null);
    setCachedToken(key, "tok-abc", Date.now() / 1000 + 3600);
    const hit = getCachedToken(key, 60);
    assert.ok(hit);
    assert.equal(hit!.token, "tok-abc");
    clearTokenCache();
  });
});

describe("per-feature config", () => {
  it("mergeFeatureConfig applies translate model/baseUrl/reasoning overrides", async () => {
    const { mergeFeatureConfig, defaultModelForFeature } =
      await import("../../src/llm/featureConfig.ts");
    const base = {
      provider: "grok" as const,
      model: "global-model",
      targetLang: "ko",
      grokApiKey: "",
      grokBaseUrl: "https://api.x.ai/v1",
      grokAuthPath: "",
      codexAuthPath: "",
      reasoningEffort: "medium" as const,
    };
    const tr = mergeFeatureConfig(base, "translate", {
      model: "grok-4.5",
      baseUrl: "https://api.x.ai/v1",
      reasoning: "low",
    });
    assert.equal(tr.model, "grok-4.5");
    assert.equal(tr.feature, "translate");
    assert.equal(tr.reasoningEffort, "low");

    const chat = mergeFeatureConfig(base, "chat", {
      model: "grok-4.5",
      provider: "grok",
    });
    assert.equal(chat.model, "grok-4.5");
    assert.equal(chat.reasoningEffort, "medium");

    const empty = mergeFeatureConfig(base, "translate", {});
    assert.equal(empty.model, "global-model");

    assert.equal(defaultModelForFeature("translate", "grok"), "grok-4.5");
    assert.equal(
      defaultModelForFeature("chat", "grok"),
      defaultModelForFeature("translate", "grok"),
    );
  });

  it("grok-4.5 coerces reasoning none → low", async () => {
    const { resolveGrokReasoningEffort } =
      await import("../../src/llm/grokClient.ts");
    assert.equal(resolveGrokReasoningEffort("grok-4.5", "none"), "low");
    assert.equal(resolveGrokReasoningEffort("grok-4.5", "high"), "high");
    assert.equal(resolveGrokReasoningEffort("grok-4.3", "none"), "none");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeMathDelimiters,
  renderMarkdown,
} from "../../src/ui/markdown.ts";
import {
  buildSummarySystemPrompt,
  buildSummaryUserPayload,
  buildSystemPrompt,
  buildUserPayload,
} from "../../src/llm/prompts.ts";
import { runTask } from "../../src/llm/router.ts";
import type { LLMClient } from "../../src/llm/types.ts";
import { consumeOpenAIChatSSE } from "../../src/llm/grokClient.ts";

describe("prompts", () => {
  it("asks for LaTeX math preservation", () => {
    const s = buildSystemPrompt("explain", "ko");
    assert.match(s, /\$inline\$|\$\$display\$\$|LaTeX/);
  });

  it("figure mode keeps math instructions", () => {
    for (const mode of ["figure-explain"] as const) {
      const s = buildSystemPrompt(mode, "ko");
      assert.match(s, /LaTeX|\$/);
    }
  });

  it("builds user payload with selection (explain path)", () => {
    const u = buildUserPayload({
      mode: "explain",
      selection: "Hello world",
      paperTitle: "Test Paper",
    });
    assert.match(u, /Hello world/);
    assert.match(u, /Test Paper/);
    assert.match(u, /explain/i);
  });

  it("explain prompt is paper-grounded and structured", () => {
    const s = buildSystemPrompt("explain", "ko");
    assert.match(s, /co-reader|research/i);
    assert.match(s, /evidence|\[E1\]|assumption/i);
  });

  it("chat prompt asks for [E#] cites not §Body", () => {
    const s = buildSystemPrompt("chat", "ko");
    assert.match(s, /\[E1\]|\[E2\]/);
    assert.match(s, /§Body|never invent|Do not invent/i);
  });

  it("summary prompt asks for 3–5 bullets only", () => {
    const s = buildSummarySystemPrompt("ko");
    assert.match(s, /3 to 5|3–5|3-5/i);
    assert.match(s, /bullet/i);
    const u = buildSummaryUserPayload({
      paperTitle: "Attention",
      context: "Evidence passages\n[§Abstract] …",
    });
    assert.match(u, /Attention/);
    assert.match(u, /Evidence passages/);
  });

  it("runTask rejects translate (fastTranslate only)", async () => {
    const client: LLMClient = {
      id: "grok",
      complete: async () => {
        throw new Error("should not be called");
      },
    };
    await assert.rejects(
      () =>
        runTask(client, {
          mode: "translate",
          targetLang: "ko",
          selection: "hi",
        }),
      /fastTranslate/,
    );
  });
});

describe("markdown math", () => {
  it("normalizes \\( \\) delimiters", () => {
    const n = normalizeMathDelimiters("see \\(x^2\\) here");
    assert.equal(n.includes("$x^2$"), true);
  });

  it("normalizes math fences and equation env", () => {
    const fence = normalizeMathDelimiters("```math\nE=mc^2\n```");
    assert.match(fence, /\$\$[\s\S]*E=mc\^2[\s\S]*\$\$/);
    const eq = normalizeMathDelimiters(
      "\\begin{equation}\na+b=c\n\\end{equation}",
    );
    assert.match(eq, /\$\$[\s\S]*a\+b=c[\s\S]*\$\$/);
    assert.doesNotMatch(eq, /begin\{equation\}/);
  });

  it("renders display math with KaTeX", () => {
    const html = renderMarkdown("Energy: $$E=mc^2$$");
    assert.match(html, /katex/);
  });

  it("renders fenced latex and align via KaTeX", () => {
    const fence = renderMarkdown("```latex\n\\frac{1}{2}\n```");
    assert.match(fence, /katex/);
    const align = renderMarkdown(
      "\\begin{aligned}\nx&=1\\\\\ny&=2\n\\end{aligned}",
    );
    assert.match(align, /katex/);
  });
});

describe("SSE consumer", () => {
  it("parses OpenAI chat stream chunks", async () => {
    const payload =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
      "data: [DONE]\n\n";
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    const resp = new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
    const text = await consumeOpenAIChatSSE(resp);
    assert.equal(text, "Hello");
  });
});

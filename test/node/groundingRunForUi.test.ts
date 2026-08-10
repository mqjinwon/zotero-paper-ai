import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fromLLMClient,
  groundAnswerForUi,
  toSentenceRefs,
} from "../../src/rag/grounding";

const PAPER_TEXT =
  "We present residual force learning for quadruped locomotion.";

describe("fromLLMClient", () => {
  it("forwards complete with default model", async () => {
    let seenModel: string | undefined;
    const client = {
      complete: async (o: {
        model?: string;
        messages: Array<{ role: string; content: string }>;
      }) => {
        seenModel = o.model;
        return "{}";
      },
    };
    const llm = fromLLMClient(client, "test-model");
    assert.equal(llm.model, "test-model");
    await llm.complete({
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(seenModel, "test-model");
  });
});

describe("groundAnswerForUi", () => {
  it("end-to-end with mock client + mock locate yields cite link", async () => {
    let step = 0;
    const client = {
      complete: async () => {
        step++;
        if (step === 1) {
          return JSON.stringify({
            claims: [
              {
                text: "They use residual force learning.",
                type: "method",
                must_terms: ["residual force learning"],
                numbers: [],
              },
            ],
          });
        }
        if (step === 2) {
          return JSON.stringify({
            claims: [
              {
                id: "c1",
                text_en: "They use residual force learning.",
                must_terms: ["residual force learning"],
                numbers: [],
              },
            ],
          });
        }
        return JSON.stringify({
          label: "support",
          sentence_id: "c0:0",
          confidence: 0.91,
        });
      },
    };
    const g = await groundAnswerForUi({
      answer: "They use residual force learning on terrain.",
      paperSentences: [
        {
          text: PAPER_TEXT,
          pageStart: 1,
          chunkId: "c0",
        },
      ],
      evidence: [{ chunk: { id: "c0" } }],
      client,
      model: "mock",
      locate: async () => ({
        pageIndex: 0,
        pageLabel: "1",
        rects: [[1, 2, 3, 4]],
        matchedText: PAPER_TEXT,
      }),
    });
    assert.ok(g.matched >= 1);
    assert.match(g.answer, /paperai-cite-phrase/);
    assert.equal(g.ragFooter, "");
    assert.ok(g.claimCount >= 1);
  });

  it("fail closed when allowLegacyFallback omitted and client throws on complete", async () => {
    const client = {
      complete: async () => {
        throw new Error("llm down");
      },
    };
    // Rule claim extract may still run after completeJson catches — force throw
    // after claims by using a client that always throws (claims use rule fallback).
    // Then normalize/judge also throw → no support → matched 0.
    // Stronger: inject locate and ensure no legacy path without allowLegacy.
    const g = await groundAnswerForUi({
      answer: "They use residual force learning for better tracking.",
      paperSentences: [{ text: PAPER_TEXT, pageStart: 1 }],
      client,
      model: "mock",
      locate: async () => null,
      // allowLegacyFallback default false
    });
    // With throwing LLM: rule claims may exist but judges fail → no links
    assert.equal(g.matched, 0);
    assert.doesNotMatch(g.answer, /paperai-cite-phrase/);
    // Body preserved (may still be original)
    assert.match(g.answer, /residual force learning/i);
  });

  it("HQ throw keeps answer unlinked even with allowLegacyFallback true", async () => {
    const statuses: string[] = [];
    // Force pipeline to throw during claim extract (complete throws after
    // extractClaims would use rules — poison corpus text access later).
    // Poison PaperSentenceRef.text so retrieve/candidates explode mid-pipeline.
    const poisoned = {
      id: "s1",
      get text(): string {
        throw new Error("hq-force-throw");
      },
      pageStart: 1,
    };
    const original =
      "Unlinked body about residual force learning stays plain text.";
    const g = await groundAnswerForUi({
      answer: original,
      paperSentences: [poisoned as { text: string; pageStart: number }],
      client: {
        complete: async () =>
          JSON.stringify({
            claims: [
              {
                text: "They use residual force learning.",
                type: "method",
                must_terms: ["residual"],
                numbers: [],
              },
            ],
          }),
      },
      model: "mock",
      // Even true: catch must NOT call groundAnswerToPaper
      allowLegacyFallback: true,
      locate: async () => null,
      onStatus: (m) => statuses.push(m),
    });
    assert.equal(g.matched, 0);
    assert.equal(g.answer, original);
    assert.doesNotMatch(g.answer, /paperai-cite-phrase/);
    assert.equal(statuses[0], "근거 판정(claim·judge·PDF) 중…");
    assert.ok(
      statuses.some(
        (s) => s.includes("근거 판정 실패") || s.includes("hq-force-throw"),
      ),
    );
  });

  it("emits progress then result via onStatus on success path", async () => {
    const statuses: string[] = [];
    let step = 0;
    const client = {
      complete: async () => {
        step++;
        if (step === 1) {
          return JSON.stringify({
            claims: [
              {
                text: "They use residual force learning.",
                type: "method",
                must_terms: ["residual force learning"],
                numbers: [],
              },
            ],
          });
        }
        if (step === 2) {
          return JSON.stringify({
            claims: [
              {
                id: "c1",
                text_en: "They use residual force learning.",
                must_terms: ["residual force learning"],
                numbers: [],
              },
            ],
          });
        }
        return JSON.stringify({
          label: "support",
          sentence_id: "c0:0",
          confidence: 0.91,
        });
      },
    };
    await groundAnswerForUi({
      answer: "They use residual force learning on terrain.",
      paperSentences: [{ text: PAPER_TEXT, pageStart: 1, chunkId: "c0" }],
      client,
      model: "mock",
      locate: async () => ({
        pageIndex: 0,
        pageLabel: "1",
        rects: [[1, 2, 3, 4]],
        matchedText: PAPER_TEXT,
      }),
      onStatus: (m) => statuses.push(m),
    });
    assert.equal(statuses[0], "근거 판정(claim·judge·PDF) 중…");
    assert.ok(statuses.length >= 2);
    assert.match(statuses[statuses.length - 1]!, /근거 링크/);
  });

  it("toSentenceRefs maps chunk evidence", () => {
    const refs = toSentenceRefs(
      [{ text: PAPER_TEXT, chunkId: "x", pageStart: 2 }],
      new Set(["x"]),
    );
    assert.equal(refs[0].fromEvidence, true);
    assert.equal(refs[0].id, "x:0");
  });
});

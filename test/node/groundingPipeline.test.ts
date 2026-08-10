import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groundAnswerHighQuality } from "../../src/rag/grounding/pipeline";
import type { PaperSentenceRef } from "../../src/rag/grounding/types";

const paper: PaperSentenceRef[] = [
  {
    id: "s1",
    text: "We present residual force learning for quadruped locomotion.",
    pageStart: 1,
    fromEvidence: true,
  },
];

function mockLlmSupport() {
  let step = 0;
  return {
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
        sentence_id: "s1",
        confidence: 0.92,
      });
    },
  };
}

describe("groundAnswerHighQuality", () => {
  it("end-to-end: KO-ish claim path with mocks yields locked link", async () => {
    const locate = async () => ({
      pageIndex: 0,
      pageLabel: "1",
      rects: [[10, 20, 100, 40]],
      matchedText: paper[0].text,
    });
    const r = await groundAnswerHighQuality({
      answer: "They use residual force learning on terrain.",
      paperSentences: paper,
      llm: mockLlmSupport(),
      locate,
    });
    assert.ok(r.matched >= 1);
    assert.match(r.answer, /paperai-cite-phrase/);
    assert.equal(r.diagnostics.locateFailures, 0);
    assert.match(r.answer, /data-rects=/);
    assert.ok(r.links.every((l) => l.source === "hq-locked"));
  });

  it("locate failure yields no link", async () => {
    const r = await groundAnswerHighQuality({
      answer: "They use residual force learning on terrain.",
      paperSentences: paper,
      llm: mockLlmSupport(),
      locate: async () => null,
    });
    assert.equal(r.matched, 0);
    assert.ok(r.diagnostics.locateFailures >= 1);
    assert.doesNotMatch(r.answer, /paperai-cite-phrase/);
  });

  it("legacy fallback when llm null and allowLegacyFallback true", async () => {
    const r = await groundAnswerHighQuality({
      answer:
        "They use residual force learning for better tracking on rough terrain.",
      paperSentences: paper,
      llm: null,
      allowLegacyFallback: true,
    });
    assert.ok(typeof r.answer === "string");
    assert.ok(r.diagnostics.claimCount >= 0);
    for (const link of r.links) {
      assert.equal(link.source, "legacy-lexical");
      assert.equal(link.rects, undefined);
    }
  });

  it("allowLegacyFallback false + no llm → matched 0, no cite links", async () => {
    const r = await groundAnswerHighQuality({
      answer: "Anything about residual force learning.",
      paperSentences: paper,
      llm: null,
      allowLegacyFallback: false,
    });
    assert.equal(r.matched, 0);
    assert.equal(r.answer, "Anything about residual force learning.");
    assert.doesNotMatch(r.answer, /paperai-cite-phrase/);
  });

  it("default allowLegacyFallback is false when omitted", async () => {
    const r = await groundAnswerHighQuality({
      answer: "They use residual force learning for better tracking.",
      paperSentences: paper,
      llm: null,
    });
    assert.equal(r.matched, 0);
    assert.doesNotMatch(r.answer, /paperai-cite-phrase/);
  });
});

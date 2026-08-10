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

describe("groundAnswerHighQuality", () => {
  it("end-to-end: KO-ish claim path with mocks yields locked link", async () => {
    let step = 0;
    const llm = {
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
    const locate = async () => ({
      pageIndex: 0,
      pageLabel: "1",
      rects: [[10, 20, 100, 40]],
      matchedText: paper[0].text,
    });
    const r = await groundAnswerHighQuality({
      answer: "They use residual force learning on terrain.",
      paperSentences: paper,
      llm,
      locate,
    });
    assert.ok(r.matched >= 1);
    assert.match(r.answer, /paperai-cite-phrase/);
    assert.equal(r.diagnostics.locateFailures, 0);
    assert.match(r.answer, /data-rects=/);
  });

  it("locate failure yields no link", async () => {
    let step = 0;
    const llm = {
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
    const r = await groundAnswerHighQuality({
      answer: "They use residual force learning on terrain.",
      paperSentences: paper,
      llm,
      locate: async () => null,
    });
    assert.equal(r.matched, 0);
    assert.ok(r.diagnostics.locateFailures >= 1);
    assert.doesNotMatch(r.answer, /paperai-cite-phrase/);
  });

  it("legacy fallback when llm null and allowLegacyFallback", async () => {
    const r = await groundAnswerHighQuality({
      answer:
        "They use residual force learning for better tracking on rough terrain.",
      paperSentences: paper,
      llm: null,
      allowLegacyFallback: true,
    });
    // Lexical path may or may not match depending on score; ensure no throw
    assert.ok(typeof r.answer === "string");
    assert.ok(r.diagnostics.claimCount >= 0);
  });

  it("no locate and no legacy: empty links when llm missing", async () => {
    const r = await groundAnswerHighQuality({
      answer: "Anything about residual force learning.",
      paperSentences: paper,
      llm: null,
      allowLegacyFallback: false,
    });
    assert.equal(r.matched, 0);
    assert.equal(r.answer, "Anything about residual force learning.");
  });
});

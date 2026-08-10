import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completeJson } from "../../src/rag/grounding/llmJson";
import { applyNormalizeResult } from "../../src/rag/grounding/normalize";
import { parseJudgment } from "../../src/rag/grounding/judge";
import type { Claim } from "../../src/rag/grounding/types";

const claim: Claim = {
  id: "c1",
  text: "질량 접촉 예측이 핵심이다",
  textEn: "질량 접촉 예측이 핵심이다",
  type: "result",
  mustTerms: [],
  numbers: [],
};

describe("applyNormalizeResult", () => {
  it("fills textEn from LLM batch", () => {
    const out = applyNormalizeResult([claim], {
      claims: [
        {
          id: "c1",
          text_en: "Mass-contact prediction is key.",
          must_terms: ["mass-contact"],
          numbers: [],
        },
      ],
    });
    assert.match(out[0].textEn, /Mass-contact/i);
    assert.equal(out[0].mustTerms[0], "mass-contact");
  });
});

describe("parseJudgment", () => {
  it("accepts support with known sentence id", () => {
    const j = parseJudgment(
      {
        label: "support",
        sentence_id: "s2",
        confidence: 0.9,
      },
      claim,
      new Map([["s2", "Explicit mass-contact prediction is key to recovery."]]),
    );
    assert.equal(j.label, "support");
    assert.equal(j.sentenceId, "s2");
    assert.ok(j.paperSentence?.includes("mass-contact"));
  });

  it("rejects unknown sentence id as none", () => {
    const j = parseJudgment(
      { label: "support", sentence_id: "nope", confidence: 1 },
      claim,
      new Map([["s2", "hello"]]),
    );
    assert.equal(j.label, "none");
    assert.equal(j.sentenceId, null);
  });
});

describe("completeJson", () => {
  it("strips fences and parses JSON", async () => {
    const llm = {
      complete: async () => '```json\n{"ok":true,"n":1}\n```',
    };
    const out = (await completeJson(llm, "sys", "user")) as {
      ok: boolean;
      n: number;
    };
    assert.equal(out.ok, true);
    assert.equal(out.n, 1);
  });
});

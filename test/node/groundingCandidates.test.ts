import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retrieveCandidates } from "../../src/rag/grounding/candidates";
import type { Claim, PaperSentenceRef } from "../../src/rag/grounding/types";

const corpus: PaperSentenceRef[] = [
  {
    id: "a",
    text: "We present residual force learning for quadruped locomotion.",
    section: "Abstract",
    fromEvidence: false,
  },
  {
    id: "b",
    text: "The stock market closed higher on Friday afternoon trading.",
    section: "Body",
    fromEvidence: false,
  },
  {
    id: "c",
    text: "Residual force learning improves tracking on rough terrain.",
    section: "Method",
    fromEvidence: true,
    chunkId: "ch1",
  },
];

const claim: Claim = {
  id: "c1",
  text: "They use residual force learning.",
  textEn: "They use residual force learning.",
  type: "method",
  mustTerms: ["residual", "force"],
  numbers: [],
};

describe("retrieveCandidates", () => {
  it("ranks residual-force sentences above unrelated", () => {
    const out = retrieveCandidates(claim, corpus, { topN: 3 });
    assert.ok(out.length >= 1);
    assert.ok(["a", "c"].includes(out[0].sentence.id));
  });

  it("boosts fromEvidence sentences via prior", () => {
    const out = retrieveCandidates(claim, corpus, { topN: 3 });
    const c = out.find((x) => x.sentence.id === "c");
    assert.ok(c);
    assert.ok(c!.scorePrior > 0);
  });

  it("dense path: ranking prefers dense match when embeddings provided", () => {
    // No evidence prior; weak BM25; dense vector points only at "b".
    const local: PaperSentenceRef[] = [
      {
        id: "a",
        text: "We present residual force learning for quadruped locomotion.",
        fromEvidence: false,
      },
      {
        id: "b",
        text: "The stock market closed higher on Friday afternoon trading.",
        fromEvidence: false,
      },
      {
        id: "c",
        text: "Residual force learning improves tracking on rough terrain.",
        fromEvidence: false,
      },
    ];
    const weakClaim: Claim = {
      id: "c-d",
      text: "xyzzy-qwerty",
      textEn: "xyzzy-qwerty",
      type: "other",
      mustTerms: [],
      numbers: [],
    };
    const without = retrieveCandidates(weakClaim, local, { topN: 3 });
    assert.ok(without.every((x) => x.scoreDense === undefined));

    // Negative cosine is dropped from dense list (sc >= 0); only "b" remains.
    const withDense = retrieveCandidates(weakClaim, local, {
      topN: 3,
      embedClaim: [1, 0, 0],
      corpusEmbeddings: [
        [-1, 0, 0],
        [1, 0, 0], // b — only dense survivor
        [-1, 0, 0],
      ],
    });
    assert.equal(withDense[0].sentence.id, "b");
    assert.ok((withDense[0].scoreDense ?? 0) > 0.99);
  });
});

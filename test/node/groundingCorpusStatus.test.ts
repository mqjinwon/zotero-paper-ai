import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGroundingCorpus } from "../../src/rag/grounding/corpus";
import {
  formatGroundingErrorStatus,
  formatGroundingProgressStatus,
  formatGroundingResultStatus,
} from "../../src/rag/grounding/status";

describe("buildGroundingCorpus", () => {
  it("prefers paperSentences when non-empty", () => {
    const paper = [
      {
        text: "We present residual force learning for quadruped locomotion.",
        pageStart: 1,
      },
    ];
    const out = buildGroundingCorpus(paper, [
      {
        chunk: {
          id: "c0",
          text: "Evidence chunk text that is long enough to pass the filter threshold easily.",
          pageStart: 2,
        },
      },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, paper[0].text);
    assert.equal(out[0].pageStart, 1);
  });

  it("maps evidence when paperSentences empty", () => {
    const long =
      "This evidence chunk is definitely long enough to become a grounding sentence.";
    const out = buildGroundingCorpus(
      [],
      [
        {
          chunk: {
            id: "e1",
            anchorText: long,
            pageStart: 3,
            pageEnd: 3,
            section: "Method",
          },
        },
        {
          chunk: { text: "too short" },
        },
      ],
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].text, long);
    assert.equal(out[0].chunkId, "e1");
    assert.equal(out[0].pageStart, 3);
    assert.equal(out[0].section, "Method");
  });

  it("clips evidence text at 420 chars", () => {
    const long = "a".repeat(500);
    const out = buildGroundingCorpus(null, [{ contextText: long }]);
    assert.equal(out.length, 1);
    assert.ok(out[0].text.length <= 420);
    assert.ok(out[0].text.endsWith("…"));
  });

  it("returns empty for null/empty inputs", () => {
    assert.deepEqual(buildGroundingCorpus(null, null), []);
    assert.deepEqual(buildGroundingCorpus(undefined, []), []);
  });
});

describe("formatGrounding*Status", () => {
  it("progress status", () => {
    assert.equal(
      formatGroundingProgressStatus(),
      "근거 판정(claim·judge·PDF) 중…",
    );
  });

  it("result with locate fails and dense", () => {
    const msg = formatGroundingResultStatus({
      matched: 2,
      claimCount: 5,
      diagnostics: {
        usedDense: true,
        claimCount: 5,
        candidateCounts: [3, 2],
        locateFailures: 1,
      },
    });
    assert.equal(msg, "근거 링크 2/5 · locate실패 1 · dense");
  });

  it("result none when zero claims", () => {
    assert.equal(
      formatGroundingResultStatus({
        matched: 0,
        claimCount: 0,
        diagnostics: {
          usedDense: false,
          claimCount: 0,
          candidateCounts: [],
          locateFailures: 0,
        },
      }),
      "근거 링크 없음",
    );
  });

  it("error status", () => {
    assert.equal(
      formatGroundingErrorStatus(new Error("boom")),
      "근거 판정 실패: boom",
    );
    assert.equal(formatGroundingErrorStatus(), "근거 링크 없음");
  });
});

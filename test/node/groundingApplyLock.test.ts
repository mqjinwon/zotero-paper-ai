import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildNeedleVariants,
  lockJudgmentToPdf,
} from "../../src/rag/grounding/pdfLock";
import { applyLockedEvidence } from "../../src/rag/grounding/apply";
import type { Claim, Judgment, LockedEvidence } from "../../src/rag/grounding/types";

describe("buildNeedleVariants", () => {
  it("includes full sentence and shorter prefixes", () => {
    const s =
      "We present residual force learning for quadruped locomotion on rough terrain.";
    const v = buildNeedleVariants(s);
    assert.equal(v[0], s.replace(/\s+/g, " ").trim());
    assert.ok(v.length >= 2);
    assert.ok(v.every((x) => x.length >= 24 || x === v[0]));
  });
});

describe("applyLockedEvidence", () => {
  it("wraps phrase and builds tray", () => {
    const locks: LockedEvidence[] = [
      {
        claimId: "c1",
        answerPhrase: "residual force learning",
        paperSentence:
          "We present residual force learning for quadruped locomotion.",
        pageStart: 1,
        locateOk: true,
        source: "hq-locked",
      },
    ];
    const { answer, tray } = applyLockedEvidence(
      "They use residual force learning carefully.",
      locks,
    );
    assert.match(answer, /paperai-cite-phrase/);
    assert.match(answer, /data-preview=/);
    assert.match(tray, /근거/);
  });

  it("includes data-rects when present", () => {
    const locks: LockedEvidence[] = [
      {
        claimId: "c1",
        answerPhrase: "residual force learning",
        paperSentence: "We present residual force learning for quadrupeds.",
        pageStart: 1,
        rects: [[10, 20, 100, 40]],
        locateOk: true,
        source: "hq-locked",
      },
    ];
    const { answer } = applyLockedEvidence(
      "They use residual force learning carefully.",
      locks,
    );
    assert.match(answer, /data-rects=/);
  });
});

describe("lockJudgmentToPdf", () => {
  const claim: Claim = {
    id: "c1",
    text: "They use residual force learning.",
    textEn: "They use residual force learning.",
    type: "method",
    mustTerms: ["residual force learning"],
    numbers: [],
  };
  const judgment: Judgment = {
    claimId: "c1",
    label: "support",
    sentenceId: "s1",
    paperSentence:
      "We present residual force learning for quadruped locomotion.",
    confidence: 0.9,
  };

  it("returns lock when locate succeeds", async () => {
    const lock = await lockJudgmentToPdf({
      claim,
      judgment,
      locate: async () => ({
        pageIndex: 0,
        pageLabel: "1",
        rects: [[1, 2, 3, 4]],
        matchedText: judgment.paperSentence!,
      }),
    });
    assert.ok(lock);
    assert.equal(lock!.pageStart, 1);
    assert.equal(lock!.locateOk, true);
    assert.equal(lock!.source, "hq-locked");
    assert.ok(lock!.rects?.length);
  });

  it("returns null when locate fails", async () => {
    const lock = await lockJudgmentToPdf({
      claim,
      judgment,
      locate: async () => null,
    });
    assert.equal(lock, null);
  });

  it("returns null for non-support", async () => {
    const lock = await lockJudgmentToPdf({
      claim,
      judgment: { ...judgment, label: "partial" },
      locate: async () => ({
        pageIndex: 0,
        pageLabel: "1",
        rects: [[1, 2, 3, 4]],
        matchedText: "x",
      }),
    });
    assert.equal(lock, null);
  });
});

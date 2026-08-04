/**
 * Post-hoc answer ↔ paper-sentence grounding tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyGroundedLinks,
  extractClaimSpans,
  groundAnswerToPaper,
  groundingScore,
  matchClaimToPaper,
  pickLinkPhrase,
  sentencesFromChunks,
  splitSentences,
  tokenPrecision,
  type PaperSentence,
} from "../../src/rag/groundAnswer.ts";
import type { IndexedChunk } from "../../src/rag/types.ts";
import { buildSystemPrompt } from "../../src/llm/prompts.ts";
import { formatContextBlock } from "../../src/rag/context.ts";

const PAPER: PaperSentence[] = [
  {
    text: "We present residual force learning for quadruped locomotion on rough terrain.",
    pageStart: 1,
    section: "Abstract",
  },
  {
    text: "The multi-scale motion prior gates frame-sequence-gait adversarial supervision continuously.",
    pageStart: 3,
    section: "Method",
  },
  {
    text: "Experiments show under 1 ms inference latency on the onboard CPU.",
    pageStart: 7,
    section: "Results",
  },
  {
    text: "Humanoid robots operating in unstructured fields remain fragile under secondary falls.",
    pageStart: 2,
    section: "Introduction",
  },
];

describe("groundAnswer core scoring", () => {
  it("tokenPrecision is high when claim reuses paper terms", () => {
    const p = tokenPrecision(
      "The paper uses residual force learning for locomotion.",
      PAPER[0].text,
    );
    assert.ok(p >= 0.4, `precision=${p}`);
  });

  it("groundingScore rejects unrelated claims", () => {
    const s = groundingScore(
      "The stock market rose sharply yesterday afternoon.",
      PAPER[0].text,
    );
    assert.ok(s < 0.3, `score=${s}`);
  });

  it("pickLinkPhrase finds shared multi-token phrase", () => {
    const phrase = pickLinkPhrase(
      "They introduce residual force learning for rough terrain walking.",
      PAPER[0].text,
    );
    assert.ok(phrase);
    assert.match(phrase!, /residual force learning/i);
  });

  it("matchClaimToPaper returns paper sentence for method claim", () => {
    const m = matchClaimToPaper(
      "They use multi-scale motion prior gating for gait supervision.",
      PAPER,
      null,
      0.35,
    );
    assert.ok(m);
    assert.match(m!.paper.text, /multi-scale motion prior/i);
    assert.match(m!.phrase, /multi-scale|motion prior|gait/i);
  });
});

describe("extractClaimSpans + splitSentences", () => {
  it("extracts bullets as claims", () => {
    const spans = extractClaimSpans(
      "- residual force learning improves tracking\n- latency is under 1 ms on CPU\n",
    );
    assert.ok(spans.length >= 2);
    assert.match(spans[0], /residual force/i);
  });

  it("splitSentences cuts on periods", () => {
    const s = splitSentences(
      "First claim here. Second claim is longer and clear. ",
    );
    assert.equal(s.length, 2);
  });
});

describe("groundAnswerToPaper end-to-end", () => {
  it("links grounded phrases to paper sentences (not cite ids)", () => {
    const answer =
      "The method relies on residual force learning for rough terrain.\n" +
      "They also use multi-scale motion prior gating in training.\n" +
      "Latency is under 1 ms on the onboard CPU.";
    const g = groundAnswerToPaper(answer, PAPER, { minScore: 0.35 });
    assert.ok(g.matched >= 2, `matched=${g.matched} claims=${g.claims}`);
    assert.match(g.answer, /paperai-cite-phrase/);
    assert.match(g.answer, /data-preview="[^"]*residual force learning/i);
    // Jump needle must be paper text, not a random answer fragment alone
    assert.match(
      g.answer,
      /data-preview="[^"]*We present residual force learning/i,
    );
    // No bare bibliography chips
    assert.doesNotMatch(g.answer, />\[1\]</);
    assert.doesNotMatch(g.answer, /#cite-1/);
    // tray present when matches
    assert.match(g.ragFooter, /paperai-evidence-tray|근거/);
  });

  it("does not invent links for ungrounded prose", () => {
    const answer =
      "Quantum bananas orbit the lunar refrigerator at infinite temperature.";
    const g = groundAnswerToPaper(answer, PAPER, { minScore: 0.42 });
    assert.equal(g.matched, 0);
    assert.doesNotMatch(g.answer, /paperai-cite/);
  });

  it("strips leftover model [1] markers without linking them as bibliography", () => {
    const answer =
      "The approach uses residual force learning for locomotion [1].";
    const g = groundAnswerToPaper(answer, PAPER, { minScore: 0.35 });
    assert.doesNotMatch(g.answer, /\[1\]/);
    if (g.matched) {
      assert.match(g.answer, /paperai-cite-phrase/);
      assert.match(g.answer, /data-preview="[^"]*residual force/i);
    }
  });

  it("applyGroundedLinks wraps only the shared phrase", () => {
    const html = applyGroundedLinks(
      "They use residual force learning carefully.",
      [
        {
          answerPhrase: "residual force learning",
          paperSentence: PAPER[0].text,
          pageStart: 1,
          score: 0.7,
        },
      ],
    );
    assert.match(html, />residual force learning</);
    assert.match(html, /data-preview="[^"]*We present residual force/i);
    assert.match(html, /data-page="1"/);
  });
});

describe("sentencesFromChunks", () => {
  it("prefers child chunks with anchors", () => {
    const chunks: IndexedChunk[] = [
      {
        id: "p1",
        text: "Parent body with many words about residual force learning for locomotion experiments on terrain. ".repeat(
          3,
        ),
        section: "Method",
        kind: "parent",
        tokenEstimate: 100,
      },
      {
        id: "c1",
        text: "We present residual force learning for quadruped locomotion on rough terrain.",
        section: "Abstract",
        kind: "child",
        parentId: "p1",
        tokenEstimate: 20,
        pageStart: 1,
        anchorText:
          "We present residual force learning for quadruped locomotion on rough terrain.",
      },
    ];
    const sents = sentencesFromChunks(chunks);
    assert.ok(sents.length >= 1);
    assert.ok(
      sents.some((s) => /residual force learning/i.test(s.text)),
      JSON.stringify(sents.map((s) => s.text.slice(0, 40))),
    );
  });
});

describe("prompts + context no cite-id protocol", () => {
  it("chat prompt forbids bibliography markers", () => {
    const s = buildSystemPrompt("chat", "ko");
    assert.match(s, /bibliography|Do \*\*not\*\* insert/i);
    assert.doesNotMatch(s, /#cite-1/);
  });

  it("formatContextBlock is reading context without cite catalog", () => {
    const block = formatContextBlock(
      [
        {
          chunk: {
            id: "1",
            text: "We present residual force learning.",
            section: "Abstract",
            kind: "abstract",
            tokenEstimate: 10,
          },
          score: 1,
          contextText: "We present residual force learning.",
          cite: "x",
        },
      ],
      "Demo",
    );
    assert.match(block, /Paper: Demo/);
    assert.match(block, /residual force/);
    assert.doesNotMatch(block, /#cite-1/);
    assert.doesNotMatch(block, /Citeable passages/);
    assert.match(block, /Do \*\*not\*\* insert bibliography|plain prose/i);
  });
});

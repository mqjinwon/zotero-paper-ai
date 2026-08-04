import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTO_HIGHLIGHT_ORDER,
  AUTO_TAG_ROOT,
  DEFAULT_AUTO_HIGHLIGHT_CLASSES,
  categoryTag,
  commentPrefix,
  getAutoMaxPerCategory,
  getAutoMaxTotal,
  isAutoHighlightCategory,
  legendLines,
  normalizeHexColor,
} from "../../src/rag/autoHighlight/taxonomy";
import {
  filterGroundedQuotes,
  parseClassifierResponse,
} from "../../src/rag/autoHighlight/classify";
import {
  selectCandidatePassages,
  type CandidatePassage,
} from "../../src/rag/autoHighlight/select";
import {
  buildPageCharMap,
  compactAlnum,
  itemToRect,
  locateQuoteOnPage,
  mergeRects,
  normalizeMatchText,
} from "../../src/rag/autoHighlight/locate";
import type { PaperIndex } from "../../src/rag/types";
import { CHUNK_POLICY } from "../../src/rag/types";

describe("autoHighlight taxonomy", () => {
  it("has 4 classes with highlight/underline split", () => {
    assert.equal(AUTO_HIGHLIGHT_ORDER.length, 4);
    assert.equal(DEFAULT_AUTO_HIGHLIGHT_CLASSES.claim.type, "highlight");
    assert.equal(DEFAULT_AUTO_HIGHLIGHT_CLASSES.method.type, "underline");
    assert.equal(DEFAULT_AUTO_HIGHLIGHT_CLASSES.novelty.type, "highlight");
    assert.equal(DEFAULT_AUTO_HIGHLIGHT_CLASSES.caveat.type, "underline");
    assert.ok(DEFAULT_AUTO_HIGHLIGHT_CLASSES.claim.color.startsWith("#"));
    assert.ok(isAutoHighlightCategory("claim"));
    assert.equal(isAutoHighlightCategory("foo"), false);
    assert.equal(categoryTag("claim"), "paper-ai-auto/claim");
    assert.match(commentPrefix("method"), /Paper AI · auto · method/);
    assert.equal(AUTO_TAG_ROOT, "paper-ai-auto");
    assert.equal(legendLines().length, 4);
    assert.equal(getAutoMaxTotal(), 16);
    assert.equal(getAutoMaxPerCategory(), 4);
  });

  it("normalizeHexColor accepts #rgb and #rrggbb", () => {
    assert.equal(normalizeHexColor("#f00", "#000000"), "#ff0000");
    assert.equal(normalizeHexColor("#ffd400", "#000"), "#ffd400");
    assert.equal(normalizeHexColor("nope", "#aabbcc"), "#aabbcc");
  });
});

describe("autoHighlight select", () => {
  it("prefers abstract/intro and caps count", () => {
    const chunks = [];
    for (let i = 0; i < 5; i++) {
      chunks.push({
        id: `a-${i}`,
        text: `Abstract sentence number ${i} with enough characters to pass the filter threshold for selection.`,
        section: "Abstract",
        kind: "child" as const,
        tokenEstimate: 40,
      });
    }
    for (let i = 0; i < 5; i++) {
      chunks.push({
        id: `r-${i}`,
        text: `References entry ${i} is usually less important for auto highlight selection heuristics.`,
        section: "References",
        kind: "child" as const,
        tokenEstimate: 40,
      });
    }
    const index: PaperIndex = {
      version: 1,
      paperId: "P",
      pdfHash: "h",
      title: "T",
      createdAt: new Date().toISOString(),
      chunkPolicy: CHUNK_POLICY,
      retrievalModeUsed: "bm25",
      embedProvider: null,
      embedModel: null,
      chunks,
      parentTokenEstimate: 100,
    };
    const c = selectCandidatePassages(index, { maxPassages: 4 });
    assert.ok(c.length <= 4);
    assert.match(c[0].section, /Abstract/i);
  });
});

describe("autoHighlight classify filter", () => {
  const candidates: CandidatePassage[] = [
    {
      id: "c1",
      section: "Introduction",
      text: "We propose a novel residual force controller for quadruped locomotion on stairs.",
    },
    {
      id: "c2",
      section: "Method",
      text: "The policy is trained with PPO for 10 million steps using domain randomization.",
    },
  ];

  it("keeps grounded quotes and drops hallucinated ones", () => {
    const items = filterGroundedQuotes(
      [
        {
          category: "novelty",
          quote:
            "We propose a novel residual force controller for quadruped locomotion on stairs.",
          reason: "contrib",
        },
        {
          category: "claim",
          quote: "This text does not appear in the paper at all whatsoever.",
          reason: "fake",
        },
      ],
      candidates,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].category, "novelty");
  });

  it("parses JSON from classifier and grounds", () => {
    const raw = JSON.stringify({
      items: [
        {
          category: "method",
          quote:
            "The policy is trained with PPO for 10 million steps using domain randomization.",
          reason: "training",
        },
      ],
    });
    const items = parseClassifierResponse(raw, candidates);
    assert.equal(items.length, 1);
    assert.equal(items[0].category, "method");
  });
});

describe("autoHighlight locate (text-first)", () => {
  it("locates multi-item quote and covers both items", () => {
    // transform[0]=font size; width in text-space units (PDF.js style)
    const items = [
      {
        str: "We propose a novel residual ",
        transform: [10, 0, 0, 10, 100, 500],
        width: 12, // will scale
        height: 10,
      },
      {
        str: "force controller for quadruped locomotion on stairs.",
        transform: [10, 0, 0, 10, 220, 500],
        width: 20,
        height: 10,
      },
      {
        str: " Unrelated other sentence about cooking pasta with salt.",
        transform: [10, 0, 0, 10, 100, 480],
        width: 25,
        height: 10,
      },
    ];
    const hit = locateQuoteOnPage(
      items,
      "We propose a novel residual force controller for quadruped locomotion on stairs.",
    );
    assert.ok(hit);
    assert.ok(hit!.itemCount >= 2, "should span both text runs");
    assert.match(hit!.matchedText.toLowerCase(), /residual/);
    assert.match(hit!.matchedText.toLowerCase(), /quadruped/);
    // rects on same line should merge
    assert.ok(hit!.rects.length >= 1);
    assert.ok(hit!.rects[0][2] > hit!.rects[0][0]);
  });

  it("matches despite extra whitespace / case in quote", () => {
    const items = [
      {
        str: "The policy is trained with PPO for 10 million steps ",
        transform: [12, 0, 0, 12, 50, 400],
        width: 30,
        height: 12,
      },
      {
        str: "using domain randomization.",
        transform: [12, 0, 0, 12, 50, 385],
        width: 18,
        height: 12,
      },
    ];
    const hit = locateQuoteOnPage(
      items,
      "  THE POLICY is trained with PPO for 10 million steps using domain randomization.  ",
    );
    assert.ok(hit);
    assert.ok(hit!.itemCount >= 2);
  });

  it("compactAlnum strips junk for matching", () => {
    assert.equal(compactAlnum("Hello, World!"), "helloworld");
    assert.equal(
      compactAlnum("99.53±0.35"),
      compactAlnum("99.53 0.35").replace(/[^a-z0-9]/g, "") ||
        compactAlnum("9953035").slice(0, 5),
    );
  });

  it("buildPageCharMap aligns compact→original", () => {
    const { text, compact, compactToOrig } = buildPageCharMap([
      { str: "Hi ", transform: [1, 0, 0, 1, 0, 0], width: 10, height: 10 },
      { str: "there", transform: [1, 0, 0, 1, 10, 0], width: 20, height: 10 },
    ]);
    assert.match(normalizeMatchText(text), /hi there/);
    assert.equal(compact, "hithere");
    assert.equal(text[compactToOrig[0]].toLowerCase(), "h");
  });

  it("itemToRect uses transform scale", () => {
    const r = itemToRect({
      str: "ab",
      transform: [10, 0, 0, 10, 100, 200],
      width: 2,
      height: 1,
    });
    assert.ok(r[2] > r[0]);
    assert.ok(r[3] > r[1]);
    assert.equal(r[0], 100);
  });

  it("mergeRects groups same line", () => {
    const r = mergeRects([
      [0, 10, 10, 20],
      [12, 11, 22, 21],
      [0, 40, 10, 50],
    ]);
    assert.equal(r.length, 2);
  });
});

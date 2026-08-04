/**
 * Headless DOM check for panel markup — no Zotero reinstall needed.
 * Uses linkedom to drive shipped buildPanelDom.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { extractFigureMentions } from "../../src/ui/imageCapture.ts";
import {
  buildPanelDom,
  countPanelControls,
  INDEX_BTN_IDLE,
} from "../../src/ui/panelView.ts";
import { formatUserVisible } from "../../src/ui/paperTask.ts";
import {
  diag,
  diagClear,
  diagSnapshot,
  buildDiagnosticReport,
} from "../../src/utils/diagnostics.ts";

function makeDoc() {
  const { document } = parseHTML("<!DOCTYPE html><html><body></body></html>");
  return document as unknown as Document;
}

describe("panel DOM (linkedom / shipped buildPanelDom)", () => {
  it("creates cards and all primary controls without innerHTML", () => {
    const doc = makeDoc();
    const container = doc.createElement("div");
    doc.body!.appendChild(container);

    const root = buildPanelDom(doc, container);
    const c = countPanelControls(root);

    assert.ok(c.cards >= 4, `expected ≥4 cards, got ${c.cards}`);
    assert.ok(c.actions >= 10, `expected ≥10 actions, got ${c.actions}`);
    assert.ok(
      root.querySelector("[data-act='sticky-toggle-overlay']"),
      "sticky hide/show toggle present",
    );
    assert.ok(
      root.querySelector("[data-act='autohl-run']"),
      "auto-highlight run present",
    );
    assert.ok(root.querySelector("[data-pai-autohl-list]"));
    assert.equal(c.hasIndex, true);
    assert.equal(c.hasChat, true);
    assert.equal(c.hasSummary, true);
    assert.equal(c.hasFigure, false); // figure UX on PDF reader
    assert.ok(
      root.querySelector("[data-pai-sticky-list]"),
      "sticky list present",
    );
    assert.ok(root.querySelector("[data-pai-summary]"), "summary body present");
    const sumBtn = root.querySelector("[data-act='summarize']");
    assert.match(sumBtn?.textContent || "", /요약 생성/);

    const title = root.querySelector(".pai-title");
    assert.ok(title, "title present");
    assert.match(title!.textContent || "", /Paper AI/);

    const indexBtn = root.querySelector("[data-act='index-paper']");
    assert.equal(indexBtn?.textContent, INDEX_BTN_IDLE);

    // Must not be empty shell
    assert.ok((root.textContent || "").length > 80);
  });

  it("container receives root as child", () => {
    const doc = makeDoc();
    const container = doc.createElement("div");
    const root = buildPanelDom(doc, container);
    assert.equal(container.firstChild, root);
    assert.equal(container.childNodes.length, 1);
  });
});

describe("diagnostics buffer", () => {
  it("records and snapshots lines", () => {
    diagClear();
    diag("test", "hello", { a: 1 });
    const snap = diagSnapshot();
    assert.match(snap, /\[test\] hello/);
    const report = buildDiagnosticReport({ unit: true });
    assert.match(report, /Paper AI diagnostic report/);
    assert.match(report, /hello/);
  });
});

describe("figure mention extract + request visible text", () => {
  it("extractFigureMentions finds Figure/Fig labels", () => {
    const text = `
Abstract
We show results.

Figure 1. Training curves on Go2.
Fig. 2: Ablation on residual force.

3 Method
See Figure 1 for overview.
`;
    const figs = extractFigureMentions(text);
    assert.ok(figs.length >= 2);
    assert.ok(figs.some((f) => /Figure 1/i.test(f.label)));
  });

  it("buildFigureContextBundle pulls captions and body discussion", async () => {
    const { buildFigureContextBundle, mergeFigureEvidence } =
      await import("../../src/ui/figureContext.ts");
    const text = `
Figure 1. Architecture of residual MPC.

1 Introduction
We propose residual forces. As shown in Figure 1, the planner outputs GRFs.

2 Method
Figure 1 illustrates the control stack with convex MPC.

3 Results
Compared to baseline, Figure 1 shows higher success on stairs.
`;
    const b = buildFigureContextBundle(text, {
      userQuestion: "what is fig 1?",
    });
    assert.ok(b.mentions.length >= 1);
    assert.ok(b.relatedParagraphs.length >= 1);
    assert.match(b.directBlock, /Figure 1/i);
    assert.match(b.ragQuery, /figure caption/i);
    const merged = mergeFigureEvidence(b.directBlock, "Paper: X\nEvidence…");
    assert.match(merged, /deterministic extract/);
    assert.match(merged, /Evidence/);
  });

  it("formatUserVisible for figure includes question and selection", () => {
    const s = formatUserVisible("figure-explain", {
      question: "y축은 무엇인가?",
      selection: "Figure 3 shows success rate",
      hasImage: true,
      imageSource: "page-canvas",
      figureHints: ["Figure 1", "Figure 3"],
    });
    assert.match(s, /그림\/표 설명 요청/);
    assert.match(s, /y축은 무엇인가/);
    assert.match(s, /Figure 3/);
    assert.match(s, /page-canvas/);
    assert.match(s, /Figure 1/);
  });
});

/**
 * Unit tests for shipped RAG modules (chunk, BM25, store, hybrid, mode wiring).
 * Drives real src/rag/* code — not re-implementations.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createNodeFileStore } from "../../src/auth/nodeFileStore.ts";
import {
  buildBm25,
  bm25Rank,
  bm25Scores,
  tokenize,
} from "../../src/rag/bm25.ts";
import {
  chunkDocument,
  isSectionHeadingLine,
  sectionNames,
  CHUNK_POLICY,
  splitIntoSections,
} from "../../src/rag/chunk.ts";
import {
  hasEmbedCredentials,
  mergeRagPrefs,
  resolveEffectiveMode,
  resolveEmbedConfig,
  shouldUseRag,
} from "../../src/rag/config.ts";
import {
  citeOf,
  citePreview,
  evidenceFooter,
  evidenceId,
  formatContextBlock,
  linkifyBareCites,
  stampEvidenceIds,
  withEvidenceAnswer,
} from "../../src/rag/context.ts";
import {
  buildIndexDiagnostics,
  formatIndexDiagnosticsDetail,
} from "../../src/rag/diagnostics.ts";
import {
  bodyProportionalPage,
  enrichEvidenceWithPages,
  softSectionPageHint,
} from "../../src/rag/enrichPages.ts";
import { cosine, hybridScores, normalizeScores } from "../../src/rag/embed.ts";
import { buildExtractedDoc, EmptyExtractError } from "../../src/rag/extract.ts";
import {
  buildIndexFromDoc,
  ensureIndex,
  isRagMode,
  queryPaper,
} from "../../src/rag/index.ts";
import {
  getSearchUnits,
  retrieveBm25Sync,
  scoreBm25Only,
  scoreHybrid,
} from "../../src/rag/retrieve.ts";
import {
  deserializeIndex,
  findLatestIndexForPaper,
  formatIndexLabel,
  indexPath,
  loadIndex,
  saveIndex,
  serializeIndex,
  simpleHash,
} from "../../src/rag/store.ts";
import type { ExtractedDoc, PaperIndex } from "../../src/rag/types.ts";
import { modeUsesPaperRag } from "../../src/llm/prompts.ts";
import { buildUserPayload } from "../../src/llm/prompts.ts";

/** Full fixture paper covering major sections. */
const FIXTURE_PAPER = `
Title: Learning Locomotion with Residual Forces

Abstract
We present a residual force learning method for quadruped locomotion.
Our approach combines model-based planning with learned residual forces
to handle unmodeled dynamics on rough terrain.

1 Introduction
Legged robots must adapt to uncertain contact. Prior work uses either
pure model predictive control or end-to-end reinforcement learning.
We bridge both by learning residual forces on top of a rigid-body planner.

2 Related Work
Model predictive control for quadrupeds has been widely studied.
Reinforcement learning methods such as domain randomization also achieve
robust locomotion but require large amounts of simulation data.

3 Method
Our method computes nominal ground reaction forces using a convex MPC
controller. A neural network then predicts residual force corrections
conditioned on proprioceptive history. The residual is added to the
nominal forces before torque mapping.

4 Experiments
We evaluate on a Unitree Go2 robot across flat ground, slopes, and
stairs. Success rate improves from 62% to 91% with residual forces.
Energy consumption decreases by 12% compared to the pure MPC baseline.

5 Results
Table 1 shows tracking error for base velocity. Our method reduces
RMSE by 34% on rough terrain. Figure 2 plots contact forces over time.

6 Discussion
Residual learning is most helpful when the rigid-body model mismatches
real friction. Limitations include dependence on accurate state estimation.

7 Conclusion
We showed that residual force learning improves quadruped locomotion
robustness without discarding classical control structure.

References
[1] Di Carlo et al. Dynamic Locomotion. 2018.
`.trim();

function fixtureDoc(paperId = "fixture1"): ExtractedDoc {
  return buildExtractedDoc({
    paperId,
    title: "Learning Locomotion with Residual Forces",
    fullText: FIXTURE_PAPER,
    source: "stub",
  });
}

function makeLongPaper(sections: number): string {
  const names = [
    "Abstract",
    "1 Introduction",
    "2 Related Work",
    "3 Method",
    "4 Experiments",
    "5 Results",
    "6 Discussion",
    "7 Conclusion",
  ];
  const parts: string[] = [];
  for (let i = 0; i < sections; i++) {
    const name =
      names[i % names.length] + (i >= names.length ? ` Extra${i}` : "");
    // ~3000 tokens each parent (~12000 chars) so total exceeds stuff limit
    const body = `paragraph about ${name} with unique token UNIQUE${i} `.repeat(
      400,
    );
    parts.push(`${name}\n${body}`);
  }
  return parts.join("\n\n");
}

describe("rag extract", () => {
  it("empty extract throws EmptyExtractError (hard fail)", () => {
    assert.throws(
      () => buildExtractedDoc({ paperId: "x", fullText: "   " }),
      (e: unknown) => e instanceof EmptyExtractError,
    );
  });

  it("non-empty extract yields hash and full text", () => {
    const doc = fixtureDoc();
    assert.ok(doc.fullText.includes("Abstract"));
    assert.ok(doc.pdfHash.length >= 8);
    assert.equal(doc.pdfHash, simpleHash(doc.fullText));
  });
});

describe("rag chunk section-para-sent-v5", () => {
  it("covers all major sections of fixture paper", () => {
    const doc = fixtureDoc();
    const chunks = chunkDocument(doc);
    assert.ok(chunks.length > 0);
    const names = sectionNames(chunks).map((n) => n.toLowerCase());
    for (const need of [
      "abstract",
      "introduction",
      "method",
      "experiments",
      "results",
      "conclusion",
    ]) {
      assert.ok(
        names.some((n) => n.includes(need)),
        `missing section matching ${need}: got ${names.join(", ")}`,
      );
    }
    const parents = chunks.filter(
      (c) => c.kind === "parent" || (c.kind === "abstract" && !c.parentId),
    );
    const children = chunks.filter(
      (c) => c.kind === "child" || (c.kind === "abstract" && c.parentId),
    );
    assert.ok(parents.length >= 5);
    assert.ok(children.length >= 5);
    assert.equal(CHUNK_POLICY, "section-para-sent-v5");
    const withPara = children.filter((c) => c.paraStart != null);
    assert.ok(withPara.length >= 3, "expected children with paraStart");
  });

  it("numbered and ALL-CAPS headings split multi-section (not all Body)", () => {
    assert.equal(isSectionHeadingLine("2 Method"), true);
    assert.equal(isSectionHeadingLine("2. Method"), true);
    assert.equal(isSectionHeadingLine("IV. Experiments"), true);
    assert.equal(isSectionHeadingLine("RELATED WORK"), true);
    assert.equal(
      isSectionHeadingLine(
        "The residual force is large when the robot walks on stairs carefully.",
      ),
      false,
    );

    const text = `
Title Line

Abstract
We study residual learning for locomotion under uncertain contact.

1 Introduction
Legged robots must adapt. Prior work is limited.

2 Method
We combine MPC with residual forces on the rigid body planner.

3 EXPERIMENTS
We evaluate on stairs and slopes with three seeds.

4 Conclusion
Residual forces improve tracking.
`.trim();
    const secs = splitIntoSections(text);
    const names = secs.map((s) => s.name.toLowerCase());
    assert.ok(names.some((n) => n.includes("abstract")));
    assert.ok(names.some((n) => /introduction|1 introduction/.test(n)));
    assert.ok(names.some((n) => /method|2 method/.test(n)));
    assert.ok(names.some((n) => /experiment|3 experiment/.test(n)));
    // Must not collapse to a single Body pack
    assert.ok(
      secs.length >= 4,
      `expected multi-section, got ${names.join("|")}`,
    );
    assert.ok(
      !secs.every((s) => /^body$/i.test(s.name)),
      "must not be all Body",
    );

    const chunks = chunkDocument(
      buildExtractedDoc({ paperId: "num-head", fullText: text }),
    );
    const sn = sectionNames(chunks).map((n) => n.toLowerCase());
    assert.ok(sn.some((n) => n.includes("method")));
    assert.ok(!sn.every((n) => n === "body" || n.startsWith("body ")));
  });

  it("citeOf legacy form still has paragraph/sentence locators", () => {
    const cite = citeOf({
      id: "1",
      text: "We study residual forces.",
      section: "Introduction",
      kind: "child",
      tokenEstimate: 10,
      paraStart: 2,
      paraEnd: 2,
      sentStart: 3,
      sentEnd: 3,
      pageStart: 2,
    });
    assert.equal(cite, "[§Introduction ¶2 s3 p.2]");
  });
});

describe("rag bm25", () => {
  it("ranks expected paragraph first for known keyword query", () => {
    const docs = [
      "The weather is sunny and warm today in the park.",
      "Residual force learning improves quadruped locomotion on stairs.",
      "Cooking pasta requires boiling water and salt.",
    ];
    const ranked = bm25Rank(docs, "residual force quadruped stairs");
    assert.equal(ranked[0].index, 1);
    assert.ok(ranked[0].score > ranked[1].score);
  });

  it("tokenize keeps multi-char terms and digit splits", () => {
    const t = tokenize("MPC residual-force Go2 L1");
    assert.ok(t.includes("mpc"));
    assert.ok(t.includes("residual"));
    assert.ok(t.includes("force"));
    assert.ok(t.includes("go"));
    assert.ok(t.includes("2"));
    assert.ok(t.includes("1")); // L1 → l + 1; single "l" dropped, digit kept
  });
});

describe("rag store round-trip", () => {
  it("save → load preserves index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperai-rag-"));
    try {
      const store = await createNodeFileStore();
      // Override homeDir to temp
      const home = dir;
      const testStore = {
        ...store,
        homeDir: () => home,
        join: (...parts: string[]) => join(...parts),
      };
      const doc = fixtureDoc("p1");
      const index = await buildIndexFromDoc(
        doc,
        mergeRagPrefs({ embeddingProvider: "none", ragRetrievalMode: "bm25" }),
      );
      const path = await saveIndex(testStore, index);
      assert.ok(path.includes("p1-"));
      assert.ok(path.endsWith(".json"));
      const loaded = await loadIndex(testStore, "p1", doc.pdfHash);
      assert.ok(loaded);
      assert.equal(loaded!.pdfHash, index.pdfHash);
      assert.equal(loaded!.chunks.length, index.chunks.length);
      assert.equal(loaded!.chunkPolicy, CHUNK_POLICY);
      assert.equal(loaded!.retrievalModeUsed, "bm25");

      const raw = serializeIndex(index);
      const again = deserializeIndex(raw);
      assert.equal(again.chunks.length, index.chunks.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("indexPath uses itemKey-hash16 form", async () => {
    const store = await createNodeFileStore();
    const p = indexPath(store, "ABCD1234", "deadbeefcafebabe99");
    assert.match(p, /ABCD1234-deadbeefcafebabe\.json$/);
  });

  it("findLatestIndexForPaper loads cache without pdfHash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperai-rag-find-"));
    try {
      const store = await createNodeFileStore();
      const home = dir;
      const testStore = {
        ...store,
        homeDir: () => home,
        join: (...parts: string[]) => join(...parts),
      };
      const doc = fixtureDoc("ITEM99");
      const index = await buildIndexFromDoc(
        doc,
        mergeRagPrefs({ embeddingProvider: "none", ragRetrievalMode: "bm25" }),
      );
      await saveIndex(testStore, index);
      const found = await findLatestIndexForPaper(testStore, "ITEM99");
      assert.ok(found);
      assert.equal(found!.paperId, "ITEM99");
      assert.match(formatIndexLabel(found!), /인덱싱 됨 · BM25 · \d+ chunks/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("rag mode resolution", () => {
  it("auto without key → bm25", () => {
    assert.equal(resolveEffectiveMode("auto", "none", ""), "bm25");
    assert.equal(resolveEffectiveMode("auto", "openai", ""), "bm25");
  });

  it("auto with key → hybrid", () => {
    assert.equal(resolveEffectiveMode("auto", "openai", "sk-test"), "hybrid");
  });

  it("hybrid without key throws clear error", () => {
    assert.throws(
      () => resolveEffectiveMode("hybrid", "none", ""),
      /embedding|API key|hybrid/i,
    );
  });

  it("bm25 always bm25 even with key", () => {
    assert.equal(resolveEffectiveMode("bm25", "openai", "sk-test"), "bm25");
  });

  it("shouldUseRag for chat/explain/figure, not translate", () => {
    assert.equal(shouldUseRag(true, "chat"), true);
    assert.equal(shouldUseRag(true, "explain"), true);
    assert.equal(shouldUseRag(true, "figure-explain"), true);

    assert.equal(shouldUseRag(true, "translate"), false);
    assert.equal(shouldUseRag(false, "chat"), false);
    assert.equal(isRagMode("chat"), true);
    assert.equal(isRagMode("explain"), true);
    assert.equal(isRagMode("translate"), false);
    assert.equal(modeUsesPaperRag("chat"), true);
    assert.equal(modeUsesPaperRag("explain"), true);
    assert.equal(modeUsesPaperRag("translate"), false);
  });

  it("resolveEmbedConfig null when provider none", () => {
    assert.equal(
      resolveEmbedConfig(
        mergeRagPrefs({ embeddingProvider: "none", embeddingApiKey: "x" }),
      ),
      null,
    );
    assert.equal(hasEmbedCredentials("none", "sk"), false);
    assert.equal(hasEmbedCredentials("openai", "sk"), true);
  });
});

describe("rag no-key index + query", () => {
  it("embeddingProvider=none builds index and returns contextBlock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperai-rag-q-"));
    try {
      const base = await createNodeFileStore();
      const store = {
        ...base,
        homeDir: () => dir,
        join: (...parts: string[]) => join(...parts),
      };
      const doc = fixtureDoc("nokey");
      const result = await queryPaper({
        store,
        query: "How do residual forces improve locomotion?",
        extract: doc,
        prefs: {
          embeddingProvider: "none",
          ragRetrievalMode: "auto",
          ragStuffTokenLimit: 6000,
        },
      });
      assert.ok(result.contextBlock.length > 0);
      assert.ok(result.evidence.length > 0);
      assert.match(result.contextBlock, /\[E\d+\]/);
      assert.equal(result.stats.usedDense, false);
      // short fixture → stuff mode
      assert.ok(result.mode === "stuff" || result.mode === "rag");
      assert.equal(result.index.retrievalModeUsed, "bm25");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("BM25 ranking on long paper finds unique token section first", async () => {
    const longText = makeLongPaper(8);
    const doc = buildExtractedDoc({
      paperId: "long1",
      title: "Long Paper",
      fullText: longText,
    });
    const index = await buildIndexFromDoc(
      doc,
      mergeRagPrefs({
        embeddingProvider: "none",
        ragRetrievalMode: "bm25",
        ragStuffTokenLimit: 100, // force retrieve path
      }),
    );
    assert.ok(index.parentTokenEstimate > 100);
    const result = retrieveBm25Sync(index, "UNIQUE3 UNIQUE3 residual", {
      topK: 3,
      stuffTokenLimit: 100,
    });
    assert.equal(result.mode, "rag");
    assert.ok(result.evidence.length > 0);
    assert.ok(
      result.evidence[0].contextText.includes("UNIQUE3") ||
        result.contextBlock.includes("UNIQUE3"),
      "expected UNIQUE3 section ranked high",
    );
    assert.match(result.contextBlock, /\[E\d+\]/);
  });
});

describe("rag hybrid vs bm25 order", () => {
  it("with mock embeddings, hybrid order ≠ bm25-only on paraphrase query", () => {
    // Three search-like docs: keyword-heavy vs semantic paraphrase target
    const units = [
      {
        id: "1",
        text: "The convex MPC controller computes ground reaction forces for the robot.",
        section: "Method",
        kind: "child" as const,
        tokenEstimate: 20,
        // embedding points near "control force robot"
        embedding: [1, 0, 0],
      },
      {
        id: "2",
        text: "Cooking recipes and pasta boiling techniques for dinner.",
        section: "Unrelated",
        kind: "child" as const,
        tokenEstimate: 15,
        embedding: [0, 1, 0],
      },
      {
        id: "3",
        text: "Adaptive torque corrections under model mismatch improve stability.",
        section: "Method",
        kind: "child" as const,
        tokenEstimate: 18,
        // semantic match for "how does learning fix model errors"
        embedding: [0.1, 0, 0.99],
      },
    ];

    const paraphraseQuery = "how does learning fix model errors";
    // BM25 likes "model" which appears in unit 3, but also may rank 1 if we use keywords
    // Force a keyword query that matches unit 1 strongly in BM25
    const keywordQuery = "convex MPC ground reaction forces";

    const bm25Order = scoreBm25Only(units, keywordQuery);
    const bm25Ranked = units
      .map((u, i) => ({ id: u.id, s: bm25Order[i] }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.id);

    // Query embedding near unit 3
    const qEmb = [0.05, 0, 1];
    const hybrid = scoreHybrid(units, keywordQuery, qEmb);
    assert.equal(hybrid.usedDense, true);
    const hybridRanked = units
      .map((u, i) => ({ id: u.id, s: hybrid.scores[i] }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.id);

    // BM25 should prefer unit 1 (exact MPC keywords)
    assert.equal(bm25Ranked[0], "1");
    // Hybrid with qEmb near unit 3 should boost unit 3 above pure BM25 position
    // At minimum hybrid ranking order differs from BM25-only
    assert.notDeepEqual(
      hybridRanked,
      bm25Ranked,
      `expected hybrid ${hybridRanked} ≠ bm25 ${bm25Ranked}`,
    );

    // Sanity: hybridScores fusion formula
    const d = normalizeScores([0.1, 0, 0.9]);
    const b = normalizeScores([1, 0.2, 0.1]);
    const h = hybridScores(d, b);
    assert.ok(Math.abs(h[0] - (0.6 * d[0] + 0.4 * b[0])) < 1e-9);
  });

  it("cosine is 1 for identical vectors", () => {
    assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  });
});

describe("rag context cites + wiring", () => {
  it("primary evidence ids are [E1]…; legacy citeOf still § form", () => {
    assert.equal(evidenceId(0), "[E1]");
    assert.equal(evidenceId(2), "[E3]");
    const cite = citeOf({
      id: "a",
      text: "x",
      section: "Method",
      kind: "parent",
      tokenEstimate: 1,
      pageStart: 3,
    });
    assert.equal(cite, "[§Method p.3]");
  });

  it("formatContextBlock stamps [E#] + Quote needle (not §Body)", () => {
    const evidence = [
      {
        chunk: {
          id: "1",
          text: "body",
          section: "Abstract",
          kind: "abstract" as const,
          tokenEstimate: 5,
          anchorText: "We present residual force learning for locomotion.",
        },
        score: 0.9,
        contextText: "We present residual force learning for locomotion.",
        cite: "[§Abstract]",
      },
    ];
    const block = formatContextBlock(evidence, "Demo Paper");
    assert.match(block, /Demo Paper/);
    assert.match(block, /\[E1\]/);
    assert.match(block, /Quote:.*residual force/i);
    assert.match(block, /residual force/);
    assert.doesNotMatch(block, /\[§Body/);
    assert.equal(evidence[0].cite, "[E1]");
  });

  it("evidenceFooter linkifies E cites with page + preview", () => {
    const footer = evidenceFooter(
      stampEvidenceIds([
        {
          chunk: {
            id: "1",
            text: "body",
            section: "Body (1)",
            kind: "parent",
            tokenEstimate: 5,
            pageStart: 2,
            pageEnd: 3,
            anchorText:
              "We present residual force learning for locomotion on rough terrain.",
          },
          score: 1,
          contextText: "We present residual force learning for locomotion.",
          cite: "pending",
        },
      ]),
    );
    assert.match(footer, /근거/);
    assert.match(footer, /#paperai-page-2/);
    assert.match(footer, /E1/);
    assert.match(footer, /residual force/);
  });

  it("citePreview builds a sentence-level locate needle", () => {
    const long =
      "We present a residual force learning method that combines model-based planning with learned residuals on rough terrain.";
    const p1 = citePreview(`${long} Later we ablate gains.`);
    assert.match(p1, /residual force learning/);
    assert.doesNotMatch(p1, /Later we ablate/);
    const p2 = citePreview(
      "We present residual forces. Later we ablate gains on rough terrain carefully.",
    );
    assert.match(p2, /We present residual forces/);
    assert.match(p2, /Later we ablate/);
    assert.ok(p1.length >= 24 && p2.length >= 24);
  });

  it("linkifyBareCites turns [E1] into HTML with quote data-preview", () => {
    const evidence = stampEvidenceIds([
      {
        chunk: {
          id: "1",
          text: "t",
          section: "Body (1)",
          kind: "parent" as const,
          tokenEstimate: 1,
          pageStart: 1,
          anchorText:
            "We present residual force learning for quadruped locomotion on rough terrain.",
        },
        score: 1,
        contextText: "Abstract under 1 ms",
        cite: "x",
      },
    ]);
    const out = linkifyBareCites("속도는 under 1 ms 입니다 [E1].", evidence);
    assert.match(out, /href="#paperai-page-1"/);
    assert.match(out, /data-page="1"/);
    assert.match(out, /class="paperai-cite"/);
    assert.match(out, /data-preview="[^"]*residual force/);
    assert.match(out, /E1/);
    assert.match(out, /residual force/);
    assert.doesNotMatch(out, /\[E1\](?!<)/);
  });

  it("linkifyBareCites still maps legacy [§Body] aliases", () => {
    const evidence = stampEvidenceIds([
      {
        chunk: {
          id: "1",
          text: "t",
          section: "Body (1)",
          kind: "parent" as const,
          tokenEstimate: 1,
          pageStart: 1,
          anchorText:
            "We present residual force learning for quadruped locomotion on rough terrain.",
        },
        score: 1,
        contextText: "Abstract under 1 ms",
        cite: "x",
      },
    ]);
    const out = linkifyBareCites("see [§Body (1)].", evidence);
    assert.match(out, /class="paperai-cite"/);
    assert.match(out, /data-preview="[^"]*residual force/);
  });

  it("withEvidenceAnswer linkifies [E1] without evidence dump", () => {
    const { answer, ragFooter } = withEvidenceAnswer("see [E1]", [
      {
        chunk: {
          id: "1",
          text: "mpc",
          section: "Method",
          kind: "parent",
          tokenEstimate: 1,
          pageStart: 3,
          anchorText: "MPC residual forces improve tracking on stairs.",
        },
        score: 1,
        contextText: "MPC residual forces",
        cite: "old",
      },
    ]);
    assert.equal(ragFooter, "");
    assert.match(answer, /#paperai-page-3/);
    assert.match(answer, /E1|paperai-cite/);
    assert.doesNotMatch(answer, /——/);
    assert.doesNotMatch(answer, /근거 \(라벨 클릭/);
  });

  it("withEvidenceAnswer can still append footer when asked", () => {
    const { answer, ragFooter } = withEvidenceAnswer(
      "see [E1]",
      [
        {
          chunk: {
            id: "1",
            text: "mpc",
            section: "Method",
            kind: "parent",
            tokenEstimate: 1,
            pageStart: 3,
          },
          score: 1,
          contextText: "MPC residual forces",
          cite: "[§Method p.3]",
        },
      ],
      { appendFooter: true },
    );
    assert.match(ragFooter, /#paperai-page-3/);
    assert.match(answer, /——/);
    assert.match(answer, /MPC residual/);
  });

  it("chat/figure user payload includes RAG evidence; translate does not need it", () => {
    const evidence = formatContextBlock(
      [
        {
          chunk: {
            id: "1",
            text: "t",
            section: "Method",
            kind: "parent",
            tokenEstimate: 1,
          },
          score: 1,
          contextText: "MPC residual",
          cite: "[§Method p.2]",
        },
      ],
      "P",
    );
    const chat = buildUserPayload({
      mode: "chat",
      question: "What is the method?",
      context: evidence,
      paperTitle: "P",
    });
    assert.match(chat, /Paper evidence \(RAG\)/);
    assert.match(chat, /\[E1\]/);

    const fig = buildUserPayload({
      mode: "figure-explain",
      context: evidence,
      hasImage: true,
    });
    assert.match(fig, /Paper evidence \(RAG\)/);
    assert.match(fig, /\[E1\]/);

    const tr = buildUserPayload({
      mode: "translate",
      selection: "hello world",
    });
    assert.doesNotMatch(tr, /Paper evidence/);
    assert.doesNotMatch(tr, /Evidence passages/);
  });
});

describe("rag page enrich + diagnostics", () => {
  it("bodyProportionalPage is disabled (never invents Body pages)", () => {
    assert.equal(bodyProportionalPage("Body (1)", 12, 5), null);
    assert.equal(bodyProportionalPage("Body (3)", 20, 4), null);
    assert.equal(softSectionPageHint("Body (2)", 10), null);
    assert.equal(softSectionPageHint("Abstract", 10), 1);
  });

  it("enrichEvidenceWithPages does not invent pages without PDF/text", async () => {
    const evidence = [
      {
        chunk: {
          id: "1",
          text: "We invent nothing here about pages.",
          section: "Body (3)",
          kind: "parent" as const,
          tokenEstimate: 10,
          // no pageStart
        },
        score: 1,
        contextText: "We invent nothing here about pages.",
        cite: "[E1]",
      },
    ];
    const r = await enrichEvidenceWithPages(evidence);
    assert.equal(evidence[0].chunk.pageStart, undefined);
    assert.ok(
      r.via === "no-pdf" || r.via === "search-miss" || r.via === "none",
    );
    assert.equal(r.filled, 0);
  });

  it("buildIndexDiagnostics summarizes sections, counts, anchors", async () => {
    const doc = fixtureDoc("diag1");
    const index = await buildIndexFromDoc(
      doc,
      mergeRagPrefs({ embeddingProvider: "none", ragRetrievalMode: "bm25" }),
    );
    const d = buildIndexDiagnostics(index);
    assert.ok(d.sectionNames.length >= 3);
    assert.ok(d.totalChunks > 0);
    assert.ok(d.parentCount + d.childCount + d.abstractCount > 0);
    assert.ok(d.sampleAnchors.length >= 1);
    assert.match(d.summaryLine, /섹션|chunks/i);
    assert.match(formatIndexDiagnosticsDetail(d), /anchors:/);
    assert.ok(
      d.bodyShare < 0.85,
      `fixture should not be mostly Body: ${d.bodyShare}`,
    );
  });
});

describe("rag ensureIndex cache", () => {
  it("second ensureIndex loads from disk without re-chunk difference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperai-rag-e-"));
    try {
      const base = await createNodeFileStore();
      const store = {
        ...base,
        homeDir: () => dir,
        join: (...parts: string[]) => join(...parts),
      };
      const doc = fixtureDoc("cache1");
      const prefs = mergeRagPrefs({
        embeddingProvider: "none",
        ragRetrievalMode: "bm25",
      });
      const a = await ensureIndex({ store, extract: doc, prefs });
      const b = await ensureIndex({ store, extract: doc, prefs });
      assert.equal(a.pdfHash, b.pdfHash);
      assert.equal(a.chunks.length, b.chunks.length);
      assert.equal(a.createdAt, b.createdAt); // same cached object fields
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("rag hybrid index with mock fetch", () => {
  it("hybrid mode embeds search units via HTTP mock", async () => {
    let calls = 0;
    const fetchImpl = async (
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls++;
      const body = JSON.parse(String(init?.body || "{}")) as {
        input: string[];
      };
      const data = body.input.map((_: string, index: number) => ({
        index,
        embedding: [index + 1, 0.5, 0.25],
      }));
      return {
        ok: true,
        status: 200,
        async json() {
          return { data };
        },
        async text() {
          return "";
        },
      } as Response;
    };

    const doc = fixtureDoc("hyb1");
    const index = await buildIndexFromDoc(
      doc,
      mergeRagPrefs({
        ragRetrievalMode: "hybrid",
        embeddingProvider: "openai",
        embeddingApiKey: "sk-mock",
        embeddingModel: "text-embedding-3-small",
      }),
      { fetchImpl: fetchImpl as typeof fetch },
    );
    assert.equal(index.retrievalModeUsed, "hybrid");
    assert.ok(calls >= 1);
    const units = getSearchUnits(index);
    assert.ok(units.some((u) => u.embedding && u.embedding.length === 3));
  });
});

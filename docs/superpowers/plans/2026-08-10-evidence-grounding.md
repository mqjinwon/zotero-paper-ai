# High-Performance Evidence Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace lexical-only post-hoc cite links with a high-quality pipeline: atomic claims → KO→EN normalize → BM25 (+ optional dense RRF) + evidence prior → LLM support judge → PDF locate fail-closed → HTML links.

**Architecture:** New modules under `src/rag/grounding/*` orchestrated by `groundAnswerHighQuality`. `paperTask` wires LLM client + paper sentences + evidence chunk ids + optional embed cfg + reader. Legacy `groundAnswerToPaper` remains as offline/fallback and for existing unit tests until migrated.

**Tech Stack:** TypeScript (Zotero plugin), existing `LLMClient.complete`, `bm25.ts`, `embed.ts`, `locateQuoteInOpenPdf`, node:test via `tsx --test test/node/*.test.ts`.

**Spec:** `docs/superpowers/specs/2026-08-10-evidence-grounding-design.md`

## Global Constraints

- Performance-first: prefer no link over wrong link (`support` + PDF lock only).
- No model bibliography cite-id protocol (`[1]`, `#cite-N`) as primary linking.
- Dense embeddings optional; BM25 path must work without embed API key.
- Final gate is LLM judge (`support` | `partial` | `none`); only `support` may become a phrase link.
- PDF locate failure ⇒ no navigable phrase link for that claim.
- Do not grow `groundAnswer.ts` as a god-file; put new logic in `src/rag/grounding/`.
- Never log API keys or tokens in `diag`.
- Prose to user: Korean; code/comments/identifiers: English.
- Tests: `npm run test:node` must pass; TDD per task.

## File map

| Path | Role |
| ---- | ---- |
| `src/rag/grounding/types.ts` | Claim, PaperSentenceRef, Candidate, Judgment, LockedEvidence, GroundingResult, GroundingLlm |
| `src/rag/grounding/rrf.ts` | Pure RRF fusion |
| `src/rag/grounding/candidates.ts` | BM25 + optional dense + evidence prior → top candidates |
| `src/rag/grounding/claims.ts` | Parse/validate claim JSON + rule fallback from answer |
| `src/rag/grounding/normalize.ts` | Batch KO→EN + mustTerms/numbers merge |
| `src/rag/grounding/judge.ts` | Build judge prompt + parse Judgment |
| `src/rag/grounding/pdfLock.ts` | Needle variants + locate adapter → LockedEvidence \| null |
| `src/rag/grounding/apply.ts` | HTML links + tray from LockedEvidence |
| `src/rag/grounding/llmJson.ts` | `completeJson(llm, system, user)` helper |
| `src/rag/grounding/pipeline.ts` | `groundAnswerHighQuality` |
| `src/rag/grounding/index.ts` | Public exports |
| `src/rag/groundAnswer.ts` | Keep legacy exports; re-export new entry if useful |
| `src/rag/index.ts` | Export high-quality entry |
| `src/ui/paperTask.ts` | Wire pipeline after `runTask` |
| `src/ui/citeNavigate.ts` | Prefer `data-rects` when present (if missing) |
| `test/node/grounding*.test.ts` | Unit + pipeline mocks |
| `test/fixtures/grounding/sample-claims.json` | Gold skeleton |

---

### Task 1: Types + RRF fusion (pure)

**Files:**
- Create: `src/rag/grounding/types.ts`
- Create: `src/rag/grounding/rrf.ts`
- Create: `test/node/groundingRrf.test.ts`

**Interfaces:**
- Produces: types below; `rrfFuse(rankLists: string[][], k?: number): Array<{ id: string; score: number }>`

- [ ] **Step 1: Write failing test for RRF**

```ts
// test/node/groundingRrf.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rrfFuse } from "../../src/rag/grounding/rrf";

describe("rrfFuse", () => {
  it("boosts items that appear high in multiple lists", () => {
    const a = ["s1", "s2", "s3"];
    const b = ["s2", "s1", "s4"];
    const out = rrfFuse([a, b], 60);
    assert.equal(out[0].id, "s2"); // rank1 in b, rank2 in a
    assert.ok(out.find((x) => x.id === "s1"));
    assert.ok(out.find((x) => x.id === "s4"));
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (module missing)**

Run: `node --import tsx --test test/node/groundingRrf.test.ts`  
Expected: cannot find module / FAIL

- [ ] **Step 3: Implement types + rrf**

```ts
// src/rag/grounding/types.ts
export type ClaimType =
  | "method"
  | "result"
  | "definition"
  | "comparison"
  | "other";

export interface Claim {
  id: string;
  text: string;
  textEn: string;
  type: ClaimType;
  mustTerms: string[];
  numbers: string[];
}

export interface PaperSentenceRef {
  id: string;
  text: string;
  pageStart?: number;
  pageEnd?: number;
  section?: string;
  chunkId?: string;
  fromEvidence?: boolean;
  embedding?: number[];
}

export interface Candidate {
  sentence: PaperSentenceRef;
  scoreFusion: number;
  scoreBm25: number;
  scoreDense?: number;
  scorePrior: number;
}

export type SupportLabel = "support" | "partial" | "none";

export interface Judgment {
  claimId: string;
  label: SupportLabel;
  sentenceId: string | null;
  paperSentence: string | null;
  confidence: number;
}

export interface LockedEvidence {
  claimId: string;
  answerPhrase: string;
  paperSentence: string;
  pageStart?: number;
  pageEnd?: number;
  section?: string;
  rects?: number[][];
  locateOk: true;
}

export interface GroundingDiagnostics {
  usedDense: boolean;
  judgeModel?: string;
  claimCount: number;
  candidateCounts: number[];
  locateFailures: number;
}

export interface GroundingResult {
  answer: string;
  links: LockedEvidence[];
  claims: Claim[];
  judgments: Judgment[];
  matched: number;
  diagnostics: GroundingDiagnostics;
}

/** Minimal LLM port for grounding (wraps LLMClient.complete). */
export type GroundingLlm = {
  complete: (opts: {
    model?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  }) => Promise<string>;
  model?: string;
};
```

```ts
// src/rag/grounding/rrf.ts
/** Reciprocal rank fusion over ordered id lists (rank 0 = best). */
export function rrfFuse(
  rankLists: string[][],
  k = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of rankLists) {
    list.forEach((id, rank) => {
      if (!id) return;
      scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `node --import tsx --test test/node/groundingRrf.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/rag/grounding/types.ts src/rag/grounding/rrf.ts test/node/groundingRrf.test.ts
git commit -m "[feat] Grounding types and RRF fusion"
```

---

### Task 2: Candidate retrieval (BM25 + prior + optional dense)

**Files:**
- Create: `src/rag/grounding/candidates.ts`
- Create: `test/node/groundingCandidates.test.ts`
- Uses: `src/rag/bm25.ts`, `src/rag/embed.ts` (`cosine`, `embedTexts` types only for optional path)

**Interfaces:**
- Consumes: `PaperSentenceRef`, `Claim`, `rrfFuse`
- Produces: `retrieveCandidates(claim, corpus, opts?) → Candidate[]`

- [ ] **Step 1: Write failing tests**

```ts
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
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `retrieveCandidates`**

```ts
// src/rag/grounding/candidates.ts
import { buildBm25, bm25Scores } from "../bm25";
import { cosine } from "../embed";
import { rrfFuse } from "./rrf";
import type { Candidate, Claim, PaperSentenceRef } from "./types";

export interface RetrieveCandidatesOpts {
  topN?: number; // default 15
  embedClaim?: number[] | null;
  /** If set, use these embeddings aligned to corpus indices (same length) */
  corpusEmbeddings?: Array<number[] | undefined> | null;
}

export function retrieveCandidates(
  claim: Claim,
  corpus: PaperSentenceRef[],
  opts?: RetrieveCandidatesOpts,
): Candidate[] {
  const topN = opts?.topN ?? 15;
  if (!corpus.length) return [];

  const query = [claim.textEn || claim.text, ...claim.mustTerms]
    .filter(Boolean)
    .join(" ");
  const bm25 = buildBm25(corpus.map((s) => s.text));
  const scores = bm25Scores(bm25, query);
  const bm25Ranked = scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .map((x) => corpus[x.i].id);

  const lists: string[][] = [bm25Ranked];
  let usedDense = false;
  const denseScore = new Map<string, number>();

  if (opts?.embedClaim?.length && opts.corpusEmbeddings?.length === corpus.length) {
    const ranked = corpus
      .map((s, i) => {
        const emb = opts.corpusEmbeddings![i];
        const sc = emb?.length ? cosine(opts.embedClaim!, emb) : -1;
        return { id: s.id, sc };
      })
      .filter((x) => x.sc >= 0)
      .sort((a, b) => b.sc - a.sc);
    ranked.forEach((x) => denseScore.set(x.id, x.sc));
    lists.push(ranked.map((x) => x.id));
    usedDense = true;
  }

  // Evidence prior list: all fromEvidence first (stable order)
  const priorList = corpus.filter((s) => s.fromEvidence).map((s) => s.id);
  if (priorList.length) lists.push(priorList);

  const fused = rrfFuse(lists);
  const byId = new Map(corpus.map((s) => [s.id, s]));
  const bm25ById = new Map(
    scores.map((s, i) => [corpus[i].id, s] as const),
  );

  const out: Candidate[] = [];
  for (const { id, score } of fused) {
    const sentence = byId.get(id);
    if (!sentence) continue;
    const scorePrior = sentence.fromEvidence ? 1 : 0;
    out.push({
      sentence,
      scoreFusion: score + scorePrior * 0.02,
      scoreBm25: bm25ById.get(id) || 0,
      scoreDense: denseScore.get(id),
      scorePrior,
    });
    if (out.length >= topN) break;
  }
  // Re-sort after prior nudge
  out.sort((a, b) => b.scoreFusion - a.scoreFusion);
  void usedDense;
  return out;
}
```

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/rag/grounding/candidates.ts test/node/groundingCandidates.test.ts
git commit -m "[feat] Grounding candidate retrieval (BM25+RRF+prior)"
```

---

### Task 3: Claim parse + rule fallback

**Files:**
- Create: `src/rag/grounding/claims.ts`
- Create: `test/node/groundingClaims.test.ts`
- Reuse: `extractClaimSpans` from `../groundAnswer` for fallback

**Interfaces:**
- Produces: `parseClaimsJson(raw: unknown, maxClaims?: number): Claim[]`  
- Produces: `claimsFromAnswerRules(answer: string, maxClaims?: number): Claim[]`

- [ ] **Step 1: Failing tests**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claimsFromAnswerRules,
  parseClaimsJson,
} from "../../src/rag/grounding/claims";

describe("parseClaimsJson", () => {
  it("accepts valid claims array", () => {
    const claims = parseClaimsJson({
      claims: [
        {
          text: "MCP predicts mass-contact.",
          type: "method",
          must_terms: ["MCP"],
          numbers: [],
        },
      ],
    });
    assert.equal(claims.length, 1);
    assert.equal(claims[0].id, "c1");
    assert.equal(claims[0].mustTerms[0], "MCP");
    assert.equal(claims[0].textEn, claims[0].text); // filled later by normalize
  });

  it("drops empty text and caps maxClaims", () => {
    const claims = parseClaimsJson(
      {
        claims: [
          { text: "", type: "other" },
          { text: "A", type: "result" },
          { text: "B", type: "result" },
        ],
      },
      1,
    );
    assert.equal(claims.length, 1);
  });
});

describe("claimsFromAnswerRules", () => {
  it("builds claims from bullets", () => {
    const c = claimsFromAnswerRules(
      "- residual force learning helps\n- latency under 1 ms\n",
    );
    assert.ok(c.length >= 2);
    assert.match(c[0].text, /residual force/i);
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
// src/rag/grounding/claims.ts
import { extractClaimSpans } from "../groundAnswer";
import type { Claim, ClaimType } from "./types";

const TYPES = new Set<ClaimType>([
  "method",
  "result",
  "definition",
  "comparison",
  "other",
]);

function asType(v: unknown): ClaimType {
  const s = String(v || "other").toLowerCase() as ClaimType;
  return TYPES.has(s) ? s : "other";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 12);
}

export function parseClaimsJson(
  raw: unknown,
  maxClaims = 8,
): Claim[] {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const arr = Array.isArray(obj.claims)
    ? obj.claims
    : Array.isArray(raw)
      ? raw
      : [];
  const out: Claim[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const text = String(o.text || o.claim || "").trim();
    if (text.length < 8) continue;
    const id = `c${out.length + 1}`;
    out.push({
      id,
      text: text.slice(0, 400),
      textEn: String(o.text_en || o.textEn || text).trim().slice(0, 400),
      type: asType(o.type),
      mustTerms: asStringArray(o.must_terms ?? o.mustTerms),
      numbers: asStringArray(o.numbers),
    });
    if (out.length >= maxClaims) break;
  }
  return out;
}

export function claimsFromAnswerRules(
  answer: string,
  maxClaims = 8,
): Claim[] {
  const spans = extractClaimSpans(answer, { minChars: 12 }).slice(0, maxClaims);
  return spans.map((text, i) => ({
    id: `c${i + 1}`,
    text,
    textEn: text,
    type: "other" as const,
    mustTerms: [],
    numbers: [],
  }));
}
```

- [ ] **Step 4: PASS + commit**

```bash
git add src/rag/grounding/claims.ts test/node/groundingClaims.test.ts
git commit -m "[feat] Grounding claim parse and rule fallback"
```

---

### Task 4: LLM JSON helper + normalize + judge parsers

**Files:**
- Create: `src/rag/grounding/llmJson.ts`
- Create: `src/rag/grounding/normalize.ts`
- Create: `src/rag/grounding/judge.ts`
- Create: `test/node/groundingJudgeNormalize.test.ts`

**Interfaces:**
- `completeJson(llm, system, user): Promise<unknown>`
- `applyNormalizeResult(claims, raw): Claim[]`
- `parseJudgment(raw, claim, allowedIds): Judgment`
- Prompt builders: `buildNormalizeUser(claims)`, `buildJudgeUser(claim, candidates)`

- [ ] **Step 1: Tests for parseJudgment + applyNormalizeResult**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
      new Map([
        ["s2", "Explicit mass-contact prediction is key to recovery."],
      ]),
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
```

- [ ] **Step 2: Implement parsers + completeJson**

```ts
// llmJson.ts — strip ```json fences, JSON.parse, throw on failure
// normalize.ts — applyNormalizeResult merges by id; buildNormalizeSystem/User strings in English
// judge.ts — parseJudgment; buildJudgeSystem/User; SUPPORT only later in pipeline
```

`completeJson`:

```ts
export async function completeJson(
  llm: GroundingLlm,
  system: string,
  user: string,
): Promise<unknown> {
  const raw = await llm.complete({
    model: llm.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const text = String(raw || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] || text).trim();
  return JSON.parse(body);
}
```

Judge system prompt (store as const string in `judge.ts`):

- You are an evidence judge for a scientific paper.
- Given a claim and candidate paper sentences, pick at most one sentence that **entails** the claim.
- Respond JSON only: `{"label":"support|partial|none","sentence_id":"…"|null,"confidence":0-1}`
- `sentence_id` MUST be one of the provided ids or null.
- Prefer `none` when unsure. `support` only if the sentence alone justifies the claim.

Normalize system:

- Translate each claim to English for retrieval; preserve technical terms and numbers.
- JSON: `{"claims":[{"id":"c1","text_en":"…","must_terms":[],"numbers":[]}]}`

- [ ] **Step 3: PASS + commit**

```bash
git add src/rag/grounding/llmJson.ts src/rag/grounding/normalize.ts src/rag/grounding/judge.ts test/node/groundingJudgeNormalize.test.ts
git commit -m "[feat] Grounding LLM JSON, normalize, judge parsers"
```

---

### Task 5: PDF lock (fail-closed) + apply HTML

**Files:**
- Create: `src/rag/grounding/pdfLock.ts`
- Create: `src/rag/grounding/apply.ts`
- Create: `test/node/groundingApplyLock.test.ts`
- Uses: `pickLinkPhrase`, `applyGroundedLinks` patterns from `groundAnswer.ts` (copy/adapt into apply.ts to avoid circular deps); `locateQuoteInOpenPdf` from `autoHighlight/locate.ts`

**Interfaces:**
- `buildNeedleVariants(sentence: string): string[]`
- `lockJudgmentToPdf(opts): Promise<LockedEvidence | null>`
- `applyLockedEvidence(answer: string, locks: LockedEvidence[]): { answer: string; tray: string }`

- [ ] **Step 1: Pure tests for needles + apply**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNeedleVariants } from "../../src/rag/grounding/pdfLock";
import { applyLockedEvidence } from "../../src/rag/grounding/apply";
import type { LockedEvidence } from "../../src/rag/grounding/types";

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
});
```

- [ ] **Step 2: Implement apply.ts** (port `htmlGroundLink` / tray / non-overlap insert from groundAnswer; add optional `data-rects` via existing `encodeRectsAttr` from context or groundAnswer)

- [ ] **Step 3: Implement pdfLock**

```ts
export function buildNeedleVariants(sentence: string): string[] {
  const full = sentence.replace(/\s+/g, " ").trim();
  const out: string[] = [];
  if (full) out.push(full);
  // hyphen heal
  const healed = full.replace(/(\w)-\s+(\w)/g, "$1$2");
  if (healed !== full) out.push(healed);
  // progressive shorten by sentence clauses
  const parts = full.split(/(?<=[,:;])\s+/);
  if (parts.length > 1) {
    let acc = parts[0];
    for (let i = 1; i < parts.length; i++) {
      acc = `${acc} ${parts[i]}`.trim();
      if (acc.length >= 28) out.push(acc);
    }
  }
  // longest prefix windows
  for (const len of [160, 100, 64]) {
    if (full.length > len) out.push(full.slice(0, len).trim());
  }
  // dedupe
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = s.toLowerCase();
    if (seen.has(k) || s.length < 12) return false;
    seen.add(k);
    return true;
  });
}

export async function lockJudgmentToPdf(opts: {
  claim: Claim;
  judgment: Judgment;
  locate: (quote: string) => Promise<{
    pageIndex: number;
    pageLabel: string;
    rects: number[][];
    matchedText: string;
  } | null>;
}): Promise<LockedEvidence | null> {
  if (opts.judgment.label !== "support" || !opts.judgment.paperSentence) {
    return null;
  }
  const paper = opts.judgment.paperSentence;
  for (const needle of buildNeedleVariants(paper)) {
    const hit = await opts.locate(needle);
    if (!hit?.rects?.length && hit?.pageIndex == null) continue;
    if (!hit) continue;
    // require a real locate hit
    const phrase =
      pickLinkPhrase(opts.claim.text, paper) ||
      pickLinkPhrase(opts.claim.textEn, paper) ||
      opts.claim.text.slice(0, 60);
    if (!opts.claim.text.toLowerCase().includes(phrase.toLowerCase())) {
      // map EN phrase failure: use claim.text slice
    }
    const answerPhrase = opts.claim.text
      .toLowerCase()
      .includes(phrase.toLowerCase())
      ? /* recover surface from claim.text */ phrase
      : opts.claim.text.slice(0, Math.min(80, opts.claim.text.length));
    return {
      claimId: opts.claim.id,
      answerPhrase,
      paperSentence: paper,
      pageStart: hit.pageIndex + 1, // 1-based for data-page consistency with existing
      section: undefined,
      rects: hit.rects,
      locateOk: true,
    };
  }
  return null;
}
```

**Note for implementer:** Existing `htmlGroundLink` uses `pageStart` as printed page number in `#paperai-page-${pageStart}` — match current convention in `groundAnswer.ts` (`pageStart` from chunks is already 1-based in many paths). Align with `PaperSentence.pageStart` from index (verify in `chunk.ts` / fixtures: often 1-based labels). Use the same units as `sentencesFromIndex` today.

- [ ] **Step 4: Wire locate adapter in pdfLock to call `locateQuoteInOpenPdf` when reader present; unit tests inject mock locate.**

- [ ] **Step 5: PASS + commit**

```bash
git commit -m "[feat] Grounding PDF lock and HTML apply"
```

---

### Task 6: Pipeline orchestration (mock LLM + mock locate)

**Files:**
- Create: `src/rag/grounding/pipeline.ts`
- Create: `src/rag/grounding/index.ts`
- Create: `test/node/groundingPipeline.test.ts`

**Interfaces:**
- Produces: `groundAnswerHighQuality(opts) → Promise<GroundingResult>`

```ts
export async function groundAnswerHighQuality(opts: {
  answer: string;
  paperSentences: PaperSentenceRef[];
  llm?: GroundingLlm | null;
  embedCfg?: import("../embed").EmbedConfig | null;
  /** async locate; if omitted, skip PDF lock and produce zero links (fail closed) */
  locate?: (quote: string) => Promise<LocatedQuote | null>;
  maxClaims?: number;
  judgeTopK?: number;
  /** When llm null, fall back to legacy groundAnswerToPaper */
  allowLegacyFallback?: boolean;
}): Promise<GroundingResult>;
```

- [ ] **Step 1: Integration test with mock llm + mock locate**

```ts
it("end-to-end: KO-ish claim path with mocks yields locked link", async () => {
  const paper = [
    {
      id: "s1",
      text: "We present residual force learning for quadruped locomotion.",
      pageStart: 1,
      fromEvidence: true,
    },
  ];
  let step = 0;
  const llm = {
    complete: async () => {
      step++;
      if (step === 1) {
        // claims
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
        // normalize
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
      // judge
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
});

it("locate failure yields no link", async () => {
  // same but locate returns null → matched 0, no cite class
});
```

- [ ] **Step 2: Implement pipeline stages in order**

1. If no llm and `allowLegacyFallback`: call `groundAnswerToPaper`, map links to result shape (locateOk assumed true only if no locate required — **legacy path does not claim PDF lock**; document as degraded).
2. Else: claims via `completeJson` + `parseClaimsJson` or rule fallback.
3. normalize via `completeJson` + `applyNormalizeResult`.
4. For each claim: `retrieveCandidates` → top K → judge `completeJson` → if support, `lockJudgmentToPdf`.
5. `applyLockedEvidence`.
6. Fill diagnostics.

Optional dense in pipeline:

```ts
// if opts.embedCfg?.apiKey and paper sentences: embed claim textEn and/or use sentence.embedding if present
```

v1 minimum: dense only when `sentence.embedding` already on refs OR single `embedTexts` for claim + on-the-fly for corpus top subset — keep simple: **if embedCfg, embed claim + all sentence texts (cap 200 sents)**.

- [ ] **Step 3: Export from `src/rag/grounding/index.ts` and `src/rag/index.ts`**

- [ ] **Step 4: PASS + commit**

```bash
git commit -m "[feat] Grounding high-quality pipeline with mocks"
```

---

### Task 7: paperTask wiring + status + reader locate

**Files:**
- Modify: `src/ui/paperTask.ts` (post-answer grounding block ~233–272)
- Modify: `src/rag/index.ts` exports
- Possibly: helper to build `PaperSentenceRef[]` with ids from `sentencesFromIndex` + evidence flags

**Interfaces:**
- Build sentences:

```ts
function toSentenceRefs(
  sents: import("../rag/groundAnswer").PaperSentence[],
  evidenceChunkIds: Set<string>,
): PaperSentenceRef[] {
  return sents.map((s, i) => ({
    id: s.chunkId ? `${s.chunkId}:${i}` : `s${i}`,
    text: s.text,
    pageStart: s.pageStart,
    pageEnd: s.pageEnd,
    section: s.section,
    chunkId: s.chunkId,
    fromEvidence: !!(s.chunkId && evidenceChunkIds.has(s.chunkId)),
  }));
}
```

- [ ] **Step 1: Change grounding block to async HQ path**

After `runTask`:

```ts
const paperSents = rag.paperSentences || [];
const evidenceIds = new Set(
  (rag.evidence || []).map((e) => e.chunk?.id).filter(Boolean) as string[],
);
if (answer && paperSents.length) {
  input.onStatus?.("근거 판정(claim·judge·PDF) 중…");
  const client = getOrCreateClient(input.store, cfg); // already have client
  const grounded = await groundAnswerHighQuality({
    answer,
    paperSentences: toSentenceRefs(paperSents, evidenceIds),
    llm: {
      complete: (o) =>
        client.complete({
          model: o.model || cfg.model,
          messages: o.messages,
        }),
      model: cfg.model,
    },
    embedCfg: /* resolveEmbedConfig from rag prefs if available */ null,
    locate: async (quote) => {
      try {
        return await locateQuoteInOpenPdf(quote);
      } catch {
        return null;
      }
    },
    allowLegacyFallback: true,
  });
  answer = grounded.answer;
  ragFooter = grounded.answer.includes("paperai-evidence-tray")
    ? "/* tray already in answer */"
    : "";
  // Prefer: pipeline returns body+tray already combined (spec)
  input.onStatus?.(
    `근거 링크 ${grounded.matched}/${grounded.claims.length}` +
      (grounded.diagnostics.locateFailures
        ? ` · locate실패 ${grounded.diagnostics.locateFailures}`
        : "") +
      (grounded.diagnostics.usedDense ? " · dense" : ""),
  );
}
```

Ensure `attachRagContext` returns `evidence` with chunk ids (already does).

- [ ] **Step 2: Manual smoke checklist in commit message body** (FR-Net question)

- [ ] **Step 3: Run full `npm run test:node` + `npx tsc --noEmit`**

- [ ] **Step 4: Commit**

```bash
git commit -m "[feat] Wire high-quality grounding into paperTask"
```

---

### Task 8: citeNavigate rect preference + gold fixture skeleton

**Files:**
- Modify: `src/ui/citeNavigate.ts` / markdown click handler path — ensure `data-rects` parsed and `navigateReaderToPosition(pageIndex0, rects)` called before quote locate when present
- Create: `test/fixtures/grounding/sample-gold.json`
- Create: `test/node/groundingGoldSkeleton.test.ts` (loads fixture, runs mock pipeline expectations)

**sample-gold.json shape:**

```json
{
  "paperSentences": [
    {
      "id": "s1",
      "text": "We present residual force learning for quadruped locomotion.",
      "pageStart": 1
    }
  ],
  "cases": [
    {
      "answer": "They use residual force learning.",
      "goldSentenceId": "s1",
      "language": "en"
    },
    {
      "answer": "잔차 힘 학습으로 보행을 개선한다.",
      "goldSentenceId": "s1",
      "language": "ko",
      "mockTextEn": "Residual force learning improves locomotion."
    }
  ]
}
```

Test: for each case, mock normalize/judge to gold id + mock locate success → `matched === 1` and preview contains gold text.

- [ ] **Step 1: Implement fixture test**
- [ ] **Step 2: Verify cite click path uses rects** (read `markdown.ts` / `handleCiteClick`; add rects branch if missing)
- [ ] **Step 3: Full test suite + commit**

```bash
git commit -m "[feat] Grounding gold skeleton and cite rect navigation"
```

---

### Task 9: Cleanup + docs

**Files:**
- Modify: `src/rag/groundAnswer.ts` header comment pointing to `grounding/`
- Modify: `AGENTS.md` RAG bullet on grounding (one short paragraph)
- Modify: `docs/superpowers/specs/2026-08-10-evidence-grounding-design.md` status → Implemented (when done)

- [ ] **Step 1: AGENTS.md** — replace “BM25 + token overlap gate” with “HQ pipeline: claims → judge → PDF lock; legacy lexical fallback”
- [ ] **Step 2: `npm run verify` or at least `test:node` + `tsc`**
- [ ] **Step 3: Commit**

```bash
git commit -m "[docs] Grounding pipeline notes in AGENTS"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
| ---------------- | ---- |
| Atomic claims LLM + rule fallback | T3, T6 |
| KO→EN normalize | T4, T6 |
| BM25 + optional dense RRF + evidence prior | T1–T2, T6 |
| LLM judge support-only | T4, T6 |
| PDF lock fail-closed | T5–T6 |
| apply links + tray | T5 |
| paperTask wire | T7 |
| No cite-id protocol | preserved prompts; HQ path |
| Modules under grounding/ | all tasks |
| Gold skeleton | T8 |
| Diagnostics | T6–T7 |
| Legacy fallback | T6 |

**Placeholder scan:** none intentional.  
**Type names:** Claim, PaperSentenceRef, Candidate, Judgment, LockedEvidence, GroundingResult, GroundingLlm — consistent across tasks.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-10-evidence-grounding.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks (`superpowers:subagent-driven-development`)
2. **Inline Execution** — this session with `superpowers:executing-plans` and checkpoints

Which approach?

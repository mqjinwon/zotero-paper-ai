# High-Performance Evidence Grounding Design

**Date:** 2026-08-10  
**Status:** Spec approved for planning (implementation only after plan + “구현 시작”)  
**Related:** `2026-08-03-paper-rag-design.md` (RAG reading context; this spec owns **answer→paper links**)  
**Product:** Paper AI Colleague — post-hoc 근거 링크 quality over cost

---

## 1. Problem

Today (`src/rag/groundAnswer.ts` + `paperTask.ts`):

1. Split answer into claim-like spans (rules only).
2. Match to paper sentences with **BM25 + token precision/Jaccard/overlap**.
3. Link when score ≥ ~0.42; jump needle = paper sentence string.

Failure modes (observed / structural):

| Layer | Failure |
| ----- | ------- |
| Cross-lingual | Korean answers vs English paper → near-zero token overlap |
| Semantics | Paraphrase / summary claims match wrong shared terms |
| Claim unit | Long bullets mix multiple assertions → wrong top sentence |
| Corpus | Full-paper lexical search ignores “what the model actually read” |
| Locate | Index string ≠ PDF.js text → wrong/missing jump |
| Calibration | Threshold tunes precision/recall but cannot fix language gap |

**Success definition (performance-first):**

- **Support precision** of linked claims ≥ 90% (human: supports / related / wrong).
- **Jump success** among linked claims ≥ 85% (lands on correct page + quote region or verified text span).
- **KO claim recall** (correct sentence in top-1 after full pipeline) ≥ 85% on a gold set.
- **False link rate** ≤ 5%; abstaining (no link) is preferred over a wrong link.

---

## 2. Goals and non-goals

### 2.1 Goals

1. Atomic, typed claims from the assistant answer (KO/EN).
2. Bilingual normalization so KO claims can match EN paper text.
3. Candidate retrieval: BM25 always; **optional** multilingual dense boost (RRF).
4. Context prior: sentences from RAG evidence used for the answer get a score bonus.
5. **Final gate: LLM judge** (`support` / `partial` / `none`) on top-K candidates only.
6. **PDF lock:** only emit a navigable link after PDF.js locate (or official rect path) succeeds.
7. Preserve product rule: **no model bibliography cite-id protocol** (`[1]`, `#cite-N`) as the primary linking mechanism.
8. Decompose new logic into focused modules under `src/rag/grounding/` (do not grow `groundAnswer.ts` further as a god-file).

### 2.2 Non-goals (v1)

- Local cross-encoder / on-device NLI weights (may be v2).
- Requiring embedding API for basic operation.
- Replacing RAG reading-context retrieval (still `retrieve.ts`).
- Perfect OCR for scanned PDFs without text layer.
- User-facing score badges (optional later; diag may log scores).

---

## 3. Decisions (locked in brainstorming)

| Topic | Decision |
| ----- | -------- |
| Final support gate | **LLM judge** (structured JSON), reuse existing chat LLM path (Codex/Grok OAuth or API key router) |
| Dense retrieval | **Optional boost** — if embed key + vectors available, dense+BM25 RRF; else BM25 + term gates; **always** LLM judge when candidates exist |
| Scope | **Full quality stack v1** in one spec/plan: claims, retrieve, judge, PDF lock, gold tests skeleton |
| Wrong locate | **No navigable phrase link** (precision over coverage) |
| Partial support | Link only if judge says `support` (not `partial`) for v1 phrase links; `partial` may appear in evidence tray as non-jumping text later if easy—**v1: tray only includes `support` + locked** |

---

## 4. Architecture

### 4.1 Pipeline

```
answer: string
paperIndex / paperSentences + ragEvidenceChunks
        │
        ▼
[1] extractClaims(answer) → Claim[]
        │  LLM structured JSON + light rule cleanup
        ▼
[2] normalizeClaims(claims) → Claim[] with textEn, mustTerms, numbers
        │  KO→EN via short LLM call (batch all claims)
        ▼
[3] retrieveCandidates(claim, corpus) → Candidate[]  // top 15
        │  BM25(textEn + mustTerms)
        │  + optional dense(textEn or textKo)
        │  + contextPrior from evidence chunk ids
        │  → RRF / weighted fusion
        ▼
[4] judgeClaim(claim, candidates[0..K]) → Judgment  // K=5 default
        │  LLM JSON: support|partial|none + chosen sentence id + short rationale
        ▼
[5] lockToPdf(judgment) → LockedEvidence | null
        │  locateQuoteInOpenPdf / fuzzy needle / page from chunk
        │  success ⇒ rects or verified preview
        ▼
[6] applyGroundedLinks + evidenceTray
        │  only LockedEvidence with support
        ▼
HTML answer (sticky/panel)
```

### 4.2 Module layout

| Module | Responsibility |
| ------ | -------------- |
| `src/rag/grounding/types.ts` | Claim, Candidate, Judgment, LockedEvidence, GroundingResult |
| `src/rag/grounding/claims.ts` | LLM claim extract + parse/validate + rule fallback |
| `src/rag/grounding/normalize.ts` | KO→EN batch normalize; mustTerms/numbers extract |
| `src/rag/grounding/candidates.ts` | BM25, optional dense, context prior, RRF |
| `src/rag/grounding/judge.ts` | LLM support judge |
| `src/rag/grounding/pdfLock.ts` | Locate + gate link emission |
| `src/rag/grounding/apply.ts` | Phrase HTML links + tray (reuse/adapt current apply helpers) |
| `src/rag/grounding/pipeline.ts` | `groundAnswerHighQuality(...)` orchestration |
| `src/rag/groundAnswer.ts` | Thin re-export / legacy `groundAnswerToPaper` wrapper for tests during migration |
| `src/ui/paperTask.ts` | Call new pipeline; pass evidence chunks + LLM client + optional embed cfg + reader |

### 4.3 Types (canonical)

```ts
export type ClaimType = "method" | "result" | "definition" | "comparison" | "other";

export interface Claim {
  id: string;              // c1, c2, ...
  text: string;            // surface in answer language
  textEn: string;          // English for retrieval/judge
  type: ClaimType;
  mustTerms: string[];     // technical terms that should appear in support
  numbers: string[];       // numeric tokens to prefer/require soft-match
}

export interface PaperSentence {
  id: string;              // stable: chunkId + hash or index
  text: string;
  pageStart?: number;
  pageEnd?: number;
  section?: string;
  chunkId?: string;
  fromEvidence?: boolean;  // true if from RAG evidence for this answer
  embedding?: number[];    // optional
}

export interface Candidate {
  sentence: PaperSentence;
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
  confidence: number;      // 0–1 model self-report, not sole gate
}

export interface LockedEvidence {
  claimId: string;
  answerPhrase: string;    // substring of claim.text for HTML wrap
  paperSentence: string;
  pageStart?: number;
  pageEnd?: number;
  section?: string;
  rects?: number[][];      // if locate provides
  locateOk: true;
}

export interface GroundingResult {
  answer: string;          // body + optional tray HTML
  links: LockedEvidence[];
  claims: Claim[];
  judgments: Judgment[];
  matched: number;
  diagnostics: {
    usedDense: boolean;
    judgeModel?: string;
    claimCount: number;
    candidateCounts: number[];
    locateFailures: number;
  };
}
```

---

## 5. Component design

### 5.1 Claim extraction (`claims.ts`)

**Input:** raw assistant answer (markdown/plain).  
**Output:** `Claim[]` (max 8 for v1).

**Primary:** one LLM call with JSON schema:

```json
{
  "claims": [
    {
      "text": "…",
      "type": "method",
      "must_terms": ["MCP", "mass-contact"],
      "numbers": []
    }
  ]
}
```

Rules:

- Atomic: one testable assertion per claim.
- Drop meta (“요약하면”, “논문에서는 다음과 같다”).
- Fallback if LLM fails: current `extractClaimSpans` → Claim with empty mustTerms and textEn=text.

### 5.2 Normalize (`normalize.ts`)

**Input:** claims (possibly KO).  
**Output:** claims with `textEn` filled.

- Single batched LLM call: map each claim text → English, preserve must_terms and numbers verbatim.
- If claim already mostly Latin technical English, textEn may equal text.
- On failure: textEn = text (degraded).

### 5.3 Candidates (`candidates.ts`)

**Corpus:** `sentencesFromIndex` / chunks (same as today), each with stable `id`.  
Mark `fromEvidence=true` for sentences derived from `rag.evidence` chunk ids used in this `runTask`.

**Per claim:**

1. **BM25** query = `textEn + mustTerms.join(" ")` over sentence texts → top 50.
2. **Dense** (if `embedCfg` and any sentence embeddings or on-the-fly embed of top-80 BM25 + all evidence sents): cosine(claim embedding, sentence) → top 50.
3. **Prior:** +fixed bonus if `fromEvidence` (e.g. equivalent to strong RRF rank boost).
4. **Term gate (soft):** if `mustTerms` non-empty, prefer candidates containing ≥1 term (case-insensitive); if none do, still keep top dense/BM25 but flag for judge (do not hard-drop all—judge decides).
5. **RRF** fuse lists → top **15** candidates.

### 5.4 LLM judge (`judge.ts`)

**Input:** one claim (`text`, `textEn`, mustTerms, numbers) + top **K=5** candidates (id + text + section/page meta).  
**Output:** Judgment.

Prompt constraints:

- Premise = paper sentence only; hypothesis = claim (prefer textEn for matching English paper).
- Labels: `support` | `partial` | `none`.
- Must return `sentence_id` only from provided ids.
- If none support, label `none` and null id.
- Temperature 0 / low; JSON only.

**Batching:** up to N claims can be one multi-claim judge call if token budget allows; otherwise sequential. Prefer **one claim per call** for reliability in v1 unless tests show batch is stable.

**Link rule:** only `support` proceeds to PDF lock.

### 5.5 PDF lock (`pdfLock.ts`)

**Input:** Judgment with paper sentence + optional pageStart + reader.  
**Output:** LockedEvidence or null.

Steps:

1. Build needle variants: full sentence; hyphen-heal; collapse whitespace; progressive shorten to longest substring ≥ 24 chars that locate accepts.
2. Call existing `locateQuoteInOpenPdf` (or successor).
3. If locate returns page/rects → success; attach rects when available.
4. If pageStart known and locate fails, optional page-scoped retry.
5. **Failure → no LockedEvidence** (no phrase link). Increment `locateFailures`.

**Answer phrase:** choose substring of `claim.text` for UI:

- Prefer longest overlap between claim.text and paper sentence tokens (existing `pickLinkPhrase` on textEn vs paper, then map back to KO surface if possible).
- Fallback: first 40–80 chars of claim.text (still only if locked).

### 5.6 Apply (`apply.ts`)

- Reuse non-overlapping HTML insertion from current `applyGroundedLinks` / `htmlGroundLink`.
- `data-preview` = **locked** paper sentence (verified).
- Prefer `data-page` + optional `data-rects` JSON for navigate (citeNavigate should prefer rects when present).
- Evidence tray lists only locked support items.

### 5.7 Orchestration (`pipeline.ts`)

```ts
export async function groundAnswerHighQuality(opts: {
  answer: string;
  paperSentences: PaperSentence[];
  evidenceChunkIds?: string[];
  llm: { completeJson: (system: string, user: string) => Promise<unknown> };
  embedCfg?: EmbedConfig | null;
  reader?: unknown;
  maxClaims?: number;      // default 8
  judgeTopK?: number;      // default 5
  minJudgeConfidence?: number; // default 0.5 soft; label is primary
}): Promise<GroundingResult>
```

**Sync legacy path:** keep `groundAnswerToPaper` for unit tests and offline fallback when `llm` unavailable → old lexical scorer, but **paperTask always prefers high-quality path** when LLM client exists.

### 5.8 paperTask integration

After `runTask` returns answer:

1. Build `paperSentences` with ids from index (as today + id field).
2. Tag evidence sentences from `rag.evidence`.
3. Call `groundAnswerHighQuality` with router LLM JSON helper and optional embed cfg + open reader.
4. Status: `근거 판정 n/m · 링크 k · locate 실패 f`.
5. On total pipeline failure: fall back to lexical ground once; never throw away answer body.

---

## 6. Error handling

| Failure | Behavior |
| ------- | -------- |
| Claim LLM fail | Rule extractClaims fallback |
| Normalize fail | textEn = text |
| No embed key | Skip dense; BM25 + prior only |
| Dense API error | Log diag; continue without dense |
| Judge fail / bad JSON | That claim → no link; others continue |
| Judge timeout | Same |
| Locate fail | No link for that claim |
| Empty corpus | No grounding; return raw answer |

Never block the user-visible answer on grounding failure.

---

## 7. Testing strategy

### 7.1 Unit (node)

- Claim JSON parse + validation + maxClaims trim.
- RRF fusion ordering with fixtures.
- Term soft-preference.
- Judge response parse (valid / invalid / unknown sentence id → none).
- applyGroundedLinks non-overlap with new LockedEvidence.
- KO fixture: Korean claim + EN paper sentences → with mocked LLM normalize+judge, expects correct sentence id.

### 7.2 Integration (node mocks)

- Full pipeline with mock `completeJson` and mock locate.
- Dense on/off paths.
- Locate fail ⇒ matched 0 for that claim.

### 7.3 Gold skeleton (checked in)

- `test/fixtures/grounding/fr-net-sample.json` (or synthetic paper): ≥10 claims KO/EN with gold sentence ids.
- Runner scores precision/recall against mocks first; real-PDF gold later optional.

### 7.4 Manual

- FR-Net chat: re-run known questions; links should jump to MCP/contribution sentences.
- Status line shows judge/locate counts.

---

## 8. Observability

- `diag("grounding", ...)` stages: claims, candidates, judge, locate.
- No API keys in logs; paper titles and claim counts OK.
- Prefer structured fields: `usedDense`, `judgeMs`, `locateFailures`.

---

## 9. Migration

1. Implement `src/rag/grounding/*` beside existing `groundAnswer.ts`.
2. Wire `paperTask` to high-quality path.
3. Re-export stable helpers from `groundAnswer.ts` for old tests.
4. Deprecate pure-lexical-as-primary once gold mock tests pass.
5. Sticky + panel both receive already-grounded HTML (no second ground).

---

## 10. Risks and mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Extra LLM latency (claims + normalize + N judges) | Batch normalize; cap claims 8; K=5; parallel judge calls with concurrency 3 |
| Judge hallucination of sentence id | Constrain to provided ids; reject unknown |
| Cost | Cap claims; optional pref later to disable HQ ground |
| Embed quality multilingual | Optional only; judge is final gate |
| PDF text mismatch | Progressive needle; fail closed |

---

## 11. Implementation phases (within this single plan)

Still one deliverable, ordered for TDD:

1. Types + pure candidate fusion + tests  
2. Claim extract/normalize (mock LLM) + tests  
3. Judge parse + pipeline with mocks  
4. PDF lock adapter + fail-closed tests  
5. paperTask wire-up + status  
6. Gold fixture skeleton + legacy wrapper  
7. citeNavigate rect preference if not already  

---

## 12. Open points (explicit, non-blocking)

- Prefer **sequential** judge calls in v1 for parse reliability (concurrency optional pref).
- Exact RRF k and prior weight: tune with gold fixture; defaults documented in plan.
- Whether `partial` appears in tray without link: **v1 no** (support+locked only).

---

## 13. Approval record

- Final gate: LLM judge  
- Dense: optional boost  
- Scope: full quality stack v1  
- Design approved in brainstorming session 2026-08-10  

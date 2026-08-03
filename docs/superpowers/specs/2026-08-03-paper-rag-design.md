# Paper AI Colleague — Single-Paper RAG Design (v2)

**Date:** 2026-08-03  
**Status:** Spec baseline (implement only after “구현 시작”)  
**Supersedes:** earlier draft wording (“chat only”, “dense optional as primary quality path”)

---

## 1. Product scope

### 1.1 What RAG is for

| Mode | Uses paper-wide index? | Also uses |
|------|------------------------|-----------|
| **질의응답** (패널 질문 / 보내기) | **Yes** | chat history |
| **그림/표 설명** | **Yes** (related text/captions) | user image + optional question |
| **수식 설명** | **Yes** (nearby defs / math context) | image and/or selection |
| 드래그 **번역** | No | selection only |
| 드래그 **설명** | No | selection only |

### 1.2 Paper coverage

- **Index the entire paper** (all extractable pages/sections).  
- No “abstract-only” or sampled indexing.  
- Short papers: may **stuff** most/all section parents into context.  
- Long papers: full index + **top-k retrieval**.

### 1.3 Dependencies policy

- **No other Zotero plugins.**  
- No required GROBID/MinerU/Docker for the default path.  
- All RAG logic lives in this repo (`src/rag/*` after clean rewrite).  
- **Embedding backends are chosen in Preferences** (including a zero-key path).

---

## 2. What “dense / BM25” means (question 3)

These are **retrieval methods inside our code**, not other Zotero plugins.

| Name | What it is | Needs |
|------|------------|--------|
| **BM25** | Keyword-style ranking we implement ourselves (tokenize + score). | **No API key.** Runs fully local after text is extracted. |
| **Dense embedding** | Turn text into vectors, rank by cosine similarity. | Either (a) **external embeddings HTTP API**, or (b) later local model — **not** free by default. |

There is **no built-in “internal SDK” from Grok/Codex OAuth that gives embeddings for free**.  
Chat login (`grok login` / `codex login`) is for **chat/completions**, not a guaranteed embeddings service.

So:

- **Default for most users (no embedding key):** **BM25-only** retrieval. Still real RAG (full-paper chunks + retrieve + cite).  
- **If user configures an embeddings provider in options:** **Hybrid = dense + BM25** (usually better for paraphrase / conceptual questions).  
- User picks the backend in Preferences — not hard-coded to one vendor.

---

## 3. Embedding / retrieval providers (Preferences)

### 3.1 Pref: `ragRetrievalMode`

| Value | Behavior | When to use |
|-------|----------|-------------|
| **`auto`** (default) | If embedding credentials valid → hybrid; else BM25-only | Most users |
| **`bm25`** | Always BM25-only | No keys / offline / debug |
| **`hybrid`** | Require embeddings; fail indexing with clear error if missing | Power users who want max quality |

### 3.2 Pref: `embeddingProvider`

| Value | Meaning | Typical needs |
|-------|---------|----------------|
| **`none`** | Never call embed API | Default with no keys |
| **`openai-compatible`** | `POST {base}/embeddings` | `embeddingBaseUrl` + `embeddingApiKey` + `embeddingModel` |
| **`openai`** | Same as compatible, base default `https://api.openai.com/v1` | OpenAI API key |
| *(future)* `local` | In-process/local server embeddings | R2+ |

**Not in v1:** calling random third-party Zotero plugins for embed.

### 3.3 Other prefs

| Pref | Default | Role |
|------|---------|------|
| `ragEnabled` | `true` | Master switch for grounded Q&A / figure / equation |
| `ragTopK` | `8` | Retrieved parents/children after expand |
| `ragStuffTokenLimit` | `6000` | Below this → stuff full structured parents |
| `embeddingBaseUrl` | empty | For openai-compatible |
| `embeddingApiKey` | empty | |
| `embeddingModel` | `text-embedding-3-small` | Used only if provider ≠ none |

### 3.4 UX copy (settings)

Explain in UI (Korean/EN short):

> 논문 검색(RAG): 기본은 **키 없이 동작(BM25)**.  
> 의미 검색을 쓰려면 Embeddings API(OpenAI 호환) 키를 넣으세요.  
> Chat용 Grok/Codex 로그인과는 별개입니다.

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────┐
│ Paper AI (Zotero plugin, this repo only)            │
│  translate / drag-explain → no RAG                  │
│  chat / figure / equation → rag.ensureIndex + query │
└──────────────────────────┬──────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────┐
│ src/rag/  (rewrite from zero — see §8)              │
│  extract.ts   full paper text                       │
│  chunk.ts     section + parent–child                │
│  bm25.ts      local keyword index                   │
│  embed.ts     optional HTTP embeddings              │
│  store.ts     ~/.paperai/rag/*.json                 │
│  retrieve.ts  bm25 | hybrid + parent expand         │
│  index.ts     orchestrate build/load                │
│  context.ts   evidence block for prompts            │
└─────────────────────────────────────────────────────┘
         │ optional HTTP only
         ▼
  User-configured embeddings API (if any)
```

---

## 5. Pipeline

### 5.1 Extract — **entire paper**

1. Resolve open PDF attachment / item.  
2. Extract **all available text** (Zotero fulltext and/or file/reader fallbacks).  
3. Prefer page-tagged spans when possible.  
4. Hash content for cache key.  
5. Empty extract → hard error (do not silently index nothing).

### 5.2 Chunk — full document, structured

Policy id: `section-parent-child-v1`

1. Split by section heading heuristics (Abstract, Intro, Method, …).  
2. Each section → parent blocks (cap ~2000 tok).  
3. Parents → children (~450 tok) as search units.  
4. Abstract marked specially (boost / force-candidate on overview queries).  
5. Overlap small or 0; **parent expansion** supplies context after hit.  
6. **Every section** of the paper is chunked (full coverage).

### 5.3 Index build

1. Chunk full doc.  
2. Always build BM25 over search units (child + abstract).  
3. If retrieval mode needs dense and provider configured: embed all search units.  
4. Persist index JSON under:

```text
~/.paperai/rag/{itemKey}-{hash16}.json
```

Fields: version, pdfHash, chunkPolicy, retrievalModeUsed, embedProvider/model, chunks (±embedding[]).

### 5.4 Retrieve

1. Query string = user question (+ optional selection boost; figure mode may add “figure caption table” bias terms).  
2. Score:  
   - `bm25` mode → BM25 only  
   - `hybrid` / auto-with-key → `0.6 * dense_norm + 0.4 * bm25_norm`  
3. Top-k unique by parent; expand to parent text.  
4. Short doc under `ragStuffTokenLimit` → stuff all parents (still full paper, no random drop).  
5. Emit `contextBlock` + citation labels `[§Section p.N]`.

### 5.5 Generate

| Mode | Prompt ingredients |
|------|-------------------|
| chat | system + history + **contextBlock** + question |
| figure-explain | system + **image** + **contextBlock** + optional question |
| equation-explain | system + image/selection + **contextBlock** + question |
| translate / drag explain | unchanged, no contextBlock |

Re-retrieve **per question turn** (history does not replace retrieval).

---

## 6. UX

| Event | Behavior |
|-------|----------|
| Open PDF / open Paper AI pane | Background `ensureIndex` (“논문 전체 인덱싱 중…”) |
| First Q&A before index ready | Wait + status, then answer |
| Answer footer | List evidence cites used |
| Settings | RAG toggle, retrieval mode, embedding provider block |

Figure flow stays panel-driven (pick image + optional question); **text evidence comes from full-paper RAG**.

---

## 7. Testing

| Layer | Assert |
|-------|--------|
| chunk | Full fixture paper → all major sections present as chunks |
| bm25 | Known query ranks expected paragraph first |
| hybrid | With mock embeddings, hybrid ≠ bm25-only order on paraphrase query |
| store | Round-trip index load |
| mode wiring | chat/figure/equation messages include evidence; translate path does not call retrieve |
| no-key | Index + query works with `embeddingProvider=none` |

---

## 8. Codebase hygiene (question 5)

**Decision: delete and rewrite.**

On implementation start:

1. **Delete** current unconnected draft under `src/rag/` entirely.  
2. **Re-create** modules to match this v2 spec only.  
3. Do not wire partial old files into chat.

---

## 9. Implementation phases (after “구현 시작”)

### R1 — Ship grounded paper Q&A + figure/equation

1. Wipe `src/rag/*` draft.  
2. extract (full paper) + chunk + store + bm25 retrieve.  
3. embed client + hybrid when prefs say so.  
4. `ensureIndex` + `queryPaper`.  
5. Wire **chat / figure-explain / equation-explain**.  
6. Prefs UI for retrieval mode + embedding provider.  
7. Unit tests + build XPI.  

### R2

- Indexing progress polish, evidence chips, weight tuning.  

### R3

- Optional user-run layout parser HTTP; multi-PDF.  

---

## 10. Risks

| Risk | Mitigation |
|------|------------|
| No embedding key (common) | Default auto → BM25; still full-paper RAG |
| Weak PDF text layer | Clear warning; still index all extracted text |
| Embed API cost/latency | Cache embeddings with pdfHash; index once |
| User confuses chat OAuth with embed | Settings copy + separate prefs |

---

## 11. Locked decisions

| # | Decision |
|---|----------|
| Scope | Full single paper; RAG for **Q&A + figure + equation**; not drag-translate |
| Parse | **Entire** extractable paper body |
| Retrieval | **BM25 always available**; **dense via user-chosen embed provider**; hybrid when dense available; prefs control mode |
| Keys | Most users have no embed key → **zero-key BM25 path is first-class** |
| Storage | `~/.paperai/rag/*.json` |
| Early code | **Delete and rewrite** (`src/rag/*`) |
| External Zotero plugins | None |

---

## 12. Approval gate

- [x] User intent on scope / full paper / retrieval options / storage / rewrite  
- [ ] User: **「구현 시작」** → execute Phase R1  

Until then: no chat/figure wiring of RAG; no partial ship.

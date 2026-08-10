# Changelog

All notable changes to **Paper AI Colleague** (Zotero plugin) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<!-- Add notes here before the next release. The release workflow copies this
     section (or the matching version section) into the GitHub Release body. -->

## [0.1.3] - 2026-08-10

### Added

- **High-quality evidence grounding pipeline** (`src/rag/grounding/*`): atomic claim extraction → KO→EN normalize → BM25 (+ optional dense RRF) with evidence prior → LLM support judge → PDF locate **fail-closed**.
- Single UI entry `groundAnswerForUi` for panel chat/explain, sticky explain, and figure sticky.
- Sticky **PDF-absolute positions** (`cardPdf`): stickies stay on the page under scroll/zoom instead of following the viewport.
- Sticky page visibility: hide cards when their source PDF page is off-screen; re-show on scroll-back.
- Sticky geometry helpers (`sticky/geometry`, `pageLookup`, `visibility`, `cardPdf`) with unit tests.
- Grounding fixtures and expanded Node tests (pipeline, UI adapter, corpus/status, sticky drag).

### Changed

- Evidence links require judge label `support` **and** successful PDF locate; prefer no link over a wrong jump.
- Legacy lexical grounding is opt-in only (`allowLegacyFallback`, default off) and tagged `source: legacy-lexical` without fake locate.
- Judge phase runs with bounded concurrency (3); locate stays sequential for PDF.js safety.

### Fixed

- Chat/sticky history not restoring after Zotero rewrote note HTML (stripped `data-paper-ai` / class attrs) — tolerant decode + heal rewrite.
- Collapsed sticky “flying away” on drag: CSS-origin delta drag, not stale `note.x` / GBR.
- Mount no longer clamp-saves screen coordinates (preserves cross-device positions until the user moves a card).
- Prefetched figure context still supplies paper sentences for grounding (index attach always runs when allowed).

## [0.1.2] - 2026-08-04

### Added

- **Post-hoc paper-sentence grounding** for chat/explain answers: after generation, claims are matched to real paper sentences (BM25 + token overlap) and linked only when the score clears a gate.
- Phrase hyperlinks on grounded wording (not bibliography-style `[1]` / `[E1]` chips); click navigates with the **paper sentence** as the locate needle.
- Collapsible **evidence tray** under answers listing verified paper sentences.
- Detachable chat window (`DialogHelper`) that shares history with the item-pane chat.
- KaTeX rendering for math in panel, detach chat, and sticky notes.
- Panel layout improvements: index-first controls, resizable chat log, clearer status.
- Official Zotero Reader navigation path: `reader.navigate({ pageIndex, position: { rects } })` with temporary highlight flash (aligned with sticky navigation).

### Changed

- RAG context is **reading-only** for the model; cite-id catalogs (`#cite-N`, forced `[E1]` protocols) are no longer used for linking.
- System prompts forbid bare bibliography markers; free prose is preferred.
- Section chunking policy notes and agent docs updated for post-hoc grounding.

### Fixed

- Misleading long cite labels (`E1 · "…"`) that hurt readability and often pointed at the wrong PDF location.
- CI surface: `npm run verify` (lint + unit tests + build) and pre-push hook.

## [0.1.1] - 2026-08-04

### Added

- Local note sync for chat and sticky data (parent child notes / Zotero Sync).
- Whole-paper bullet summary action.
- Auto-highlight pipeline (claim / method / novelty / caveat) with PDF annotations.
- Configurable `dataDir` for RAG cache (default under Zotero data directory).
- Version tag included in published XPI filename.

### Fixed

- Green CI: Prettier/ESLint, Node unit tests, Dependabot noise.

## [0.1.0] - 2026-08-03

### Added

- Initial public release scaffold for **Paper AI Colleague**.
- Selection translate / explain, paper chat with optional RAG (BM25 / hybrid).
- Codex / Grok OAuth and API-key LLM routing.
- Bootstrap plugin for Zotero 7–9 with item-pane UI.

[Unreleased]: https://github.com/mqjinwon/zotero-paper-ai/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/mqjinwon/zotero-paper-ai/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/mqjinwon/zotero-paper-ai/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/mqjinwon/zotero-paper-ai/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mqjinwon/zotero-paper-ai/releases/tag/v0.1.0

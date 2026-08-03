# Paper AI Colleague Implementation Plan

> **For agentic workers:** Inline execution in this session.

**Goal:** Zotero plugin with selection translate/explain/chat, KaTeX, CLI OAuth (Codex+Grok) + API key fallback.

**Architecture:** Thin Zotero UI over pure TS auth + OpenAI-compatible / Codex Responses clients. Credential source of truth remains CLI auth files.

**Tech Stack:** TypeScript, zotero-plugin-scaffold, zotero-plugin-toolkit, KaTeX, marked, Node test runner for auth.

## Global Constraints

- Port auth behavior from `/home/jin/Documents/PDFMathTranslate/pdf2zh/auth/*` (no new OAuth UI).
- Do not log access/refresh tokens.
- firefox115 target; Zotero 7+.

## Tasks

### Task 1: Project identity + prefs

### Task 2: Auth modules + Node tests

### Task 3: LLM clients + router

### Task 4: Side panel UI + selection + KaTeX

### Task 5: Build XPI + live smoke

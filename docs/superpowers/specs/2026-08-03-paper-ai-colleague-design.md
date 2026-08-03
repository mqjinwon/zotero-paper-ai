# Paper AI Colleague (Zotero) — Design

**Date:** 2026-08-03  
**Status:** Approved (Option B, auth = CLI OAuth + API key fallback)  
**Reference:** Moonlight UX goals; PDFMathTranslate `pdf2zh/auth/*` for credential reuse

## Goals

- Integrated Zotero plugin (single side panel + selection actions): translate, explain, chat, KaTeX math rendering.
- Auth v1:
  1. **CLI OAuth reuse** — `~/.codex/auth.json` (ChatGPT/Codex), `~/.grok/auth.json` (xAI OIDC).
  2. **API key fallback** — Grok `GROK`/prefs key; optional OpenAI API key path later.
- No in-app browser OAuth UI in v1. User runs `codex login` / `grok login` once.
- Refresh tokens write back to CLI auth files so CLIs stay in sync (file lock).

## Non-goals (MVP / still deferred)

- MinerU / DocLayout auto equation hover overlays (full page layout engine)
- Smart citation cards, auto-highlight novelty/method
- Multi-PDF RAG index service

## Phase 2 (shipped)

- Figure / region explain via vision (Grok multimodal `image_url`)
- Equation explain: image crop and/or broken selection text → LaTeX + KaTeX render path
- Pane + Tools menu actions; file-picker fallback when PDF snapshot unavailable
- Codex degrades with clear error on image modes (text-only Responses path)

## Architecture

```
Zotero Reader selection / pane
        │
        ▼
  src/ui/*  (toolbar actions, side panel, KaTeX)
        │
        ▼
  src/llm/router.ts  →  codexClient | grokClient
        │
        ▼
  src/auth/*  (load → refresh if needed → save)
        │
   ~/.codex/auth.json | ~/.grok/auth.json | prefs API key
```

### Auth (port of PDFMathTranslate)

| Provider | File | Refresh | Call |
|----------|------|---------|------|
| Codex | `~/.codex/auth.json` | `POST https://auth.openai.com/oauth/token` client_id `app_EMoamEEZ73f0CkXaXp7hrann` | `POST https://chatgpt.com/backend-api/codex/responses` SSE |
| Grok | prefs/env key first; else `~/.grok/auth.json` | OIDC `token_endpoint` (default `https://auth.x.ai/oauth2/token`) | `https://api.x.ai/v1/chat/completions` |

Errors instruct `codex login` / `grok login`. No silent use of stale access after failed refresh.

### LLM routing

- Pref `provider`: `grok` | `openai-codex`
- Pref `model`: provider default (`grok-2-1212` / `gpt-5.4` overridable)
- Pref `grokApiKey`: if non-empty, skip OAuth for Grok
- Pref `codexAuthPath` / `grokAuthPath`: empty → home defaults

### UI MVP

1. **Reader item pane section** — Chat history, input, mode chips (translate/explain/chat), math-rendered Markdown.
2. **Selection actions** — On text selection in reader: translate / explain (inject selection + page context into pane).
3. **Prefs** — provider, model, API key, auth paths, Test connection.
4. **Save to note** — Append last answer as child note on the item.

### Math rendering

- Stream/final Markdown; normalize `\(...\)` / `\[...\]` → `$` / `$$` where needed.
- Render with KaTeX in pane; fallback to raw LaTeX on error.
- System prompts: preserve math as `$...$` / `$$...$$`.

## Testing

- Node unit tests for auth load/refresh/save (temp files, mocked fetch).
- Live smoke (optional): real `~/.grok` / `~/.codex` short completion (no token logging).
- `npm run build` produces installable `.xpi`.

## Success criteria (MVP)

1. With valid `~/.grok/auth.json` (or API key), translate selection works in Zotero.
2. With valid `~/.codex/auth.json`, Codex path works.
3. Answers with math render as KaTeX.
4. Build passes; auth unit tests pass.

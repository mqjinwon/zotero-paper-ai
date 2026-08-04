# Paper AI Colleague

AI co-reader for Zotero 7–9 PDF tabs: translate, explain, chat, paper summary, RAG cites, and auto-highlights.

**Addon ID:** `paper-ai@mqjinwon.github.io`  
**Repo:** [mqjinwon/zotero-paper-ai](https://github.com/mqjinwon/zotero-paper-ai)

## Features

| Feature              | What it does                                      |
| -------------------- | ------------------------------------------------- |
| **Translate**        | Fast selection translate (no RAG)                 |
| **Explain / Figure** | Selection or area → sticky note on the PDF        |
| **Chat**             | Paper Q&A with RAG; history syncs as a child note |
| **Summary**          | 3–5 bullet paper summary (synced note)            |
| **Auto-highlight**   | 4-class claim/method/novelty/caveat annotations   |
| **Cites**            | Inline `[§Section ¶n s…]` links jump in the PDF   |

## Install

1. Download `paper-ai-colleague-vX.Y.Z.xpi` from [Releases](https://github.com/mqjinwon/zotero-paper-ai/releases).
2. Zotero → Tools → Plugins → Install Add-on From File.
3. Restart Zotero.

Auth (once): `grok login` and/or `codex login` (or set a Grok API key in prefs).

## Quick start

1. Open a PDF in the **built-in reader**.
2. Open the item pane **Paper AI** section.
3. Drag text → translate / explain; use the panel for summary, auto-highlight, and chat.

Full guides: [docs/USAGE_en.md](docs/USAGE_en.md) · [docs/USAGE_kr.md](docs/USAGE_kr.md)

## Data & sync

| Data                    | Storage                                           | Sync                |
| ----------------------- | ------------------------------------------------- | ------------------- |
| Chat / sticky / summary | Child notes (`paper-ai-*` tags)                   | Zotero library sync |
| Auto-highlights         | PDF annotations (`paper-ai-auto`)                 | Zotero library sync |
| RAG index               | `{Zotero data dir}/paperai/rag/` (pref `dataDir`) | Local cache only    |
| OAuth / API keys        | `~/.grok`, `~/.codex`, prefs                      | Device-local        |

## Dev

```bash
npm install
npm run verify       # lint + unit tests + build (same as CI; also pre-push hook)
npm run deploy:local # build → default profile XPI
# Restart Zotero
```

`npm install` sets `core.hooksPath` to `.githooks` so **`git push` runs `npm run verify` first**.

| Path           | Role                                 |
| -------------- | ------------------------------------ |
| `src/llm/`     | Prompts, Grok/Codex, translate       |
| `src/rag/`     | Extract, chunk, BM25, auto-highlight |
| `src/ui/`      | Panel, stickies, reader events       |
| `src/auth/`    | CLI OAuth reuse                      |
| `src/storage/` | Item-note persistence                |

License: AGPL-3.0-or-later. See [SECURITY.md](SECURITY.md).

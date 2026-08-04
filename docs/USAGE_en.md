# Paper AI Colleague — Usage (English)

## 1. One-time setup

### Auth

```bash
grok login    # recommended (vision / figures)
codex login   # optional (ChatGPT text)
```

Files: `~/.grok/auth.json`, `~/.codex/auth.json`.  
Or: **Edit → Settings → Paper AI Colleague** → Grok API key.

### Install

- **Release:** download XPI → Tools → Plugins → Install from file → restart.
- **Dev:** `npm install && npm run deploy:local` → restart Zotero.

## 2. Open the panel

1. Open a PDF with Zotero’s **built-in reader** (not an external viewer).
2. Select the parent item (or keep the PDF tab focused).
3. Right **item pane** → section **Paper AI**.

## 3. Everyday actions

### Translate / explain (on the PDF)

1. Drag-select text.
2. Use the selection popup: **Translate** or **Explain**.
3. Explain opens a **sticky** on the PDF (drag, collapse with `—`, close with `×`).

### Figure

1. Select Area / image annotation on the PDF.
2. Use **Figure explain** (context menu / sidebar, depending on build).
3. Needs **Grok** (or another vision-capable setup).

### Paper summary (panel top)

1. Click **Generate summary**.
2. Get 3–5 Markdown bullets grounded in RAG.
3. Stored as a child note tagged `paper-ai-summary` (library sync).

### Auto-highlight

1. Scroll the PDF so pages load (text layer ready).
2. Click **Generate**.
3. PDF annotations appear in four classes (defaults):

| Class | Default style | Meaning |
| ----- | ------------- | ------- |
| Claim / result | Yellow highlight | Main claims, results |
| Method / definition | Blue underline | How / definitions |
| Novelty | Green highlight | Contributions |
| Caveat | Rose underline | Limitations, assumptions |

4. List actions: **Go** / **Delete** one · **Clear all** (only `paper-ai-auto` tags).
5. Prefs: max count, colors, highlight vs underline per class.

Re-generate after changing colors (old autos keep old colors until cleared).

### Chat

1. Type a question → **Send** (Enter; Shift+Enter = newline).
2. Answers may include `[§Introduction ¶2 s3]` links — click to jump.
3. History is a child note (`paper-ai-chat`), not a dump of the evidence list.
4. **Clear chat** wipes the stored history for this paper.

### PDF sticky overlay

| Button | Effect |
| ------ | ------ |
| Hide on PDF | Overlay cards/connectors off; list kept |
| Show on PDF | Overlay on again |
| Collapse / expand all | Fold cards only |
| List row click | Show overlay + focus that sticky |

### Index (RAG)

- **Index this paper** builds a local BM25 cache under the data directory.
- First chat/summary/auto-highlight may index automatically.
- Cache is **local**; rebuild is cheap.

## 4. Settings (summary)

**Edit → Settings → Paper AI Colleague**

- **Data directory:** empty = `{Zotero data dir}/paperai` (RAG only).
- **Target language:** output language (default often `ko` or set as you like).
- Provider / model / reasoning (global + per feature).
- **Auto-highlight:** totals, per-category caps, colors, types.
- **RAG:** BM25 by default; optional embeddings key for hybrid.

## 5. Sync

- Notes + annotations → **Zotero library sync**.
- RAG folder → not WebDAV file sync; optional folder sync if you point `dataDir` at a shared path.
- Secrets stay out of library notes.

## 6. Troubleshooting

| Symptom | Try |
| ------- | --- |
| Empty panel / no buttons | Restart after deploy; check addon enabled |
| Index / extract fail | Open PDF tab; need a text layer (not pure scan) |
| Auto-highlight wrong place | Clear all → scroll pages → Generate again |
| Auto-highlight save fail | Update to a build that sends annotation `key` (Zotero 9) |
| No vision | Use Grok OAuth/API |
| Debug | **Copy diagnostics** → paste into an issue/chat |

## 7. Tags (for power users)

| Tag | Meaning |
| --- | ------- |
| `paper-ai-chat` | Chat history note |
| `paper-ai-sticky` | Sticky JSON note |
| `paper-ai-summary` | Summary note |
| `paper-ai-auto` | Auto-highlight annotations |
| `paper-ai-auto/{claim\|method\|novelty\|caveat}` | Class |

Manual highlights without these tags are never bulk-deleted by **Clear all**.

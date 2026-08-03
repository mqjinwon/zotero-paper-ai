# AGENTS.md — Paper AI (zotero-plugins)

Compact facts for coding agents. Prose to user: Korean; code/comments/IDs: English.

## Product map

| Mode | Entry | RAG | Sticky | LLM path |
|------|--------|-----|--------|----------|
| translate | selection popup / panel | no | no | **`fastTranslate` only** |
| explain | selection / panel | yes | yes | `runTask` + prompts |
| chat | panel | yes | no | `runTask` + history |
| figure-explain | area select / ann button | yes + caption merge | yes | vision `runTask` |

- **Never** `runTask({ mode: "translate" })` — throws. Type `PromptMode = Exclude<TaskMode,"translate">`.
- `TaskMode` still includes `"translate"` for prefs/UI only.

## Hard-won UI / PDF rules

1. **Stickies mount on reader shell** (`reader._iframeWindow`), not nested PDF.js — selection/copy works.
2. **Region outline**: paint **inside PDF page `div`** (absolute, p2v via `convertToViewportPoint`). Shell SVG desyncs with left/right panels.
3. **Connector lines**: shell SVG; anchors via page rects + `mozInnerScreenX` cross-iframe map. Scroll: all docs + PDF.js `eventBus` + interval.
4. **Cite click**: `event.target` may be **Text node** → use `parentElement` then `closest`. Wire panel root click **and** mousedown.
5. **Navigate page**: `reader.navigate({ pageIndex })` (0-based) first; then PDF.js `currentPageNumber` / `scrollPageIntoView` with Xray waive. Links: HTML `<a class="paperai-cite" data-page data-preview href="#paperai-page-N">` — not MD titles (quotes break).
6. **Markdown paint**: `setMarkdownHtml` = DOMParser + `importNode` (item-pane rejects naive `innerHTML` for tables).
7. **Enrich pages** before footer: search + Body(n) heuristic; **do not rewrite `e.cite`** (must stay `[§Body (1)]` for linkify).

## RAG

- Index: `~/.paperai/rag/`; policy bump rebuilds (`CHUNK_POLICY`).
- Prefer PDF.js per-page extract when reader open (page map for cites). Fulltext alone → no `pageStart`.
- Stuff short papers; else BM25/hybrid. Footer via `withEvidenceAnswer` after stream ends.
- Figure: `figureContext` captions/discussions + `attachRagContext`.

## Prompts (`src/llm/prompts.ts`)

- Role: **research co-reader**, paper-grounded, cite `[§…]`, LaTeX preserved.
- Explain: what / why here / assumptions.
- Figure: name fig, axes, **claim in paper**.
- Chat: answer first, short, evidence or say missing.
- Translate: tiny `FAST_SYSTEM` in `fastTranslate.ts` only.
- **targetLang**: global pref only (`extensions.zotero.paperai.targetLang`, default `ko`).

## Data / local deploy

```
~/.paperai/{chat,sticky,rag}/
npm run deploy:local  → <profile>/extensions/<addonID>.xpi
Restart Zotero after deploy
```

- Public **addonID**: `paper-ai@mqjinwon.github.io` (`package.json` → manifest).
- **Repo** (recommended): `mqjinwon/zotero-paper-ai`.

- Panel: 노트 저장 = last answer → Zotero note; 진단 로그 = `diag` ring buffer clipboard.
- Sticky JSON can hold image thumb (capped); connectors need `pdfLocation.position.rects`.

## Git & GitHub (XPI public release)

How most Zotero plugins (template / scaffold) ship XPI — **not** by committing `.xpi` to `main`.

### What users see on GitHub Releases

| Asset | Role |
|-------|------|
| `*.xpi` | Installable plugin (per version tag `vX.Y.Z`) |
| Release notes | Changelog for that version |
| Special tag **`release`** | Holds **`update.json`** / **`update-beta.json`** only (auto-update manifests) |

URLs (this repo’s `zotero-plugin.config.ts`):

- XPI: `…/releases/download/v{{version}}/{{xpiName}}.xpi`
- Updates: `…/releases/download/release/update.json` (stable) or `update-beta.json` (prerelease)

### Standard flow (this repo)

```
1) Work on branch → PR → merge main
2) On clean main:  npm run release
     = bumpp: bump package.json version → commit → tag vX.Y.Z → push tag
3) Tag push triggers .github/workflows/release.yml
     = npm run build  then  npm run release (scaffold publish)
4) CI creates/updates GitHub Release + uploads XPI (+ updates the `release` tag manifests)
```

- Workflow: `.github/workflows/release.yml` → reusable `zotero-plugin-dev/workflows/.../release-plugin.yml`
- Needs `permissions: contents: write` (and issues/PR write for release comments).
- **Do not** hand-upload only an XPI and forget version/`update.json` — Zotero auto-update depends on manifests.
- **Do not** commit `.scaffold/build/*.xpi` into git; CI builds artifacts.
- Local dev: `npm run deploy:local` (auto profile + same public addonID).

### Version / prerelease

- Stable: `1.2.3` → `update.json` (and usually refresh beta manifest too).
- Prerelease: `1.2.3-beta.1` (has `-`) → **`update-beta.json`** so stable users are not force-updated to beta.
- Bump **only** via release tooling (or keep `package.json` version = git tag `v…`).

### Agent rules (git / release)

| Do | Don’t |
|----|--------|
| Feature work: **branch + PR** to `main` | Force-push `main` / rewrite published tags |
| Release from **up-to-date `main`**, green CI | Release from dirty tree / random feature branch |
| Use **`npm run release`** (tag-driven CI) | Manually invent version without tag/workflow |
| Real `addonID` + `repository` in `package.json` | Placeholder `@local.dev` / `github.com/local` |
| Confirm Release has XPI + notes | Assume local XPI == published |
| Secrets only in prefs / `~/.grok` / CI secrets | Commit keys, auth.json, or log tokens |

### Manual emergency publish (last resort)

If CI broken: `npm run build` → GitHub → Releases → tag `vX.Y.Z` → upload `.scaffold/build/*.xpi` + run scaffold release steps so **`release`/`update*.json`** stay consistent. Prefer fixing CI over manual forever.

### Checklist before first public release

1. `package.json`: version, repository, homepage, addonID (`paper-ai@mqjinwon.github.io`)
2. Create empty GitHub repo **`zotero-paper-ai`** under `mqjinwon` (or rename package URLs)
3. `git remote add origin …` → push `main` → enable Actions
4. README install → Releases; no secrets in tree (`rg` for sk-/xai-/ghp_)
5. `npm run release` → tag → green workflow → XPI on Release page

### Security (public)

- Never commit: `.env`, `auth.json`, API keys, `*.xpi` (build artifact).
- OAuth lives in `~/.grok` / `~/.codex` only; prefs keys stay in Zotero profile.
- `diag` / 진단 로그: no tokens; paper titles OK.
- See `SECURITY.md`.

## Don’t (product)

- Remount stickies inside PDF.js content for “coords” — breaks copy.
- Put region boxes only on shell SVG.
- Use MD link titles for previews with `"` / `)`.
- Call `buildSystemPrompt("translate")` / dead dual translate path.
- Invent equation mode (removed).

## Touch points

`paperTask` · `prompts` · `fastTranslate` · `router` · `rag/*` · `stickyNotes` · `markdown` · `panel` · `readerEvents` · `readerFigure` · `imageCapture` · `.github/workflows/release.yml` · `zotero-plugin.config.ts`

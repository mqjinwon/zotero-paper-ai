# AGENTS.md — Paper AI (zotero-plugins)

Compact facts for coding agents. Prose to user: Korean; code/comments/IDs: English.

## Product map

| Mode           | Entry                    | RAG                 | Sticky | LLM path                 |
| -------------- | ------------------------ | ------------------- | ------ | ------------------------ |
| translate      | selection popup / panel  | no                  | no     | **`fastTranslate` only** |
| explain        | selection / panel        | yes                 | yes    | `runTask` + prompts      |
| chat           | panel                    | yes                 | no     | `runTask` + history      |
| figure-explain | area select / ann button | yes + caption merge | yes    | vision `runTask`         |

- **Never** `runTask({ mode: "translate" })` — throws. Type `PromptMode = Exclude<TaskMode,"translate">`.
- `TaskMode` still includes `"translate"` for prefs/UI only.

## Hard-won UI / PDF rules

1. **Stickies mount on reader shell** (`reader._iframeWindow`), not nested PDF.js — selection/copy works.
2. **Region outline**: paint **inside PDF page `div`** (absolute, p2v via `convertToViewportPoint`). Shell SVG desyncs with left/right panels.
3. **Connector lines**: shell SVG; anchors via page rects + `mozInnerScreenX` cross-iframe map. Scroll: all docs + PDF.js `eventBus` + interval.
4. **Cite click**: `event.target` may be **Text node** → use `parentElement` then `closest`. Wire panel root click **and** mousedown.
5. **Cite navigate (official first)**: `reader.navigate({ pageIndex, position: { pageIndex, rects } })` — same Location contract as sticky. Then flash rects. Fallback: quote locate → page-only. Links: post-hoc phrase anchors whose `data-preview` is a **real paper sentence** (`groundAnswerToPaper`), not RAG cite ids.
6. **Markdown paint**: `setMarkdownHtml` = DOMParser + `importNode` (item-pane rejects naive `innerHTML` for tables).
7. **Ground after answer**: extract claim spans → match paper sentences (BM25 + token overlap gate) → link only when score high; jump needle = paper sentence.

## RAG

- Index: `{dataDir}/rag/` (default `{Zotero.DataDirectory}/paperai/rag`); policy bump rebuilds (`CHUNK_POLICY`).
- Chunk policy `section-para-sent-v5`. RAG supplies **reading context** only; links are **not** pre-built evidence slots.
- Auto-highlight: `src/rag/autoHighlight/*` — 4 classes (claim/method/novelty/caveat), tags `paper-ai-auto`, Zotero Annotations.saveFromJSON.
- Prefer PDF.js per-page extract when reader open (page map for cites). Fulltext alone → weaker `pageStart`.
- Stuff short papers: full parent context for the model. Else BM25/hybrid passages for context.
- Answers: free prose → **post-hoc paper-sentence grounding** (`src/rag/groundAnswer.ts`) + optional evidence tray.
- Figure: `figureContext` captions/discussions + `attachRagContext`.

## Prompts (`src/llm/prompts.ts`)

- Role: **research co-reader**, paper-grounded free prose, LaTeX preserved.
- No model cite ids / `#cite-N` protocol — grounding is post-hoc.
- Explain: what / why here / assumptions.
- Figure: name fig, axes, **claim in paper**.
- Chat: answer first, short, evidence or say missing.
- Translate: tiny `FAST_SYSTEM` in `fastTranslate.ts` only.
- **targetLang**: global pref only (`extensions.zotero.paperai.targetLang`, default `ko`).

## Data / local deploy

```
Chat/sticky → parent child notes (tags paper-ai-chat / paper-ai-sticky)
              encode: src/storage/itemNoteStore.ts → Zotero library sync
RAG cache   → {dataDir}/rag/  (pref dataDir empty = DataDirectory/paperai)
Legacy file → read once, migrate into notes
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

| Asset                     | Role                                                                          |
| ------------------------- | ----------------------------------------------------------------------------- |
| `*.xpi`                   | Installable plugin (per version tag `vX.Y.Z`)                                 |
| Release notes             | English notes from **`CHANGELOG.md`** for that version (auto-applied in CI)   |
| Special tag **`release`** | Holds **`update.json`** / **`update-beta.json`** only (auto-update manifests) |

URLs (this repo’s `zotero-plugin.config.ts`):

- XPI: `…/releases/download/v{{version}}/paper-ai-colleague-v{{version}}.xpi` (`xpiName` in `zotero-plugin.config.ts`)
- Updates: `…/releases/download/release/update.json` (stable) or `update-beta.json` (prerelease)

### Changelog (English, required for releases)

- Source of truth: repo root **`CHANGELOG.md`** ([Keep a Changelog](https://keepachangelog.com/) style).
- Before cutting a release: move items from `## [Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD` and update compare links at the bottom.
- Extract notes: `node scripts/extract-changelog.mjs 0.1.2` (or `v0.1.2`).
- On tag push, workflow job **Changelog → release notes** runs `gh release edit` with that section so the GitHub Release body is never `_No significant changes._`.

### Standard flow (this repo)

```
1) Work on branch → PR → merge main
2) Edit CHANGELOG.md (Unreleased → version section, English)
3) On clean main:  npx zotero-plugin release patch -y   # or minor / major
     = bumpp: bump package.json version → commit → tag vX.Y.Z → push tag
4) Tag push triggers .github/workflows/release.yml
     = build + scaffold publish XPI
     = then set Release body from CHANGELOG.md
```

- Workflow: `.github/workflows/release.yml` → reusable release-plugin + `release-notes` job.
- Needs `permissions: contents: write` (and issues/PR write for release comments).
- **Do not** hand-upload only an XPI and forget version/`update.json` — Zotero auto-update depends on manifests.
- **Do not** commit `.scaffold/build/*.xpi` into git; CI builds artifacts.
- Local dev: `npm run deploy:local` (auto profile + same public addonID).

### Version / prerelease

- Stable: `1.2.3` → `update.json` (and usually refresh beta manifest too).
- Prerelease: `1.2.3-beta.1` (has `-`) → **`update-beta.json`** so stable users are not force-updated to beta.
- Bump **only** via release tooling (or keep `package.json` version = git tag `v…`).

### Agent rules (git / release)

| Do                                              | Don’t                                           |
| ----------------------------------------------- | ----------------------------------------------- |
| Feature work: **branch + PR** to `main`         | Force-push `main` / rewrite published tags      |
| Release from **up-to-date `main`**, green CI    | Release from dirty tree / random feature branch |
| Use **`npm run release`** (tag-driven CI)       | Manually invent version without tag/workflow    |
| Real `addonID` + `repository` in `package.json` | Placeholder `@local.dev` / `github.com/local`   |
| Confirm Release has XPI + notes                 | Assume local XPI == published                   |
| Secrets only in prefs / `~/.grok` / CI secrets  | Commit keys, auth.json, or log tokens           |

### Manual emergency publish (last resort)

If CI broken: `npm run build` → GitHub → Releases → tag `vX.Y.Z` → upload `.scaffold/build/*.xpi` + run scaffold release steps so **`release`/`update*.json`** stay consistent. Prefer fixing CI over manual forever.

### Local CI before push

```bash
npm run verify   # lint:check + test:node + build  (= GitHub CI surface)
```

- `.githooks/pre-push` runs `verify` (enabled via `npm install` → `prepare` → `core.hooksPath`).
- Skip once: `git push --no-verify` (prefer fixing instead).

### Checklist before first public release

1. `package.json`: version, repository, homepage, addonID (`paper-ai@mqjinwon.github.io`)
2. Create empty GitHub repo **`zotero-paper-ai`** under `mqjinwon` (or rename package URLs)
3. `git remote add origin …` → push `main` → enable Actions
4. README install → Releases; no secrets in tree (`rg` for sk-/xai-/ghp\_)
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

/**
 * Evidence formatting for LLM *reading* context (not cite-id catalogs).
 * Answer hyperlinks are post-hoc paper-sentence grounding — see groundAnswer.ts.
 */

import { formatLocator } from "./chunk";
import { groundAnswerToPaper } from "./groundAnswer";
import type { IndexedChunk, RetrievedEvidence } from "./types";

/** Stable evidence id for the model + UI, e.g. [1]. */
export function evidenceId(index0: number): string {
  return `[${index0 + 1}]`;
}

/** Legacy model form still accepted as alias of evidenceId. */
export function evidenceIdLegacyE(index0: number): string {
  return `[E${index0 + 1}]`;
}

/** Stamp sequential [1]… cites onto evidence (mutates). */
export function stampEvidenceIds(
  evidence: RetrievedEvidence[],
): RetrievedEvidence[] {
  for (let i = 0; i < evidence.length; i++) {
    evidence[i].cite = evidenceId(i);
  }
  return evidence;
}

/** Locator suffix for optional human meta only: " ¶2 s3". */
export function locatorSuffix(c: IndexedChunk): string {
  let s = "";
  if (c.paraStart != null) {
    if (c.paraEnd != null && c.paraEnd !== c.paraStart) {
      s += ` ¶${c.paraStart}–${c.paraEnd}`;
    } else {
      s += ` ¶${c.paraStart}`;
      if (
        c.sentStart != null &&
        (c.paraEnd == null || c.paraEnd === c.paraStart)
      ) {
        if (c.sentEnd != null && c.sentEnd !== c.sentStart) {
          s += ` s${c.sentStart}–${c.sentEnd}`;
        } else {
          s += ` s${c.sentStart}`;
        }
      }
    }
  }
  return s;
}

/**
 * Legacy section-style cite (aliases / tests / old history).
 * New retrieval paths use evidenceId via stampEvidenceIds.
 */
export function citeOf(c: IndexedChunk): string {
  const section = c.section.startsWith("§") ? c.section : `§${c.section}`;
  const loc = locatorSuffix(c);
  const pages =
    c.pageStart != null
      ? c.pageEnd != null && c.pageEnd !== c.pageStart
        ? ` p.${c.pageStart}–${c.pageEnd}`
        : ` p.${c.pageStart}`
      : "";
  return `[${section}${loc}${pages}]`;
}

/** Section-only form for legacy aliases. */
export function citeBareSection(c: IndexedChunk): string {
  const section = c.section.startsWith("§") ? c.section : `§${c.section}`;
  return `[${section}]`;
}

/**
 * Reading context for the LLM only — no cite-id catalog.
 * Links are attached later by groundAnswerToPaper against real paper sentences.
 */
export function formatContextBlock(
  evidence: RetrievedEvidence[],
  title: string,
  opts?: { fullPaper?: string },
): string {
  if (!evidence.length && !opts?.fullPaper?.trim()) return "";
  // Keep ids for internal bookkeeping only (not for model citation protocol)
  stampEvidenceIds(evidence);
  const lines = [
    `Paper: ${title}`,
    "Answer using only the paper text below. Be precise and paper-grounded.",
    "Do **not** insert bibliography markers like [1], [2], [E1], or §Body locators.",
    "Do **not** invent markdown cite links. Write plain prose (bullets OK).",
    "",
  ];
  if (opts?.fullPaper?.trim()) {
    lines.push("Full paper context:");
    lines.push(opts.fullPaper.trim());
    lines.push("");
  }
  if (evidence.length && !opts?.fullPaper?.trim()) {
    lines.push("Relevant passages from the paper:");
    lines.push("");
    evidence.forEach((e, i) => {
      const loc = e.chunk ? formatLocator(e.chunk) : "";
      lines.push(`### Passage ${i + 1}${loc ? ` (${loc})` : ""}`);
      const body = (e.contextText || e.chunk?.text || "").trim();
      const short =
        body.length > 1200 ? `${body.slice(0, 1200).trim()}…` : body;
      lines.push(short);
      lines.push("");
    });
  } else if (evidence.length && opts?.fullPaper?.trim()) {
    // full paper already included — optional short focus snippets omitted to avoid id catalog
  }
  lines.push(
    "If the paper text is insufficient for the question, say what is missing.",
  );
  return lines.join("\n");
}

export interface CiteLink {
  /** Primary key as model sees it, e.g. [1] */
  cite: string;
  /** Inner text without brackets, e.g. "1" */
  label: string;
  pageStart?: number;
  pageEnd?: number;
  /**
   * Sentence-level needle for PDF text locate (auto-HL algorithm).
   */
  preview: string;
  /** PDF user-space rects when known (0-based page via pageStart-1). */
  rects?: number[][];
  /** Section / locator for hover */
  meta?: string;
  /** Legacy § labels and variants for old answers. */
  aliases?: string[];
}

/** Prefer first 1–2 sentences as a locate needle (min ~24 alnum for auto-HL). */
export function citePreview(text: string, max = 320): string {
  const t = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  const m = t.match(/^(.+?[.!?])(?:\s+|$)/);
  if (m && m[1].length >= 40 && m[1].length <= max) {
    if (m[1].length < 80 && t.length > m[1].length + 10) {
      const rest = t.slice(m[1].length).trim();
      const m2 = rest.match(/^(.+?[.!?])(?:\s+|$)/);
      const two = m2 ? `${m[1]} ${m2[1]}` : `${m[1]} ${rest}`;
      return two.slice(0, max).trim();
    }
    return m[1].trim();
  }
  return t.slice(0, max);
}

function escapeHtml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hrefFor(c: CiteLink): string {
  if (c.pageStart != null) return `#paperai-page-${c.pageStart}`;
  return c.preview ? "#paperai-search" : "#paperai-cite";
}

/** Encode rects for data-rects (cap size). */
export function encodeRectsAttr(rects?: number[][] | null): string {
  if (!rects?.length) return "";
  const capped = rects
    .slice(0, 6)
    .map((r) => r.slice(0, 4).map((n) => Math.round(Number(n) * 100) / 100));
  try {
    return JSON.stringify(capped);
  } catch {
    return "";
  }
}

export function parseRectsAttr(
  raw: string | null | undefined,
): number[][] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return undefined;
    const out: number[][] = [];
    for (const item of v) {
      if (
        Array.isArray(item) &&
        item.length >= 4 &&
        item.every((n) => typeof n === "number" && Number.isFinite(n))
      ) {
        out.push(item.slice(0, 4) as number[]);
      }
    }
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Deduped cite metadata for footer + body linkify. */
export function uniqueCiteLinks(evidence: RetrievedEvidence[]): CiteLink[] {
  const out: CiteLink[] = [];
  const seen = new Set<string>();
  evidence.forEach((e, i) => {
    const key = e.cite || evidenceId(i);
    if (!key || seen.has(key)) return;
    seen.add(key);

    const section = e.chunk?.section
      ? e.chunk.section.startsWith("§")
        ? e.chunk.section
        : `§${e.chunk.section}`
      : "";
    const legacy = e.chunk ? citeOf(e.chunk) : "";
    const bareSection = section ? `[${section}]` : "";
    const withLoc =
      section && e.chunk ? `[${section}${locatorSuffix(e.chunk)}]` : "";
    // Accept [E1] as alias of [1]
    const n = Number(String(key).replace(/[^0-9]/g, ""));
    const eAlias = Number.isFinite(n) && n >= 1 ? evidenceIdLegacyE(n - 1) : "";
    const aliases = [legacy, bareSection, withLoc, eAlias].filter(
      (a) => a && a !== key && !seen.has(a),
    ) as string[];
    for (const a of aliases) seen.add(a);

    const previewSrc =
      e.chunk?.anchorText || e.contextText || e.chunk?.text || "";
    const label = key.replace(/^\[/, "").replace(/\]$/, "");
    const meta = e.chunk ? formatLocator(e.chunk) : "";
    out.push({
      cite: key,
      label,
      pageStart:
        e.chunk?.pageStart ??
        (e.pageIndex0 != null ? e.pageIndex0 + 1 : undefined),
      pageEnd: e.chunk?.pageEnd,
      preview: citePreview(previewSrc, 320),
      rects: e.rects,
      meta,
      aliases,
    });
  });
  return out;
}

/** Short default phrase when model only emitted a bare id (fallback). */
export function defaultCitePhrase(c: CiteLink, max = 48): string {
  const t = String(c.preview || "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length >= 8) {
    // Prefer first ~4–8 words / short clause
    const words = t.split(" ");
    if (words.length <= 6 && t.length <= max) return t;
    const cut = words.slice(0, 6).join(" ");
    return cut.length > max ? `${cut.slice(0, max - 1).trim()}…` : cut;
  }
  const num = String(c.label).replace(/^E/i, "");
  return c.meta ? c.meta.split(" · ")[0] || `근거 ${num}` : `근거 ${num}`;
}

/**
 * HTML anchor for a cite.
 * Prefer visibleText = the grounded phrase in the answer (not [1] bibliography markers).
 */
export function htmlCiteLink(
  c: CiteLink,
  opts?: {
    withPageHint?: boolean;
    withSnippet?: boolean;
    /** Linked phrase shown in the answer body */
    visibleText?: string;
    /** tray/chip compact style when no real phrase */
    chip?: boolean;
  },
): string {
  void opts?.withSnippet;
  void opts?.withPageHint;
  const href = hrefFor(c);
  const pageAttr = c.pageStart != null ? ` data-page="${c.pageStart}"` : "";
  const previewAttr = c.preview
    ? ` data-preview="${escapeHtml(c.preview)}"`
    : "";
  const rectsEnc = encodeRectsAttr(c.rects);
  const rectsAttr = rectsEnc ? ` data-rects="${escapeHtml(rectsEnc)}"` : "";
  const eid = c.label.replace(/^E/i, "");
  const eidAttr = eid ? ` data-eid="${escapeHtml(eid)}"` : "";
  const titleParts = [
    c.meta || "",
    c.pageStart != null && !c.meta?.includes(`p.${c.pageStart}`)
      ? `p.${c.pageStart}`
      : "",
    c.preview || "",
  ].filter(Boolean);
  const title = escapeHtml(titleParts.join(" · ").slice(0, 400));
  const phrase = (opts?.visibleText || "").replace(/\s+/g, " ").trim();
  const visible = phrase
    ? phrase.slice(0, 120)
    : defaultCitePhrase(c, opts?.chip ? 28 : 48);
  const isChip = !!opts?.chip || (!phrase && visible.length <= 12);
  const cls = isChip
    ? "paperai-cite paperai-cite-chip"
    : "paperai-cite paperai-cite-phrase";
  return (
    `<a class="${cls}" href="${href}" title="${title}"` +
    `${eidAttr}${pageAttr}${previewAttr}${rectsAttr}>${escapeHtml(visible)}</a>`
  );
}

/** @deprecated use htmlCiteLink */
export function mdCiteLink(
  c: CiteLink,
  opts?: { withPageHint?: boolean },
): string {
  return htmlCiteLink(c, opts);
}

/**
 * Collapsible evidence tray under the answer.
 * Each row links a short phrase (not a bare [n] marker).
 */
export function evidenceTray(evidence: RetrievedEvidence[]): string {
  const links = uniqueCiteLinks(evidence);
  if (!links.length) return "";
  const items = links.map((c) => {
    const q =
      c.preview.length > 160
        ? `${c.preview.slice(0, 159).trim()}…`
        : c.preview || "(발췌 없음)";
    const meta = c.meta
      ? ` <span class="pai-cite-meta">${escapeHtml(c.meta)}</span>`
      : "";
    return `<li>${htmlCiteLink(c, { visibleText: defaultCitePhrase(c, 40) })}${meta} — ${escapeHtml(q)}</li>`;
  });
  return [
    `<details class="paperai-evidence-tray">`,
    `<summary>근거 ${links.length}</summary>`,
    `<ol class="paperai-evidence-list">`,
    ...items,
    `</ol>`,
    `</details>`,
  ].join("\n");
}

/**
 * Optional list of all retrieved cites (legacy text footer).
 */
export function evidenceFooter(evidence: RetrievedEvidence[]): string {
  const links = uniqueCiteLinks(evidence);
  if (!links.length) return "";
  const lines = [
    "근거 (문구 클릭 → PDF 해당 문장 · 호버 시 발췌):",
    ...links.map((c) => {
      const tail =
        c.preview.length >= 120 ? `${c.preview}…` : c.preview || "(발췌 없음)";
      return `- ${htmlCiteLink(c, { visibleText: defaultCitePhrase(c, 40) })} — ${escapeHtml(tail)}`;
    }),
  ];
  return lines.join("\n");
}

/**
 * Collapse adjacent identical cite markers: [1][1] → [1], [E2] [E2] → [E2].
 */
export function dedupeAdjacentCites(text: string): string {
  if (!text) return text;
  return text.replace(/(\[(?:E)?\d+\])(?:\s*\1)+/gi, "$1");
}

function buildCiteMap(links: CiteLink[]): Map<string, CiteLink> {
  const byLabel = new Map<string, CiteLink>();
  for (const c of links) {
    byLabel.set(c.cite, c);
    byLabel.set(c.label, c);
    byLabel.set(c.cite.toLowerCase(), c);
    const n = Number(String(c.label).replace(/^E/i, ""));
    if (Number.isFinite(n) && n >= 1) {
      byLabel.set(String(n), c);
      byLabel.set(`[${n}]`, c);
      byLabel.set(`[E${n}]`, c);
      byLabel.set(`[e${n}]`, c);
      byLabel.set(`E${n}`, c);
    }
    for (const a of c.aliases || []) {
      if (!byLabel.has(a)) byLabel.set(a, c);
      const inner = a.replace(/^\[/, "").replace(/\]$/, "");
      if (!byLabel.has(inner)) byLabel.set(inner, c);
    }
  }
  return byLabel;
}

function resolveCite(
  byLabel: Map<string, CiteLink>,
  n: number,
): CiteLink | undefined {
  return (
    byLabel.get(evidenceId(n - 1)) ||
    byLabel.get(`[E${n}]`) ||
    byLabel.get(String(n))
  );
}

/**
 * Markdown phrase cites → HTML.
 * Accepts: [phrase](#cite-1), [phrase](#e1), [phrase](cite:1), [phrase](#paperai-cite-1)
 */
export function linkifyPhraseMarkdown(
  text: string,
  byLabel: Map<string, CiteLink>,
): string {
  if (!text) return text;
  // [phrase](#cite-1) / [phrase](#e1) / [phrase](cite:1)
  return text.replace(
    /\[([^\]]{1,120})\]\(\s*(?:#(?:cite-|e|paperai-cite-)?|cite:)(\d+)\s*\)/gi,
    (full, phrase: string, nStr: string) => {
      const n = Number(nStr);
      const c = resolveCite(byLabel, n);
      if (!c) return full;
      const p = String(phrase || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!p || /^\[?\d+\]?$/.test(p) || /^E\d+$/i.test(p)) {
        return htmlCiteLink(c, { visibleText: defaultCitePhrase(c) });
      }
      return htmlCiteLink(c, { visibleText: p });
    },
  );
}

/**
 * Bare [1] after a phrase → promote preceding words/phrase into the link.
 * "residual force learning [1]" → linked "residual force learning"
 * Korean: take trailing run of non-punct chars before the marker.
 */
export function promoteBareCitesToPhrases(
  text: string,
  byLabel: Map<string, CiteLink>,
): string {
  if (!text) return text;
  // Prefer: (phrase) + optional space + [n]
  // Phrase: 2–80 chars, no brackets/newlines, not ending mid-HTML
  return text.replace(
    /([^\n[\]<>]{2,80}?)(\s*)\[E?(\d+)\](?!\()/gi,
    (full, before: string, ws: string, nStr: string) => {
      const n = Number(nStr);
      const c = resolveCite(byLabel, n);
      if (!c) return full;

      const raw = String(before);
      // If already ends with our anchor, leave bare id for next pass strip
      if (/<\/a>\s*$/i.test(raw)) {
        return `${raw}${ws}`; // drop bare id next to existing link
      }

      // Take a short tail phrase from `before`
      const trimmed = raw.replace(/\s+$/, "");
      const leadSpace = raw.slice(0, raw.length - trimmed.length);

      // Split on sentence / clause boundaries; keep last clause tail
      const clause =
        trimmed.split(/(?<=[.!?。！？;；:：…])\s+/).pop() || trimmed;
      const prefix = trimmed.slice(0, trimmed.length - clause.length);

      // English: last 2–8 words; Korean/mixed: last 8–48 chars of continuous text
      let phrase = clause.trim();
      const words = phrase.split(/\s+/).filter(Boolean);
      if (words.length >= 2 && /[A-Za-z]/.test(phrase)) {
        phrase = words.slice(-Math.min(8, Math.max(2, words.length))).join(" ");
      } else if (phrase.length > 48) {
        phrase =
          phrase
            .slice(-48)
            .replace(/^\S*\s+/, "")
            .trim() || phrase.slice(-40);
      }
      // Drop leading bullets/list junk
      phrase = phrase.replace(/^[\s·•\-*–—]+/, "").trim();
      if (phrase.length < 2) {
        return `${raw}${ws}${htmlCiteLink(c, { visibleText: defaultCitePhrase(c) })}`;
      }

      // Reconstruct: prefix of clause stays unlinked if we shortened word-wise
      let head = prefix + leadSpace;
      if (words.length >= 2 && /[A-Za-z]/.test(clause)) {
        const all = clause.trim().split(/\s+/).filter(Boolean);
        const used = phrase.split(/\s+/).length;
        if (all.length > used) {
          head =
            prefix +
            all.slice(0, all.length - used).join(" ") +
            " " +
            leadSpace;
        }
      } else if (clause.trim().length > phrase.length) {
        const longer = clause.trim();
        if (longer.endsWith(phrase)) {
          head =
            prefix + longer.slice(0, longer.length - phrase.length) + leadSpace;
        }
      }

      return `${head}${htmlCiteLink(c, { visibleText: phrase })}`;
    },
  );
}

/**
 * Rewrite model cites into phrase hyperlinks:
 * 1) [phrase](#cite-N)  2) bare [N] promoted onto preceding phrase
 * 3) legacy [§…]
 */
export function linkifyBareCites(
  text: string,
  evidence: RetrievedEvidence[],
): string {
  const links = uniqueCiteLinks(evidence);
  if (!text || !links.length) return text;
  let out = dedupeAdjacentCites(text);
  const byLabel = buildCiteMap(links);

  // 1) Preferred: markdown phrase links
  out = linkifyPhraseMarkdown(out, byLabel);

  // 2) Bare [n] → attach to preceding phrase (or default phrase)
  out = promoteBareCitesToPhrases(out, byLabel);

  // 3) Any leftover bare [n] (start of line, etc.) → default phrase link
  out = out.replace(/\[E?(\d+)\](?!\()/gi, (full, nStr: string) => {
    const c = resolveCite(byLabel, Number(nStr));
    if (!c) return full;
    return htmlCiteLink(c, { visibleText: defaultCitePhrase(c) });
  });

  // Legacy § labels (longer first)
  const ordered = [...links].sort(
    (a, b) =>
      Math.max(b.cite.length, ...(b.aliases || []).map((x) => x.length)) -
      Math.max(a.cite.length, ...(a.aliases || []).map((x) => x.length)),
  );
  for (const c of ordered) {
    const keys = [...(c.aliases || [])].filter((k) => k.startsWith("[§"));
    keys.sort((a, b) => b.length - a.length);
    for (const k of keys) {
      const re = new RegExp(escapeRegExp(k) + "(?!\\()", "g");
      out = out.replace(
        re,
        htmlCiteLink(c, { visibleText: defaultCitePhrase(c) }),
      );
    }
  }

  out = out.replace(/\[§([^\]]+)\](?!\()/g, (full, inner: string) => {
    const label = `§${inner}`;
    const base = label.replace(/\s+p\.\d+(?:–\d+)?\s*$/i, "").trim();
    const c =
      byLabel.get(`[${label}]`) ||
      byLabel.get(label) ||
      byLabel.get(`[${base}]`) ||
      byLabel.get(base);
    if (!c) return full;
    return htmlCiteLink(c, { visibleText: defaultCitePhrase(c) });
  });

  return out;
}

/**
 * @deprecated Prefer groundAnswerToPaper (post-hoc paper sentences).
 * Kept for callers that only have evidence chunks — builds a weak sentence list
 * from those chunks and grounds against them.
 */
export function withEvidenceAnswer(
  answer: string,
  evidence: RetrievedEvidence[],
  opts?: { appendFooter?: boolean; appendTray?: boolean },
): { answer: string; ragFooter: string } {
  void opts;
  if (!evidence.length) {
    return { answer, ragFooter: "" };
  }
  // Lazy import avoided: build minimal sentence list from evidence chunks
  const sents = evidence
    .map((e) => {
      const text = (e.chunk?.anchorText || e.chunk?.text || e.contextText || "")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length < 28) return null;
      return {
        text: text.length > 420 ? `${text.slice(0, 419).trim()}…` : text,
        pageStart: e.chunk?.pageStart,
        pageEnd: e.chunk?.pageEnd,
        section: e.chunk?.section,
      };
    })
    .filter(Boolean) as Array<{
    text: string;
    pageStart?: number;
    pageEnd?: number;
    section?: string;
  }>;
  if (!sents.length) {
    const cleaned = String(answer || "")
      .replace(/\[E?\d+\](?!\()/gi, "")
      .replace(/\[§[^\]]+\](?!\()/g, "");
    return { answer: cleaned, ragFooter: "" };
  }
  const g = groundAnswerToPaper(answer || "", sents);
  return { answer: g.answer, ragFooter: g.ragFooter };
}

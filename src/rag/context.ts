/**
 * Evidence formatting + answer linkify.
 * Primary cite form: [E1], [E2], … with a sentence quote needle for PDF locate.
 * Legacy [§Section …] labels still linkify when present (old chats / aliases).
 */

import { formatLocator } from "./chunk";
import type { IndexedChunk, RetrievedEvidence } from "./types";

/** Stable evidence id for the model + UI, e.g. [E1]. */
export function evidenceId(index0: number): string {
  return `[E${index0 + 1}]`;
}

/** Stamp sequential [E1]… cites onto evidence (mutates). */
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
 * Legacy section-style cite (kept for aliases / tests / old history).
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

export function formatContextBlock(
  evidence: RetrievedEvidence[],
  title: string,
): string {
  if (!evidence.length) return "";
  stampEvidenceIds(evidence);
  const lines = [
    `Paper: ${title}`,
    "Evidence passages — cite ONLY with the bracket ids [E1], [E2], … exactly as labeled.",
    "Do not invent §Body-style section locators. Prefer the given Quote needle when referring to a passage.",
    "",
  ];
  evidence.forEach((e, i) => {
    const id = e.cite || evidenceId(i);
    const previewSrc =
      e.chunk?.anchorText || e.contextText || e.chunk?.text || "";
    const quote = citePreview(previewSrc, 280);
    const loc = formatLocator(e.chunk);
    lines.push(`### ${id}`);
    if (quote) lines.push(`Quote: ${quote}`);
    if (loc) lines.push(`Meta: ${loc}`);
    lines.push(e.contextText.trim());
    lines.push("");
  });
  lines.push(
    "Use only the evidence above when possible. If it is insufficient, say what is missing. " +
      "When you rely on a passage, cite its id only (e.g. [E1] or [E2]).",
  );
  return lines.join("\n");
}

export interface CiteLink {
  /** Primary key as model sees it, e.g. [E1] */
  cite: string;
  /** Inner text without brackets */
  label: string;
  pageStart?: number;
  pageEnd?: number;
  /**
   * Sentence-level needle for PDF text locate (auto-HL algorithm).
   */
  preview: string;
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

/** Visible snippet next to evidence id. */
function citeLinkSnippet(preview: string, max = 48): string {
  const t = String(preview || "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length < 12) return "";
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trim()}…`;
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

function pageHint(c: CiteLink): string {
  if (c.pageStart == null) return "";
  if (c.pageEnd != null && c.pageEnd !== c.pageStart) {
    return ` · p.${c.pageStart}–${c.pageEnd}`;
  }
  return ` · p.${c.pageStart}`;
}

function hrefFor(c: CiteLink): string {
  if (c.pageStart != null) return `#paperai-page-${c.pageStart}`;
  return c.preview ? "#paperai-search" : "#paperai-cite";
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
    const aliases = [legacy, bareSection, withLoc].filter(
      (a) => a && a !== key && !seen.has(a),
    ) as string[];
    for (const a of aliases) seen.add(a);

    const previewSrc =
      e.chunk?.anchorText || e.contextText || e.chunk?.text || "";
    const label = key.replace(/^\[/, "").replace(/\]$/, "");
    out.push({
      cite: key,
      label,
      pageStart: e.chunk?.pageStart,
      pageEnd: e.chunk?.pageEnd,
      preview: citePreview(previewSrc, 320),
      aliases,
    });
  });
  return out;
}

/**
 * HTML anchor for a cite.
 * data-preview = sentence needle for locateQuoteInOpenPdf; data-page = 1-based page.
 * Visible text: E1 · “quote…” (not §Body geometry).
 */
export function htmlCiteLink(
  c: CiteLink,
  opts?: { withPageHint?: boolean; withSnippet?: boolean },
): string {
  const hint = opts?.withPageHint === false ? "" : pageHint(c);
  const href = hrefFor(c);
  const pageAttr = c.pageStart != null ? ` data-page="${c.pageStart}"` : "";
  const previewAttr = c.preview
    ? ` data-preview="${escapeHtml(c.preview)}"`
    : "";
  const title = escapeHtml(
    c.preview ? `${c.preview}${c.preview.length >= 300 ? "…" : ""}` : c.label,
  );
  const snip =
    opts?.withSnippet === false ? "" : citeLinkSnippet(c.preview, 48);
  const visible = snip ? `${c.label}${hint} · “${snip}”` : `${c.label}${hint}`;
  return (
    `<a class="paperai-cite" href="${href}" title="${title}"` +
    `${pageAttr}${previewAttr}>${escapeHtml(visible)}</a>`
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
 * Optional list of all retrieved cites (legacy). Not appended by default.
 */
export function evidenceFooter(evidence: RetrievedEvidence[]): string {
  const links = uniqueCiteLinks(evidence);
  if (!links.length) return "";
  const lines = [
    "근거 (라벨 클릭 → PDF 해당 문장 하이라이트 · 호버 시 발췌):",
    ...links.map((c) => {
      const tail =
        c.preview.length >= 120 ? `${c.preview}…` : c.preview || "(발췌 없음)";
      return `- ${htmlCiteLink(c)} — ${tail}`;
    }),
  ];
  return lines.join("\n");
}

/**
 * Rewrite model cites [E1] / legacy [§…] into HTML links with quote needles.
 */
export function linkifyBareCites(
  text: string,
  evidence: RetrievedEvidence[],
): string {
  const links = uniqueCiteLinks(evidence);
  if (!text || !links.length) return text;
  let out = text;

  const byLabel = new Map<string, CiteLink>();
  for (const c of links) {
    byLabel.set(c.cite, c);
    byLabel.set(c.label, c);
    byLabel.set(c.cite.toLowerCase(), c);
    for (const a of c.aliases || []) {
      if (!byLabel.has(a)) byLabel.set(a, c);
      const inner = a.replace(/^\[/, "").replace(/\]$/, "");
      if (!byLabel.has(inner)) byLabel.set(inner, c);
    }
  }

  // Primary: [E1], [E2], … (case-insensitive E)
  out = out.replace(/\[E(\d+)\](?!\()/gi, (full, n: string) => {
    const key = `[E${Number(n)}]`;
    const c = byLabel.get(key) || byLabel.get(key.toLowerCase());
    if (!c) return full;
    return htmlCiteLink(c, { withPageHint: false });
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
      out = out.replace(re, htmlCiteLink(c, { withPageHint: false }));
    }
  }

  // Residual [§Anything] that still matches known alias map
  out = out.replace(/\[§([^\]]+)\](?!\()/g, (full, inner: string) => {
    const label = `§${inner}`;
    const base = label.replace(/\s+p\.\d+(?:–\d+)?\s*$/i, "").trim();
    const c =
      byLabel.get(`[${label}]`) ||
      byLabel.get(label) ||
      byLabel.get(`[${base}]`) ||
      byLabel.get(base);
    if (!c) return full;
    return htmlCiteLink(c, { withPageHint: false });
  });

  return out;
}

/**
 * Linkify in-body cites → clickable PDF text jumps.
 * Does **not** append the full evidence footer list by default.
 */
export function withEvidenceAnswer(
  answer: string,
  evidence: RetrievedEvidence[],
  opts?: { appendFooter?: boolean },
): { answer: string; ragFooter: string } {
  if (!evidence.length) {
    return { answer, ragFooter: "" };
  }
  stampEvidenceIds(evidence);
  const body = linkifyBareCites(answer || "", evidence);
  if (opts?.appendFooter) {
    const ragFooter = evidenceFooter(evidence);
    return {
      answer: ragFooter ? `${body}\n\n——\n${ragFooter}` : body,
      ragFooter,
    };
  }
  return { answer: body, ragFooter: "" };
}

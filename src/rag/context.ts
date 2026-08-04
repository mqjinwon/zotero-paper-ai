/**
 * Format retrieved evidence into an LLM context block + citation labels.
 * Cite form: [§Section ¶N sM p.P] — paragraph/sentence when known.
 * UI answers rewrite bare cites into HTML anchors (not MD titles — quotes break MD).
 */

import { formatLocator } from "./chunk";
import type { IndexedChunk, RetrievedEvidence } from "./types";

/** Locator suffix: " ¶2 s3" or " ¶2–4" (no page — page appended separately). */
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

/** Section-only form still emitted so models can use either style. */
export function citeBareSection(c: IndexedChunk): string {
  const section = c.section.startsWith("§") ? c.section : `§${c.section}`;
  return `[${section}]`;
}

export function formatContextBlock(
  evidence: RetrievedEvidence[],
  title: string,
): string {
  if (!evidence.length) return "";
  const lines = [
    `Paper: ${title}`,
    "Evidence passages (cite with the EXACT labels in brackets):",
    "",
  ];
  evidence.forEach((e, i) => {
    const loc = formatLocator(e.chunk);
    lines.push(`### ${i + 1}. ${e.cite}`);
    lines.push(`Locator: ${loc}`);
    lines.push(e.contextText.trim());
    lines.push("");
  });
  lines.push(
    "Use only the evidence above when possible. If it is insufficient, say what is missing. " +
      "When you rely on a passage, cite its exact label " +
      "(e.g. [§Introduction ¶2 s3] or [§Method ¶1]). Prefer the most specific label given.",
  );
  return lines.join("\n");
}

export interface CiteLink {
  /** Full label as model sees it, e.g. [§Introduction ¶2 s3] */
  cite: string;
  /** Inner text without brackets */
  label: string;
  pageStart?: number;
  pageEnd?: number;
  preview: string;
  /** Optional secondary keys for linkify (bare section). */
  aliases?: string[];
}

function citePreview(text: string, max = 120): string {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
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
  for (const e of evidence) {
    const section = e.chunk?.section
      ? e.chunk.section.startsWith("§")
        ? e.chunk.section
        : `§${e.chunk.section}`
      : "";
    const precise = e.cite || citeOf(e.chunk);
    // Prefer precise locator cite as primary key
    const key = precise || (section ? `[${section}]` : "");
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const bareSection = section ? `[${section}]` : "";
    const withLoc =
      section && e.chunk ? `[${section}${locatorSuffix(e.chunk)}]` : "";
    const aliases = [bareSection, withLoc, e.cite].filter(
      (a) => a && a !== key,
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
      preview: citePreview(previewSrc),
      aliases,
    });
  }
  return out;
}

/**
 * HTML anchor for a cite. Avoids markdown title="..." which breaks on quotes/parens.
 * data-preview holds search text; data-page holds 1-based page when known.
 */
export function htmlCiteLink(
  c: CiteLink,
  opts?: { withPageHint?: boolean },
): string {
  const hint = opts?.withPageHint === false ? "" : pageHint(c);
  const href = hrefFor(c);
  const pageAttr = c.pageStart != null ? ` data-page="${c.pageStart}"` : "";
  const previewAttr = c.preview
    ? ` data-preview="${escapeHtml(c.preview)}"`
    : "";
  const title = escapeHtml(
    c.preview ? `${c.preview}${c.preview.length >= 120 ? "…" : ""}` : c.label,
  );
  return (
    `<a class="paperai-cite" href="${href}" title="${title}"` +
    `${pageAttr}${previewAttr}>${escapeHtml(c.label + hint)}</a>`
  );
}

/** @deprecated use htmlCiteLink — kept for tests that check page hrefs */
export function mdCiteLink(
  c: CiteLink,
  opts?: { withPageHint?: boolean },
): string {
  // Emit HTML so marked passes it through; still works in node tests via string match
  return htmlCiteLink(c, opts);
}

/**
 * Optional list of all retrieved cites (legacy). Not appended to answers by
 * default — UI relies on in-body [§…] linkify only.
 */
export function evidenceFooter(evidence: RetrievedEvidence[]): string {
  const links = uniqueCiteLinks(evidence);
  if (!links.length) return "";
  const lines = [
    "근거 (라벨 클릭 → PDF 해당 페이지 · 호버 시 발췌 미리보기):",
    ...links.map((c) => {
      const tail =
        c.preview.length >= 120 ? `${c.preview}…` : c.preview || "(발췌 없음)";
      return `- ${htmlCiteLink(c)} — ${tail}`;
    }),
  ];
  return lines.join("\n");
}

/**
 * Rewrite bare model cites like [§Body (1)] into HTML links.
 * Also matches [§Body (1) p.3] style if the model included pages.
 */
export function linkifyBareCites(
  text: string,
  evidence: RetrievedEvidence[],
): string {
  const links = uniqueCiteLinks(evidence);
  if (!text || !links.length) return text;
  links.sort((a, b) => b.cite.length - a.cite.length);
  let out = text;

  // Build map section → link for flexible matching (precise + aliases)
  const byLabel = new Map<string, CiteLink>();
  for (const c of links) {
    byLabel.set(c.cite, c);
    byLabel.set(c.label, c);
    for (const a of c.aliases || []) {
      if (!byLabel.has(a)) byLabel.set(a, c);
      const inner = a.replace(/^\[/, "").replace(/\]$/, "");
      if (!byLabel.has(inner)) byLabel.set(inner, c);
    }
  }

  // Longer cites first so ¶2 s3 beats bare section
  const ordered = [...links].sort((a, b) => b.cite.length - a.cite.length);
  for (const c of ordered) {
    const keys = [c.cite, ...(c.aliases || [])].filter(Boolean);
    for (const k of keys) {
      const re = new RegExp(escapeRegExp(k) + "(?!\\()", "g");
      out = out.replace(re, htmlCiteLink(c, { withPageHint: false }));
    }
  }

  // Also replace [§Anything] that matches a known label prefix (page-less)
  out = out.replace(/\[§([^\]]+)\](?!\()/g, (full, inner: string) => {
    const label = `§${inner}`;
    // strip trailing " p.N" for lookup
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
 * Linkify in-body cites like [§Body (1)] → clickable PDF jumps.
 * Does **not** append the full evidence footer list (user preference).
 */
export function withEvidenceAnswer(
  answer: string,
  evidence: RetrievedEvidence[],
  opts?: { appendFooter?: boolean },
): { answer: string; ragFooter: string } {
  if (!evidence.length) {
    return { answer, ragFooter: "" };
  }
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

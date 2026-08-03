/**
 * Format retrieved evidence into an LLM context block + citation labels.
 * Cite form: [§Section p.N]
 * UI answers rewrite bare cites into HTML anchors (not MD titles — quotes break MD).
 */

import type { IndexedChunk, RetrievedEvidence } from "./types";

export function citeOf(c: IndexedChunk): string {
  const section = c.section.startsWith("§") ? c.section : `§${c.section}`;
  const pages =
    c.pageStart != null
      ? c.pageEnd != null && c.pageEnd !== c.pageStart
        ? ` p.${c.pageStart}–${c.pageEnd}`
        : ` p.${c.pageStart}`
      : "";
  return `[${section}${pages}]`;
}

export function formatContextBlock(
  evidence: RetrievedEvidence[],
  title: string,
): string {
  if (!evidence.length) return "";
  const lines = [
    `Paper: ${title}`,
    "Evidence passages (cite these with their labels when answering):",
    "",
  ];
  evidence.forEach((e, i) => {
    lines.push(`### ${i + 1}. ${e.cite} (score=${e.score.toFixed(3)})`);
    lines.push(e.contextText.trim());
    lines.push("");
  });
  lines.push(
    "Use only the evidence above when possible. If it is insufficient, say what is missing. " +
      "When you rely on a passage, cite its label (e.g. [§Body (2)] or [§Method p.3]).",
  );
  return lines.join("\n");
}

export interface CiteLink {
  /** Full label as model sees it, e.g. [§Body (1)] or [§Method p.3] */
  cite: string;
  /** Inner text without brackets */
  label: string;
  pageStart?: number;
  pageEnd?: number;
  preview: string;
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
    // Prefer bare section label (without p.N) so we match model output [§Body (1)]
    const section = e.chunk?.section
      ? e.chunk.section.startsWith("§")
        ? e.chunk.section
        : `§${e.chunk.section}`
      : "";
    const bareCite = section ? `[${section}]` : e.cite;
    const key = bareCite || e.cite;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // Also skip if we already have the p.N form as only cite
    if (e.cite && e.cite !== key) seen.add(e.cite);

    const label = key.replace(/^\[/, "").replace(/\]$/, "");
    out.push({
      cite: bareCite || e.cite,
      label,
      pageStart: e.chunk?.pageStart,
      pageEnd: e.chunk?.pageEnd,
      preview: citePreview(e.contextText || e.chunk?.text || ""),
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
 * Footer for UI answers: clickable cites + short previews.
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

  // Build map section → link for flexible matching
  const byLabel = new Map<string, CiteLink>();
  for (const c of links) {
    byLabel.set(c.cite, c);
    // Also index without brackets
    byLabel.set(c.label, c);
  }

  // Replace exact cite tokens first
  for (const c of links) {
    const re = new RegExp(escapeRegExp(c.cite) + "(?!\\()", "g");
    out = out.replace(re, htmlCiteLink(c, { withPageHint: false }));
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

/** Linkify body cites + append evidence footer. */
export function withEvidenceAnswer(
  answer: string,
  evidence: RetrievedEvidence[],
): { answer: string; ragFooter: string } {
  if (!evidence.length) {
    return { answer, ragFooter: "" };
  }
  const ragFooter = evidenceFooter(evidence);
  const body = linkifyBareCites(answer || "", evidence);
  return {
    answer: `${body}\n\n——\n${ragFooter}`,
    ragFooter,
  };
}

/**
 * Apply LockedEvidence as HTML phrase links + evidence tray.
 * Ported from groundAnswer apply helpers; GroundedLink-compatible fields.
 */

import { encodeRectsAttr } from "../context";
import type { LockedEvidence } from "./types";

function escapeHtml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeKey(s: string): string {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** HTML phrase link; optional data-rects for official navigate path. */
export function htmlLockedLink(link: LockedEvidence): string {
  const href =
    link.pageStart != null
      ? `#paperai-page-${link.pageStart}`
      : "#paperai-search";
  const pageAttr =
    link.pageStart != null ? ` data-page="${link.pageStart}"` : "";
  const previewAttr = ` data-preview="${escapeHtml(link.paperSentence)}"`;
  const rectsEnc = encodeRectsAttr(link.rects);
  const rectsAttr = rectsEnc ? ` data-rects="${escapeHtml(rectsEnc)}"` : "";
  const title = escapeHtml(
    [
      link.section,
      link.pageStart != null ? `p.${link.pageStart}` : "",
      link.paperSentence,
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 400),
  );
  return (
    `<a class="paperai-cite paperai-cite-phrase" href="${href}" title="${title}"` +
    `${pageAttr}${previewAttr}${rectsAttr}>${escapeHtml(link.answerPhrase)}</a>`
  );
}

/**
 * Apply non-overlapping locked links into the answer text.
 */
export function applyLockedLinks(
  answer: string,
  locks: LockedEvidence[],
): string {
  if (!answer || !locks.length) return answer;
  const ordered = [...locks].sort(
    (a, b) => b.answerPhrase.length - a.answerPhrase.length,
  );
  let out = answer;
  const usedRanges: Array<{ start: number; end: number }> = [];

  for (const link of ordered) {
    const phrase = link.answerPhrase;
    if (!phrase || phrase.length < 3) continue;
    const lower = out.toLowerCase();
    const needle = phrase.toLowerCase();
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(needle, from);
      if (idx < 0) break;
      const end = idx + phrase.length;
      const before = out.slice(Math.max(0, idx - 3), idx);
      if (before.includes("<a") || /[=>]$/.test(before)) {
        from = end;
        continue;
      }
      const lastOpen = out.lastIndexOf("<a ", idx);
      const lastClose = out.lastIndexOf("</a>", idx);
      if (lastOpen > lastClose) {
        from = end;
        continue;
      }
      const overlaps = usedRanges.some(
        (r) => !(end <= r.start || idx >= r.end),
      );
      if (overlaps) {
        from = end;
        continue;
      }
      const surface = out.slice(idx, end);
      const html = htmlLockedLink({ ...link, answerPhrase: surface });
      out = out.slice(0, idx) + html + out.slice(end);
      usedRanges.push({ start: idx, end: idx + html.length });
      break;
    }
  }
  return out;
}

export function evidenceTrayFromLocks(locks: LockedEvidence[]): string {
  if (!locks.length) return "";
  const seen = new Set<string>();
  const items: string[] = [];
  for (const g of locks) {
    const key = normalizeKey(g.paperSentence).slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = [g.section, g.pageStart != null ? `p.${g.pageStart}` : ""]
      .filter(Boolean)
      .join(" · ");
    const q =
      g.paperSentence.length > 160
        ? `${g.paperSentence.slice(0, 159).trim()}…`
        : g.paperSentence;
    items.push(
      `<li>${htmlLockedLink(g)}${
        meta ? ` <span class="pai-cite-meta">${escapeHtml(meta)}</span>` : ""
      } — ${escapeHtml(q)}</li>`,
    );
  }
  if (!items.length) return "";
  return [
    `<details class="paperai-evidence-tray">`,
    `<summary>근거 ${items.length}</summary>`,
    `<ol class="paperai-evidence-list">`,
    ...items,
    `</ol>`,
    `</details>`,
  ].join("\n");
}

/**
 * Insert phrase links + tray. Returns combined answer and tray HTML alone.
 */
export function applyLockedEvidence(
  answer: string,
  locks: LockedEvidence[],
): { answer: string; tray: string } {
  const cleaned = String(answer || "")
    .replace(/\[E?\d+\](?!\()/gi, "")
    .replace(/\[§[^\]]+\](?!\()/g, "")
    .replace(
      /\[([^\]]{1,120})\]\(\s*(?:#(?:cite-|e|paperai-cite-)?|cite:)\d+\s*\)/gi,
      "$1",
    );
  const body = applyLockedLinks(cleaned, locks);
  const tray = evidenceTrayFromLocks(locks);
  return {
    answer: tray ? `${body}\n\n${tray}` : body,
    tray,
  };
}

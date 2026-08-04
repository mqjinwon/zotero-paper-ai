/**
 * Pure index diagnostics for panel readout (no Zotero deps).
 */

import type { PaperIndex } from "./types";

export interface IndexDiagnostics {
  sectionNames: string[];
  /** Fraction of chunks whose section base is "Body" (0–1). */
  bodyShare: number;
  parentCount: number;
  childCount: number;
  abstractCount: number;
  totalChunks: number;
  sampleAnchors: string[];
  chunkPolicy: string;
  retrievalMode: string;
  /** One-line Korean summary for the panel. */
  summaryLine: string;
}

function baseSection(section: string): string {
  return String(section || "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .trim();
}

/**
 * Summarize a PaperIndex for humans: sections, Body share, counts, anchors.
 */
export function buildIndexDiagnostics(index: PaperIndex): IndexDiagnostics {
  const chunks = index?.chunks || [];
  const sectionOrder: string[] = [];
  const seen = new Set<string>();
  let bodyChunks = 0;
  let parentCount = 0;
  let childCount = 0;
  let abstractCount = 0;

  for (const c of chunks) {
    const base = baseSection(c.section);
    if (base && !seen.has(base)) {
      seen.add(base);
      sectionOrder.push(base);
    }
    if (/^body$/i.test(base)) bodyChunks++;
    if (c.kind === "parent") parentCount++;
    else if (c.kind === "child") childCount++;
    else if (c.kind === "abstract") abstractCount++;
  }

  const totalChunks = chunks.length;
  const bodyShare = totalChunks ? bodyChunks / totalChunks : 0;

  const sampleAnchors: string[] = [];
  for (const c of chunks) {
    if (sampleAnchors.length >= 3) break;
    const a = String(c.anchorText || "")
      .replace(/\s+/g, " ")
      .trim();
    if (a.length >= 20) {
      sampleAnchors.push(a.length > 72 ? `${a.slice(0, 71)}…` : a);
    }
  }

  const mode = index.retrievalModeUsed || "bm25";
  const secPreview =
    sectionOrder.length <= 6
      ? sectionOrder.join(", ")
      : `${sectionOrder.slice(0, 5).join(", ")}…(+${sectionOrder.length - 5})`;

  const bodyPct = Math.round(bodyShare * 100);
  const bodyNote =
    bodyShare >= 0.85
      ? ` · ⚠ Body ${bodyPct}% (헤딩 감지 약함 — 재인덱싱/텍스트 확인)`
      : bodyShare > 0.2
        ? ` · Body ${bodyPct}%`
        : "";

  const anchorHint = sampleAnchors[0]
    ? ` · 예: “${sampleAnchors[0].slice(0, 40)}${sampleAnchors[0].length > 40 ? "…" : ""}”`
    : "";

  const summaryLine =
    `섹션 ${sectionOrder.length}개 (${secPreview || "—"}) · ` +
    `chunks ${totalChunks} (P${parentCount}/C${childCount}/A${abstractCount}) · ` +
    `${mode}${bodyNote}${anchorHint}`;

  return {
    sectionNames: sectionOrder,
    bodyShare,
    parentCount,
    childCount,
    abstractCount,
    totalChunks,
    sampleAnchors,
    chunkPolicy: index.chunkPolicy || "",
    retrievalMode: String(mode),
    summaryLine,
  };
}

/** Multi-line detail for status / diagnostics copy. */
export function formatIndexDiagnosticsDetail(d: IndexDiagnostics): string {
  const lines = [
    d.summaryLine,
    d.sampleAnchors.length
      ? `anchors: ${d.sampleAnchors.map((a) => `“${a}”`).join(" | ")}`
      : "anchors: (none)",
    d.chunkPolicy ? `policy: ${d.chunkPolicy}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

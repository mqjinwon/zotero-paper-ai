/**
 * Attach page numbers to evidence that only has section labels (e.g. §Body (1)).
 * Does NOT rewrite e.cite (must stay as model labels like [§Body (1)] for linkify).
 */

import type { RetrievedEvidence } from "./types";

function resolveZotero(): any {
  const g = globalThis as any;
  if (g.Zotero) return g.Zotero;
  try {
    let w: any = g.window || g;
    for (let i = 0; i < 6 && w; i++) {
      if (w.Zotero) return w.Zotero;
      w = w.parent !== w ? w.parent : null;
    }
  } catch {
    /* ignore */
  }
  try {
    return g.top?.Zotero || null;
  } catch {
    return null;
  }
}

export function findOpenPdfApp(): any {
  const tryWin = (w: unknown) => {
    try {
      const app = (w as any)?.PDFViewerApplication;
      if (app?.pdfDocument || app?.pdfViewer) return app;
    } catch {
      /* ignore */
    }
    return null;
  };
  try {
    const Z = resolveZotero();
    const readers = Z?.Reader?._readers || [];
    // Prefer selected tab reader
    try {
      const main = Z?.getMainWindow?.();
      const tabId = main?.Zotero_Tabs?.selectedID;
      if (tabId != null && Z?.Reader?.getByTabID) {
        const r = Z.Reader.getByTabID(tabId);
        if (r && !readers.includes(r)) readers.unshift(r);
        else if (r) {
          readers.splice(readers.indexOf(r), 1);
          readers.unshift(r);
        }
      }
    } catch {
      /* ignore */
    }
    for (const r of readers) {
      for (const w of [
        r?._internalReader?._primaryView?._iframeWindow,
        r?._internalReader?._primaryView?._iframe?.contentWindow,
        r?._internalReader?._lastView?._iframeWindow,
        r?._iframeWindow,
        r?._iframe?.contentWindow,
        r?._window,
      ]) {
        const app = tryWin(w);
        if (app?.pdfDocument) return app;
        if (app) return app;
      }
      // Walk iframes under reader shell
      try {
        const shell = r?._iframeWindow?.document || r?._iframe?.contentDocument;
        const iframes = shell?.querySelectorAll?.("iframe") || [];
        for (const fr of Array.from(iframes)) {
          const app = tryWin((fr as HTMLIFrameElement).contentWindow);
          if (app?.pdfDocument) return app;
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Prefer a mid-chunk phrase so incomplete leading words don't break search. */
export function pickSearchNeedle(text: string): string {
  const cleaned = String(text || "")
    .replace(/[^\w\s.,;:%-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter((w) => w.length > 2);
  if (words.length < 4) return words.join(" ").slice(0, 48);
  const start = Math.min(4, Math.max(0, words.length - 10));
  return words.slice(start, start + 10).join(" ");
}

async function findPageForNeedle(
  app: any,
  needle: string,
): Promise<number | null> {
  if (!app?.pdfDocument || !needle || needle.length < 8) return null;
  const n = needle.toLowerCase();
  const variants = [
    n.slice(0, Math.min(36, n.length)),
    n.slice(0, Math.min(24, n.length)),
    n.split(" ").slice(0, 5).join(" "),
  ].filter((v) => v.length >= 8);
  const num = Math.min(app.pdfDocument.numPages || 0, 150);
  for (let p = 1; p <= num; p++) {
    try {
      const page = await app.pdfDocument.getPage(p);
      const tc = await page.getTextContent();
      const text = (tc.items || [])
        .map((it: { str?: string }) => it.str || "")
        .join(" ")
        .toLowerCase()
        .replace(/\s+/g, " ");
      if (variants.some((v) => text.includes(v))) return p;
    } catch {
      /* skip page */
    }
  }
  return null;
}

function bodyIndex(section: string): number | null {
  const m = String(section || "").match(/Body\s*\((\d+)\)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sectionHeuristicPage(
  section: string,
  numPages: number,
  maxBody: number,
): number | null {
  if (numPages < 1) return null;
  const s = String(section || "").toLowerCase();
  if (/abstract/.test(s)) return 1;
  if (/reference/.test(s)) return numPages;
  if (/conclusion|future\s*work/.test(s)) {
    return Math.max(1, numPages - 1);
  }
  const bi = bodyIndex(section);
  if (bi != null && maxBody > 0) {
    // Spread Body (1..N) across the PDF
    const page = Math.ceil(((bi - 0.25) / maxBody) * numPages);
    return Math.max(1, Math.min(numPages, page));
  }
  return null;
}

/**
 * Mutates evidence chunks' pageStart/pageEnd only (cite labels unchanged).
 * Order: text search → section/Body proportional heuristic.
 */
export async function enrichEvidenceWithPages(
  evidence: RetrievedEvidence[],
): Promise<{ filled: number; via: string }> {
  if (!evidence.length) return { filled: 0, via: "empty" };
  const app = findOpenPdfApp();
  const numPages = Number(app?.pdfDocument?.numPages) || 0;

  let maxBody = 1;
  for (const e of evidence) {
    const bi = bodyIndex(e.chunk?.section || "");
    if (bi != null) maxBody = Math.max(maxBody, bi);
  }

  const cache = new Map<string, number | null>();
  let filled = 0;
  let via = "none";

  for (const e of evidence) {
    if (e.chunk.pageStart != null) {
      filled++;
      continue;
    }
    let page: number | null = null;

    // 1) PDF.js text search
    if (app?.pdfDocument) {
      const needle = pickSearchNeedle(e.contextText || e.chunk.text || "");
      if (needle) {
        if (cache.has(needle)) page = cache.get(needle) ?? null;
        else {
          page = await findPageForNeedle(app, needle);
          cache.set(needle, page);
        }
        if (page != null) via = via === "none" ? "search" : via;
      }
    }

    // 2) Heuristic from section / Body (n)
    if (page == null && numPages > 0) {
      page = sectionHeuristicPage(e.chunk.section || "", numPages, maxBody);
      if (page != null)
        via = via === "none" || via === "search" ? via + "+heur" : via;
    }

    if (page != null && page > 0) {
      e.chunk.pageStart = page;
      e.chunk.pageEnd = page;
      // IMPORTANT: do not rewrite e.cite — model answers use [§Body (1)] without p.N
      filled++;
    }
  }

  return {
    filled,
    via: via === "none" ? (numPages ? "heur-miss" : "no-pdf") : via,
  };
}

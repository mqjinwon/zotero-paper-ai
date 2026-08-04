/**
 * Attach page numbers to evidence via real PDF text search only.
 * Does NOT invent pages from Body (k) proportional heuristics (disabled).
 * Cite labels stay as [E#]; navigation uses quote locate when page is unknown.
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

/**
 * Body (k) proportional page assignment — permanently disabled.
 * Exported so tests prove it never invents pages from section indices alone.
 */
export function bodyProportionalPage(
  _section: string,
  _numPages: number,
  _maxBody?: number,
): number | null {
  return null;
}

/**
 * Optional soft section → page guess (NOT Body-proportional).
 * Only extreme anchors: abstract→1, references→last. Everything else null.
 * Callers may ignore this entirely; enrichEvidenceWithPages does not use it
 * for navigation inventing when text search is available.
 */
export function softSectionPageHint(
  section: string,
  numPages: number,
): number | null {
  if (numPages < 1) return null;
  const s = String(section || "").toLowerCase();
  if (/abstract/.test(s)) return 1;
  if (/reference/.test(s)) return numPages;
  // Explicitly never invent from Body (k)
  if (/body\s*\(\d+\)/i.test(s) || /^body$/i.test(s.trim())) return null;
  return null;
}

/**
 * Mutates evidence chunks' pageStart/pageEnd only when known from:
 *  1) already set on the chunk
 *  2) open-PDF text search
 * Never assigns pages solely from Body (k) packing indices.
 */
export async function enrichEvidenceWithPages(
  evidence: RetrievedEvidence[],
): Promise<{ filled: number; via: string }> {
  if (!evidence.length) return { filled: 0, via: "empty" };
  const app = findOpenPdfApp();
  const numPages = Number(app?.pdfDocument?.numPages) || 0;

  const cache = new Map<string, number | null>();
  let filled = 0;
  let via = "none";

  for (const e of evidence) {
    if (e.chunk.pageStart != null) {
      filled++;
      continue;
    }
    let page: number | null = null;

    // 1) PDF.js text search only (real content)
    if (app?.pdfDocument) {
      const needle = pickSearchNeedle(
        e.chunk?.anchorText || e.contextText || e.chunk.text || "",
      );
      if (needle) {
        if (cache.has(needle)) page = cache.get(needle) ?? null;
        else {
          page = await findPageForNeedle(app, needle);
          cache.set(needle, page);
        }
        if (page != null) via = via === "none" ? "search" : via;
      }
    }

    // 2) Body-proportional heuristic: intentionally not used
    // bodyProportionalPage(...) always returns null.
    if (page == null) {
      void bodyProportionalPage(e.chunk.section || "", numPages);
    }

    if (page != null && page > 0) {
      e.chunk.pageStart = page;
      e.chunk.pageEnd = page;
      // Do not rewrite e.cite — model answers use [E#]
      filled++;
    }
  }

  return {
    filled,
    via: via === "none" ? (numPages ? "search-miss" : "no-pdf") : via,
  };
}

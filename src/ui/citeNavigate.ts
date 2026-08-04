/**
 * Sentence-level cite navigation: reuse auto-highlight text locate,
 * then flash a temporary highlight on the matched PDF glyphs.
 */

import {
  locateQuoteInOpenPdf,
  type LocatedQuote,
} from "../rag/autoHighlight/locate";
import { diag } from "../utils/diagnostics";

const FLASH_CLASS = "paperai-cite-flash";
const FLASH_MS = 2800;

function unwrap(obj: any): any {
  if (!obj) return obj;
  try {
    const Cu = (globalThis as any).Cu || (globalThis as any).Components?.utils;
    if (Cu?.waiveXrays) return Cu.waiveXrays(obj);
  } catch {
    /* ignore */
  }
  try {
    return obj.wrappedJSObject || obj;
  } catch {
    return obj;
  }
}

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
    /* cross-origin */
  }
  try {
    return g.top?.Zotero || null;
  } catch {
    return null;
  }
}

function collectReaders(Z: any): any[] {
  const out: unknown[] = [];
  try {
    const main = Z?.getMainWindow?.() || null;
    const tabId =
      main?.Zotero_Tabs?.selectedID ??
      (globalThis as any).Zotero_Tabs?.selectedID;
    if (tabId != null && Z?.Reader?.getByTabID) {
      const r = Z.Reader.getByTabID(tabId);
      if (r) out.push(r);
    }
  } catch {
    /* ignore */
  }
  try {
    for (const r of Z?.Reader?._readers || []) {
      if (!out.includes(r)) out.push(r);
    }
  } catch {
    /* ignore */
  }
  return out;
}

function windowsFromReader(reader: any): Window[] {
  const wins: Window[] = [];
  const push = (w: unknown) => {
    if (w && typeof (w as Window).document !== "undefined") {
      if (!wins.includes(w as Window)) wins.push(w as Window);
    }
  };
  try {
    push(reader?._internalReader?._primaryView?._iframeWindow);
    push(reader?._internalReader?._primaryView?._iframe?.contentWindow);
    push(reader?._internalReader?._lastView?._iframeWindow);
    push(reader?._iframeWindow);
    push(reader?._iframe?.contentWindow);
    push(reader?._window);
    const shell =
      reader?._iframeWindow?.document || reader?._iframe?.contentDocument;
    for (const fr of Array.from(shell?.querySelectorAll?.("iframe") || [])) {
      push((fr as HTMLIFrameElement).contentWindow);
    }
  } catch {
    /* ignore */
  }
  return wins;
}

function pdfAppFromWindow(w: Window | null | undefined): any {
  if (!w) return null;
  try {
    const raw = unwrap(w);
    const app =
      raw?.PDFViewerApplication ||
      (w as unknown as { PDFViewerApplication?: unknown }).PDFViewerApplication;
    return unwrap(app) || app || null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pdfJsGoToPage(app: any, pageLabel: number): boolean {
  if (!app || !Number.isFinite(pageLabel) || pageLabel < 1) return false;
  const n = Math.floor(pageLabel);
  try {
    const viewer = unwrap(app.pdfViewer) || app.pdfViewer;
    if (!viewer) {
      if ("page" in app) {
        app.page = n;
        return true;
      }
      return false;
    }
    try {
      viewer.currentPageNumber = n;
    } catch {
      /* ignore */
    }
    try {
      if (typeof viewer.scrollPageIntoView === "function") {
        viewer.scrollPageIntoView({ pageNumber: n });
      }
    } catch {
      /* ignore */
    }
    try {
      app.page = n;
    } catch {
      /* ignore */
    }
    const cur = Number(viewer.currentPageNumber || app.page || 0);
    return cur === n || cur > 0;
  } catch (e) {
    diag("cite", "pdfJsGoToPage fail", String(e));
    return false;
  }
}

/** Page-only jump (no text locate). */
export async function navigateReaderToPageOnly(
  pageLabel: number,
): Promise<boolean> {
  const page = Math.floor(Number(pageLabel));
  if (!(page >= 1)) return false;
  const Z = resolveZotero();
  const readers = collectReaders(Z);

  for (const reader of readers) {
    if (!reader?.navigate) continue;
    try {
      await reader.navigate({ pageIndex: page - 1 });
      return true;
    } catch {
      /* try next */
    }
    try {
      await reader.navigate({
        pageIndex: page - 1,
        pageLabel: String(page),
      });
      return true;
    } catch {
      /* continue */
    }
  }

  for (const reader of readers) {
    for (const w of windowsFromReader(reader)) {
      const app = pdfAppFromWindow(w);
      if (pdfJsGoToPage(app, page)) {
        try {
          w.focus?.();
        } catch {
          /* ignore */
        }
        return true;
      }
    }
  }
  return false;
}

function clearCiteFlashes(doc?: Document | null): void {
  const roots: Array<Document | null | undefined> = [doc];
  if (!doc) {
    const Z = resolveZotero();
    for (const reader of collectReaders(Z)) {
      for (const w of windowsFromReader(reader)) {
        roots.push(w.document);
      }
    }
  }
  for (const d of roots) {
    if (!d) continue;
    try {
      for (const el of Array.from(
        d.querySelectorAll(`.${FLASH_CLASS}`),
      ) as Element[]) {
        el.remove();
      }
    } catch {
      /* ignore */
    }
  }
}

function pdfRectToCss(
  viewport: any,
  rect: number[],
): { left: number; top: number; width: number; height: number } | null {
  if (!rect || rect.length < 4) return null;
  const [x1, y1, x2, y2] = rect;
  try {
    if (typeof viewport?.convertToViewportRectangle === "function") {
      const v = viewport.convertToViewportRectangle([
        x1,
        y1,
        x2,
        y2,
      ]) as number[];
      const left = Math.min(v[0], v[2]);
      const top = Math.min(v[1], v[3]);
      const width = Math.abs(v[2] - v[0]);
      const height = Math.abs(v[3] - v[1]);
      if (width > 0.5 && height > 0.5) return { left, top, width, height };
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof viewport?.convertToViewportPoint === "function") {
      const p0 = viewport.convertToViewportPoint(x1, y1) as number[];
      const p1 = viewport.convertToViewportPoint(x2, y2) as number[];
      const left = Math.min(p0[0], p1[0]);
      const top = Math.min(p0[1], p1[1]);
      const width = Math.abs(p1[0] - p0[0]);
      const height = Math.abs(p1[1] - p0[1]);
      if (width > 0.5 && height > 0.5) return { left, top, width, height };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Paint temporary yellow boxes on matched PDF text (DOM overlay on page div).
 * Returns true if at least one rect was painted.
 */
export function flashLocatedQuote(loc: LocatedQuote): boolean {
  if (!loc?.rects?.length) return false;
  const pageNum = loc.pageIndex + 1;
  const Z = resolveZotero();
  let painted = false;

  for (const reader of collectReaders(Z)) {
    for (const w of windowsFromReader(reader)) {
      try {
        const doc = w.document;
        if (!doc) continue;
        clearCiteFlashes(doc);

        const app = pdfAppFromWindow(w);
        const viewer = unwrap(app?.pdfViewer) || app?.pdfViewer;
        const pageView = unwrap(viewer?.getPageView?.(loc.pageIndex));
        const viewport = unwrap(pageView?.viewport) || pageView?.viewport;
        const pageEl =
          (pageView?.div as HTMLElement | undefined) ||
          (doc.querySelector(
            `.page[data-page-number="${pageNum}"]`,
          ) as HTMLElement | null);
        if (!pageEl || !viewport) continue;

        // Ensure page is positioned for absolute children
        try {
          const cs = w.getComputedStyle?.(pageEl);
          if (cs && cs.position === "static") {
            pageEl.style.position = "relative";
          }
        } catch {
          /* ignore */
        }

        let firstEl: HTMLElement | null = null;
        for (const r of loc.rects) {
          const box = pdfRectToCss(viewport, r);
          if (!box) continue;
          const div = doc.createElement("div");
          div.className = FLASH_CLASS;
          Object.assign(div.style, {
            position: "absolute",
            left: `${box.left}px`,
            top: `${box.top}px`,
            width: `${box.width}px`,
            height: `${Math.max(box.height, 3)}px`,
            background: "rgba(255, 214, 10, 0.48)",
            border: "1px solid rgba(230, 162, 0, 0.95)",
            borderRadius: "2px",
            pointerEvents: "none",
            zIndex: "25",
            boxSizing: "border-box",
            mixBlendMode: "multiply",
          } as CSSStyleDeclaration);
          pageEl.appendChild(div);
          if (!firstEl) firstEl = div;
          painted = true;
        }

        if (firstEl) {
          try {
            firstEl.scrollIntoView({
              block: "center",
              inline: "nearest",
              behavior: "smooth",
            });
          } catch {
            try {
              pageEl.scrollIntoView({ block: "center" });
            } catch {
              /* ignore */
            }
          }
          const captureDoc = doc;
          setTimeout(() => {
            try {
              clearCiteFlashes(captureDoc);
            } catch {
              /* ignore */
            }
          }, FLASH_MS);
        }

        if (painted) {
          diag("cite", "flash ok", {
            page: pageNum,
            rects: loc.rects.length,
            matched: (loc.matchedText || "").slice(0, 48),
          });
          return true;
        }
      } catch (e) {
        diag("cite", "flash fail", String(e));
      }
    }
  }
  return painted;
}

/**
 * Jump to evidence text (sentence-level) using the same locate path as auto-HL.
 * Falls back to page-only navigation when quote match fails.
 */
export async function navigateReaderToEvidence(
  pageLabel: number,
  quote?: string,
): Promise<boolean> {
  const page =
    Number.isFinite(pageLabel) && pageLabel >= 1 ? Math.floor(pageLabel) : 0;
  const q = String(quote || "")
    .replace(/\s+/g, " ")
    .trim();

  diag("cite", "navigate evidence", {
    page,
    quoteLen: q.length,
    head: q.slice(0, 48),
  });

  // 1) Open the hinted page so the text layer / PDF page is nearby
  if (page >= 1) {
    await navigateReaderToPageOnly(page);
    await sleep(180);
  }

  // 2) Text locate (DOM range → PDF.js items), same as auto-highlight
  if (q.length >= 12) {
    let loc = await locateQuoteInOpenPdf(q, page >= 1 ? page : undefined);
    if (!loc && page >= 1) {
      // Text layer may lag after page jump
      await sleep(280);
      loc = await locateQuoteInOpenPdf(q, page);
    }
    if (!loc) {
      // Last try: full-document search without page hint
      loc = await locateQuoteInOpenPdf(q, undefined);
    }
    if (loc) {
      const targetPage = loc.pageIndex + 1;
      if (targetPage !== page) {
        await navigateReaderToPageOnly(targetPage);
        await sleep(160);
        // Re-locate after the target page is shown (better DOM rects)
        const loc2 = await locateQuoteInOpenPdf(q, targetPage);
        if (loc2) loc = loc2;
      }
      const flashed = flashLocatedQuote(loc);
      diag("cite", "locate ok", {
        page: loc.pageIndex + 1,
        flashed,
        matched: (loc.matchedText || "").slice(0, 48),
      });
      return true;
    }
    diag("cite", "locate miss — page fallback", {
      page,
      quoteLen: q.length,
    });
  }

  // 3) Page-only fallback
  if (page >= 1) {
    const ok = await navigateReaderToPageOnly(page);
    return ok;
  }
  return false;
}

/**
 * Locate a quote by TEXT (like drag-select), then take glyph rects of the match.
 *
 * Priority:
 *  1) DOM textLayer + Range.getClientRects()  (same path as user selection)
 *  2) PDF.js getTextContent items → item bounding boxes (word-sequence match)
 *
 * No page-proportional or heuristic spatial guesses.
 */

import { diag } from "../../utils/diagnostics";
import { AUTO_MIN_QUOTE_CHARS } from "./taxonomy";

export interface PdfTextItem {
  str: string;
  /** PDF.js transform: [a, b, c, d, e, f] */
  transform: number[];
  width: number;
  height: number;
}

export interface LocatedQuote {
  pageIndex: number; // 0-based for Zotero
  pageLabel: string;
  rects: number[][]; // [x1,y1,x2,y2] PDF user space
  matchedText: string;
}

export function normalizeMatchText(s: string): string {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Strip spaces/punct for resilient compare (keeps alnum). */
export function compactAlnum(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Build joined page string with 1:1 char→item map (insert single spaces between items).
 * Also builds compact (no-space) string with map for fuzzy match.
 */
export function buildPageCharMap(items: PdfTextItem[]): {
  text: string;
  charToItem: number[];
  compact: string;
  compactToOrig: number[];
} {
  let text = "";
  const charToItem: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const str = items[i].str || "";
    if (!str) continue;
    if (text.length && !/\s$/.test(text) && !/^\s/.test(str)) {
      text += " ";
      charToItem.push(i);
    }
    for (let k = 0; k < str.length; k++) {
      text += str[k];
      charToItem.push(i);
    }
  }
  let compact = "";
  const compactToOrig: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/[a-z0-9]/i.test(ch)) {
      compact += ch.toLowerCase();
      compactToOrig.push(i);
    }
  }
  return { text, charToItem, compact, compactToOrig };
}

/**
 * PDF.js TextItem → axis-aligned rect in PDF user space.
 * width is in text space; scale by horizontal transform length (PDF.js convention).
 * @see https://github.com/mozilla/pdf.js/issues/8655
 */
export function itemToRect(it: PdfTextItem): number[] {
  const m = it.transform || [1, 0, 0, 1, 0, 0];
  const x = m[4] ?? 0;
  const y = m[5] ?? 0;
  const scaleX = Math.hypot(m[0] || 0, m[1] || 0) || 1;
  const scaleY = Math.hypot(m[2] || 0, m[3] || 0) || Math.abs(m[3]) || 1;
  // item.width is glyph advance in text space (font-size already partly in matrix)
  let w = Number(it.width) || 0;
  // If width looks unscaled (~character count), scale by |a|
  if (w > 0 && scaleX > 0 && w < 2000) {
    // PDF.js stores width already multiplied by font size in many builds;
    // try: w_user = width * (scaleX / fontSizeApprox). Common working form:
    w = w * (Math.abs(m[0]) > 0.01 ? 1 : scaleX);
    // When transform[0] is font size, width is often already in user x units:
    // keep as-is if |m[0]| ~= scaleX
    if (Math.abs(Math.abs(m[0]) - scaleX) < 1e-3) {
      w = Number(it.width) || w;
    } else {
      w = (Number(it.width) || 0) * scaleX;
    }
  }
  if (!(w > 0)) w = scaleX * Math.max(1, (it.str || "").length * 0.5);
  const h = scaleY || Number(it.height) || 10;
  // Baseline at y; extend downward/upward like text selection
  const descent = h * 0.25;
  const ascent = h * 0.85;
  return [x, y - descent, x + Math.abs(w), y + ascent];
}

export function mergeRects(rects: number[][]): number[][] {
  if (rects.length <= 1) return rects.filter(validRect);
  const lines: number[][][] = [];
  const sorted = [...rects]
    .filter(validRect)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  for (const r of sorted) {
    const midY = (r[1] + r[3]) / 2;
    let line = lines.find((L) => {
      const m = (L[0][1] + L[0][3]) / 2;
      return Math.abs(m - midY) < Math.max(3, (r[3] - r[1]) * 0.6);
    });
    if (!line) {
      line = [];
      lines.push(line);
    }
    line.push(r);
  }
  return lines.map((line) => {
    const x1 = Math.min(...line.map((r) => r[0]));
    const y1 = Math.min(...line.map((r) => r[1]));
    const x2 = Math.max(...line.map((r) => r[2]));
    const y2 = Math.max(...line.map((r) => r[3]));
    return [x1, y1, x2, y2];
  });
}

function validRect(r: number[]): boolean {
  if (!r || r.length < 4) return false;
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  // Reject degenerate or absurd whole-page blobs
  return w > 0.5 && h > 0.5 && w < 2000 && h < 200;
}

/**
 * Find quote on page by compact alphanumeric match (handles hyphenation / odd spaces),
 * then take rects of ALL text items covering the matched character range.
 */
export function locateQuoteOnPage(
  items: PdfTextItem[],
  quote: string,
): { rects: number[][]; matchedText: string; itemCount: number } | null {
  const qCompact = compactAlnum(quote);
  if (qCompact.length < Math.min(AUTO_MIN_QUOTE_CHARS, 20)) return null;

  const { text, charToItem, compact, compactToOrig } = buildPageCharMap(items);
  if (!compact.length) return null;

  // Prefer full quote; then longest prefix ≥ 24 alnum chars
  let cStart = compact.indexOf(qCompact);
  let cLen = qCompact.length;
  if (cStart < 0) {
    for (let len = Math.min(qCompact.length, 80); len >= 24; len -= 4) {
      const sub = qCompact.slice(0, len);
      cStart = compact.indexOf(sub);
      if (cStart >= 0) {
        cLen = len;
        break;
      }
    }
  }
  if (cStart < 0) return null;

  const cEnd = cStart + cLen - 1;
  if (cEnd >= compactToOrig.length) return null;
  const origStart = compactToOrig[cStart];
  const origEnd = compactToOrig[cEnd];

  const itemSet = new Set<number>();
  for (let i = origStart; i <= origEnd && i < charToItem.length; i++) {
    itemSet.add(charToItem[i]);
  }
  if (!itemSet.size) return null;

  // Require enough of the quote covered (avoid single-glyph false hits)
  if (itemSet.size === 1 && cLen > 40) {
    // one text run can be long — OK if that item is long enough
    const only = items[[...itemSet][0]];
    if (compactAlnum(only?.str || "").length < cLen * 0.5) return null;
  }

  const rects = mergeRects(
    [...itemSet].map((i) => itemToRect(items[i])).filter(validRect),
  );
  if (!rects.length) return null;

  return {
    rects,
    matchedText: text
      .slice(origStart, origEnd + 1)
      .replace(/\s+/g, " ")
      .trim(),
    itemCount: itemSet.size,
  };
}

/** Unwrap Xray wrappers so PDF.js methods are callable from chrome (Zotero 9). */
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

function collectReaderWindows(): Window[] {
  const wins: Window[] = [];
  const push = (w: unknown) => {
    if (w && typeof (w as Window).document !== "undefined") {
      if (!wins.includes(w as Window)) wins.push(w as Window);
    }
  };
  try {
    const Z = (globalThis as any).Zotero;
    const readers: any[] = [];
    const win = Z?.getMainWindow?.() || globalThis;
    const tabs = win?.Zotero_Tabs;
    if (tabs?.selectedID && Z?.Reader?.getByTabID) {
      const r = Z.Reader.getByTabID(tabs.selectedID);
      if (r) readers.push(r);
    }
    for (const r of Z?.Reader?._readers || []) {
      if (r && !readers.includes(r)) readers.push(r);
    }
    for (const r of readers) {
      push(r?._internalReader?._primaryView?._iframeWindow);
      push(r?._internalReader?._primaryView?._iframe?.contentWindow);
      push(r?._iframeWindow);
      push(r?._iframe?.contentWindow);
      push(r?._window);
      try {
        const shell = r?._iframeWindow?.document || r?._iframe?.contentDocument;
        for (const fr of Array.from(
          shell?.querySelectorAll?.("iframe") || [],
        )) {
          push((fr as HTMLIFrameElement).contentWindow);
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return wins;
}

function pdfAppsFromReaders(): any[] {
  const apps: any[] = [];
  for (const w of collectReaderWindows()) {
    try {
      const raw = unwrap(w);
      const app = unwrap(
        raw?.PDFViewerApplication ||
          (w as unknown as { PDFViewerApplication?: unknown })
            .PDFViewerApplication,
      );
      if (app?.pdfDocument && !apps.includes(app)) apps.push(app);
    } catch {
      /* ignore */
    }
  }
  return apps;
}

export async function itemsFromPage(
  pdfDocIn: any,
  pageNum1: number,
): Promise<PdfTextItem[]> {
  const pdfDoc = unwrap(pdfDocIn);
  if (!pdfDoc || typeof pdfDoc.getPage !== "function") {
    throw new Error("pdfDocument.getPage unavailable");
  }
  let page: any = await pdfDoc.getPage(pageNum1);
  page = unwrap(page);
  const proxy = unwrap(page?.pdfPage) || page;

  let getTC: ((...a: any[]) => Promise<any>) | null = null;
  if (typeof proxy?.getTextContent === "function") {
    getTC = proxy.getTextContent.bind(proxy);
  } else if (typeof page?.getTextContent === "function") {
    getTC = page.getTextContent.bind(page);
  }
  if (!getTC) {
    throw new Error("page.getTextContent is not a function");
  }

  const tc = unwrap(await getTC()) || (await getTC());
  const rawItems = unwrap(tc)?.items || tc?.items || [];
  return (rawItems as any[])
    .filter((it) => it && typeof (unwrap(it).str ?? it.str) === "string")
    .map((it) => {
      const u = unwrap(it) || it;
      return {
        str: String(u.str || ""),
        transform: (u.transform as number[]) || [1, 0, 0, 1, 0, 0],
        width: Number(u.width) || 0,
        height: Number(u.height) || 0,
      };
    });
}

/**
 * Drag-select style: find text nodes, build Range, use getClientRects(),
 * convert to PDF user space via viewport.convertToPdfPoint.
 */
function locateViaDomTextSelection(
  quote: string,
  hintPage?: number,
): LocatedQuote | null {
  const qNorm = normalizeMatchText(quote);
  const qCompact = compactAlnum(quote);
  if (qCompact.length < Math.min(AUTO_MIN_QUOTE_CHARS, 20)) return null;

  for (const w of collectReaderWindows()) {
    try {
      const doc = w.document;
      if (!doc) continue;
      const app = unwrap(
        unwrap(w)?.PDFViewerApplication || (w as any).PDFViewerApplication,
      );
      const viewer = unwrap(app?.pdfViewer) || app?.pdfViewer;
      const pageEls = Array.from(
        doc.querySelectorAll(
          ".page[data-page-number], [data-page-number].page, .page",
        ),
      ) as HTMLElement[];

      const order = [...pageEls].sort((a, b) => {
        const pa = Number(a.getAttribute("data-page-number") || 0);
        const pb = Number(b.getAttribute("data-page-number") || 0);
        if (hintPage) {
          if (pa === hintPage) return -1;
          if (pb === hintPage) return 1;
        }
        return pa - pb;
      });

      for (const pageEl of order) {
        const pageNum = Number(pageEl.getAttribute("data-page-number") || 0);
        if (pageNum < 1) continue;
        const layer =
          (pageEl.querySelector(".textLayer") as HTMLElement | null) ||
          (pageEl.querySelector("[class*='textLayer']") as HTMLElement | null);
        if (!layer) continue;

        // Collect text nodes in order (same order as visual text)
        const walker = doc.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        let n: Node | null;
        while ((n = walker.nextNode())) {
          if (n.nodeValue && n.nodeValue.length) nodes.push(n as Text);
        }
        if (!nodes.length) continue;

        // Build full string + map char → {node, offset}
        let full = "";
        type MapE = { node: Text; offset: number };
        const map: MapE[] = [];
        for (const node of nodes) {
          const s = node.nodeValue || "";
          for (let i = 0; i < s.length; i++) {
            full += s[i];
            map.push({ node, offset: i });
          }
        }

        // Compact match
        let compact = "";
        const compactToFull: number[] = [];
        for (let i = 0; i < full.length; i++) {
          if (/[a-z0-9]/i.test(full[i])) {
            compact += full[i].toLowerCase();
            compactToFull.push(i);
          }
        }

        let cStart = compact.indexOf(qCompact);
        let cLen = qCompact.length;
        if (cStart < 0) {
          for (let len = Math.min(qCompact.length, 80); len >= 24; len -= 4) {
            const sub = qCompact.slice(0, len);
            cStart = compact.indexOf(sub);
            if (cStart >= 0) {
              cLen = len;
              break;
            }
          }
        }
        if (cStart < 0) continue;
        const cEnd = cStart + cLen - 1;
        if (cEnd >= compactToFull.length) continue;

        const fStart = compactToFull[cStart];
        const fEnd = compactToFull[cEnd];
        const startMap = map[fStart];
        const endMap = map[fEnd];
        if (!startMap || !endMap) continue;

        // Range like a drag selection
        const range = doc.createRange();
        try {
          range.setStart(startMap.node, startMap.offset);
          range.setEnd(endMap.node, endMap.offset + 1);
        } catch {
          continue;
        }

        const clientRects = Array.from(range.getClientRects() || []);
        if (!clientRects.length) continue;

        const pageView = unwrap(viewer?.getPageView?.(pageNum - 1));
        const viewport = unwrap(pageView?.viewport) || pageView?.viewport;
        const div = (pageView?.div as HTMLElement) || pageEl;
        const divRect = div.getBoundingClientRect();

        const pdfRects: number[][] = [];
        for (const r of clientRects) {
          if (r.width < 0.5 || r.height < 0.5) continue;
          const x0 = r.left - divRect.left;
          const y0 = r.top - divRect.top;
          const x1 = r.right - divRect.left;
          const y1 = r.bottom - divRect.top;

          if (viewport && typeof viewport.convertToPdfPoint === "function") {
            const p0 = viewport.convertToPdfPoint(x0, y0);
            const p1 = viewport.convertToPdfPoint(x1, y1);
            const rx1 = Math.min(p0[0], p1[0]);
            const ry1 = Math.min(p0[1], p1[1]);
            const rx2 = Math.max(p0[0], p1[0]);
            const ry2 = Math.max(p0[1], p1[1]);
            if (rx2 > rx1 && ry2 > ry1) pdfRects.push([rx1, ry1, rx2, ry2]);
          } else {
            let pdfW = 612;
            let pdfH = 792;
            try {
              const vb = viewport?.viewBox as number[] | undefined;
              if (vb && vb.length >= 4) {
                pdfW = Math.max(1, vb[2] - vb[0]);
                pdfH = Math.max(1, vb[3] - vb[1]);
              }
            } catch {
              /* ignore */
            }
            const left = (x0 / Math.max(1, divRect.width)) * pdfW;
            const right = (x1 / Math.max(1, divRect.width)) * pdfW;
            const topPdf = (1 - y0 / Math.max(1, divRect.height)) * pdfH;
            const botPdf = (1 - y1 / Math.max(1, divRect.height)) * pdfH;
            pdfRects.push([
              Math.min(left, right),
              Math.min(topPdf, botPdf),
              Math.max(left, right),
              Math.max(topPdf, botPdf),
            ]);
          }
        }

        const merged = mergeRects(pdfRects);
        if (!merged.length) continue;

        const matchedText = full
          .slice(fStart, fEnd + 1)
          .replace(/\s+/g, " ")
          .trim();
        diag("autoHL", "locate text-select ok", {
          page: pageNum,
          rects: merged.length,
          via: "dom-range",
          q: qNorm.slice(0, 40),
        });
        return {
          pageIndex: pageNum - 1,
          pageLabel: String(pageNum),
          rects: merged,
          matchedText,
        };
      }
    } catch (e) {
      diag("autoHL", "locate DOM range fail", String(e));
    }
  }
  return null;
}

/**
 * Search open PDF for quote by text; return glyph rects of the match.
 */
export async function locateQuoteInOpenPdf(
  quote: string,
  hintPage?: number,
): Promise<LocatedQuote | null> {
  const qCompact = compactAlnum(quote);
  if (qCompact.length < Math.min(AUTO_MIN_QUOTE_CHARS, 20)) return null;

  // 1) Drag-select style (most accurate when text layer is rendered)
  const domHit = locateViaDomTextSelection(quote, hintPage);
  if (domHit) return domHit;

  // 2) PDF.js text content word/compact match → item rects
  const apps = pdfAppsFromReaders();
  let apiFailLogged = false;
  for (const app of apps) {
    const pdfDoc = unwrap(app.pdfDocument) || app.pdfDocument;
    if (!pdfDoc) continue;
    const num = Math.min(Number(pdfDoc.numPages) || 0, 200);
    if (num < 1) continue;
    const order: number[] = [];
    if (hintPage && hintPage >= 1 && hintPage <= num) order.push(hintPage);
    for (let p = 1; p <= num; p++) {
      if (!order.includes(p)) order.push(p);
    }

    for (const p of order) {
      try {
        const items = await itemsFromPage(pdfDoc, p);
        if (!items.length) continue;
        const hit = locateQuoteOnPage(items, quote);
        if (hit) {
          diag("autoHL", "locate text-items ok", {
            page: p,
            rects: hit.rects.length,
            items: hit.itemCount,
          });
          return {
            pageIndex: p - 1,
            pageLabel: String(p),
            rects: hit.rects,
            matchedText: hit.matchedText,
          };
        }
      } catch (e) {
        if (!apiFailLogged) {
          apiFailLogged = true;
          diag("autoHL", "locate pdfjs API fail", { p, e: String(e) });
        }
        if (String(e).includes("not a function")) break;
      }
    }
  }

  diag("autoHL", "locate miss", { q: normalizeMatchText(quote).slice(0, 40) });
  return null;
}

/**
 * Sticky result cards on the PDF reader (explain / figure).
 * Stay until the user closes them.
 * Primary: Zotero child note (library sync). Fallback read: dataDir file.
 */

import { createZoteroFileStore } from "../auth/fileStore";
import {
  loadItemNotePayload,
  saveItemNotePayload,
} from "../storage/itemNoteStore";
import { resolveReadableFile } from "../utils/dataDir";
import { diag } from "../utils/diagnostics";
import { setMarkdownHtmlWithCites } from "./markdown";
// Bundled as text via esbuild loader

// @ts-expect-error css imported as string
import katexCssRaw from "katex/dist/katex.min.css";

export type { StickyKind, StickyNote, StickyPdfLocation } from "./sticky/types";
export {
  STICKY_MIN_W,
  STICKY_MIN_H,
  STICKY_DEFAULT_W,
  STICKY_DEFAULT_H,
  HOST_ID,
  CARD_ATTR,
  SVG_ID,
  uid,
  kindLabel,
  kindColor,
  clampStickySize,
} from "./sticky/types";
import {
  STICKY_MIN_W,
  STICKY_MIN_H,
  STICKY_DEFAULT_W,
  STICKY_DEFAULT_H,
  HOST_ID,
  CARD_ATTR,
  SVG_ID,
  uid,
  kindLabel,
  kindColor,
  clampStickySize,
  type StickyKind,
  type StickyNote,
  type StickyPdfLocation,
} from "./sticky/types";

// In-memory cache keyed by itemKey
const byItem = new Map<string, StickyNote[]>();

/**
 * When true, sticky host is display:none on the PDF (panel list still works).
 * Session-scoped per itemKey — not persisted (easy to re-show).
 */
const overlayHiddenByItem = new Map<string, boolean>();

/** Cap image data-URLs stored in the synced note. */
const MAX_STICKY_IMAGE_CHARS = 200_000;

export function isStickyOverlayHidden(itemKey: string): boolean {
  return !!itemKey && overlayHiddenByItem.get(itemKey) === true;
}

/** Hide/show all sticky cards + connectors on the PDF reader. */
export function setStickyOverlayHidden(
  itemKey: string,
  hidden: boolean,
  reader?: any,
): void {
  if (!itemKey) return;
  overlayHiddenByItem.set(itemKey, hidden);
  applyOverlayVisibilityToOpenReaders(itemKey, reader);
}

function applyHostVisibility(host: HTMLElement, itemKey: string): void {
  const hidden = isStickyOverlayHidden(itemKey);
  host.dataset.itemKey = itemKey;
  host.dataset.paperaiHidden = hidden ? "1" : "0";
  host.style.display = hidden ? "none" : "block";
  // Keep pointer-events off on host; cards re-enable locally when visible
  if (hidden) {
    host.style.visibility = "hidden";
  } else {
    host.style.visibility = "visible";
  }
}

function applyOverlayVisibilityToOpenReaders(
  itemKey: string,
  preferredReader?: any,
): void {
  const readers: any[] = [];
  if (preferredReader) readers.push(preferredReader);
  try {
    const Z = (globalThis as any).Zotero;
    for (const r of Z?.Reader?._readers || []) {
      if (r && !readers.includes(r)) readers.push(r);
    }
  } catch {
    /* ignore */
  }
  for (const reader of readers) {
    try {
      for (const doc of readerDocCandidates(reader)) {
        const host = doc.getElementById?.(HOST_ID) as HTMLElement | null;
        if (!host) continue;
        // Match host itemKey if set; otherwise apply when this is preferred reader
        const hk = host.dataset.itemKey || "";
        if (hk && hk !== itemKey && preferredReader !== reader) continue;
        applyHostVisibility(host, itemKey);
      }
    } catch {
      /* ignore */
    }
  }
}

function dedupeNotes(list: StickyNote[]): StickyNote[] {
  const byId = new Map<string, StickyNote>();
  for (const n of list) {
    if (!n?.id) continue;
    // Keep latest by createdAt if duplicates
    const prev = byId.get(n.id);
    if (!prev || String(n.createdAt) >= String(prev.createdAt)) {
      byId.set(n.id, n);
    }
  }
  return [...byId.values()];
}

function sanitizeStickies(list: StickyNote[]): StickyNote[] {
  return dedupeNotes(
    list
      .filter((n) => n?.id && n.pinned !== false)
      .map((n) => {
        const copy = { ...n };
        if (
          copy.imageDataUrl &&
          copy.imageDataUrl.length > MAX_STICKY_IMAGE_CHARS
        ) {
          delete copy.imageDataUrl;
        }
        return copy;
      }),
  );
}

function parseStickyPayload(payload: unknown): StickyNote[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return sanitizeStickies(payload as StickyNote[]);
  const obj = payload as { stickies?: StickyNote[] };
  if (Array.isArray(obj.stickies)) return sanitizeStickies(obj.stickies);
  return [];
}

async function loadStickiesFromFile(itemKey: string): Promise<StickyNote[]> {
  try {
    const store = createZoteroFileStore();
    const path = await resolveReadableFile(store, "sticky", `${itemKey}.json`);
    if (!path) return [];
    const raw = await store.readText(path);
    const list = JSON.parse(raw) as StickyNote[];
    const notes = sanitizeStickies(Array.isArray(list) ? list : []);
    if (notes.length) {
      diag("sticky", "loaded from file (legacy)", {
        itemKey,
        count: notes.length,
        path,
      });
    }
    return notes;
  } catch {
    return [];
  }
}

export async function loadStickies(
  itemKey: string,
  opts?: { forceReload?: boolean },
): Promise<StickyNote[]> {
  if (!itemKey) return [];
  if (!opts?.forceReload && byItem.has(itemKey)) {
    return dedupeNotes(byItem.get(itemKey)!);
  }
  try {
    const fromNote = parseStickyPayload(
      await loadItemNotePayload(itemKey, "sticky"),
    );
    if (fromNote.length) {
      byItem.set(itemKey, fromNote);
      diag("sticky", "loaded from Zotero note", {
        itemKey,
        count: fromNote.length,
      });
      return fromNote;
    }
    const fromFile = await loadStickiesFromFile(itemKey);
    byItem.set(itemKey, fromFile);
    if (fromFile.length) {
      // Migrate once into library sync
      void saveStickies(itemKey);
    }
    return fromFile;
  } catch (e) {
    diag("sticky", "load fail", String(e));
    byItem.set(itemKey, []);
    return [];
  }
}

export async function saveStickies(itemKey: string): Promise<void> {
  if (!itemKey) return;
  try {
    const notes = sanitizeStickies(byItem.get(itemKey) || []);
    byItem.set(itemKey, notes);
    const payload = {
      itemKey,
      updatedAt: new Date().toISOString(),
      stickies: notes,
    };
    const ok = await saveItemNotePayload(itemKey, "sticky", payload);
    diag("sticky", ok ? "saved to Zotero note" : "save failed", {
      itemKey,
      count: notes.length,
    });
  } catch (e) {
    diag("sticky", "save fail", String(e));
  }
}

/** Candidate reader documents (outer shell + nested PDF view). */

function readerDocCandidates(reader: any): Document[] {
  const out: Document[] = [];
  const seen = new Set<Document>();
  const push = (d: unknown) => {
    if (!d || typeof (d as Document).createElement !== "function") return;
    const doc = d as Document;
    if (seen.has(doc)) return;
    seen.add(doc);
    out.push(doc);
  };
  try {
    // Nested PDF view first — has [data-page-number] / .page
    push(reader?._internalReader?._primaryView?._iframeWindow?.document);
    push(
      reader?._internalReader?._primaryView?._iframe?.contentWindow?.document,
    );
    push(reader?._iframeWindow?.document);
    push(reader?._iframe?.contentWindow?.document);
    push(reader?._window?.document);
    // Walk nested iframes under outer reader (Zotero #primary-view)
    for (const base of [...out]) {
      try {
        const iframes = base.querySelectorAll?.("iframe") || [];
        for (const fr of Array.from(iframes)) {
          try {
            push((fr as HTMLIFrameElement).contentDocument);
          } catch {
            /* cross-origin */
          }
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

function docHasPdfPages(doc: Document): boolean {
  try {
    return !!(
      doc.querySelector?.("[data-page-number]") ||
      doc.querySelector?.(".page") ||
      doc.querySelector?.("#viewer .canvasWrapper canvas") ||
      doc.querySelector?.("#viewerContainer")
    );
  } catch {
    return false;
  }
}

/**
 * Single primary reader document only.
 * Prefer the iframe that actually hosts PDF pages (connectors need it).
 */
/**
 * Prefer the outer reader chrome document (not the nested PDF.js page view).
 * Stickies mounted inside PDF.js lose text selection/copy; the item-pane chat
 * works because it lives outside PDF.js — same idea here.
 * Connectors still resolve page anchors across nested docs.
 */

function primaryReaderDoc(reader: any): Document | null {
  const shellFirst: unknown[] = [
    reader?._iframeWindow?.document,
    reader?._iframe?.contentWindow?.document,
    reader?._window?.document,
  ];
  for (const d of shellFirst) {
    if (d && typeof (d as Document).createElement === "function") {
      return d as Document;
    }
  }
  const candidates = readerDocCandidates(reader);
  for (const d of candidates) {
    if (docHasPdfPages(d)) return d;
  }
  return candidates[0] || null;
}

/** Remove sticky hosts from non-primary docs (cleanup after older bug). */

function cleanupExtraHosts(reader: any, keep: Document | null): void {
  for (const doc of readerDocCandidates(reader)) {
    if (keep && doc === keep) continue;
    try {
      doc.getElementById(HOST_ID)?.remove();
    } catch {
      /* ignore */
    }
  }
}

function readerDocs(reader: any): Document[] {
  const d = primaryReaderDoc(reader);
  return d ? [d] : [];
}

function ensureStickyDocStyles(doc: Document): void {
  if (doc.getElementById("paperai-sticky-style")) return;
  const style = doc.createElement("style");
  style.id = "paperai-sticky-style";
  // KaTeX font paths → CDN so math renders in reader iframe
  const katexCss = String(katexCssRaw || "").replace(
    /url\((?:\.\/)?fonts\//g,
    "url(https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/fonts/",
  );
  style.textContent = `
${katexCss}
/* Selectable sticky text — override PDF.js user-select:none */
.paperai-sticky-body,
.paperai-sticky-body *,
.paperai-sticky-quote,
.paperai-sticky-quote * {
  -moz-user-select: text !important;
  -webkit-user-select: text !important;
  user-select: text !important;
  cursor: text !important;
}
.paperai-sticky-body {
  white-space: normal !important;
}
.paperai-sticky-body p { margin: 0.35em 0; }
.paperai-sticky-body p:first-child { margin-top: 0; }
.paperai-sticky-body p:last-child { margin-bottom: 0; }
.paperai-sticky-body ul, .paperai-sticky-body ol { margin: 0.35em 0; padding-left: 1.2em; }
.paperai-sticky-body code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.92em;
  background: #f0f0f0;
  padding: 0 3px;
  border-radius: 3px;
}
.paperai-sticky-body pre {
  overflow: auto;
  background: #f4f4f4;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 11px;
}
.paperai-sticky-body .katex { font-size: 1.05em; }
.paperai-sticky-body .katex-display { margin: 0.4em 0; overflow-x: auto; }
.paperai-sticky-body table {
  border-collapse: collapse; width: 100%; margin: 0.4em 0; font-size: 11px;
  display: block; overflow-x: auto;
}
.paperai-sticky-body th, .paperai-sticky-body td {
  border: 1px solid #ddd; padding: 3px 6px; text-align: left;
}
.paperai-sticky-body th { background: #f5f5f5; font-weight: 700; }
.paperai-sticky-body h1, .paperai-sticky-body h2, .paperai-sticky-body h3 {
  margin: 0.5em 0 0.3em; font-weight: 700;
}
.paperai-sticky-body a.paperai-cite,
.paperai-sticky-body a[href^="#paperai-page-"],
.paperai-sticky-body a[href="#paperai-cite"] {
  color: #1557b0;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  font-weight: 600;
}
.paperai-sticky-body a.paperai-cite:hover,
.paperai-sticky-body a[href^="#paperai-page-"]:hover {
  color: #0b3d91;
  background: #e8f0fe;
  border-radius: 2px;
}
/* KaTeX injects a body{} rule — keep iframe body from becoming unselectable */
body {
  -moz-user-select: auto;
}
`;
  const parent = doc.head || doc.documentElement;
  if (parent) parent.appendChild(style);
}

function setStickyBodyHtml(el: HTMLElement, md: string): void {
  setMarkdownHtmlWithCites(el, md || "…");
}

function ensureHost(doc: Document): HTMLElement {
  ensureStickyDocStyles(doc);
  let host = doc.getElementById(HOST_ID) as HTMLElement | null;
  if (host) return host;
  host = doc.createElement("div");
  host.id = HOST_ID;
  Object.assign(host.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    zIndex: "2147483000",
  } as CSSStyleDeclaration);
  const parent = doc.body || doc.documentElement;
  if (parent) parent.appendChild(host);
  return host;
}

/**
 * Caret under a screen point (Firefox: caretPositionFromPoint).
 * PDF.js often preventDefault()s document pointer events, killing native
 * drag-select — we rebuild selection with the Selection API instead.
 */
function caretFromPoint(
  doc: Document,
  x: number,
  y: number,
): { node: Node; offset: number } | null {
  const d = doc as any;
  try {
    if (typeof d.caretPositionFromPoint === "function") {
      const p = d.caretPositionFromPoint(x, y);
      if (p?.offsetNode) return { node: p.offsetNode, offset: p.offset ?? 0 };
    }
    if (typeof d.caretRangeFromPoint === "function") {
      const r = d.caretRangeFromPoint(x, y);
      if (r?.startContainer)
        return { node: r.startContainer, offset: r.startOffset ?? 0 };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Same selection model as panel chat bubbles: user-select:text + stop bubble to PDF.
 * No plain-text twin; copy uses selection or full innerText via privileged clipboard.
 */
function protectTextSelection(el: HTMLElement, plainFallback?: string): void {
  el.setAttribute("data-paperai-select", "1");
  try {
    el.style.setProperty("user-select", "text", "important");
    el.style.setProperty("-moz-user-select", "text", "important");
    el.style.setProperty("-webkit-user-select", "text", "important");
    el.style.cursor = "text";
  } catch {
    /* ignore */
  }

  const doc = el.ownerDocument;
  if (!doc) return;

  const stop = (ev: Event) => {
    const t = ev.target as Element | null;
    if (t?.closest?.("button, a, input, textarea")) return;
    ev.stopPropagation();
  };
  // Capture + bubble so PDF.js (if still nearby) cannot steal the gesture
  for (const type of [
    "mousedown",
    "mouseup",
    "mousemove",
    "pointerdown",
    "pointerup",
    "pointermove",
    "click",
    "dblclick",
  ]) {
    el.addEventListener(type, stop, true);
    el.addEventListener(type, stop, false);
  }

  el.addEventListener(
    "keydown",
    (ev: Event) => {
      const e = ev as KeyboardEvent;
      e.stopPropagation();
      const key = (e.key || "").toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "c") {
        try {
          const sel = doc.getSelection?.();
          let text =
            sel && !sel.isCollapsed && el.contains(sel.anchorNode)
              ? sel.toString()
              : "";
          if (!text) {
            text = (
              el.innerText ||
              el.textContent ||
              plainFallback ||
              ""
            ).trim();
          }
          if (text) {
            e.preventDefault();
            copyTextPrivileged(text);
          }
        } catch {
          /* ignore */
        }
      }
      if ((e.ctrlKey || e.metaKey) && key === "a") {
        try {
          e.preventDefault();
          const sel = doc.getSelection?.();
          if (!sel) return;
          const range = doc.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch {
          /* ignore */
        }
      }
    },
    true,
  );
}

/**
 * Copy via Zotero/chrome privileges — reader iframe clipboard is often blocked.
 */
function copyTextPrivileged(text: string): boolean {
  if (!text) return false;
  try {
    const g = globalThis as any;
    const Cc = g.Cc || g.Components?.classes;
    const Ci = g.Ci || g.Components?.interfaces;
    if (Cc && Ci) {
      const helper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
        Ci.nsIClipboardHelper,
      );
      helper.copyString(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const Z = (globalThis as any).Zotero;
    const win = Z?.getMainWindow?.();
    if (win?.navigator?.clipboard?.writeText) {
      void win.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

async function copyText(_doc: Document, text: string): Promise<void> {
  if (copyTextPrivileged(text)) return;
  try {
    const nav = (_doc.defaultView as any)?.navigator || navigator;
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
    }
  } catch {
    /* ignore */
  }
}

function ensureConnectorSvg(host: HTMLElement, doc: Document): SVGSVGElement {
  let svg = host.querySelector(`#${SVG_ID}`) as unknown as SVGSVGElement | null;
  if (!svg) {
    svg = doc.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    ) as unknown as SVGSVGElement;
    svg.id = SVG_ID;
    host.insertBefore(svg, host.firstChild);
  }
  const win = doc.defaultView;
  const vw = Math.max(
    win?.innerWidth || 0,
    doc.documentElement?.clientWidth || 0,
    800,
  );
  const vh = Math.max(
    win?.innerHeight || 0,
    doc.documentElement?.clientHeight || 0,
    600,
  );
  // Explicit pixel size + viewBox so Firefox maps line coords 1:1 to CSS px
  svg.setAttribute("width", String(vw));
  svg.setAttribute("height", String(vh));
  svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
  svg.setAttribute("preserveAspectRatio", "none");
  Object.assign(svg.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: `${vw}px`,
    height: `${vh}px`,
    pointerEvents: "none",
    zIndex: "2147482999",
    overflow: "visible",
  } as CSSStyleDeclaration);
  return svg;
}

/** Find page element for 0-based pageIndex (Zotero uses data-page-number 1-based). */
function findPageEl(doc: Document, pageIndex: number): HTMLElement | null {
  const pageNum = pageIndex + 1;
  return (
    (doc.querySelector(
      `[data-page-number="${pageNum}"]`,
    ) as HTMLElement | null) ||
    (doc.querySelector(
      `.page[data-page-number="${pageNum}"]`,
    ) as HTMLElement | null) ||
    (doc.querySelectorAll(".page")[pageIndex] as HTMLElement | null) ||
    null
  );
}

/**
 * Map PDF user-space point → client coords in `doc` via PDF.js viewport when possible.
 */
function pdfPointToClient(
  doc: Document,
  pageIndex: number,
  pdfX: number,
  pdfY: number,
): { x: number; y: number } | null {
  const win = doc.defaultView as unknown as {
    PDFViewerApplication?: {
      pdfViewer?: {
        getPageView?: (i: number) => {
          viewport?: {
            convertToViewportPoint: (x: number, y: number) => number[];
            width?: number;
            height?: number;
            viewBox?: number[];
          };
          div?: HTMLElement;
        };
      };
    };
  } | null;
  try {
    const pageView =
      win?.PDFViewerApplication?.pdfViewer?.getPageView?.(pageIndex);
    const viewport = pageView?.viewport;
    const div = pageView?.div;
    if (viewport?.convertToViewportPoint && div) {
      const pt = viewport.convertToViewportPoint(pdfX, pdfY);
      const vx = pt[0] ?? 0;
      const vy = pt[1] ?? 0;
      const pr = div.getBoundingClientRect();
      return { x: pr.left + vx, y: pr.top + vy };
    }
  } catch {
    /* fall through */
  }

  const page = findPageEl(doc, pageIndex);
  if (!page) return null;
  const pr = page.getBoundingClientRect();
  if (pr.width < 2 || pr.height < 2) return null;

  // Prefer canvas CSS box as the painted page area
  const canvas = page.querySelector("canvas") as HTMLCanvasElement | null;
  const box = canvas?.getBoundingClientRect?.() || pr;

  // Infer PDF page size from viewport.viewBox when available; else US Letter
  let pdfW = 612;
  let pdfH = 792;
  try {
    const pageView =
      win?.PDFViewerApplication?.pdfViewer?.getPageView?.(pageIndex);
    const vb = pageView?.viewport?.viewBox as number[] | undefined;
    if (vb && vb.length >= 4) {
      pdfW = Math.max(1, (vb[2] ?? 612) - (vb[0] ?? 0));
      pdfH = Math.max(1, (vb[3] ?? 792) - (vb[1] ?? 0));
    } else {
      const raw = (pageView as any)?.pdfPage?.view as number[] | undefined;
      if (raw && raw.length >= 4) {
        pdfW = Math.max(1, raw[2]! - raw[0]!);
        pdfH = Math.max(1, raw[3]! - raw[1]!);
      }
    }
  } catch {
    /* ignore */
  }

  // PDF origin bottom-left → CSS top-left
  return {
    x: box.left + (pdfX / pdfW) * box.width,
    y: box.top + (1 - pdfY / pdfH) * box.height,
  };
}

/** Page index for ordering (0-based). Unknown → large number. */
export function stickyPageIndex(note: StickyNote): number {
  const p =
    note.pdfLocation?.position?.pageIndex ?? note.pdfLocation?.pageIndex;
  if (typeof p === "number" && Number.isFinite(p)) return p;
  const lab = note.pageLabel ? parseInt(String(note.pageLabel), 10) : NaN;
  if (Number.isFinite(lab) && lab > 0) return lab - 1;
  return 9999;
}

/** Sort stickies in reading order: page → PDF y → createdAt. */
export function sortStickiesByPaperOrder(notes: StickyNote[]): StickyNote[] {
  return [...notes].sort((a, b) => {
    const pa = stickyPageIndex(a);
    const pb = stickyPageIndex(b);
    if (pa !== pb) return pa - pb;
    const ya = a.pdfLocation?.position?.rects?.[0]?.[1] ?? a.y ?? 0;
    const yb = b.pdfLocation?.position?.rects?.[0]?.[1] ?? b.y ?? 0;
    if (ya !== yb) return ya - yb;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

/**
 * Live screen point for the quoted region (recomputed every draw so scroll works).
 * Always recompute from PDF page/rects — never trust stale quoteAnchor alone after scroll.
 */

function resolveQuoteAnchor(
  doc: Document,
  note: StickyNote,
  reader: any,
): { x: number; y: number } | null {
  const pageIndex =
    note.pdfLocation?.position?.pageIndex ?? note.pdfLocation?.pageIndex;
  const rects = note.pdfLocation?.position?.rects;

  // Prefer docs that host PDF pages first (nested PDF.js iframe)
  const docs: Document[] = [];
  try {
    for (const d of readerDocCandidates(reader)) {
      if (!docs.includes(d)) docs.push(d);
    }
  } catch {
    /* ignore */
  }
  if (!docs.includes(doc)) docs.push(doc);
  docs.sort((a, b) => Number(docHasPdfPages(b)) - Number(docHasPdfPages(a)));

  if (pageIndex != null && Number.isFinite(pageIndex)) {
    for (const d of docs) {
      try {
        const r0 = rects?.[0];
        if (r0 && r0.length >= 4) {
          const x1 = r0[0] ?? 0;
          const y1 = r0[1] ?? 0;
          const x2 = r0[2] ?? 0;
          const y2 = r0[3] ?? 0;

          // Prefer PDF.js convertToViewportPoint on both corners (Zotero style)
          const win = d.defaultView as unknown as {
            PDFViewerApplication?: {
              pdfViewer?: {
                getPageView?: (i: number) => {
                  viewport?: {
                    convertToViewportPoint: (x: number, y: number) => number[];
                  };
                  div?: HTMLElement;
                };
              };
            };
          } | null;
          const pageView =
            win?.PDFViewerApplication?.pdfViewer?.getPageView?.(pageIndex);
          if (pageView?.viewport?.convertToViewportPoint && pageView.div) {
            // Zotero p2v corner order
            const a = pageView.viewport.convertToViewportPoint(x1, y1);
            const b = pageView.viewport.convertToViewportPoint(x2, y2);
            const vx1 = Math.min(a[0] ?? 0, b[0] ?? 0);
            const vx2 = Math.max(a[0] ?? 0, b[0] ?? 0);
            const vy1 = Math.min(a[1] ?? 0, b[1] ?? 0);
            const pr = pageView.div.getBoundingClientRect();
            // Skip off-screen-ish pages with zero size
            if (pr.width < 2 || pr.height < 2) continue;
            // Point is in PDF iframe client space → map into sticky host (shell)
            const local = {
              x: pr.left + (vx1 + vx2) / 2,
              y: pr.top + vy1,
            };
            return mapClientPointToDoc(d, doc, local.x, local.y);
          }

          const midX = (x1 + x2) / 2;
          const midY = (Math.max(y1, y2) + Math.min(y1, y2)) / 2;
          const pt = pdfPointToClient(d, pageIndex, midX, midY);
          if (pt) return mapClientPointToDoc(d, doc, pt.x, pt.y);
        }

        // Page known but no rects — pin near top-left of page (still scroll-synced)
        const page = findPageEl(d, pageIndex);
        if (page) {
          const pr = page.getBoundingClientRect();
          if (pr.width > 2 && pr.height > 2) {
            return mapClientPointToDoc(
              d,
              doc,
              pr.left + 24,
              pr.top + Math.min(48, pr.height * 0.15),
            );
          }
        }
      } catch {
        /* try next doc */
      }
    }
  }

  // Last resort: static capture-time anchor (wrong after scroll — only if nothing else)
  if (
    note.quoteAnchor &&
    Number.isFinite(note.quoteAnchor.x) &&
    Number.isFinite(note.quoteAnchor.y)
  ) {
    // If anchor was captured in a nested PDF iframe, map into host
    for (const d of docs) {
      if (d === doc) continue;
      if (docHasPdfPages(d)) {
        return mapClientPointToDoc(
          d,
          doc,
          note.quoteAnchor.x,
          note.quoteAnchor.y,
        );
      }
    }
    return note.quoteAnchor;
  }
  return null;
}

/**
 * Clear previous region boxes painted inside PDF page divs.
 * Regions live ON the page (not shell SVG) so left/right panels can't desync them.
 */

function clearPdfRegionBoxes(reader: any, noteIds?: Set<string>): void {
  try {
    for (const d of readerDocCandidates(reader)) {
      const nodes = d.querySelectorAll?.("[data-paperai-region]");
      if (!nodes) continue;
      for (const node of Array.from(nodes)) {
        const el = node as Element;
        const id = el.getAttribute("data-paperai-region") || "";
        if (noteIds && !noteIds.has(id)) continue;
        try {
          el.remove();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Draw dashed region boxes as absolute children of the PDF.js page div.
 * Same coordinate model as Zotero annotations (p2v) — immune to shell sidebars.
 */
function drawRegionOutline(
  _hostDoc: Document,
  _svg: SVGSVGElement,
  note: StickyNote,

  reader: any,
  color: string,
  _NS: string,
): void {
  const pageIndex =
    note.pdfLocation?.position?.pageIndex ?? note.pdfLocation?.pageIndex;
  const rects = note.pdfLocation?.position?.rects;
  if (pageIndex == null || !rects?.length) return;

  const docs: Document[] = [];
  try {
    for (const d of readerDocCandidates(reader)) {
      if (!docs.includes(d)) docs.push(d);
    }
  } catch {
    /* ignore */
  }
  docs.sort((a, b) => Number(docHasPdfPages(b)) - Number(docHasPdfPages(a)));

  for (const d of docs) {
    try {
      const win = d.defaultView as unknown as {
        PDFViewerApplication?: {
          pdfViewer?: {
            getPageView?: (i: number) => {
              viewport?: {
                convertToViewportPoint: (x: number, y: number) => number[];
                width?: number;
                height?: number;
              };
              div?: HTMLElement;
            };
          };
        };
      } | null;
      const pageView =
        win?.PDFViewerApplication?.pdfViewer?.getPageView?.(pageIndex);
      if (!pageView?.viewport?.convertToViewportPoint || !pageView.div) {
        continue;
      }
      const pageDiv = pageView.div;
      const viewport = pageView.viewport;
      // Page div is the annotation coordinate root in PDF.js / Zotero
      try {
        const cs = d.defaultView?.getComputedStyle?.(pageDiv);
        if (cs && cs.position === "static") {
          pageDiv.style.position = "relative";
        }
      } catch {
        pageDiv.style.position = "relative";
      }

      for (const r of rects) {
        if (!r || r.length < 4) continue;
        // Zotero p2v: convertToViewportPoint on both corners (PDF bottom-left origin)
        const a = viewport.convertToViewportPoint(r[0]!, r[1]!);
        const b = viewport.convertToViewportPoint(r[2]!, r[3]!);
        const vx1 = a[0] ?? 0;
        const vy1 = a[1] ?? 0;
        const vx2 = b[0] ?? 0;
        const vy2 = b[1] ?? 0;
        const left = Math.min(vx1, vx2);
        const top = Math.min(vy1, vy2);
        const width = Math.abs(vx2 - vx1);
        const height = Math.abs(vy2 - vy1);
        if (width < 2 || height < 2) continue;

        const box = d.createElement("div");
        box.setAttribute("data-paperai-region", note.id);
        Object.assign(box.style, {
          position: "absolute",
          left: `${left}px`,
          top: `${top}px`,
          width: `${width}px`,
          height: `${height}px`,
          border: `2px dashed ${color}`,
          background: color.startsWith("#")
            ? `${color}22`
            : "rgba(255,152,0,0.12)",
          boxSizing: "border-box",
          borderRadius: "2px",
          pointerEvents: "none",
          zIndex: "3",
        } as CSSStyleDeclaration);
        pageDiv.appendChild(box);
      }
      return;
    } catch {
      /* try next doc */
    }
  }
}

/**
 * Map a client point from one document viewport into another.
 * Prefers Firefox/Zotero mozInnerScreenX (correct with sidebars + nested iframes).
 */
function mapClientPointToDoc(
  fromDoc: Document,
  toDoc: Document,
  x: number,
  y: number,
): { x: number; y: number } {
  if (fromDoc === toDoc) return { x, y };
  try {
    const fromWin = fromDoc.defaultView as any;

    const toWin = toDoc.defaultView as any;
    if (fromWin && toWin) {
      const fsx = fromWin.mozInnerScreenX;
      const fsy = fromWin.mozInnerScreenY;
      const tsx = toWin.mozInnerScreenX;
      const tsy = toWin.mozInnerScreenY;
      if (
        Number.isFinite(fsx) &&
        Number.isFinite(fsy) &&
        Number.isFinite(tsx) &&
        Number.isFinite(tsy)
      ) {
        return { x: x + fsx - tsx, y: y + fsy - tsy };
      }
    }
  } catch {
    /* fall through */
  }
  try {
    const fe = fromDoc.defaultView?.frameElement as HTMLElement | null;
    if (fe) {
      const r = fe.getBoundingClientRect();
      const parentDoc = fe.ownerDocument;
      if (parentDoc === toDoc) {
        return { x: r.left + x, y: r.top + y };
      }
      let accX = x + r.left;
      let accY = y + r.top;
      let cur: Document | null = parentDoc;
      while (cur && cur !== toDoc) {
        const nextFe = cur.defaultView?.frameElement as HTMLElement | null;
        if (!nextFe) break;
        const nr = nextFe.getBoundingClientRect();
        accX += nr.left;
        accY += nr.top;
        cur = nextFe.ownerDocument;
      }
      if (cur === toDoc) return { x: accX, y: accY };
    }
  } catch {
    /* ignore */
  }
  return { x, y };
}

function redrawConnectors(
  doc: Document,
  host: HTMLElement,
  notes: StickyNote[],

  reader: any,
): void {
  const svg = ensureConnectorSvg(host, doc);
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const NS = "http://www.w3.org/2000/svg";
  const vw = doc.defaultView?.innerWidth || 2000;
  const vh = doc.defaultView?.innerHeight || 2000;
  let drawn = 0;
  let skippedNoCard = 0;
  let skippedNoAnchor = 0;

  // Regions are painted on PDF page divs (not shell SVG)
  const activeIds = new Set(notes.map((n) => n.id));
  clearPdfRegionBoxes(reader, activeIds);

  for (const note of notes) {
    const card = host.querySelector(
      `[${CARD_ATTR}="${note.id}"]`,
    ) as HTMLElement | null;
    if (!card) {
      skippedNoCard++;
      continue;
    }
    const color = kindColor(note.kind);
    // Region outline on PDF page (sidebar-safe)
    drawRegionOutline(doc, svg, note, reader, color, NS);

    const anchor = resolveQuoteAnchor(doc, note, reader);
    if (!anchor) {
      skippedNoAnchor++;
      continue;
    }
    const cr = card.getBoundingClientRect();
    // Skip if card not laid out yet
    if (cr.width < 2 && cr.height < 2) continue;

    const cx = cr.left + cr.width / 2;
    const cy = cr.top + Math.min(22, cr.height / 2);
    let fromX = cr.left;
    let fromY = cy;
    if (anchor.x > cx) fromX = cr.right;
    if (Math.abs(anchor.y - cy) > Math.abs(anchor.x - cx) * 0.6) {
      fromX = cx;
      fromY = anchor.y < cy ? cr.top : cr.bottom;
    }
    // Keep endpoints near viewport but allow slight overflow
    const toX = Math.max(-40, Math.min(vw + 40, anchor.x));
    const toY = Math.max(-40, Math.min(vh + 40, anchor.y));

    // Halo underlay for contrast on any background
    const halo = doc.createElementNS(NS, "line");
    halo.setAttribute("x1", String(fromX));
    halo.setAttribute("y1", String(fromY));
    halo.setAttribute("x2", String(toX));
    halo.setAttribute("y2", String(toY));
    halo.setAttribute("stroke", "#ffffff");
    halo.setAttribute("stroke-width", "4");
    halo.setAttribute("stroke-linecap", "round");
    halo.setAttribute("opacity", "0.85");
    svg.appendChild(halo);

    const line = doc.createElementNS(NS, "line");
    line.setAttribute("x1", String(fromX));
    line.setAttribute("y1", String(fromY));
    line.setAttribute("x2", String(toX));
    line.setAttribute("y2", String(toY));
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", "2.2");
    line.setAttribute("stroke-dasharray", "6 5");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("opacity", "0.95");
    line.setAttribute("data-paperai-connector", note.id);
    svg.appendChild(line);

    const dot = doc.createElementNS(NS, "circle");
    dot.setAttribute("cx", String(toX));
    dot.setAttribute("cy", String(toY));
    dot.setAttribute("r", "5");
    dot.setAttribute("fill", color);
    dot.setAttribute("stroke", "#fff");
    dot.setAttribute("stroke-width", "1.5");
    dot.setAttribute("opacity", "0.95");
    svg.appendChild(dot);

    const dot2 = doc.createElementNS(NS, "circle");
    dot2.setAttribute("cx", String(fromX));
    dot2.setAttribute("cy", String(fromY));
    dot2.setAttribute("r", "4");
    dot2.setAttribute("fill", color);
    dot2.setAttribute("stroke", "#fff");
    dot2.setAttribute("stroke-width", "1.2");
    dot2.setAttribute("opacity", "0.85");
    svg.appendChild(dot2);

    drawn++;
  }

  if (notes.length > 0) {
    diag("sticky", "connectors", {
      notes: notes.length,
      drawn,
      skippedNoCard,
      skippedNoAnchor,
      pages: doc.querySelectorAll("[data-page-number], .page").length,
      hasPdfApp: !!(
        doc.defaultView as unknown as { PDFViewerApplication?: unknown }
      )?.PDFViewerApplication,
    });
  }
}

const SCROLL_HOOK = "__paperaiConnectorScroll";
const SCROLL_CLEANUP = "__paperaiConnectorScrollCleanup";
const RAF_HOOK = "__paperaiConnectorRaf";

/**
 * Keep dashed connectors + region outlines synced with:
 * - sticky drag (caller redraw)
 * - PDF scroll / zoom / rotate (nested iframe + PDF.js eventBus)
 * - window resize
 */

function installConnectorScrollHook(
  hostDoc: Document,
  reader: any,
  redraw: () => void,
): void {
  const root = hostDoc as any;
  // Always refresh the active redraw fn (remounts swap closures)
  root[SCROLL_HOOK] = redraw;

  // Tear down previous listeners from prior mount
  try {
    (root[SCROLL_CLEANUP] as (() => void) | undefined)?.();
  } catch {
    /* ignore */
  }

  let ticking = false;
  const schedule = () => {
    if (ticking) return;
    ticking = true;
    const w = hostDoc.defaultView;
    const raf =
      w?.requestAnimationFrame?.bind(w) ||
      ((cb: () => void) => setTimeout(cb, 16));
    raf(() => {
      ticking = false;
      try {
        (root[SCROLL_HOOK] as () => void)?.();
      } catch {
        /* ignore */
      }
    });
  };

  const cleanups: Array<() => void> = [];
  const on = (
    target: EventTarget | null | undefined,
    type: string,
    opts?: boolean | AddEventListenerOptions,
  ) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, schedule, opts as AddEventListenerOptions);
    cleanups.push(() => {
      try {
        target.removeEventListener(
          type,
          schedule,
          opts as EventListenerOptions,
        );
      } catch {
        /* ignore */
      }
    });
  };

  const docs: Document[] = [hostDoc];
  try {
    for (const d of readerDocCandidates(reader)) {
      if (!docs.includes(d)) docs.push(d);
    }
  } catch {
    /* ignore */
  }

  for (const d of docs) {
    on(d, "scroll", true);
    on(d, "wheel", { passive: true, capture: true });
    on(d.defaultView, "resize");
    on(d.defaultView, "scroll", true);
    const viewer =
      d.getElementById("viewerContainer") ||
      d.querySelector("#viewer") ||
      d.querySelector(".pdfViewer") ||
      d.querySelector("#mainContainer") ||
      d.querySelector("#viewerContainer");
    on(viewer, "scroll", true);
    // PDF.js view updates (scroll/zoom) — critical for nested iframe sync
    try {
      const app = (
        d.defaultView as unknown as {
          PDFViewerApplication?: {
            eventBus?: {
              on?: (name: string, fn: () => void) => void;
              off?: (name: string, fn: () => void) => void;
            };
          };
        }
      )?.PDFViewerApplication;
      const bus = app?.eventBus;
      if (bus?.on) {
        for (const ev of [
          "updateviewarea",
          "scalechanging",
          "scalechanged",
          "rotationchanging",
          "pagechanging",
          "pagerendered",
        ]) {
          try {
            bus.on(ev, schedule);
            cleanups.push(() => {
              try {
                bus.off?.(ev, schedule);
              } catch {
                /* ignore */
              }
            });
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Light rAF heartbeat while stickies are mounted (catches missed scroll targets)
  try {
    const prev = root[RAF_HOOK] as number | undefined;
    if (prev && hostDoc.defaultView?.cancelAnimationFrame) {
      hostDoc.defaultView.cancelAnimationFrame(prev);
    }
  } catch {
    /* ignore */
  }
  let frames = 0;
  const beat = () => {
    frames++;
    // Redraw every 2nd frame (~30Hz) while alive
    if (frames % 2 === 0) schedule();
    try {
      root[RAF_HOOK] = hostDoc.defaultView?.requestAnimationFrame?.(beat);
    } catch {
      /* ignore */
    }
  };
  // Only run heartbeat for a short settle period after mount, then rely on events.
  // Continuous rAF forever is too expensive — use a 3s burst + event hooks.
  const start = Date.now();
  const burst = () => {
    schedule();
    if (Date.now() - start < 3000) {
      root[RAF_HOOK] = hostDoc.defaultView?.requestAnimationFrame?.(burst);
    } else {
      // After burst, keep a slow interval as safety net (zoom without events)
      const id = hostDoc.defaultView?.setInterval?.(schedule, 250);
      if (id != null) {
        cleanups.push(() => {
          try {
            hostDoc.defaultView?.clearInterval?.(id);
          } catch {
            /* ignore */
          }
        });
      }
    }
  };
  try {
    root[RAF_HOOK] = hostDoc.defaultView?.requestAnimationFrame?.(burst);
  } catch {
    /* ignore */
  }

  root[SCROLL_CLEANUP] = () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    try {
      const rafId = root[RAF_HOOK];
      if (rafId != null) hostDoc.defaultView?.cancelAnimationFrame?.(rafId);
    } catch {
      /* ignore */
    }
  };
}

async function navigateToNote(reader: any, note: StickyNote): Promise<void> {
  try {
    const loc = note.pdfLocation;
    if (reader?.navigate) {
      await reader.navigate({
        pageIndex: loc?.pageIndex ?? loc?.position?.pageIndex,
        pageLabel: loc?.pageLabel || note.pageLabel,
        position: loc?.position,
      });
      diag("sticky", "navigated", {
        id: note.id,
        pageIndex: loc?.pageIndex ?? loc?.position?.pageIndex,
      });
    }
  } catch (e) {
    diag("sticky", "navigate fail", String(e));
  }
}

function renderCard(
  doc: Document,
  note: StickyNote,

  reader: any,
  onClose: () => void,
  onMoved: () => void,
): HTMLElement {
  const size = clampStickySize(
    note.w ?? STICKY_DEFAULT_W,
    note.h ?? STICKY_DEFAULT_H,
  );
  note.w = size.w;
  note.h = size.h;

  const card = doc.createElement("div");
  card.setAttribute(CARD_ATTR, note.id);
  // Clamp into current iframe viewport (host may switch outer ↔ PDF view)
  const vw = doc.defaultView?.innerWidth || 1200;
  const vh = doc.defaultView?.innerHeight || 800;
  const left = Math.max(8, Math.min(note.x, Math.max(8, vw - size.w - 8)));
  const top = Math.max(8, Math.min(note.y, Math.max(8, vh - 48)));
  Object.assign(card.style, {
    position: "fixed",
    left: `${left}px`,
    top: `${top}px`,
    width: `${size.w}px`,
    height: `${size.h}px`,
    display: "flex",
    flexDirection: "column",
    background: "#fffef8",
    border: `1px solid ${kindColor(note.kind)}`,
    borderRadius: "10px",
    boxShadow: "0 4px 18px rgba(0,0,0,.18)",
    font: "12px/1.4 system-ui, sans-serif",
    color: "#1a1a1a",
    pointerEvents: "auto",
    overflow: "hidden",
    zIndex: "2147483001",
    resize: "none",
  } as CSSStyleDeclaration);
  try {
    card.style.userSelect = "text";
  } catch {
    /* ignore */
  }

  const head = doc.createElement("div");
  Object.assign(head.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "6px",
    padding: "6px 8px",
    background: kindColor(note.kind),
    color: "#fff",
    fontWeight: "700",
    cursor: "move",
    userSelect: "none",
  } as CSSStyleDeclaration);
  const title = doc.createElement("span");
  title.style.flex = "1";
  title.style.overflow = "hidden";
  title.style.textOverflow = "ellipsis";
  title.style.whiteSpace = "nowrap";
  title.textContent = `${kindLabel(note.kind)}${note.pageLabel ? ` · p.${note.pageLabel}` : ""}`;
  head.appendChild(title);

  const headBtns = doc.createElement("div");
  Object.assign(headBtns.style, {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    flexShrink: "0",
  } as CSSStyleDeclaration);

  const foldBtn = doc.createElement("button");
  foldBtn.type = "button";
  foldBtn.title = "접기/펼치기";
  Object.assign(foldBtn.style, {
    cursor: "pointer",
    border: "1px solid rgba(255,255,255,.6)",
    background: "transparent",
    color: "#fff",
    fontSize: "11px",
    fontWeight: "700",
    borderRadius: "4px",
    padding: "1px 6px",
    lineHeight: "1.2",
  } as CSSStyleDeclaration);

  const copyBtn = doc.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "복사";
  copyBtn.title = "답변 텍스트 복사";
  Object.assign(copyBtn.style, {
    cursor: "pointer",
    border: "1px solid rgba(255,255,255,.6)",
    background: "transparent",
    color: "#fff",
    fontSize: "11px",
    fontWeight: "600",
    borderRadius: "4px",
    padding: "1px 6px",
  } as CSSStyleDeclaration);
  copyBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  // copyBtn wired after body exists (see below)
  foldBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  headBtns.appendChild(foldBtn);
  headBtns.appendChild(copyBtn);

  const close = doc.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.title = "이 메모 닫기 (저장에서도 삭제)";
  Object.assign(close.style, {
    cursor: "pointer",
    border: "none",
    background: "transparent",
    color: "#fff",
    fontSize: "16px",
    fontWeight: "700",
    lineHeight: "1",
    padding: "0 2px",
  } as CSSStyleDeclaration);
  close.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  close.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClose();
  });
  headBtns.appendChild(close);
  head.appendChild(headBtns);
  card.appendChild(head);

  // Content regions (hidden when collapsed)
  // Figure: show selected region thumbnail so user sees which area was explained
  let imgWrap: HTMLElement | null = null;
  if (note.imageDataUrl && note.kind === "figure") {
    imgWrap = doc.createElement("div");
    Object.assign(imgWrap.style, {
      padding: "6px 8px 0",
      borderBottom: "1px solid #eee",
      background: "#fafafa",
    } as CSSStyleDeclaration);
    const img = doc.createElement("img");
    img.src = note.imageDataUrl;
    img.alt = "선택 영역";
    Object.assign(img.style, {
      display: "block",
      width: "100%",
      maxHeight: "140px",
      objectFit: "contain",
      borderRadius: "6px",
      border: `1px solid ${kindColor(note.kind)}`,
      background: "#fff",
    } as CSSStyleDeclaration);
    imgWrap.appendChild(img);
    card.appendChild(imgWrap);
  }

  let qRow: HTMLElement | null = null;
  if (note.quote) {
    // Selectable quote + separate jump control (so copy works)
    qRow = doc.createElement("div");
    Object.assign(qRow.style, {
      display: "flex",
      gap: "4px",
      alignItems: "flex-start",
      padding: "6px 8px 4px",
      borderBottom: "1px solid #eee",
    } as CSSStyleDeclaration);

    const q = doc.createElement("div");
    q.className = "paperai-sticky-quote";
    Object.assign(q.style, {
      flex: "1",
      color: "#333",
      fontSize: "11px",
      maxHeight: "56px",
      overflow: "auto",
      cursor: "text",
      whiteSpace: "pre-wrap",
    } as CSSStyleDeclaration);
    try {
      q.style.userSelect = "text";
    } catch {
      /* ignore */
    }
    q.textContent = `“${note.quote.slice(0, 280)}${note.quote.length > 280 ? "…" : ""}”`;
    protectTextSelection(q, note.quote);

    const jump = doc.createElement("button");
    jump.type = "button";
    jump.textContent = "↗";
    jump.title = "원문 위치로 이동";
    Object.assign(jump.style, {
      flexShrink: "0",
      cursor: "pointer",
      border: "1px solid #c5c5c5",
      background: "#fff",
      borderRadius: "4px",
      padding: "0 6px",
      fontSize: "12px",
      lineHeight: "20px",
      color: "#1565c0",
    } as CSSStyleDeclaration);
    jump.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    jump.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void navigateToNote(reader, note);
    });

    qRow.appendChild(q);
    qRow.appendChild(jump);
    card.appendChild(qRow);
  }

  const body = doc.createElement("div");
  body.className = "paperai-sticky-body";
  Object.assign(body.style, {
    padding: "8px",
    overflow: "auto",
    flex: "1 1 auto",
    wordBreak: "break-word",
    minHeight: "40px",
    cursor: "text",
    height: "0", // flex child fills remaining card height
  } as CSSStyleDeclaration);
  try {
    body.style.userSelect = "text";
  } catch {
    /* ignore */
  }
  setStickyBodyHtml(body, note.answer || "…");
  protectTextSelection(body, note.answer);
  card.appendChild(body);

  // Header 복사: selection in rendered body if any, else full rendered text
  copyBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const sel = doc.getSelection?.();
      let text = "";
      if (
        sel &&
        !sel.isCollapsed &&
        sel.toString() &&
        card.contains(sel.anchorNode)
      ) {
        text = sel.toString();
      } else {
        text = (body.innerText || body.textContent || note.answer || "").trim();
      }
      if (!text) {
        text = [note.quote ? `인용: ${note.quote}` : "", note.answer || ""]
          .filter(Boolean)
          .join("\n\n");
      }
      if (!text) return;
      const ok = copyTextPrivileged(text);
      copyBtn.textContent = ok ? "됨" : "실패";
      setTimeout(() => {
        copyBtn.textContent = "복사";
      }, 1000);
    } catch {
      copyBtn.textContent = "실패";
      setTimeout(() => {
        copyBtn.textContent = "복사";
      }, 1000);
    }
  });

  // SE resize handle
  const grip = doc.createElement("div");
  grip.title = "드래그해서 크기 조절";
  Object.assign(grip.style, {
    position: "absolute",
    right: "0",
    bottom: "0",
    width: "16px",
    height: "16px",
    cursor: "nwse-resize",
    background:
      "linear-gradient(135deg, transparent 50%, " +
      kindColor(note.kind) +
      " 50%)",
    opacity: "0.85",
    borderBottomRightRadius: "10px",
    flexShrink: "0",
    zIndex: "2",
  } as CSSStyleDeclaration);
  card.appendChild(grip);

  const applyCollapsed = () => {
    const folded = !!note.collapsed;
    foldBtn.textContent = folded ? "▣" : "—";
    foldBtn.title = folded ? "펼치기" : "접기";
    if (imgWrap) imgWrap.style.display = folded ? "none" : "block";
    if (qRow) qRow.style.display = folded ? "none" : "flex";
    body.style.display = folded ? "none" : "";
    body.style.flex = folded ? "0" : "1 1 auto";
    body.style.height = folded ? "auto" : "0";
    grip.style.display = folded ? "none" : "block";
    if (folded) {
      card.style.width = "auto";
      card.style.minWidth = "120px";
      card.style.maxWidth = "220px";
      card.style.height = "auto";
      card.style.maxHeight = "none";
    } else {
      card.style.width = `${note.w ?? STICKY_DEFAULT_W}px`;
      card.style.minWidth = "";
      card.style.maxWidth = "";
      card.style.height = `${note.h ?? STICKY_DEFAULT_H}px`;
    }
    onMoved();
  };
  foldBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    note.collapsed = !note.collapsed;
    applyCollapsed();
    void saveStickies(note.itemKey);
  });
  // Double-click header (not buttons) to fold
  head.addEventListener("dblclick", (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.tagName === "BUTTON" || t?.closest?.("button")) return;
    e.preventDefault();
    e.stopPropagation();
    note.collapsed = !note.collapsed;
    applyCollapsed();
    void saveStickies(note.itemKey);
  });
  applyCollapsed();

  // Drag ONLY from header (not body) so text selection works in content
  let dragging = false;
  let resizing = false;
  let ox = 0;
  let oy = 0;
  let startW = size.w;
  let startH = size.h;
  let startX = 0;
  let startY = 0;
  let activePointer: number | null = null;

  const onPointerDown = (ev: Event) => {
    const e = ev as PointerEvent;
    if (e.button != null && e.button !== 0) return;
    const t = e.target as HTMLElement | null;
    if (t?.tagName === "BUTTON" || t?.closest?.("button")) return;
    // only header itself (title span ok)
    dragging = true;
    activePointer = e.pointerId;
    ox = e.clientX - note.x;
    oy = e.clientY - note.y;
    try {
      head.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const onPointerMove = (ev: Event) => {
    if (!dragging) return;
    const e = ev as PointerEvent;
    if (activePointer != null && e.pointerId !== activePointer) return;
    note.x = Math.max(0, Math.round(e.clientX - ox));
    note.y = Math.max(0, Math.round(e.clientY - oy));
    card.style.left = `${note.x}px`;
    card.style.top = `${note.y}px`;
    // Immediate redraw so dashed connector tracks sticky during drag
    try {
      onMoved();
    } catch {
      /* ignore */
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const onPointerUp = (ev: Event) => {
    if (!dragging) return;
    const e = ev as PointerEvent;
    if (activePointer != null && e.pointerId !== activePointer) return;
    dragging = false;
    activePointer = null;
    try {
      head.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    void saveStickies(note.itemKey);
    onMoved();
    e.preventDefault();
    e.stopPropagation();
  };

  // Bind drag only on head — never on document (that steals text selection)
  head.addEventListener("pointerdown", onPointerDown);
  head.addEventListener("pointermove", onPointerMove);
  head.addEventListener("pointerup", onPointerUp);
  head.addEventListener("pointercancel", onPointerUp);

  const onResizeDown = (ev: Event) => {
    const e = ev as PointerEvent;
    if (e.button != null && e.button !== 0) return;
    resizing = true;
    activePointer = e.pointerId;
    startW = note.w ?? STICKY_DEFAULT_W;
    startH = note.h ?? STICKY_DEFAULT_H;
    startX = e.clientX;
    startY = e.clientY;
    try {
      grip.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const onResizeMove = (ev: Event) => {
    if (!resizing) return;
    const e = ev as PointerEvent;
    if (activePointer != null && e.pointerId !== activePointer) return;
    const next = clampStickySize(
      startW + (e.clientX - startX),
      startH + (e.clientY - startY),
    );
    note.w = next.w;
    note.h = next.h;
    card.style.width = `${next.w}px`;
    card.style.height = `${next.h}px`;
    onMoved();
    e.preventDefault();
    e.stopPropagation();
  };
  const onResizeUp = (ev: Event) => {
    if (!resizing) return;
    const e = ev as PointerEvent;
    if (activePointer != null && e.pointerId !== activePointer) return;
    resizing = false;
    activePointer = null;
    try {
      grip.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    void saveStickies(note.itemKey);
    onMoved();
    e.preventDefault();
    e.stopPropagation();
  };
  grip.addEventListener("pointerdown", onResizeDown);
  grip.addEventListener("pointermove", onResizeMove);
  grip.addEventListener("pointerup", onResizeUp);
  grip.addEventListener("pointercancel", onResizeUp);
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  return card;
}

/** Debounce remounts from toolbar + selection popup firing together. */
let mountTimer: ReturnType<typeof setTimeout> | null = null;
let mountKey = "";

/**
 * Paint stickies once into the primary reader iframe only.
 * Always reloads from disk so re-opening the PDF restores notes.
 */
export async function mountStickiesForReader(
  reader: any,
  itemKey: string,
  opts?: { forceReload?: boolean },
): Promise<void> {
  if (!reader || !itemKey || itemKey === "unknown") return;
  // Coalesce burst remounts (toolbar + popup both call this)
  const token = `${itemKey}:${Date.now()}`;
  mountKey = token;
  if (mountTimer) clearTimeout(mountTimer);
  await new Promise<void>((resolve) => {
    mountTimer = setTimeout(() => resolve(), 50);
  });
  if (mountKey !== token) return;

  const notes = await loadStickies(itemKey, {
    forceReload: opts?.forceReload !== false,
  });
  const doc = primaryReaderDoc(reader);
  cleanupExtraHosts(reader, doc);
  if (!doc) {
    diag("sticky", "no reader doc to mount — will retry via watcher");
    return;
  }

  try {
    if (!doc.body) {
      await new Promise((r) => setTimeout(r, 80));
    }
    const host = ensureHost(doc);
    host.querySelectorAll(`[${CARD_ATTR}]`).forEach((n: Element) => n.remove());
    // keep / recreate svg after clearing cards only
    host.querySelector(`#${SVG_ID}`)?.remove();
    applyHostVisibility(host, itemKey);

    const seen = new Set<string>();
    const active: StickyNote[] = [];
    const redraw = () => {
      if (isStickyOverlayHidden(itemKey)) return;
      redrawConnectors(doc, host, active, reader);
    };

    for (const note of notes) {
      if (!note?.id || seen.has(note.id)) continue;
      seen.add(note.id);
      active.push(note);
      const card = renderCard(
        doc,
        note,
        reader,
        () => {
          void dismissSticky(note.itemKey, note.id, reader);
        },
        redraw,
      );
      host.appendChild(card);
    }
    if (!isStickyOverlayHidden(itemKey)) {
      redraw();
      installConnectorScrollHook(doc, reader, redraw);
      // Re-draw after layout / scroll settle
      setTimeout(redraw, 50);
      setTimeout(redraw, 200);
      setTimeout(redraw, 800);
    }

    diag("sticky", "mounted", {
      itemKey,
      count: seen.size,
      hidden: isStickyOverlayHidden(itemKey),
      hostCards: host.querySelectorAll(`[${CARD_ATTR}]`).length,
      pages: doc.querySelectorAll("[data-page-number], .page").length,
      hasPdfApp: !!(
        doc.defaultView as unknown as { PDFViewerApplication?: unknown }
      )?.PDFViewerApplication,
      svgKids: host.querySelector(`#${SVG_ID}`)?.childElementCount ?? 0,
    });
  } catch (e) {
    diag("sticky", "mount doc fail", String(e));
  }
}

/** Notes for item, paper-order sorted (for panel list). */
export async function listStickiesInPaperOrder(
  itemKey: string,
): Promise<StickyNote[]> {
  const notes = await loadStickies(itemKey, { forceReload: true });
  return sortStickiesByPaperOrder(notes);
}

export async function setStickyCollapsed(
  itemKey: string,
  id: string,
  collapsed: boolean,

  reader?: any,
): Promise<void> {
  const list = await loadStickies(itemKey);
  const n = list.find((x) => x.id === id);
  if (!n) return;
  n.collapsed = collapsed;
  byItem.set(itemKey, list);
  await saveStickies(itemKey);
  if (reader) await mountStickiesForReader(reader, itemKey);
}

/** Expand + bring card to front + navigate to quote. */
export async function focusSticky(
  itemKey: string,
  id: string,

  reader?: any,
): Promise<void> {
  const list = await loadStickies(itemKey);
  const n = list.find((x) => x.id === id);
  if (!n) return;
  n.collapsed = false;
  byItem.set(itemKey, list);
  await saveStickies(itemKey);
  // Panel click should reveal overlay even if user hid stickies
  if (isStickyOverlayHidden(itemKey)) {
    setStickyOverlayHidden(itemKey, false, reader);
  }
  if (reader) {
    await mountStickiesForReader(reader, itemKey);
    await navigateToNote(reader, n);
    try {
      const doc = primaryReaderDoc(reader);
      const card = doc?.querySelector(
        `[${CARD_ATTR}="${id}"]`,
      ) as HTMLElement | null;
      if (card) {
        card.style.zIndex = "2147483010";
        card.style.boxShadow = "0 0 0 2px #1a73e8, 0 6px 20px rgba(0,0,0,.25)";
        setTimeout(() => {
          try {
            card.style.zIndex = "2147483001";
            card.style.boxShadow = "0 4px 18px rgba(0,0,0,.18)";
          } catch {
            /* ignore */
          }
        }, 1600);
      }
    } catch {
      /* ignore */
    }
  }
}

export async function setAllStickiesCollapsed(
  itemKey: string,
  collapsed: boolean,

  reader?: any,
): Promise<void> {
  const list = await loadStickies(itemKey);
  for (const n of list) n.collapsed = collapsed;
  byItem.set(itemKey, list);
  await saveStickies(itemKey);
  if (reader) await mountStickiesForReader(reader, itemKey);
}

/** Background remount so stickies reappear after tab switch / reader reload. */
let watcher: ReturnType<typeof setInterval> | null = null;

export function startStickyWatcher(): void {
  if (watcher) return;
  watcher = setInterval(() => {
    try {
      const Z = (globalThis as any).Zotero;
      if (!Z?.Reader) return;
      const win = Z.getMainWindow?.() || globalThis;
      const tabs = win.Zotero_Tabs;

      let reader: any =
        (tabs?.selectedID && Z.Reader.getByTabID?.(tabs.selectedID)) || null;
      if (!reader && Z.Reader._readers?.length) {
        reader = Z.Reader._readers[Z.Reader._readers.length - 1];
      }
      if (!reader) return;
      const id = reader.itemID ?? reader._item?.id;
      const key =
        reader._item?.parentItem?.key ||
        reader._item?.key ||
        (id != null ? String(id) : "");
      // Prefer open-paper resolution when available
      try {
        // lazy import avoid cycle — use attachment key for path consistency
        const attKey = reader._item?.key || key;
        if (!attKey) return;
        // Only remount if host missing or empty but we have saved notes
        const doc = primaryReaderDoc(reader);
        if (!doc) return;
        const host = doc.getElementById(HOST_ID);
        const hasCards = !!host?.querySelector(`[${CARD_ATTR}]`);
        if (hasCards) return;
        // Try parent key and attachment key
        const keys = [
          reader._item?.parentItem?.key,
          reader._item?.key,
          id != null ? String(id) : null,
        ].filter(Boolean) as string[];
        void (async () => {
          for (const k of keys) {
            const notes = await loadStickies(k, { forceReload: true });
            if (notes.length) {
              await mountStickiesForReader(reader, k, { forceReload: true });
              return;
            }
          }
        })();
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  }, 2000);
}

export function stopStickyWatcher(): void {
  if (watcher) {
    clearInterval(watcher);
    watcher = null;
  }
}

export async function upsertSticky(
  note: Omit<StickyNote, "id" | "createdAt" | "pinned"> & {
    id?: string;
    createdAt?: string;
    pinned?: boolean;
  },

  reader?: any,
): Promise<StickyNote> {
  const itemKey = note.itemKey;
  const list = await loadStickies(itemKey);
  let existing = note.id ? list.find((n) => n.id === note.id) : undefined;
  if (existing) {
    existing.answer = note.answer;
    existing.quote = note.quote ?? existing.quote;
    existing.x = note.x ?? existing.x;
    existing.y = note.y ?? existing.y;
    if (note.w != null) existing.w = note.w;
    if (note.h != null) existing.h = note.h;
    if (note.collapsed != null) existing.collapsed = note.collapsed;
    existing.kind = note.kind ?? existing.kind;
    existing.pageLabel = note.pageLabel ?? existing.pageLabel;
    if (note.pdfLocation) existing.pdfLocation = note.pdfLocation;
    if (note.quoteAnchor) existing.quoteAnchor = note.quoteAnchor;
    if (note.imageDataUrl) existing.imageDataUrl = note.imageDataUrl;
    if (note.annotationKey) existing.annotationKey = note.annotationKey;
  } else {
    existing = {
      id: note.id || uid(),
      itemKey,
      kind: note.kind,
      quote: note.quote || "",
      answer: note.answer || "",
      pageLabel: note.pageLabel,
      x: note.x ?? 24,
      y: note.y ?? 80 + list.length * 28,
      w: note.w ?? STICKY_DEFAULT_W,
      h: note.h ?? STICKY_DEFAULT_H,
      collapsed: note.collapsed === true,
      createdAt: note.createdAt || new Date().toISOString(),
      pinned: note.pinned !== false,
      pdfLocation: note.pdfLocation,
      quoteAnchor: note.quoteAnchor,
      imageDataUrl: note.imageDataUrl,
      annotationKey: note.annotationKey,
    };
    list.push(existing);
  }
  byItem.set(itemKey, list);
  await saveStickies(itemKey);
  if (reader) await mountStickiesForReader(reader, itemKey);
  else {
    // try any open reader
    try {
      const Z = (globalThis as any).Zotero;
      const r =
        Z?.Reader?.getByTabID?.(
          Z?.getMainWindow?.()?.Zotero_Tabs?.selectedID,
        ) || Z?.Reader?._readers?.[Z.Reader._readers.length - 1];
      if (r) await mountStickiesForReader(r, itemKey);
    } catch {
      /* ignore */
    }
  }
  return existing;
}

/** Debounce sticky MD paint during stream (still try real MD each time). */
const stickyStreamTimers = new Map<string, ReturnType<typeof setTimeout>>();

export async function updateStickyAnswer(
  itemKey: string,
  id: string,
  answer: string,

  reader?: any,
  opts?: { final?: boolean },
): Promise<void> {
  const list = await loadStickies(itemKey);
  const n = list.find((x) => x.id === id);
  if (!n) return;
  n.answer = answer;
  byItem.set(itemKey, list);

  const paint = () => {
    for (const doc of reader ? readerDocs(reader) : []) {
      ensureStickyDocStyles(doc);
      const card = doc.querySelector(
        `[${CARD_ATTR}="${id}"]`,
      ) as HTMLElement | null;
      if (!card) continue;
      const body = card.querySelector(
        ".paperai-sticky-body",
      ) as HTMLElement | null;
      if (!body) continue;
      try {
        setStickyBodyHtml(body, answer);
      } catch {
        body.style.whiteSpace = "pre-wrap";
        body.textContent = answer || "…";
      }
    }
  };

  const key = `${itemKey}:${id}`;
  if (opts?.final) {
    const t = stickyStreamTimers.get(key);
    if (t) clearTimeout(t);
    stickyStreamTimers.delete(key);
    paint();
    await saveStickies(itemKey);
    return;
  }

  // Debounced progressive MD (same final string, just incomplete mid-way)
  const prev = stickyStreamTimers.get(key);
  if (prev) clearTimeout(prev);
  stickyStreamTimers.set(
    key,
    setTimeout(() => {
      stickyStreamTimers.delete(key);
      paint();
    }, 120),
  );
  if (answer.length % 500 < 24) await saveStickies(itemKey);
}

export async function dismissSticky(
  itemKey: string,
  id: string,

  reader?: any,
): Promise<void> {
  const list = (await loadStickies(itemKey)).filter((n) => n.id !== id);
  byItem.set(itemKey, list);
  await saveStickies(itemKey);
  if (reader) await mountStickiesForReader(reader, itemKey);
  else {
    // remove from any open docs
    try {
      const Z = (globalThis as any).Zotero;
      for (const r of Z?.Reader?._readers || []) {
        for (const doc of readerDocs(r)) {
          doc.querySelector(`[${CARD_ATTR}="${id}"]`)?.remove();
        }
      }
    } catch {
      /* ignore */
    }
  }
  diag("sticky", "dismissed", { itemKey, id });
}

/**
 * Best-effort card position + PDF location + quote screen anchor.
 */
export function positionFromAnnotationParams(
  params: any,

  reader: any,
): {
  x: number;
  y: number;
  pageLabel?: string;
  pdfLocation?: StickyPdfLocation;
  quoteAnchor?: { x: number; y: number };
} {
  const ann = params?.annotation || {};
  const pageLabel = String(ann.pageLabel || params?.pageLabel || "");
  const pageIndex =
    typeof ann.position?.pageIndex === "number"
      ? ann.position.pageIndex
      : typeof ann.pageIndex === "number"
        ? ann.pageIndex
        : undefined;
  const rects = ann.position?.rects;

  let x = 48;
  let y = 96;
  let quoteAnchor: { x: number; y: number } | undefined;

  try {
    const win = reader?._iframeWindow;
    const vw = win?.innerWidth || 800;
    x = Math.max(16, vw - 340);
    y = 80 + (pageIndex || 0) * 12;

    // Live selection rect in the iframe (best anchor for dashed line)
    const sel = win?.getSelection?.();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r && r.width + r.height > 2) {
        quoteAnchor = {
          x: r.left + r.width / 2,
          y: r.top + Math.min(r.height / 2, 12),
        };
        // Place sticky to the right of selection when possible
        x = Math.min(vw - 320, Math.max(16, r.right + 16));
        y = Math.max(8, r.top - 8);
      }
    }
  } catch {
    /* defaults */
  }

  const pdfLocation: StickyPdfLocation = {
    pageIndex,
    pageLabel: pageLabel || undefined,
    position:
      pageIndex != null || rects
        ? {
            pageIndex,
            rects: Array.isArray(rects) ? rects : undefined,
          }
        : undefined,
  };

  return {
    x,
    y,
    pageLabel: pageLabel || undefined,
    pdfLocation,
    quoteAnchor,
  };
}

export function nextCascadeOffset(itemKey: string): number {
  const n = byItem.get(itemKey)?.length || 0;
  return n * 36;
}

/**
 * Create a highlight+comment annotation so the note lives in the PDF permanently.
 * Best-effort — sticky UI still works if this fails.
 */
export async function saveAsPdfAnnotation(opts: {
  reader: any;
  quote: string;
  answer: string;
  kind: StickyKind;

  annotationParams?: any;
}): Promise<boolean> {
  try {
    const Z = (globalThis as any).Zotero;
    const item =
      opts.reader?._item ||
      (opts.reader?.itemID ? Z.Items.get(opts.reader.itemID) : null);
    if (!item || !Z.Annotations?.saveFromJSON) return false;

    const pos = opts.annotationParams?.annotation?.position || {
      pageIndex: 0,
      rects: [[100, 100, 300, 140]],
    };
    const pageLabel = String(
      opts.annotationParams?.annotation?.pageLabel || "1",
    );
    // Zotero 9 requires key in annotation JSON
    let key = "";
    try {
      key =
        Z.DataObjectUtilities?.generateKey?.() ||
        Z.Utilities?.randomString?.(8, "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ") ||
        Z.randomString?.(8) ||
        "";
    } catch {
      key = "";
    }
    if (!key) {
      const chars = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
      for (let i = 0; i < 8; i++) {
        key += chars[Math.floor(Math.random() * chars.length)];
      }
    }
    const json = {
      key,
      id: key,
      type: "highlight" as const,
      text: opts.quote.slice(0, 2000),
      comment: `[Paper AI · ${kindLabel(opts.kind)}]\n${opts.answer}`.slice(
        0,
        8000,
      ),
      color: kindColor(opts.kind),
      pageLabel,
      sortIndex: "00000|000000|00000",
      position: pos,
      tags: [{ name: "paper-ai", color: "" }],
    };

    await Z.Annotations.saveFromJSON(item, json as any, { skipSelect: true });
    diag("sticky", "saved annotation", { kind: opts.kind });
    return true;
  } catch (e) {
    diag("sticky", "annotation save fail", String(e));
    return false;
  }
}

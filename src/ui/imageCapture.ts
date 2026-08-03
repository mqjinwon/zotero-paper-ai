/**
 * Figure/table image capture — precise selection only (NOT full-page canvas).
 * Sources: image annotations, selection crop, user file pick.
 */

import type { ImagePayload } from "../llm/types";
import { rememberReaderAttachmentId } from "../rag/paperRef";
import { diag } from "../utils/diagnostics";

export function bytesToBase64(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof btoa === "function") {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      binary += String.fromCharCode(...u8.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
  return Buffer.from(u8).toString("base64");
}

export function dataUrlToImagePayload(dataUrl: string): ImagePayload | null {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!m) return null;
  return { mimeType: m[1], base64: m[2].replace(/\s/g, "") };
}

export function imageToDataUrl(img: ImagePayload): string {
  return `data:${img.mimeType || "image/png"};base64,${img.base64}`;
}

export interface CaptureResult {
  image: ImagePayload;
  source: "image-annotation" | "selection-canvas" | "file";
  label?: string;
  /** Zotero annotation key when from Select Area / image annotation */
  annotationKey?: string;
  pageLabel?: string;
  pageIndex?: number;
  /** PDF user-space rects [x1,y1,x2,y2][] when known */
  rects?: number[][];
  /** Client-space box at capture time (for temporary highlight) */
  clientRect?: { left: number; top: number; width: number; height: number };
}

export type { FigureMention } from "./figureContext";
export { extractFigureMentions } from "./figureContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSelectedReaderAny(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Z = (globalThis as any).Zotero;
    const win = Z?.getMainWindow?.() || globalThis;
    const tabs = win.Zotero_Tabs || (globalThis as any).Zotero_Tabs;
    if (Z?.Reader && tabs?.selectedID) {
      const r = Z.Reader.getByTabID(tabs.selectedID);
      if (r) return r;
    }
    if (Z?.Reader?._readers?.length) {
      return Z.Reader._readers[Z.Reader._readers.length - 1];
    }
  } catch {
    /* ignore */
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readerContentWindows(reader: any): Window[] {
  const wins: Window[] = [];
  const push = (w: unknown) => {
    if (w && typeof (w as Window).document !== "undefined") {
      if (!wins.includes(w as Window)) wins.push(w as Window);
    }
  };
  try {
    // Prefer nested PDF.js view (has canvases / pages) over outer shell
    push(reader?._internalReader?._primaryView?._iframeWindow);
    push(reader?._internalReader?._primaryView?._iframe?.contentWindow);
    push(reader?._iframeWindow);
    push(reader?._window);
    push(reader?._iframe?.contentWindow);
  } catch {
    /* ignore */
  }
  // Re-order: windows that actually host PDF pages first
  wins.sort((a, b) => {
    const score = (w: Window) => {
      try {
        const d = w.document;
        if (findPageCanvas(d)) return 2;
        if (d.querySelector?.("[data-page-number], .page")) return 1;
      } catch {
        /* ignore */
      }
      return 0;
    };
    return score(b) - score(a);
  });
  return wins;
}

function findPageCanvas(doc: Document): HTMLCanvasElement | null {
  return (
    (doc.querySelector(".canvasWrapper canvas") as HTMLCanvasElement | null) ||
    (doc.querySelector("#viewer .page canvas") as HTMLCanvasElement | null) ||
    (doc.querySelector("canvas") as HTMLCanvasElement | null)
  );
}

/**
 * Crop ONLY when there is a non-collapsed text/area selection on the page.
 * Does NOT capture the full page.
 */
function tryCanvasSelectionDataUrl(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  win: any,
  canvas: HTMLCanvasElement,
): string | null {
  try {
    const sel = win.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    // Require a reasonably large selection (figure-like region)
    if (!rect || rect.width < 24 || rect.height < 24) return null;

    const cRect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(cRect.width, 1);
    const scaleY = canvas.height / Math.max(cRect.height, 1);
    const sx = Math.max(0, (rect.left - cRect.left) * scaleX);
    const sy = Math.max(0, (rect.top - cRect.top) * scaleY);
    const sw = Math.min(canvas.width - sx, rect.width * scaleX);
    const sh = Math.min(canvas.height - sy, rect.height * scaleY);
    if (sw < 24 || sh < 24) return null;

    const off = canvas.ownerDocument!.createElement("canvas");
    off.width = Math.ceil(sw);
    off.height = Math.ceil(sh);
    const ctx = off.getContext("2d") as unknown as {
      drawImage: (
        image: CanvasImageSource,
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        dx: number,
        dy: number,
        dw: number,
        dh: number,
      ) => void;
    } | null;
    if (!ctx) return null;
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, off.width, off.height);
    return off.toDataURL("image/png");
  } catch {
    return null;
  }
}

function isImageAnnotationItem(ann: {
  annotationType?: unknown;
  isImageAnnotation?: () => boolean;
  getField?: (k: string) => unknown;
}): boolean {
  try {
    if (typeof ann.isImageAnnotation === "function" && ann.isImageAnnotation()) {
      return true;
    }
  } catch {
    /* ignore */
  }
  const type =
    ann.annotationType ??
    ann.getField?.("annotationType") ??
    "";
  // Zotero: string "image"|"ink" or numeric ANNOTATION_TYPE_IMAGE=3 / INK=4
  if (type === 3 || type === 4) return true;
  return /image|ink/i.test(String(type));
}

/**
 * Load PNG for a Select Area / image / ink annotation.
 * Official path: Zotero.Annotations.toJSON → cache file (NOT getImageDataURL).
 */
export async function imagePayloadFromAnnotationItem(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ann: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader?: any,
): Promise<ImagePayload | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Z = (globalThis as any).Zotero;
  const key = String(ann?.key || ann?.id || "");

  // 0) In-memory data URL (reader JSON while still open)
  for (const cand of [
    ann?.image,
    ann?.annotationImageDataURL,
    ann?._image,
  ]) {
    if (typeof cand === "string" && cand.startsWith("data:")) {
      const p = dataUrlToImagePayload(cand);
      if (p?.base64) {
        diag("figure", "image from in-memory data URL", { key });
        return p;
      }
    }
  }

  // 1) Official: Annotations.toJSON includes image as data URI when cache exists
  try {
    if (Z?.Annotations?.toJSON && ann?.libraryID != null && ann?.key) {
      const json = await Z.Annotations.toJSON(ann);
      if (json?.image) {
        const p = dataUrlToImagePayload(String(json.image));
        if (p?.base64) {
          diag("figure", "image from Annotations.toJSON", {
            key,
            bytes: p.base64.length,
          });
          return p;
        }
      }
    }
  } catch (e) {
    diag("figure", "Annotations.toJSON fail", String(e));
  }

  // 2) Cache path: ~/.zotero/.../cache/library/{key}.png
  try {
    if (Z?.Annotations?.getCacheImagePath && ann?.libraryID != null && ann?.key) {
      const path = Z.Annotations.getCacheImagePath({
        libraryID: ann.libraryID,
        key: ann.key,
      });
      if (path) {
        const p = await readPathAsImagePayload(String(path));
        if (p?.base64) {
          diag("figure", "image from cache path", { key, path: String(path) });
          return p;
        }
      }
    }
  } catch (e) {
    diag("figure", "cache path read fail", String(e));
  }

  // 3) Crop rendered annotation box from PDF canvas (DOM)
  try {
    const crop = cropAnnotationFromReaderDom(reader || getSelectedReaderAny(), key);
    if (crop?.base64) {
      diag("figure", "image from DOM crop", { key, bytes: crop.base64.length });
      return crop;
    }
  } catch (e) {
    diag("figure", "DOM crop fail", String(e));
  }

  // 4) Crop using annotationPosition rects
  try {
    let pos = ann?.annotationPosition || ann?.position;
    if (typeof pos === "string") {
      try {
        pos = JSON.parse(pos);
      } catch {
        pos = null;
      }
    }
    if (pos?.rects?.length) {
      const crop = cropRectsFromReader(
        reader || getSelectedReaderAny(),
        pos.pageIndex ?? 0,
        pos.rects,
      );
      if (crop?.base64) {
        diag("figure", "image from position rects", {
          key,
          bytes: crop.base64.length,
        });
        return crop;
      }
    }
  } catch (e) {
    diag("figure", "rect crop fail", String(e));
  }

  diag("figure", "no image for annotation", { key });
  return null;
}

/** Crop the on-screen annotation element ([data-annotation-id]) from page canvas. */
function cropAnnotationFromReaderDom(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader: any,
  annotationId: string,
): ImagePayload | null {
  if (!reader || !annotationId) return null;
  for (const win of readerContentWindows(reader)) {
    const doc = win.document;
    if (!doc) continue;
    const el =
      (doc.querySelector(
        `[data-annotation-id="${annotationId}"]`,
      ) as HTMLElement | null) ||
      (doc.querySelector(
        `[data-sidebar-annotation-id="${annotationId}"]`,
      ) as HTMLElement | null);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    // Find canvas under this page
    const page =
      (el.closest(".page") as HTMLElement | null) ||
      (doc.querySelector(".page") as HTMLElement | null);
    const canvas =
      (page?.querySelector("canvas") as HTMLCanvasElement | null) ||
      findPageCanvas(doc);
    if (!canvas) continue;
    const url = cropClientRectFromCanvas(canvas, rect);
    if (url) {
      const p = dataUrlToImagePayload(url);
      if (p) return p;
    }
  }
  // Reader in-memory map
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view: any =
      reader?._internalReader?._primaryView ||
      reader?._internalReader?._views?.[0];
    const mem =
      view?._annotationsByID?.get?.(annotationId) ||
      view?._annotationsByID?.get?.(String(annotationId));
    if (mem?.image && typeof mem.image === "string") {
      return dataUrlToImagePayload(mem.image);
    }
  } catch {
    /* ignore */
  }
  return null;
}

function cropClientRectFromCanvas(
  canvas: HTMLCanvasElement,
  rect: { left: number; top: number; width: number; height: number },
): string | null {
  try {
    const cRect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(cRect.width, 1);
    const scaleY = canvas.height / Math.max(cRect.height, 1);
    const sx = Math.max(0, (rect.left - cRect.left) * scaleX);
    const sy = Math.max(0, (rect.top - cRect.top) * scaleY);
    const sw = Math.min(canvas.width - sx, rect.width * scaleX);
    const sh = Math.min(canvas.height - sy, rect.height * scaleY);
    if (sw < 8 || sh < 8) return null;
    const off = canvas.ownerDocument!.createElement("canvas");
    off.width = Math.ceil(sw);
    off.height = Math.ceil(sh);
    const ctx = off.getContext("2d") as unknown as {
      drawImage: (
        image: CanvasImageSource,
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        dx: number,
        dy: number,
        dw: number,
        dh: number,
      ) => void;
    } | null;
    if (!ctx) return null;
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, off.width, off.height);
    return off.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * Crop PDF.js page canvas using PDF user-space rects [x1,y1,x2,y2].
 * Best-effort mapping via page element size (works for typical Zotero scale).
 */
function cropRectsFromReader(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader: any,
  pageIndex: number,
  rects: number[][],
): ImagePayload | null {
  if (!reader || !rects?.length) return null;
  const pageNum = (pageIndex ?? 0) + 1;
  for (const win of readerContentWindows(reader)) {
    const doc = win.document;
    if (!doc) continue;
    const page =
      (doc.querySelector(
        `.page[data-page-number="${pageNum}"]`,
      ) as HTMLElement | null) ||
      (doc.querySelectorAll(".page")[pageIndex] as HTMLElement | null);
    if (!page) continue;
    const canvas =
      (page.querySelector("canvas") as HTMLCanvasElement | null) ||
      findPageCanvas(doc);
    if (!canvas) continue;
    const pr = page.getBoundingClientRect();
    // Union of rects in PDF coords
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of rects) {
      if (!r || r.length < 4) continue;
      minX = Math.min(minX, r[0], r[2]);
      maxX = Math.max(maxX, r[0], r[2]);
      minY = Math.min(minY, r[1], r[3]);
      maxY = Math.max(maxY, r[1], r[3]);
    }
    if (!Number.isFinite(minX)) continue;
    // Detect if coords look like CSS pixels already (vs PDF 0–612)
    const pdfLike = maxX > pr.width * 1.2 || maxY > pr.height * 1.2;
    let left: number;
    let top: number;
    let width: number;
    let height: number;
    if (pdfLike) {
      // PDF bottom-left origin → CSS top-left (approx using page box / media)
      const pdfW = Math.max(maxX, 612);
      const pdfH = Math.max(maxY, 792);
      left = pr.left + (minX / pdfW) * pr.width;
      // y from bottom
      top = pr.top + (1 - maxY / pdfH) * pr.height;
      width = ((maxX - minX) / pdfW) * pr.width;
      height = ((maxY - minY) / pdfH) * pr.height;
    } else {
      left = pr.left + minX;
      top = pr.top + minY;
      width = maxX - minX;
      height = maxY - minY;
    }
    if (width < 8 || height < 8) continue;
    const url = cropClientRectFromCanvas(canvas, {
      left,
      top,
      width,
      height,
    });
    if (url) {
      const p = dataUrlToImagePayload(url);
      if (p) return p;
    }
  }
  return null;
}

/**
 * List image annotations on the open PDF attachment (precise figure crops).
 */
export async function listImageAnnotations(): Promise<
  Array<{ key: string; label: string; image: ImagePayload }>
> {
  const out: Array<{ key: string; label: string; image: ImagePayload }> = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Z = (globalThis as any).Zotero;
    const reader = getSelectedReaderAny();
    const item =
      reader?._item ||
      (reader?.itemID ? Z.Items.get(reader.itemID) : null);
    if (!item) {
      diag("figure", "no item for annotations");
      return out;
    }
    if (item.id) rememberReaderAttachmentId(item.id);

    const anns =
      typeof item.getAnnotations === "function" ? item.getAnnotations() : [];
    diag("figure", "annotations count", anns?.length ?? 0);

    for (const ann of anns || []) {
      try {
        if (!isImageAnnotationItem(ann)) continue;
        const image = await imagePayloadFromAnnotationItem(ann, reader);
        if (!image?.base64) continue;

        const comment =
          ann.annotationComment ||
          ann.getField?.("annotationComment") ||
          ann.annotationText ||
          "";
        const page = ann.annotationPageLabel || ann.annotationPage || "";
        const label = comment
          ? String(comment).slice(0, 80)
          : `Image annotation${page ? ` p.${page}` : ""}`;
        out.push({
          key: String(ann.key || ann.id || out.length),
          label,
          image,
        });
      } catch (e) {
        diag("figure", "ann parse err", String(e));
      }
    }
  } catch (e) {
    diag("figure", "listImageAnnotations err", String(e));
  }
  diag("figure", "image annotations usable", out.length);
  return out;
}

/**
 * Precise capture only: selection crop → image annotation → (optional) file.
 * Never returns full-page canvas.
 */
export async function capturePreciseFigure(opts?: {
  allowFilePicker?: boolean;
  preferAnnotationKey?: string;
}): Promise<CaptureResult | null> {
  const reader = getSelectedReaderAny();
  if (reader) {
    const attId = reader.itemID ?? reader._item?.id;
    if (attId) rememberReaderAttachmentId(attId);
  }

  // 1) Selection region crop (user must select a region / text box)
  try {
    for (const win of reader ? readerContentWindows(reader) : []) {
      const canvas = findPageCanvas(win.document);
      if (!canvas) continue;
      const selUrl = tryCanvasSelectionDataUrl(win, canvas);
      if (selUrl) {
        const image = dataUrlToImagePayload(selUrl);
        if (image?.base64) {
          diag("figure", "selection crop ok", { bytes: image.base64.length });
          return { image, source: "selection-canvas", label: "선택 영역" };
        }
      }
    }
  } catch (e) {
    diag("figure", "selection crop err", String(e));
  }

  // 2) Image annotations (user-drawn figure boxes in Zotero)
  const anns = await listImageAnnotations();
  if (anns.length) {
    const pick =
      (opts?.preferAnnotationKey &&
        anns.find((a) => a.key === opts.preferAnnotationKey)) ||
      anns[0];
    return {
      image: pick.image,
      source: "image-annotation",
      label: pick.label,
    };
  }

  // 3) File pick only if allowed
  if (opts?.allowFilePicker !== false) {
    const file = await pickImageFileAsPayload();
    if (file) {
      diag("figure", "file pick ok");
      return { image: file, source: "file", label: "파일" };
    }
  }

  diag("figure", "no precise figure source");
  return null;
}

async function readPathAsImagePayload(path: string): Promise<ImagePayload | null> {
  if (!path) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const lower = String(path).toLowerCase();
  let mimeType = "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) mimeType = "image/jpeg";
  else if (lower.endsWith(".webp")) mimeType = "image/webp";

  try {
    const IOUtils = g.IOUtils;
    if (IOUtils?.exists && !(await IOUtils.exists(path))) return null;
    if (IOUtils?.read) {
      const bytes = await IOUtils.read(path);
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (u8.length) return { base64: bytesToBase64(u8), mimeType };
    }
  } catch {
    /* try Zotero.File */
  }
  try {
    if (g.Zotero?.File?.generateDataURI) {
      const uri = await g.Zotero.File.generateDataURI(path, mimeType);
      return dataUrlToImagePayload(String(uri || ""));
    }
    if (g.Zotero?.File?.getBinaryContentsAsync) {
      const bin = await g.Zotero.File.getBinaryContentsAsync(path);
      // binary string → base64
      if (typeof bin === "string" && bin.length) {
        if (typeof btoa === "function") {
          return { base64: btoa(bin), mimeType };
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function pickImageFileAsPayload(): Promise<ImagePayload | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ztoolkit = (globalThis as any).ztoolkit;
    if (ztoolkit?.FilePicker) {
      const path = await new ztoolkit.FilePicker(
        "Select figure/table image (not full page)",
        "open",
        [
          ["Images", "*.png; *.jpg; *.jpeg; *.webp"],
          ["All files", "*.*"],
        ],
      ).open();
      if (path) return readPathAsImagePayload(String(path));
    }
  } catch {
    /* XPCOM */
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    const Cc = g.Cc || g.Components?.classes;
    const Ci = g.Ci || g.Components?.interfaces;
    const Services = g.Services;
    if (!Cc || !Ci) return null;
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    const win =
      g.Zotero?.getMainWindow?.() ||
      Services?.wm?.getMostRecentWindow?.("navigator:browser") ||
      null;
    if (!win) return null;
    fp.init(
      win.browsingContext || win,
      "Select figure/table image",
      Ci.nsIFilePicker.modeOpen,
    );
    fp.appendFilters(Ci.nsIFilePicker.filterImages);
    const result = await new Promise<number>((resolve) => {
      fp.open((rv: number) => resolve(rv));
    });
    if (
      result !== Ci.nsIFilePicker.returnOK &&
      result !== Ci.nsIFilePicker.returnReplace
    ) {
      return null;
    }
    const path = fp.file?.path || fp.domFile?.mozFullPath;
    if (!path) return null;
    return readPathAsImagePayload(String(path));
  } catch {
    return null;
  }
}

/**
 * Load a single Select Area / image / ink annotation by key.
 * Tries: item API → Annotations.toJSON/cache → DOM crop → position rects.
 */
export async function captureAnnotationByKey(
  annotationKey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader?: any,
): Promise<CaptureResult | null> {
  if (!annotationKey) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Z = (globalThis as any).Zotero;
  const r = reader || getSelectedReaderAny();

  // Fast path: DOM / in-memory (works even before cache is flushed)
  try {
    const domImg = cropAnnotationFromReaderDom(r, annotationKey);
    if (domImg?.base64) {
      const loc = annotationLocationFromReader(r, annotationKey);
      return {
        image: domImg,
        source: "image-annotation",
        label: "선택 영역",
        annotationKey,
        ...loc,
      };
    }
  } catch {
    /* continue */
  }

  try {
    const item =
      r?._item || (r?.itemID != null ? Z.Items.get(r.itemID) : null);
    if (item?.id) rememberReaderAttachmentId(item.id);

    // Resolve annotation item by key
    let ann: unknown = null;
    if (item?.libraryID != null && Z.Items?.getByLibraryAndKey) {
      ann = Z.Items.getByLibraryAndKey(item.libraryID, annotationKey);
    }
    if (!ann && typeof item?.getAnnotations === "function") {
      for (const a of item.getAnnotations() || []) {
        const k = String(a.key || a.id || "");
        if (k === annotationKey || String(a.id) === annotationKey) {
          ann = a;
          break;
        }
      }
    }

    if (ann) {
      const image = await imagePayloadFromAnnotationItem(ann, r);
      if (image?.base64) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = ann as any;
        const label = String(
          a.annotationComment || a.annotationText || "선택 영역",
        ).slice(0, 80);
        const loc = locationFromAnnotationItem(a) ||
          annotationLocationFromReader(r, annotationKey);
        return {
          image,
          source: "image-annotation",
          label,
          annotationKey,
          ...loc,
        };
      }
    }

    // Last resort: any list match
    const anns = await listImageAnnotations();
    const hit =
      anns.find((a) => a.key === annotationKey) ||
      (anns.length === 1 ? anns[0] : undefined);
    if (hit) {
      const loc = annotationLocationFromReader(r, annotationKey);
      return {
        image: hit.image,
        source: "image-annotation",
        label: hit.label,
        annotationKey: hit.key,
        ...loc,
      };
    }
  } catch (e) {
    diag("figure", "captureAnnotationByKey err", String(e));
  }
  return null;
}

/** Parse pageIndex / rects / pageLabel from a Zotero annotation item. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function locationFromAnnotationItem(ann: any): {
  pageLabel?: string;
  pageIndex?: number;
  rects?: number[][];
} {
  if (!ann) return {};
  let pageLabel =
    ann.annotationPageLabel != null
      ? String(ann.annotationPageLabel)
      : ann.pageLabel != null
        ? String(ann.pageLabel)
        : undefined;
  let pageIndex: number | undefined;
  let rects: number[][] | undefined;
  try {
    let pos = ann.annotationPosition ?? ann.position;
    if (typeof pos === "string") {
      try {
        pos = JSON.parse(pos);
      } catch {
        pos = null;
      }
    }
    if (pos && typeof pos === "object") {
      if (typeof pos.pageIndex === "number") pageIndex = pos.pageIndex;
      if (Array.isArray(pos.rects)) rects = pos.rects as number[][];
    }
  } catch {
    /* ignore */
  }
  if (pageIndex == null && pageLabel) {
    const n = parseInt(pageLabel, 10);
    if (Number.isFinite(n) && n > 0) pageIndex = n - 1;
  }
  return { pageLabel, pageIndex, rects };
}

/**
 * Best-effort location from live reader annotation map / DOM.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function annotationLocationFromReader(
  reader: any,
  annotationKey: string,
): {
  pageLabel?: string;
  pageIndex?: number;
  rects?: number[][];
  clientRect?: { left: number; top: number; width: number; height: number };
} {
  if (!reader || !annotationKey) return {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view: any =
      reader?._internalReader?._primaryView ||
      reader?._internalReader?._views?.[0];
    const mem =
      view?._annotationsByID?.get?.(annotationKey) ||
      view?._annotationsByID?.get?.(String(annotationKey));
    if (mem) {
      const pos = mem.position || {};
      const pageIndex =
        typeof pos.pageIndex === "number" ? pos.pageIndex : undefined;
      const rects = Array.isArray(pos.rects) ? pos.rects : undefined;
      const pageLabel =
        mem.pageLabel != null ? String(mem.pageLabel) : undefined;
      return { pageLabel, pageIndex, rects };
    }
  } catch {
    /* ignore */
  }
  // DOM hit target
  for (const win of readerContentWindows(reader)) {
    try {
      const el = win.document?.querySelector?.(
        `[data-annotation-id="${annotationKey}"]`,
      ) as HTMLElement | null;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      return {
        clientRect: {
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
        },
      };
    } catch {
      /* ignore */
    }
  }
  return {};
}

/** Map a client-space box to PDF pageIndex + rects when possible. */
function clientBoxToPdfLocation(
  doc: Document,
  left: number,
  top: number,
  width: number,
  height: number,
): {
  pageLabel?: string;
  pageIndex?: number;
  rects?: number[][];
} {
  const cx = left + width / 2;
  const cy = top + height / 2;
  const pages = Array.from(
    doc.querySelectorAll("[data-page-number], .page"),
  ) as HTMLElement[];
  let page: HTMLElement | null = null;
  let pageIndex = 0;
  for (const p of pages) {
    const pr = p.getBoundingClientRect();
    if (
      cx >= pr.left &&
      cx <= pr.right &&
      cy >= pr.top &&
      cy <= pr.bottom
    ) {
      page = p;
      const n = parseInt(p.getAttribute("data-page-number") || "", 10);
      pageIndex = Number.isFinite(n) && n > 0 ? n - 1 : pages.indexOf(p);
      break;
    }
  }
  if (!page && pages[0]) {
    page = pages[0];
    pageIndex = 0;
  }
  if (!page) return {};

  const win = doc.defaultView as unknown as {
    PDFViewerApplication?: {
      pdfViewer?: {
        getPageView?: (i: number) => {
          viewport?: {
            convertToPdfPoint?: (x: number, y: number) => number[];
          };
          div?: HTMLElement;
        };
      };
    };
  } | null;

  try {
    const pageView = win?.PDFViewerApplication?.pdfViewer?.getPageView?.(
      pageIndex,
    );
    const viewport = pageView?.viewport as
      | {
          convertToPdfPoint?: (x: number, y: number) => number[];
          convertToViewportPoint?: (x: number, y: number) => number[];
          width?: number;
          height?: number;
          viewBox?: number[];
        }
      | undefined;
    const div = pageView?.div || page;
    if (div && viewport) {
      const pr = div.getBoundingClientRect();
      const lx1 = left - pr.left;
      const ly1 = top - pr.top;
      const lx2 = left + width - pr.left;
      const ly2 = top + height - pr.top;
      if (typeof viewport.convertToPdfPoint === "function") {
        // Zotero v2p corner pairing
        const a = viewport.convertToPdfPoint(lx1, ly1);
        const b = viewport.convertToPdfPoint(lx2, ly2);
        const x1 = Math.min(a[0] ?? 0, b[0] ?? 0);
        const y1 = Math.min(a[1] ?? 0, b[1] ?? 0);
        const x2 = Math.max(a[0] ?? 0, b[0] ?? 0);
        const y2 = Math.max(a[1] ?? 0, b[1] ?? 0);
        return {
          pageIndex,
          pageLabel: String(pageIndex + 1),
          rects: [[x1, y1, x2, y2]],
        };
      }
      // Fallback: invert convertToViewportPoint via viewBox scale
      const vb = viewport.viewBox;
      const pdfW =
        vb && vb.length >= 4
          ? Math.max(1, (vb[2] ?? 612) - (vb[0] ?? 0))
          : 612;
      const pdfH =
        vb && vb.length >= 4
          ? Math.max(1, (vb[3] ?? 792) - (vb[1] ?? 0))
          : 792;
      const vw = Math.max(1, viewport.width || pr.width);
      const vh = Math.max(1, viewport.height || pr.height);
      // Viewport y grows downward; PDF y grows upward
      const toPdf = (lx: number, ly: number) => {
        const px = (lx / vw) * pdfW;
        const py = (1 - ly / vh) * pdfH;
        return [px, py] as [number, number];
      };
      const [ax, ay] = toPdf(lx1, ly1);
      const [bx, by] = toPdf(lx2, ly2);
      return {
        pageIndex,
        pageLabel: String(pageIndex + 1),
        rects: [
          [
            Math.min(ax, bx),
            Math.min(ay, by),
            Math.max(ax, bx),
            Math.max(ay, by),
          ],
        ],
      };
    }
  } catch {
    /* fall through */
  }

  // Heuristic: treat page CSS box as letter PDF
  const pr = page.getBoundingClientRect();
  const pdfW = 612;
  const pdfH = 792;
  const toPdf = (clientX: number, clientY: number) => {
    const px = ((clientX - pr.left) / Math.max(pr.width, 1)) * pdfW;
    const py = (1 - (clientY - pr.top) / Math.max(pr.height, 1)) * pdfH;
    return [px, py] as [number, number];
  };
  const [x1, yTop] = toPdf(left, top);
  const [x2, yBot] = toPdf(left + width, top + height);
  return {
    pageIndex,
    pageLabel: String(pageIndex + 1),
    rects: [
      [
        Math.min(x1, x2),
        Math.min(yTop, yBot),
        Math.max(x1, x2),
        Math.max(yTop, yBot),
      ],
    ],
  };
}

/**
 * One-shot marquee crop on the PDF canvas (in-reader Select Area alternative).
 * User drags a box; we crop that region and never return a full page.
 */
export async function beginAreaSelectCapture(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader?: any,
): Promise<CaptureResult | null> {
  const r = reader || getSelectedReaderAny();
  if (!r) return null;
  const wins = readerContentWindows(r);
  const win = wins[0];
  if (!win?.document) return null;
  const doc = win.document;
  const canvas = findPageCanvas(doc);
  if (!canvas) {
    diag("figure", "area select: no canvas");
    return null;
  }

  return new Promise((resolve) => {
    const overlay = doc.createElement("div");
    overlay.id = "paperai-area-select-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "100%",
      height: "100%",
      zIndex: "2147483646",
      cursor: "crosshair",
      background: "rgba(26,115,232,0.06)",
      pointerEvents: "auto",
    } as CSSStyleDeclaration);

    const box = doc.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      border: "2px solid #1a73e8",
      background: "rgba(26,115,232,0.12)",
      display: "none",
      pointerEvents: "none",
      zIndex: "2147483647",
    } as CSSStyleDeclaration);

    const hint = doc.createElement("div");
    hint.textContent =
      "영역을 드래그하세요 · Esc 취소 · 그림/표만 포함되게 잘라 주세요";
    Object.assign(hint.style, {
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#1a73e8",
      color: "#fff",
      padding: "6px 12px",
      borderRadius: "8px",
      font: "12px/1.4 system-ui,sans-serif",
      zIndex: "2147483647",
      pointerEvents: "none",
      boxShadow: "0 2px 10px rgba(0,0,0,.2)",
    } as CSSStyleDeclaration);

    let x0 = 0;
    let y0 = 0;
    let dragging = false;
    let done = false;

    const cleanup = () => {
      try {
        overlay.remove();
        box.remove();
        hint.remove();
      } catch {
        /* ignore */
      }
      win.removeEventListener("keydown", onKey, true);
    };

    const finish = (result: CaptureResult | null) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };

    const onKey = (ev: Event) => {
      const e = ev as KeyboardEvent;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };

    overlay.addEventListener("pointerdown", (ev: Event) => {
      const e = ev as PointerEvent;
      if (e.button != null && e.button !== 0) return;
      dragging = true;
      x0 = e.clientX;
      y0 = e.clientY;
      Object.assign(box.style, {
        display: "block",
        left: `${x0}px`,
        top: `${y0}px`,
        width: "0px",
        height: "0px",
      });
      try {
        overlay.setPointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
      e.preventDefault();
      e.stopPropagation();
    });

    overlay.addEventListener("pointermove", (ev: Event) => {
      if (!dragging) return;
      const e = ev as PointerEvent;
      const x1 = e.clientX;
      const y1 = e.clientY;
      const left = Math.min(x0, x1);
      const top = Math.min(y0, y1);
      const w = Math.abs(x1 - x0);
      const h = Math.abs(y1 - y0);
      Object.assign(box.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${w}px`,
        height: `${h}px`,
      });
      e.preventDefault();
      e.stopPropagation();
    });

    overlay.addEventListener("pointerup", (ev: Event) => {
      if (!dragging) return;
      dragging = false;
      const e = ev as PointerEvent;
      const x1 = e.clientX;
      const y1 = e.clientY;
      const left = Math.min(x0, x1);
      const top = Math.min(y0, y1);
      const w = Math.abs(x1 - x0);
      const h = Math.abs(y1 - y0);
      e.preventDefault();
      e.stopPropagation();

      if (w < 24 || h < 24) {
        finish(null);
        return;
      }

      try {
        const cRect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / Math.max(cRect.width, 1);
        const scaleY = canvas.height / Math.max(cRect.height, 1);
        const sx = Math.max(0, (left - cRect.left) * scaleX);
        const sy = Math.max(0, (top - cRect.top) * scaleY);
        const sw = Math.min(canvas.width - sx, w * scaleX);
        const sh = Math.min(canvas.height - sy, h * scaleY);
        if (sw < 24 || sh < 24) {
          finish(null);
          return;
        }
        const off = doc.createElement("canvas");
        off.width = Math.ceil(sw);
        off.height = Math.ceil(sh);
        const ctx = off.getContext("2d") as unknown as {
          drawImage: (
            image: CanvasImageSource,
            sx: number,
            sy: number,
            sw: number,
            sh: number,
            dx: number,
            dy: number,
            dw: number,
            dh: number,
          ) => void;
        } | null;
        if (!ctx) {
          finish(null);
          return;
        }
        ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, off.width, off.height);
        const url = off.toDataURL("image/png");
        const image = dataUrlToImagePayload(url);
        if (!image?.base64) {
          finish(null);
          return;
        }
        diag("figure", "area select crop ok", {
          w: off.width,
          h: off.height,
          bytes: image.base64.length,
        });
        const loc = clientBoxToPdfLocation(doc, left, top, w, h);
        finish({
          image,
          source: "selection-canvas",
          label: "선택 영역",
          clientRect: { left, top, width: w, height: h },
          ...loc,
        });
      } catch (err) {
        diag("figure", "area select crop fail", String(err));
        finish(null);
      }
    });

    win.addEventListener("keydown", onKey, true);
    (doc.body || doc.documentElement)!.appendChild(overlay);
    (doc.body || doc.documentElement)!.appendChild(box);
    (doc.body || doc.documentElement)!.appendChild(hint);
  });
}

/** Convenience: precise capture → image only. */
export async function obtainImageForVision(opts?: {
  allowFilePicker?: boolean;
}): Promise<ImagePayload | null> {
  const cap = await capturePreciseFigure(opts);
  return cap?.image || null;
}

/** Alias for capturePreciseFigure (panel call sites). */
export async function obtainCaptureForVision(opts?: {
  allowFilePicker?: boolean;
}): Promise<CaptureResult | null> {
  return capturePreciseFigure(opts);
}

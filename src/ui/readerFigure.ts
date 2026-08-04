/**
 * Figure explain sticky pipeline + in-reader image annotation buttons.
 */
import { config } from "../../package.json";
import { createZoteroFileStore } from "../auth/fileStore";
import { resolveFeatureConfig } from "../llm/featureConfig";
import { runTask } from "../llm/router";
import { getOrCreateClient } from "../llm/fastTranslate";
import type { ImagePayload } from "../llm/types";
import {
  enrichEvidenceWithPages,
  ensureIndex,
  withEvidenceAnswer,
} from "../rag/index";
import { getOpenPaperRef } from "../rag/paperRef";
import { readRagPrefs } from "../rag/prefs";
import { diag } from "../utils/diagnostics";
import { buildFigureContextBundle, mergeFigureEvidence } from "./figureContext";
import {
  annotationLocationFromReader,
  captureAnnotationByKey,
  dataUrlToImagePayload,
  imageToDataUrl,
  listImageAnnotations,
  locationFromAnnotationItem,
  type CaptureResult,
} from "./imageCapture";
import { attachRagContext } from "./paperTask";
import {
  mountStickiesForReader,
  nextCascadeOffset,
  positionFromAnnotationParams,
  updateStickyAnswer,
  upsertSticky,
  type StickyPdfLocation,
} from "./stickyNotes";
import { itemKeyFromReader, getLastAnnotationParams } from "./readerSelection";

export async function runFigureStickyTask(opts: {
  reader?: any;
  /** Prefer this annotation key (Select Area result) */
  annotationKey?: string;
  /** Pre-captured image */
  capture?: CaptureResult | null;
  pageLabel?: string;
  question?: string;
  statusEl?: HTMLElement | null;
}): Promise<void> {
  const Z = (globalThis as any).Zotero;

  let reader: any = opts.reader;
  if (!reader) {
    try {
      const tabs =
        Z?.getMainWindow?.()?.Zotero_Tabs || (globalThis as any).Zotero_Tabs;
      reader =
        Z?.Reader?.getByTabID?.(tabs?.selectedID) ||
        Z?.Reader?._readers?.[Z.Reader._readers.length - 1];
    } catch {
      /* ignore */
    }
  }

  const setStatus = (msg: string) => {
    if (opts.statusEl) opts.statusEl.textContent = msg;
  };

  let capture = opts.capture || null;
  if (!capture && opts.annotationKey) {
    setStatus("선택 영역 이미지 로드 중…");
    capture = await captureAnnotationByKey(opts.annotationKey, reader);
  }
  // If still missing, try newest image annotation on this PDF
  if (!capture?.image?.base64) {
    setStatus("이미지 주석 다시 찾는 중…");
    try {
      const all = await listImageAnnotations();
      if (all.length) {
        const last = all[all.length - 1];
        capture = {
          image: last.image,
          source: "image-annotation",
          label: last.label,
        };
        diag("figure", "fallback to latest image annotation", {
          key: last.key,
          n: all.length,
        });
      }
    } catch (e) {
      diag("figure", "list fallback fail", String(e));
    }
  }
  if (!capture?.image?.base64) {
    setStatus(
      "이미지를 읽지 못했습니다. Select Area 후 사이드바/우클릭「그림 설명」을 사용하세요.",
    );
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({
        text: "Select Area 이미지를 못 읽음 → 주석 우클릭 또는 이미지 우측「그림 설명」",
        type: "fail",
      })
      .show();
    return;
  }

  const image: ImagePayload = capture.image;
  const itemKey = itemKeyFromReader(reader);
  const pos = positionFromAnnotationParams(getLastAnnotationParams(), reader);
  pos.y += nextCascadeOffset(itemKey);

  // Prefer location from the figure annotation / capture (not last text selection)
  const annKey = opts.annotationKey || capture.annotationKey;
  let pageLabel =
    opts.pageLabel || capture.pageLabel || pos.pageLabel || undefined;
  let pageIndex =
    capture.pageIndex ??
    pos.pdfLocation?.position?.pageIndex ??
    pos.pdfLocation?.pageIndex;
  let rects = capture.rects || pos.pdfLocation?.position?.rects || undefined;
  if (annKey) {
    const loc = annotationLocationFromReader(reader, annKey);
    if (loc.pageIndex != null) pageIndex = loc.pageIndex;
    if (loc.pageLabel) pageLabel = loc.pageLabel;
    if (loc.rects?.length) rects = loc.rects;
  }
  if (pageLabel == null && pageIndex != null) {
    pageLabel = String(pageIndex + 1);
  }

  const pdfLocation: StickyPdfLocation | undefined =
    pageIndex != null || rects
      ? {
          pageIndex,
          pageLabel: pageLabel || undefined,
          position: {
            pageIndex,
            rects: Array.isArray(rects) ? rects : undefined,
          },
        }
      : pos.pdfLocation;

  // Place sticky near the figure when we know a client rect.
  // clientRect is often in nested PDF.js coords — prefer shell window size for placement.
  let x = pos.x;
  let y = pos.y;
  if (capture.clientRect) {
    try {
      const shellWin =
        reader?._iframeWindow ||
        reader?._iframe?.contentWindow ||
        reader?._internalReader?._primaryView?._iframeWindow;
      const vw = shellWin?.innerWidth || 900;
      // Use right side of reader for sticky; region is tracked via PDF rects
      x = Math.max(16, vw - 340);
      y = Math.max(
        8,
        Math.min(capture.clientRect.top, (shellWin?.innerHeight || 800) - 120),
      );
    } catch {
      /* keep pos */
    }
  }

  let imageDataUrl: string | undefined;
  try {
    const full = imageToDataUrl(image);
    // Cap sticky JSON (~300KB) so disk notes stay usable; region outline still works without thumb
    if (full.length <= 300_000) imageDataUrl = full;
  } catch {
    /* ignore */
  }

  // Do NOT store nested-iframe client quoteAnchor — it goes stale on scroll and
  // lives in the wrong coordinate space vs shell-mounted stickies. PDF rects only.
  const sticky = await upsertSticky(
    {
      itemKey,
      kind: "figure",
      quote: `🖼 ${capture.label || "선택 영역"}${pageLabel ? ` · p.${pageLabel}` : ""}`,
      answer: "그림 관련 본문 검색 중…",
      pageLabel,
      x,
      y,
      pinned: true,
      pdfLocation,
      quoteAnchor: undefined,
      imageDataUrl,
      annotationKey: annKey,
    },
    reader,
  );

  try {
    const store = createZoteroFileStore();
    const paper = getOpenPaperRef();
    setStatus("캡션·본문 figure 문단 수집 중…");
    void updateStickyAnswer(
      itemKey,
      sticky.id,
      "캡션·본문 figure 문단 수집 중…",
      reader,
    );

    let fullText = "";
    try {
      if (paper?.itemKey) {
        const idx = await ensureIndex({
          store,
          prefs: readRagPrefs(),
          itemKey: paper.itemKey,
          itemID: paper.itemID,
          title: paper.title,
          onStatus: (m) => {
            setStatus(m);
            void updateStickyAnswer(itemKey, sticky.id, m, reader);
          },
        });
        fullText = idx.chunks
          .filter((c) => c.kind === "parent" || c.kind === "abstract")
          .map((c) => c.text)
          .join("\n");
      }
    } catch (e) {
      diag("figure", "index for figure context fail", String(e));
    }

    const bundle = buildFigureContextBundle(fullText, {
      pageLabel,
      userQuestion: opts.question,
    });
    setStatus("관련 문단 RAG 검색 중…");
    void updateStickyAnswer(
      itemKey,
      sticky.id,
      "관련 문단 RAG 검색 중…",
      reader,
    );

    const rag = await attachRagContext({
      mode: "figure-explain",
      store,
      query: bundle.ragQuery || "figure caption table",
      selection: bundle.labels.join(" "),
      paper,
      ragPrefs: readRagPrefs(),
      onStatus: (m) => {
        setStatus(m);
        void updateStickyAnswer(itemKey, sticky.id, m, reader);
      },
    });

    const context = mergeFigureEvidence(bundle.directBlock, rag.contextBlock);
    setStatus("이미지 + 본문 근거로 설명 생성 중…");
    void updateStickyAnswer(
      itemKey,
      sticky.id,
      "이미지 + 본문 근거로 설명 생성 중…",
      reader,
    );

    const cfg = resolveFeatureConfig("figure-explain");
    const client = getOrCreateClient(store, cfg);
    let answer = await runTask(client, {
      mode: "figure-explain",
      model: cfg.model,
      targetLang: cfg.targetLang,
      paperTitle: paper?.title,
      context: context || undefined,
      question: opts.question || undefined,
      image,
      selection: bundle.labels.join(", ") || undefined,
      onDelta: (d) => {
        answer += d;
        void updateStickyAnswer(itemKey, sticky.id, answer || "…", reader);
      },
      reasoningEffort: cfg.reasoningEffort,
    });
    if (rag.evidence?.length && answer) {
      try {
        await enrichEvidenceWithPages(rag.evidence);
      } catch {
        /* ignore */
      }
      // Inline [E#] / legacy [§…] links only — no trailing evidence dump
      answer = withEvidenceAnswer(answer, rag.evidence).answer;
    }
    answer = answer || "(empty)";
    await updateStickyAnswer(itemKey, sticky.id, answer, reader, {
      final: true,
    });
    setStatus("완료 · PDF 위 고정 메모 (×로 닫기)");
    diag("figure", "sticky explain done", {
      itemKey,
      labels: bundle.labels.slice(0, 5),
      contextLen: context.length,
      imageBytes: image.base64.length,
      thumb: imageToDataUrl(image).slice(0, 32),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateStickyAnswer(itemKey, sticky.id, `오류: ${msg}`, reader, {
      final: true,
    });
    setStatus(msg);
    diag("figure", "sticky explain fail", msg);
  }
}

function isImageLikeAnnotation(ann: {
  type?: string;
  annotationType?: string;
  image?: unknown;
  annotationImageDataURL?: unknown;
}): boolean {
  const type = String(ann?.type || ann?.annotationType || "");
  if (/image|ink|area/i.test(type)) return true;
  if (typeof ann?.image === "string" && ann.image.startsWith("data:"))
    return true;
  if (
    typeof ann?.annotationImageDataURL === "string" &&
    ann.annotationImageDataURL.startsWith("data:")
  ) {
    return true;
  }
  // Select Area often has image as object/blob URL later — type is still image
  if (ann?.image) return true;
  return false;
}

function makeFigureExplainButton(
  doc: Document,
  opts: {
    reader?: any;

    ann?: any;
    key: string;
    compact?: boolean;
  },
): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.className = "paperai-figure-explain-btn";
  b.textContent = opts.compact ? "설명" : "그림 설명";
  b.title = "이 이미지 주석 + 논문 캡션/본문으로 설명";
  Object.assign(b.style, {
    cursor: "pointer",
    marginLeft: "4px",
    padding: opts.compact ? "2px 8px" : "1px 6px",
    fontSize: "11px",
    borderRadius: "4px",
    border: "1px solid #0d904f",
    background: "#e8f5e9",
    color: "#0d904f",
    fontWeight: "700",
    lineHeight: "1.2",
    whiteSpace: "nowrap",
    boxShadow: opts.compact ? "0 1px 4px rgba(0,0,0,.18)" : "none",
    zIndex: "2147483640",
  } as CSSStyleDeclaration);
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ann = opts.ann || {};
    let capture: CaptureResult | null = null;
    try {
      const dataUrl =
        typeof ann?.image === "string"
          ? ann.image
          : typeof ann?.annotationImageDataURL === "string"
            ? ann.annotationImageDataURL
            : "";
      if (dataUrl.startsWith("data:")) {
        const image = dataUrlToImagePayload(dataUrl);
        if (image?.base64) {
          const loc = locationFromAnnotationItem(ann);
          capture = {
            image,
            source: "image-annotation",
            label: String(ann?.comment || ann?.text || "선택 영역").slice(
              0,
              80,
            ),
            annotationKey: opts.key,
            ...loc,
          };
        }
      }
    } catch {
      /* resolve by key */
    }
    void runFigureStickyTask({
      reader: opts.reader,
      annotationKey: opts.key,
      capture,
      pageLabel: ann?.pageLabel ? String(ann.pageLabel) : undefined,
    });
  });
  return b;
}

export function onRenderSidebarAnnotationHeader(event: {
  reader?: any;
  doc: Document;

  params?: any;
  append: (...nodes: Array<Node | string>) => void;
}): void {
  const { doc, append, reader, params } = event;
  const ann = params?.annotation || params;
  if (!isImageLikeAnnotation(ann)) {
    // Still show for unknown types that look like Select Area (has rects, no text)
    const hasRects = !!ann?.position?.rects?.length;
    const noText = !ann?.text;
    if (!(hasRects && noText)) return;
  }
  const key = String(ann?.id || ann?.key || "");
  if (!key) return;

  append(makeFigureExplainButton(doc, { reader, ann, key }));
}

/**
 * Floating 「그림 설명」 on image annotations in the PDF view (top-right of box).
 * Zotero only offers sidebar inject; this restores an in-page affordance.
 */
const FIG_BTN_HOOK = "__paperaiFigureBtnHook";

export function installFigureAnnotationButtons(reader: any): void {
  if (!reader) return;

  if ((reader as any)[FIG_BTN_HOOK]) return;

  (reader as any)[FIG_BTN_HOOK] = true;

  const tick = () => {
    try {
      refreshFigureAnnotationButtons(reader);
    } catch {
      /* ignore */
    }
  };
  // Initial + light poll (selection/render is async in Zotero reader)
  setTimeout(tick, 400);
  setTimeout(tick, 1200);
  const id = setInterval(tick, 2500);
  // Stop after long session idle — remount on toolbar will reinstall if needed
  setTimeout(() => clearInterval(id), 1000 * 60 * 30);
}

function refreshFigureAnnotationButtons(reader: any): void {
  const wins: Window[] = [];
  const push = (w: unknown) => {
    if (w && typeof (w as Window).document !== "undefined") {
      wins.push(w as Window);
    }
  };
  push(reader?._internalReader?._primaryView?._iframeWindow);
  push(reader?._iframeWindow);
  push(reader?._iframe?.contentWindow);

  // Collect image annotation keys from in-memory map
  const imageKeys = new Set<string>();
  try {
    const view: any =
      reader?._internalReader?._primaryView ||
      reader?._internalReader?._views?.[0];
    const map = view?._annotationsByID;
    if (map && typeof map.forEach === "function") {
      map.forEach((ann: { type?: string; id?: string }, key: string) => {
        if (/image|ink/i.test(String(ann?.type || ""))) {
          imageKeys.add(String(ann?.id || key));
        }
      });
    }
  } catch {
    /* ignore */
  }

  for (const win of wins) {
    const doc = win.document;
    if (!doc) continue;

    // Remove orphaned buttons
    const orphanBtns = Array.from(
      doc.querySelectorAll("[data-paperai-fig-btn]"),
    ) as HTMLElement[];
    for (const el of orphanBtns) {
      const key = el.getAttribute("data-paperai-fig-btn") || "";
      const target = doc.querySelector(`[data-annotation-id="${key}"]`);
      if (!target) el.remove();
    }

    const nodes = Array.from(
      doc.querySelectorAll("[data-annotation-id]"),
    ) as HTMLElement[];
    // Group by id — take union rect
    const byId = new Map<string, DOMRect>();
    for (const el of nodes) {
      const key = el.getAttribute("data-annotation-id") || "";
      if (!key) continue;
      // Prefer known image keys; otherwise only large boxes (area-like)
      const r = el.getBoundingClientRect();
      if (r.width < 28 || r.height < 28) continue;
      if (!imageKeys.has(key) && r.width * r.height < 80 * 80) continue;
      const prev = byId.get(key);
      if (!prev) {
        byId.set(key, r);
      } else {
        const left = Math.min(prev.left, r.left);
        const top = Math.min(prev.top, r.top);
        const right = Math.max(prev.right, r.right);
        const bottom = Math.max(prev.bottom, r.bottom);
        byId.set(key, new DOMRect(left, top, right - left, bottom - top));
      }
    }

    for (const [key, r] of byId) {
      let btn = doc.querySelector(
        `[data-paperai-fig-btn="${key}"]`,
      ) as HTMLButtonElement | null;
      if (!btn) {
        btn = makeFigureExplainButton(doc, {
          reader,
          key,
          compact: true,
        });
        btn.setAttribute("data-paperai-fig-btn", key);
        Object.assign(btn.style, {
          position: "fixed",
          marginLeft: "0",
          pointerEvents: "auto",
        } as CSSStyleDeclaration);
        const parent = doc.body || doc.documentElement;
        if (parent) parent.appendChild(btn);
      }
      // Top-right of the annotation box
      if (!btn) continue;
      btn.style.left = `${Math.max(4, r.right - 52)}px`;
      btn.style.top = `${Math.max(4, r.top - 2)}px`;
      btn.style.display = "block";
    }
  }
}

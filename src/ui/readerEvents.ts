/**
 * Zotero Reader event registration:
 * - Text selection popup: translate (ephemeral) / explain (sticky)
 * - Annotation context: figure explain
 * - Toolbar: remount stickies + figure buttons
 */
import { config } from "../../package.json";
import { createZoteroFileStore } from "../auth/fileStore";
import { resolveFeatureConfig } from "../llm/featureConfig";
import { fastTranslate, getOrCreateClient } from "../llm/fastTranslate";
import { runTask } from "../llm/router";
import { getOpenPaperRef, rememberReaderAttachmentId } from "../rag/paperRef";
import { readRagPrefs } from "../rag/prefs";
import { diag } from "../utils/diagnostics";
import { getPref, setPref } from "../utils/prefs";
import { beginAreaSelectCapture } from "./imageCapture";
import { enrichEvidenceWithPages, withEvidenceAnswer } from "../rag/index";
import { attachRagContext } from "./paperTask";
import {
  installFigureAnnotationButtons,
  onRenderSidebarAnnotationHeader as sidebarHeader,
  runFigureStickyTask,
} from "./readerFigure";
import {
  autoTranslateEnabled,
  getLastReaderSelection,
  itemKeyFromReader,
  minChars,
  setLastAnnotationParams,
  setLastReaderSelection,
} from "./readerSelection";
import {
  mountStickiesForReader,
  nextCascadeOffset,
  positionFromAnnotationParams,
  saveAsPdfAnnotation,
  startStickyWatcher,
  updateStickyAnswer,
  upsertSticky,
  type StickyKind,
} from "./stickyNotes";

export {
  getLastReaderSelection,
  setLastReaderSelection,
} from "./readerSelection";
export { runFigureStickyTask } from "./readerFigure";

const TRANSLATE_BOX_MIN_W = 240;
const TRANSLATE_BOX_MIN_H = 80;
const TRANSLATE_BOX_DEFAULT_W = 360;
const TRANSLATE_BOX_DEFAULT_H = 140;
const TRANSLATE_RESULT_ATTR = "data-paperai-translate-result";

/** Survive Zotero selection-popup re-renders: last result per source text. */
const translateCache = new Map<string, string>();
let translateSeq = 0;

function mkBtn(
  doc: Document,
  label: string,
  primary: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.textContent = label;
  Object.assign(b.style, {
    cursor: "pointer",
    marginRight: "6px",
    padding: "5px 12px",
    border: primary ? "1px solid #1a73e8" : "1px solid #ccc",
    borderRadius: "8px",
    background: primary ? "#1a73e8" : "#fff",
    color: primary ? "#fff" : "#1a1a1a",
    fontSize: "12px",
    fontWeight: "600",
    fontFamily: "system-ui, sans-serif",
  });
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

function readTranslateBoxSize(): { w: number; h: number } {
  try {
    const w = Number(getPref("translateResultW"));
    const h = Number(getPref("translateResultH"));
    return {
      w:
        Number.isFinite(w) && w >= TRANSLATE_BOX_MIN_W
          ? Math.min(720, Math.round(w))
          : TRANSLATE_BOX_DEFAULT_W,
      h:
        Number.isFinite(h) && h >= TRANSLATE_BOX_MIN_H
          ? Math.min(420, Math.round(h))
          : TRANSLATE_BOX_DEFAULT_H,
    };
  } catch {
    return { w: TRANSLATE_BOX_DEFAULT_W, h: TRANSLATE_BOX_DEFAULT_H };
  }
}

function saveTranslateBoxSize(w: number, h: number): void {
  try {
    setPref(
      "translateResultW",
      Math.max(TRANSLATE_BOX_MIN_W, Math.min(720, Math.round(w))),
    );
    setPref(
      "translateResultH",
      Math.max(TRANSLATE_BOX_MIN_H, Math.min(420, Math.round(h))),
    );
  } catch {
    /* ignore */
  }
}

/** Cross-realm safe: never use instanceof HTMLTextAreaElement across docs. */
function writeTextarea(el: Element, msg: string): void {
  if (el.tagName?.toLowerCase() !== "textarea") {
    (el as HTMLElement).textContent = msg;
    return;
  }
  try {
    (el as HTMLTextAreaElement).value = msg;
  } catch {
    try {
      el.textContent = msg;
    } catch {
      /* ignore */
    }
  }
}

/** Push text into every live translate box in a document (and optional el). */
function paintTranslateResult(
  doc: Document | null | undefined,
  msg: string,
  preferred?: HTMLElement | null,
): void {
  if (preferred) writeTextarea(preferred, msg);
  if (!doc) return;
  try {
    const nodes = doc.querySelectorAll(`[${TRANSLATE_RESULT_ATTR}]`);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes.item(i);
      if (el && el !== preferred) writeTextarea(el, msg);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Let the Zotero selection popup grow with our content (avoid clipped / orphan UI).
 * Allows wider bubbles so horizontal resize of the translate box stays inside.
 */
function expandSelectionPopupShell(from: HTMLElement, wantW?: number): void {
  const maxW = Math.max(wantW || 440, 440);
  let n: HTMLElement | null = from;
  for (let i = 0; i < 12 && n; i++) {
    try {
      n.style.maxHeight = "none";
      n.style.height = "auto";
      n.style.overflow = "visible";
      if (i <= 5) {
        n.style.maxWidth = `min(${maxW}px, 96vw)`;
        n.style.width = "auto";
        n.style.boxSizing = "border-box";
      }
    } catch {
      /* ignore */
    }
    n = n.parentElement as HTMLElement | null;
  }
}

/**
 * Translate result panel inside selection popup.
 * Both axes resizable; popup shell is expanded so the box stays attached.
 */
function createTranslateResultBox(
  doc: Document,
  sourceText: string,
): {
  root: HTMLElement;
  statusEl: HTMLTextAreaElement;
} {
  const size = readTranslateBoxSize();
  const root = doc.createElement("div");
  root.setAttribute("data-paperai-translate-box", "1");
  Object.assign(root.style, {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    width: `${size.w}px`,
    maxWidth: "min(720px, 96vw)",
    minWidth: `${TRANSLATE_BOX_MIN_W}px`,
    boxSizing: "border-box",
    marginTop: "2px",
  } as CSSStyleDeclaration);

  const bar = doc.createElement("div");
  Object.assign(bar.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    fontSize: "10px",
    color: "#666",
    minWidth: "0",
  } as CSSStyleDeclaration);
  const barLabel = doc.createElement("span");
  barLabel.textContent = "번역 · 선택 복사 · 모서리로 가로·세로 조절";
  Object.assign(barLabel.style, {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: "1",
    minWidth: "0",
  } as CSSStyleDeclaration);
  bar.appendChild(barLabel);

  const copyBtn = doc.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "복사";
  copyBtn.title = "전체 번역 복사";
  Object.assign(copyBtn.style, {
    cursor: "pointer",
    padding: "2px 8px",
    fontSize: "10px",
    border: "1px solid #c5c5c5",
    borderRadius: "4px",
    background: "#fff",
    color: "#1a1a1a",
    flexShrink: "0",
  } as CSSStyleDeclaration);
  bar.appendChild(copyBtn);
  root.appendChild(bar);

  const ta = doc.createElement("textarea");
  ta.readOnly = true;
  ta.spellcheck = false;
  ta.setAttribute(TRANSLATE_RESULT_ATTR, "1");
  ta.placeholder = "번역을 기다리는 중…";
  Object.assign(ta.style, {
    display: "block",
    boxSizing: "border-box",
    width: "100%",
    height: `${size.h}px`,
    minWidth: `${TRANSLATE_BOX_MIN_W}px`,
    minHeight: `${TRANSLATE_BOX_MIN_H}px`,
    maxWidth: "100%",
    maxHeight: "420px",
    resize: "both",
    overflow: "auto",
    padding: "8px",
    margin: "0",
    background: "#f8f9fa",
    border: "1px solid #c5c5c5",
    borderRadius: "8px",
    font: "12px/1.45 system-ui, sans-serif",
    color: "#1a1a1a",
    cursor: "text",
    whiteSpace: "pre-wrap",
  } as CSSStyleDeclaration);
  try {
    ta.style.setProperty("user-select", "text", "important");
    ta.style.setProperty("-moz-user-select", "text", "important");
  } catch {
    /* ignore */
  }

  const cached = translateCache.get(sourceText);
  if (cached) writeTextarea(ta, cached);

  const stopBubble = (ev: Event) => {
    ev.stopPropagation();
  };
  for (const type of [
    "mousedown",
    "mouseup",
    "mousemove",
    "pointerdown",
    "pointerup",
    "pointermove",
    "click",
    "dblclick",
    "contextmenu",
    "selectstart",
  ]) {
    ta.addEventListener(type, stopBubble, true);
    ta.addEventListener(type, stopBubble, false);
  }

  copyBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  copyBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const v = ta.value || "";
    if (!v || v === "번역 중…") return;
    void (async () => {
      try {
        const nav = (doc.defaultView as any)?.navigator || navigator;
        if (nav?.clipboard?.writeText) {
          await nav.clipboard.writeText(v);
        } else {
          ta.focus();
          ta.select();
          doc.execCommand?.("copy");
        }
        copyBtn.textContent = "복사됨";
        setTimeout(() => {
          copyBtn.textContent = "복사";
        }, 1200);
      } catch {
        ta.focus();
        ta.select();
      }
    })();
  });

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const persistSize = () => {
    const w = Math.round(ta.offsetWidth || root.offsetWidth);
    const h = Math.round(ta.offsetHeight);
    if (w >= TRANSLATE_BOX_MIN_W && h >= TRANSLATE_BOX_MIN_H) {
      saveTranslateBoxSize(w, h);
      root.style.width = `${w}px`;
      expandSelectionPopupShell(root, w + 48);
    }
  };
  ta.addEventListener("mouseup", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(persistSize, 120);
  });
  try {
    const RO = doc.defaultView?.ResizeObserver;
    if (RO) {
      const ro = new RO(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(persistSize, 200);
      });
      ro.observe(ta);
    }
  } catch {
    /* ignore */
  }

  root.appendChild(ta);
  return { root, statusEl: ta };
}

/** Stream translate into status/popup only — no sticky note. */
export async function runTranslateOnly(opts: {
  text: string;

  reader?: any;
  statusEl?: HTMLElement | null;
  /** Document that hosts the selection popup (for re-paint after re-render) */
  doc?: Document | null;
}): Promise<void> {
  const text = (opts.text || "").trim();
  if (!text) {
    diag("translate", "empty text — skip");
    return;
  }

  const seq = ++translateSeq;
  const doc =
    opts.doc ||
    opts.statusEl?.ownerDocument ||
    (opts.reader as any)?._iframeWindow?.document ||
    null;

  let prog: any = null;
  if (!opts.statusEl && !doc) {
    try {
      prog = new ztoolkit.ProgressWindow(config.addonName)
        .createLine({ text: "번역 중…", type: "default" })
        .show();
    } catch {
      /* ignore */
    }
  }

  const set = (msg: string, done?: boolean) => {
    if (seq !== translateSeq) return; // superseded by a newer request
    translateCache.set(text, msg);
    paintTranslateResult(doc, msg, opts.statusEl || null);
    if (!opts.statusEl && !doc) {
      try {
        prog?.changeLine?.({
          text: msg.length > 180 ? msg.slice(0, 180) + "…" : msg,
          type: done === false ? "fail" : done ? "success" : "default",
        });
      } catch {
        /* ignore */
      }
    }
  };

  set("번역 중…");
  diag("translate", "start", { chars: text.length, model: "resolve…" });
  try {
    const store = createZoteroFileStore();
    const cfg = resolveFeatureConfig("translate");
    diag("translate", "cfg", {
      provider: cfg.provider,
      model: cfg.model,
      reasoning: cfg.reasoningEffort,
    });
    let answer = "";
    answer = await fastTranslate(store, cfg, text, {
      onDelta: (d) => {
        answer += d;
        set(answer || "…");
      },
    });
    answer = answer || "(empty)";
    set(answer, true);
    if (!opts.statusEl && !doc) {
      try {
        prog?.startCloseTimer?.(12_000);
      } catch {
        /* ignore */
      }
    }
    diag("translate", "done", { chars: answer.length, src: text.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    set(`오류: ${msg}`, false);
    diag("translate", "fail", msg);
  }
}

/**
 * Explain → sticky on PDF. Translate → runTranslateOnly (no sticky).
 */
export async function runStickyTask(opts: {
  mode: "translate" | "explain";
  text: string;
  question?: string;

  reader?: any;

  params?: any;
  statusEl?: HTMLElement | null;
  doc?: Document | null;
}): Promise<void> {
  const text = (opts.text || "").trim();
  if (!text) return;

  if (opts.mode === "translate") {
    await runTranslateOnly({
      text,
      reader: opts.reader,
      statusEl: opts.statusEl,
      doc: opts.doc || opts.statusEl?.ownerDocument || null,
    });
    return;
  }

  const question = (opts.question || "").trim();

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

  const itemKey = itemKeyFromReader(reader);
  const pos = positionFromAnnotationParams(opts.params, reader);
  pos.y += nextCascadeOffset(itemKey);

  const kind: StickyKind = "explain";
  const quoteLabel = question
    ? `${text.slice(0, 200)}${text.length > 200 ? "…" : ""}\n— 질문: ${question}`
    : text;

  const sticky = await upsertSticky(
    {
      itemKey,
      kind,
      quote: quoteLabel,
      answer: "설명 중…",
      pageLabel: pos.pageLabel,
      x: pos.x,
      y: pos.y,
      pinned: true,
      pdfLocation: pos.pdfLocation,
      quoteAnchor: pos.quoteAnchor,
    },
    reader,
  );

  if (opts.statusEl) {
    opts.statusEl.textContent =
      "논문 문맥(RAG) 검색 후 설명 중… (PDF 위 고정 메모)";
  }

  try {
    const store = createZoteroFileStore();
    const cfg = resolveFeatureConfig("explain");
    let answer = "";

    const paper = getOpenPaperRef();
    const ragQuery = [question, text].filter(Boolean).join("\n");
    if (opts.statusEl) opts.statusEl.textContent = "관련 문단 검색(RAG) 중…";
    void updateStickyAnswer(
      itemKey,
      sticky.id,
      "관련 문단 검색(RAG) 중…",
      reader,
    );

    const rag = await attachRagContext({
      mode: "explain",
      store,
      query: ragQuery,
      selection: text,
      paper,
      ragPrefs: readRagPrefs(),
      onStatus: (msg) => {
        if (opts.statusEl) opts.statusEl.textContent = msg;
        void updateStickyAnswer(itemKey, sticky.id, msg, reader);
      },
    });

    if (opts.statusEl) {
      opts.statusEl.textContent = rag.usedRag
        ? "문맥 확보 · 설명 생성 중…"
        : "문맥 없이 설명 생성 중…";
    }
    void updateStickyAnswer(
      itemKey,
      sticky.id,
      rag.usedRag ? "문맥 확보 · 설명 생성 중…" : "설명 생성 중…",
      reader,
    );

    const client = getOrCreateClient(store, cfg);
    answer = await runTask(client, {
      mode: "explain",
      model: cfg.model,
      targetLang: cfg.targetLang,
      selection: text,
      question: question || undefined,
      paperTitle: paper?.title,
      context: rag.contextBlock || undefined,
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
      // Inline [§…] links only — no trailing evidence dump
      answer = withEvidenceAnswer(answer, rag.evidence).answer;
    }
    diag("sticky", "explain RAG", {
      usedRag: rag.usedRag,
      contextLen: rag.contextBlock.length,
      evidence: rag.evidence?.length || 0,
    });

    answer = answer || "(empty)";
    await updateStickyAnswer(itemKey, sticky.id, answer, reader, {
      final: true,
    });

    void saveAsPdfAnnotation({
      reader,
      quote: quoteLabel,
      answer,
      kind,
      annotationParams: opts.params,
    });

    if (opts.statusEl) {
      opts.statusEl.textContent =
        "완료 · PDF 위 노트에서 드래그해 복사 가능 (× 로 닫기)";
    }
    diag("sticky", "task done", {
      mode: "explain",
      itemKey,
      id: sticky.id,
      hasQuestion: !!question,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateStickyAnswer(itemKey, sticky.id, `오류: ${msg}`, reader, {
      final: true,
    });
    if (opts.statusEl) opts.statusEl.textContent = msg;
    diag("sticky", "task fail", msg);
  }
}

const COMPOSER_ID = "paperai-explain-composer";
let composerKeyShield: ((ev: Event) => void) | null = null;

let composerShieldWin: any = null;

function removeExplainComposer(): void {
  try {
    const Z = (globalThis as any).Zotero;
    const wins = [
      Z?.getMainWindow?.(),
      ...(Z?.getMainWindows?.() || []),
      globalThis,
    ];
    for (const w of wins) {
      try {
        w?.document?.getElementById?.(COMPOSER_ID)?.remove();
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  if (composerKeyShield && composerShieldWin) {
    try {
      composerShieldWin.removeEventListener("keydown", composerKeyShield, true);
    } catch {
      /* ignore */
    }
  }
  composerKeyShield = null;
  composerShieldWin = null;
}

function openExplainComposer(opts: {
  text: string;

  reader?: any;

  params?: any;
}): void {
  removeExplainComposer();
  const text = (opts.text || "").trim();
  if (!text) return;

  const Z = (globalThis as any).Zotero;

  const win: any = Z?.getMainWindow?.() || globalThis;
  const rdoc: Document = win.document;

  const reader = opts.reader;

  const wrap = rdoc.createElement("div");
  wrap.id = COMPOSER_ID;
  Object.assign(wrap.style, {
    position: "fixed",
    right: "24px",
    bottom: "24px",
    width: "360px",
    zIndex: "2147483646",
    background: "#fff",
    border: "1px solid #c5c5c5",
    borderRadius: "12px",
    boxShadow: "0 8px 28px rgba(0,0,0,.22)",
    padding: "12px",
    font: "12px/1.4 system-ui, sans-serif",
    color: "#1a1a1a",
  } as CSSStyleDeclaration);

  const head = rdoc.createElement("div");
  Object.assign(head.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "8px",
    fontWeight: "700",
  } as CSSStyleDeclaration);
  head.textContent = "설명 작성";
  const close = rdoc.createElement("button");
  close.type = "button";
  close.textContent = "×";
  Object.assign(close.style, {
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: "16px",
  } as CSSStyleDeclaration);
  close.onclick = () => removeExplainComposer();
  head.appendChild(close);
  wrap.appendChild(head);

  const preview = rdoc.createElement("div");
  preview.textContent = text.length > 180 ? text.slice(0, 180) + "…" : text;
  Object.assign(preview.style, {
    maxHeight: "64px",
    overflow: "auto",
    padding: "6px 8px",
    background: "#f6f6f6",
    borderRadius: "8px",
    marginBottom: "8px",
    color: "#444",
    fontSize: "11px",
  } as CSSStyleDeclaration);
  wrap.appendChild(preview);

  const intent = rdoc.createElement("textarea");
  intent.rows = 3;
  intent.placeholder = "무엇을 알고 싶나요? (비워도 됨)";
  Object.assign(intent.style, {
    width: "100%",
    boxSizing: "border-box",
    resize: "vertical",
    padding: "8px",
    border: "1px solid #c5c5c5",
    borderRadius: "8px",
    font: "13px/1.4 system-ui, sans-serif",
    color: "#1a1a1a",
    background: "#fff",
  } as CSSStyleDeclaration);
  wrap.appendChild(intent);

  const status = rdoc.createElement("div");
  Object.assign(status.style, {
    fontSize: "11px",
    color: "#666",
    minHeight: "1.2em",
    margin: "6px 0",
  } as CSSStyleDeclaration);
  status.textContent = "메인 창 입력 · Ctrl+Enter=설명 · Esc=닫기";
  wrap.appendChild(status);

  const row = rdoc.createElement("div");
  Object.assign(row.style, {
    display: "flex",
    gap: "6px",
    flexWrap: "wrap",
  } as CSSStyleDeclaration);

  const runExplain = () => {
    try {
      if (text) setLastReaderSelection(text);
      status.textContent = "설명 생성 중…";
      void runStickyTask({
        mode: "explain",
        text,
        question: intent.value,
        reader,
        params: opts.params,
        statusEl: status,
      });
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
    }
  };

  const btnExplain = rdoc.createElement("button");
  btnExplain.type = "button";
  btnExplain.textContent = "설명 실행";
  Object.assign(btnExplain.style, {
    cursor: "pointer",
    padding: "8px 14px",
    border: "1px solid #1a73e8",
    borderRadius: "8px",
    background: "#1a73e8",
    color: "#fff",
    fontSize: "13px",
    fontWeight: "600",
  } as CSSStyleDeclaration);
  btnExplain.onclick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    runExplain();
  };

  const btnTr = rdoc.createElement("button");
  btnTr.type = "button";
  btnTr.textContent = "번역만";
  Object.assign(btnTr.style, {
    cursor: "pointer",
    padding: "8px 14px",
    border: "1px solid #ccc",
    borderRadius: "8px",
    background: "#fff",
    color: "#1a1a1a",
    fontSize: "13px",
    fontWeight: "600",
  } as CSSStyleDeclaration);
  btnTr.onclick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (text) setLastReaderSelection(text);
    status.textContent = "번역 중…";
    void runTranslateOnly({ text, reader, statusEl: status });
  };

  row.appendChild(btnExplain);
  row.appendChild(btnTr);
  wrap.appendChild(row);

  // Keyboard isolation
  composerShieldWin = win;
  composerKeyShield = (ev: Event) => {
    const e = ev as KeyboardEvent;
    const t = e.target as Node | null;
    if (!wrap.contains(t)) return;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      removeExplainComposer();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runExplain();
    }
  };
  win.addEventListener("keydown", composerKeyShield, true);

  const parent = rdoc.body || rdoc.documentElement;
  if (parent) parent.appendChild(wrap);
  setTimeout(() => {
    try {
      intent.focus({ preventScroll: true } as FocusOptions);
    } catch {
      intent.focus();
    }
  }, 40);
}

function onRenderTextSelectionPopup(event: {
  reader?: any;
  doc: Document;

  params?: any;
  append: (...nodes: Array<Node | string>) => void;
}): void {
  const { doc, params, append, reader } = event;
  setLastAnnotationParams(params || null);
  try {
    const id = reader?.itemID ?? reader?._item?.id;
    if (id) rememberReaderAttachmentId(id);
  } catch {
    /* ignore */
  }
  const text = String(params?.annotation?.text || "").trim();
  if (text) setLastReaderSelection(text);

  try {
    const key = itemKeyFromReader(reader);
    if (key && key !== "unknown") void mountStickiesForReader(reader, key);
  } catch {
    /* ignore */
  }

  const initSize = readTranslateBoxSize();
  // One card: buttons + result; width tracks saved translate box size
  const wrap = doc.createElement("div");
  Object.assign(wrap.style, {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    marginTop: "6px",
    width: `${initSize.w}px`,
    minWidth: `${TRANSLATE_BOX_MIN_W}px`,
    maxWidth: "min(720px, 96vw)",
    boxSizing: "border-box",
    font: "12px/1.4 system-ui, sans-serif",
    color: "#1a1a1a",
  });

  const hint = doc.createElement("div");
  hint.textContent = "번역 · 선택 복사 · 가로·세로 크기 조절 · 설명 = PDF 메모";
  Object.assign(hint.style, { fontSize: "11px", color: "#666" });
  wrap.appendChild(hint);

  const row = doc.createElement("div");
  Object.assign(row.style, {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    alignItems: "center",
  });

  const translateBox = createTranslateResultBox(doc, text);
  const status = translateBox.statusEl;

  const resolveText = (): string => {
    let t = text;
    try {
      const live = (reader as any)?._iframeWindow
        ?.getSelection?.()
        ?.toString?.();
      if (typeof live === "string" && live.trim()) t = live.trim();
    } catch {
      /* keep */
    }
    if (!t) t = getLastReaderSelection();
    return (t || "").trim();
  };

  const doTranslate = () => {
    const t = resolveText();
    if (!t) {
      writeTextarea(status, "오류: 선택된 텍스트가 없습니다.");
      return;
    }
    setLastReaderSelection(t);
    void runTranslateOnly({
      text: t,
      reader,
      statusEl: status,
      doc,
    });
  };

  row.appendChild(mkBtn(doc, "번역", true, doTranslate));
  row.appendChild(
    mkBtn(doc, "설명 작성…", false, () => {
      const t = resolveText();
      if (t) setLastReaderSelection(t);
      openExplainComposer({ text: t || text, reader, params });
    }),
  );
  wrap.appendChild(row);
  wrap.appendChild(translateBox.root);
  append(wrap);

  // Grow the Zotero popup so our card (incl. horizontal resize) stays inside
  try {
    expandSelectionPopupShell(wrap, initSize.w + 48);
    const w = doc.defaultView;
    w?.requestAnimationFrame?.(() =>
      expandSelectionPopupShell(wrap, initSize.w + 48),
    );
    setTimeout(() => expandSelectionPopupShell(wrap, initSize.w + 48), 50);
  } catch {
    /* ignore */
  }

  // Auto-translate: only if no fresh cached final answer (avoid re-fire spam)
  const cached = text ? translateCache.get(text) : undefined;
  const looksFinal =
    !!cached &&
    cached !== "번역 중…" &&
    !cached.startsWith("오류:") &&
    cached.length > 0;
  if (
    text &&
    autoTranslateEnabled() &&
    text.length >= minChars() &&
    !looksFinal
  ) {
    void runTranslateOnly({
      text,
      reader,
      statusEl: status,
      doc,
    });
  } else if (looksFinal && cached) {
    writeTextarea(status, cached);
  }
}

function onRenderToolbar(event: { reader?: any }): void {
  try {
    const r =
      event.reader ||
      (globalThis as any).Zotero?.Reader?._readers?.slice?.(-1)?.[0];
    const key = itemKeyFromReader(r);
    if (key && key !== "unknown") void mountStickiesForReader(r, key);
    if (r) installFigureAnnotationButtons(r);
  } catch {
    /* ignore */
  }
}

function onCreateViewContextMenu(event: {
  reader?: any;
  append: (params: {
    label: string;
    disabled?: boolean;
    onCommand: () => void;
  }) => void;
}): void {
  const { append, reader } = event;
  const run = (mode: "translate" | "explain") => {
    let text = getLastReaderSelection();
    try {
      const r =
        reader ||
        (globalThis as any).Zotero?.Reader?.getByTabID?.(
          ((globalThis as any).Zotero?.getMainWindow?.() || globalThis)
            .Zotero_Tabs?.selectedID,
        );
      const live = r?._iframeWindow?.getSelection?.()?.toString?.();
      if (typeof live === "string" && live.trim()) {
        text = live.trim();
        setLastReaderSelection(text);
      }
      void runStickyTask({ mode, text, reader: r });
    } catch {
      void runStickyTask({ mode, text, reader });
    }
  };
  append({
    label: "Paper AI: 번역 (팝업 표시)",
    onCommand: () => run("translate"),
  });
  append({
    label: "Paper AI: 설명 (PDF 고정 메모)",
    onCommand: () => run("explain"),
  });
  append({
    label: "Paper AI: 영역 그림 설명…",
    onCommand: () => {
      void (async () => {
        const cap = await beginAreaSelectCapture(reader);
        if (cap) await runFigureStickyTask({ reader, capture: cap });
      })();
    },
  });
}

function onCreateAnnotationContextMenu(event: {
  reader?: any;

  params?: any;
  append: (params: {
    label: string;
    disabled?: boolean;
    onCommand: () => void;
  }) => void;
}): void {
  const { append, reader, params } = event;
  const ids: string[] = Array.isArray(params?.ids)
    ? params.ids.map(String)
    : params?.currentID
      ? [String(params.currentID)]
      : [];
  const key = ids[0] || String(params?.currentID || "");
  append({
    label: "Paper AI: 이 영역 그림 설명 (캡션·본문 RAG)",
    disabled: !key,
    onCommand: () => {
      void runFigureStickyTask({
        reader,
        annotationKey: key,
      });
    },
  });
}

export function registerReaderEvents(): void {
  const id = config.addonID;
  try {
    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      onRenderTextSelectionPopup as never,
      id,
    );
    Zotero.Reader.registerEventListener(
      "renderToolbar",
      onRenderToolbar as never,
      id,
    );
    Zotero.Reader.registerEventListener(
      "createViewContextMenu",
      onCreateViewContextMenu as never,
      id,
    );
    Zotero.Reader.registerEventListener(
      "createAnnotationContextMenu",
      onCreateAnnotationContextMenu as never,
      id,
    );
    Zotero.Reader.registerEventListener(
      "renderSidebarAnnotationHeader",
      sidebarHeader as never,
      id,
    );
    startStickyWatcher();
  } catch (e) {
    ztoolkit.log("registerReaderEvents failed", e);
  }
}

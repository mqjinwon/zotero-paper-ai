/**
 * Panel mount + action controller (session-scoped).
 * Task/RAG orchestration lives in paperTask.ts; markup in panelView.ts.
 */

import { config } from "../../package.json";
import { createZoteroFileStore } from "../auth/fileStore";
import { ensureIndex } from "../rag/index";
import { describeOpenPaperRef, getOpenPaperRef } from "../rag/paperRef";
import { readRagPrefs } from "../rag/prefs";
import { findLatestIndexForPaper, formatIndexLabel } from "../rag/store";
import { isVisionMode } from "../llm/router";
import type { ImagePayload, TaskMode } from "../llm/types";
import {
  buildFigureContextBundle,
  extractFigureMentions,
  mergeFigureEvidence,
} from "./figureContext";
import {
  imageToDataUrl,
  obtainCaptureForVision,
  obtainImageForVision,
} from "./imageCapture";
import {
  buildDiagnosticReport,
  copyTextToClipboard,
  diag,
} from "../utils/diagnostics";
import {
  focusSticky,
  listStickiesInPaperOrder,
  isStickyOverlayHidden,
  mountStickiesForReader,
  nextCascadeOffset,
  setAllStickiesCollapsed,
  setStickyOverlayHidden,
  stickyPageIndex,
  upsertSticky,
  type StickyKind,
  type StickyNote,
} from "./stickyNotes";
import {
  handleCiteClick,
  scrubIllegalChars,
  setMarkdownHtmlWithCites,
} from "./markdown";
import {
  attachRagContext,
  formatUserVisible,
  runPaperTask,
  type ChatTurn,
} from "./paperTask";
import {
  clearChatHistory,
  loadChatHistory,
  saveChatHistory,
} from "./chatStore";
import { runPaperSummary } from "./paperSummary";
import {
  deleteAllAutoAnnotations,
  deleteAutoAnnotation,
  listAutoAnnotations,
  runAutoHighlight,
  getAutoHighlightClass,
  legendLines,
  type AppliedAutoHighlight,
} from "../rag/autoHighlight";
import {
  createPanelSession,
  getLastPanelSession,
  sessionEl,
  setSessionBusy,
  setSessionStatus,
  type PanelSession,
} from "./panelSession";
import { navigateReaderToPage } from "./markdown";
import {
  buildPanelDom,
  INDEX_BTN_RUNNING,
  setIndexButtonState,
} from "./panelView";
import { getReaderSelectionText, saveAnswerAsNote } from "./reader";
import { loadPaperSummary, savePaperSummary } from "./summaryStore";

export type { ChatTurn };

/**
 * Paint chat log.
 *
 * Mid-stream MD is fine when insertion is robust (DOMParser) — same final string
 * is just incomplete until the last token. We always *try* MD; if paint fails
 * we keep plain text for that bubble only (never wipe the whole log).
 */
function scheduleRenderLog(session: PanelSession): void {
  if (session.renderTimer) return;
  session.renderTimer = setTimeout(() => {
    session.renderTimer = null;
    try {
      renderLog(session);
    } catch (e) {
      diag("chat", "renderLog fatal", String(e));
    }
  }, 80);
}

function paintAssistantBody(doc: Document, content: string): HTMLElement {
  const body = doc.createElement("div");
  body.className = "pai-md";
  const ok = setMarkdownHtmlWithCites(body, content || "…");
  if (!ok) {
    diag("chat", "md paint fell back to plain", {
      len: content.length,
      head: content.slice(0, 80),
    });
  }
  return body;
}

function renderLog(session: PanelSession): void {
  const log = sessionEl(session, "[data-pai-log]");
  if (!log) return;
  const doc = log.ownerDocument || session.root.ownerDocument;
  if (!doc) return;

  try {
    while (log.firstChild) log.removeChild(log.firstChild);

    if (!session.history.length) {
      const empty = doc.createElement("div");
      empty.className = "pai-bubble empty";
      empty.textContent =
        "아직 대화가 없습니다. 아래에 질문을 쓰고 Enter 또는 보내기를 누르세요.";
      log.appendChild(empty);
      return;
    }

    for (const m of session.history) {
      const bubble = doc.createElement("div");
      bubble.className = `pai-bubble ${m.role === "assistant" ? "assistant" : "user"}`;

      if (m.role === "user" && m.imageDataUrl) {
        try {
          const wrap = doc.createElement("div");
          wrap.className = "pai-img-wrap";
          const img = doc.createElement("img");
          img.className = "pai-thumb";
          img.alt = "figure";
          const src = scrubIllegalChars(m.imageDataUrl);
          if (src.startsWith("data:image/") || src.startsWith("https:")) {
            img.src = src;
          }
          wrap.appendChild(img);
          const cap = doc.createElement("div");
          cap.className = "pai-img-cap";
          cap.textContent = m.imageCaption || "PDF에서 추출한 이미지";
          wrap.appendChild(cap);
          bubble.appendChild(wrap);
        } catch (e) {
          diag("chat", "img paint fail", String(e));
        }
      }

      const content = scrubIllegalChars(
        m.content || (m.role === "assistant" ? "…" : ""),
      );

      if (m.role === "assistant") {
        bubble.appendChild(paintAssistantBody(doc, content));
      } else {
        const body = doc.createElement("div");
        body.style.whiteSpace = "pre-wrap";
        body.textContent = content;
        bubble.appendChild(body);
      }
      log.appendChild(bubble);
    }
    log.scrollTop = log.scrollHeight;
  } catch (e) {
    diag("chat", "renderLog outer fail", String(e));
    // Do NOT wipe history — leave previous DOM if clear failed mid-way
  }
}

export function mountPanel(doc: Document, container: HTMLElement): void {
  try {
    const root = buildPanelDom(doc, container);
    const session = createPanelSession(root);

    const input = sessionEl<HTMLTextAreaElement>(session, "[data-pai-input]");
    input?.addEventListener("keydown", (ev: Event) => {
      const ke = ev as KeyboardEvent;
      if (ke.key === "Enter" && !ke.shiftKey) {
        ke.preventDefault();
        void runAction(session, "chat");
      }
    });

    root.addEventListener(
      "click",
      (ev) => {
        // Cite links first (Text-node-safe) — before data-act handler
        if (handleCiteClick(ev, root)) {
          setSessionStatus(session, "근거 링크로 PDF 페이지 이동 중…");
          return;
        }
        const raw = ev.target as Node | null;
        const el =
          raw && raw.nodeType === 3
            ? (raw as Text).parentElement
            : (raw as Element | null);
        const t = el?.closest?.("[data-act]") as HTMLElement | null;
        if (!t || !root.contains(t)) return;
        const act = t.getAttribute("data-act");
        if (!act) return;
        ev.preventDefault();
        ev.stopPropagation();
        handleAct(session, act, t);
      },
      true,
    );
    // mousedown backup — some item-pane hosts swallow click on anchors
    root.addEventListener(
      "mousedown",
      (ev) => {
        if (handleCiteClick(ev, root)) {
          setSessionStatus(session, "근거 링크로 PDF 페이지 이동 중…");
        }
      },
      true,
    );

    setSessionStatus(session, "준비됨 — 버튼이 활성화되어 있습니다.");
    void refreshIndexButtonStatus(session);
    void refreshStickyList(session);
    void restoreChatHistory(session);
    void restorePaperSummary(session);
    void refreshAutoHighlightList(session);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      ztoolkit.log("mountPanel failed", e);
    } catch {
      /* ignore */
    }
    try {
      container.textContent = "";
      const err = doc.createElement("div");
      err.setAttribute(
        "style",
        "padding:12px;color:#c5221f;font:13px/1.45 system-ui;background:#fce8e6;border-radius:8px",
      );
      err.textContent = `Paper AI 패널 로드 실패: ${msg}`;
      container.appendChild(err);
    } catch {
      /* ignore */
    }
  }
}

function chatItemKey(): string {
  try {
    const paper = getOpenPaperRef();
    return paper?.itemKey || "";
  } catch {
    return "";
  }
}

async function restoreChatHistory(session: PanelSession): Promise<void> {
  const key = chatItemKey();
  if (!key) {
    setSessionStatus(
      session,
      "준비됨 — PDF를 열면 이 논문의 대화 기록이 불러와집니다.",
    );
    return;
  }
  const hist = await loadChatHistory(key);
  if (!hist.length) return;
  session.history = hist;
  const last = [...hist].reverse().find((h) => h.role === "assistant");
  session.lastAnswer = last?.content || "";
  renderLog(session);
  setSessionStatus(
    session,
    `대화 기록 ${hist.length}턴 복원 (이 논문 노트 · Zotero 동기화)`,
  );
}

function paintSummaryBody(session: PanelSession, markdown: string): void {
  const body = sessionEl(session, "[data-pai-summary]");
  if (!body) return;
  const md = (markdown || "").trim();
  body.classList.remove("is-empty");
  if (!md) {
    body.classList.add("is-empty");
    body.textContent = "아직 요약이 없습니다. 「요약 생성하기」를 누르세요.";
    return;
  }
  body.textContent = "";
  const wrap = session.root.ownerDocument!.createElement("div");
  wrap.className = "pai-md";
  const ok = setMarkdownHtmlWithCites(wrap, md);
  if (!ok) {
    body.textContent = md;
    return;
  }
  body.appendChild(wrap);
}

async function restorePaperSummary(session: PanelSession): Promise<void> {
  const key = chatItemKey();
  if (!key) return;
  const rec = await loadPaperSummary(key);
  if (!rec?.markdown) return;
  paintSummaryBody(session, rec.markdown);
  session.lastAnswer = rec.markdown;
}

async function runSummarize(session: PanelSession): Promise<void> {
  if (session.busy) {
    setSessionStatus(session, "다른 작업이 진행 중입니다…");
    return;
  }
  const paper = getOpenPaperRef();
  if (!paper?.itemKey) {
    setSessionStatus(
      session,
      "요약을 만들 PDF를 찾지 못했습니다. PDF 탭을 연 뒤 다시 시도하세요.",
    );
    return;
  }

  setSessionBusy(session, true);
  const btnEl = session.root.querySelector(
    "[data-act='summarize']",
  ) as HTMLButtonElement | null;
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "요약 생성 중…";
  }

  let streamed = "";
  try {
    const store = createZoteroFileStore();
    const result = await runPaperSummary({
      store,
      paper,
      onStatus: (s) => setSessionStatus(session, s),
      onDelta: (t) => {
        streamed += t;
        paintSummaryBody(session, streamed);
      },
    });
    paintSummaryBody(session, result.markdown);
    session.lastAnswer = result.markdown;
    await savePaperSummary(paper.itemKey, result.markdown, {
      provider: result.provider,
      model: result.model,
    });
    if (result.indexLabel) {
      setIndexButtonState(session.root, "ready", result.indexLabel);
    }
    setSessionStatus(
      session,
      `요약 완료 (${result.provider} · ${result.model}` +
        `${result.usedRag ? " · RAG" : ""}) · 이 논문 노트에 저장됨`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diag("ui", "summary fail", msg);
    if (!streamed.trim()) {
      paintSummaryBody(session, "");
    }
    setSessionStatus(session, `요약 실패: ${msg}`);
  } finally {
    setSessionBusy(session, false);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = "요약 생성하기";
    }
  }
}

function handleAct(
  session: PanelSession,
  act: string,
  el?: HTMLElement | null,
): void {
  if (act === "clear") {
    session.history.length = 0;
    session.lastAnswer = "";
    renderLog(session);
    const key = chatItemKey();
    if (key) void clearChatHistory(key);
    setSessionStatus(session, "대화를 지웠습니다 (저장본 포함).");
    return;
  }
  if (act === "diag-copy") {
    void (async () => {
      const paper = getOpenPaperRef();
      const report = buildDiagnosticReport({
        paper: paper
          ? {
              itemKey: paper.itemKey,
              itemID: paper.itemID ?? null,
              title: paper.title,
              source: paper.source || null,
            }
          : null,
        historyLen: session.history.length,
        busy: session.busy,
        indexBusy: session.indexBusy,
      });
      const ok = await copyTextToClipboard(report);
      setSessionStatus(
        session,
        ok
          ? `진단 로그를 클립보드에 복사했습니다 (${report.length}자). 채팅에 붙여 넣어 주세요.`
          : "클립보드 복사 실패 — 상태줄 아래 대화에 로그를 붙입니다.",
      );
      if (!ok) {
        session.history.push({
          role: "assistant",
          content: "```\n" + report.slice(0, 12000) + "\n```",
        });
        renderLog(session);
      }
      diag("ui", "diag-copy", { ok, len: report.length });
    })();
    return;
  }
  if (act === "note") {
    void (async () => {
      try {
        if (!session.lastAnswer) {
          throw new Error(
            "저장할 답변이 없습니다. 먼저 질문하거나 번역하세요.",
          );
        }
        await saveAnswerAsNote("Paper AI", session.lastAnswer);
        setSessionStatus(session, "마지막 답변을 노트에 저장했습니다.");
      } catch (e) {
        setSessionStatus(session, e instanceof Error ? e.message : String(e));
      }
    })();
    return;
  }
  if (act === "index-paper") {
    void runManualIndex(session);
    return;
  }
  if (act === "summarize") {
    void runSummarize(session);
    return;
  }
  if (act === "autohl-run") {
    void runAutoHighlightAction(session);
    return;
  }
  if (act === "autohl-clear") {
    void clearAutoHighlights(session);
    return;
  }
  if (act === "autohl-refresh") {
    void refreshAutoHighlightList(session);
    return;
  }
  if (act === "autohl-del" || act === "autohl-go") {
    const key = el?.getAttribute("data-key") || "";
    const page = el?.getAttribute("data-page") || "";
    if (act === "autohl-del" && key) {
      void (async () => {
        await deleteAutoAnnotation(key);
        await refreshAutoHighlightList(session);
        setSessionStatus(session, "자동 하이라이트 1개를 삭제했습니다.");
      })();
    } else if (act === "autohl-go" && page) {
      void navigateReaderToPage(Number(page));
    }
    return;
  }
  if (act === "chat") {
    void runAction(session, act);
    return;
  }
  if (act === "sticky-refresh") {
    void refreshStickyList(session);
    return;
  }
  if (act === "sticky-toggle-overlay") {
    void (async () => {
      const paper = getOpenPaperRef();
      if (!paper?.itemKey) {
        setSessionStatus(session, "열린 PDF가 없습니다.");
        return;
      }
      const Z = (globalThis as any).Zotero;
      const reader =
        Z?.Reader?.getByTabID?.(
          Z?.getMainWindow?.()?.Zotero_Tabs?.selectedID,
        ) || Z?.Reader?._readers?.[Z.Reader._readers.length - 1];
      const nextHidden = !isStickyOverlayHidden(paper.itemKey);
      setStickyOverlayHidden(paper.itemKey, nextHidden, reader);
      if (reader) {
        await mountStickiesForReader(reader, paper.itemKey, {
          forceReload: false,
        });
      }
      updateStickyOverlayButton(session, paper.itemKey);
      setSessionStatus(
        session,
        nextHidden
          ? "PDF 위 메모를 숨겼습니다. 목록은 유지됩니다. 「PDF에 보이기」로 다시 켤 수 있습니다."
          : "PDF 위 메모를 다시 표시합니다.",
      );
    })();
    return;
  }
  if (act === "sticky-collapse-all" || act === "sticky-expand-all") {
    void (async () => {
      const paper = getOpenPaperRef();
      if (!paper?.itemKey) {
        setSessionStatus(session, "열린 PDF가 없습니다.");
        return;
      }

      const Z = (globalThis as any).Zotero;
      const reader =
        Z?.Reader?.getByTabID?.(
          Z?.getMainWindow?.()?.Zotero_Tabs?.selectedID,
        ) || Z?.Reader?._readers?.[Z.Reader._readers.length - 1];
      await setAllStickiesCollapsed(
        paper.itemKey,
        act === "sticky-collapse-all",
        reader,
      );
      await refreshStickyList(session);
      setSessionStatus(
        session,
        act === "sticky-collapse-all"
          ? "모든 PDF 메모를 접었습니다."
          : "모든 PDF 메모를 펼쳤습니다.",
      );
    })();
    return;
  }
}

function getActiveReader(): any {
  try {
    const Z = (globalThis as any).Zotero;
    return (
      Z?.Reader?.getByTabID?.(Z?.getMainWindow?.()?.Zotero_Tabs?.selectedID) ||
      Z?.Reader?._readers?.[Z.Reader._readers.length - 1]
    );
  } catch {
    return null;
  }
}

async function refreshAutoHighlightList(session: PanelSession): Promise<void> {
  const listEl = sessionEl(session, "[data-pai-autohl-list]");
  if (!listEl) return;
  const doc = session.root.ownerDocument!;
  listEl.textContent = "";
  let rows: AppliedAutoHighlight[] = [];
  try {
    rows = listAutoAnnotations();
  } catch {
    rows = [];
  }
  const legendEl = sessionEl(session, "[data-pai-autohl-legend]");
  if (legendEl) {
    legendEl.textContent =
      legendLines().join(" · ") +
      " · 태그 paper-ai-auto 로 수동 주석과 구분. 설정에서 개수·색 변경 가능.";
  }

  if (!rows.length) {
    const empty = doc.createElement("div");
    empty.className = "pai-muted";
    empty.textContent =
      "아직 자동 하이라이트가 없습니다. 「생성하기」를 누르세요.";
    listEl.appendChild(empty);
    return;
  }
  for (const r of rows) {
    const cls = getAutoHighlightClass(r.category);
    const row = doc.createElement("div");
    row.className = "pai-autohl-row";

    const sw = doc.createElement("span");
    sw.className =
      "pai-autohl-swatch" + (cls.type === "underline" ? " uline" : "");
    sw.style.background = cls.type === "highlight" ? cls.color : "transparent";
    sw.style.color = cls.color;
    sw.style.borderBottomColor = cls.color;

    const meta = doc.createElement("div");
    meta.className = "pai-autohl-meta";
    const head = doc.createElement("div");
    head.className = "pai-muted";
    head.textContent = `${cls.labelKo} · p.${r.pageLabel}`;
    const quote = doc.createElement("div");
    quote.className = "pai-autohl-quote";
    quote.textContent = r.quote || "(empty)";
    meta.appendChild(head);
    meta.appendChild(quote);

    const actions = doc.createElement("div");
    actions.className = "pai-actions";
    const go = doc.createElement("button");
    go.type = "button";
    go.className = "pai-btn ghost";
    go.setAttribute("data-act", "autohl-go");
    go.setAttribute("data-page", r.pageLabel);
    go.textContent = "이동";
    const del = doc.createElement("button");
    del.type = "button";
    del.className = "pai-btn ghost";
    del.setAttribute("data-act", "autohl-del");
    del.setAttribute("data-key", r.key);
    del.textContent = "삭제";
    actions.appendChild(go);
    actions.appendChild(del);

    row.appendChild(sw);
    row.appendChild(meta);
    row.appendChild(actions);
    listEl.appendChild(row);
  }
}

async function runAutoHighlightAction(session: PanelSession): Promise<void> {
  if (session.busy) {
    setSessionStatus(session, "다른 작업이 진행 중입니다…");
    return;
  }
  setSessionBusy(session, true);
  const btnEl = session.root.querySelector(
    "[data-act='autohl-run']",
  ) as HTMLButtonElement | null;
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "생성 중…";
  }
  try {
    const store = createZoteroFileStore();
    const result = await runAutoHighlight({
      store,
      reader: getActiveReader(),
      onStatus: (s) => setSessionStatus(session, s),
    });
    await refreshAutoHighlightList(session);
    setSessionStatus(
      session,
      `자동 하이라이트 완료: ${result.applied.length}개 표시` +
        (result.skipped ? ` · 위치 실패 ${result.skipped}` : "") +
        ` (후보 ${result.candidateCount} · 분류 ${result.classifiedCount})`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diag("ui", "autohl fail", msg);
    setSessionStatus(session, `자동 하이라이트 실패: ${msg}`);
  } finally {
    setSessionBusy(session, false);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = "생성하기";
    }
  }
}

async function clearAutoHighlights(session: PanelSession): Promise<void> {
  try {
    const n = await deleteAllAutoAnnotations();
    await refreshAutoHighlightList(session);
    setSessionStatus(
      session,
      n
        ? `자동 하이라이트 ${n}개를 삭제했습니다. (수동 주석은 유지)`
        : "삭제할 자동 하이라이트가 없습니다.",
    );
  } catch (e) {
    setSessionStatus(session, e instanceof Error ? e.message : String(e));
  }
}

function updateStickyOverlayButton(
  session: PanelSession,
  itemKey?: string,
): void {
  const btnEl = session.root.querySelector(
    "[data-act='sticky-toggle-overlay']",
  ) as HTMLButtonElement | null;
  if (!btnEl) return;
  const key = itemKey || getOpenPaperRef()?.itemKey || "";
  const hidden = key ? isStickyOverlayHidden(key) : false;
  btnEl.textContent = hidden ? "PDF에 보이기" : "PDF에서 숨기기";
  btnEl.title = hidden
    ? "PDF 리더 위에 메모 카드·연결선을 다시 표시"
    : "PDF 리더 위 메모만 숨김 (목록·데이터 유지)";
}

function kindLabelKo(kind: StickyKind | string): string {
  switch (kind) {
    case "translate":
      return "번역";
    case "explain":
      return "설명";
    case "figure":
      return "그림";
    case "chat":
      return "Q&A";
    default:
      return "메모";
  }
}

async function refreshStickyList(session: PanelSession): Promise<void> {
  const listEl = sessionEl(session, "[data-pai-sticky-list]");
  if (!listEl) return;
  const paper = getOpenPaperRef();
  listEl.textContent = "";
  updateStickyOverlayButton(session, paper?.itemKey);
  if (!paper?.itemKey) {
    const empty = session.root.ownerDocument!.createElement("div");
    empty.className = "pai-muted";
    empty.textContent = "열린 PDF가 없습니다.";
    listEl.appendChild(empty);
    return;
  }
  let notes: StickyNote[] = [];
  try {
    notes = await listStickiesInPaperOrder(paper.itemKey);
  } catch (e) {
    const err = session.root.ownerDocument!.createElement("div");
    err.className = "pai-muted";
    err.textContent = e instanceof Error ? e.message : String(e);
    listEl.appendChild(err);
    return;
  }
  if (!notes.length) {
    const empty = session.root.ownerDocument!.createElement("div");
    empty.className = "pai-muted";
    empty.textContent =
      "메모 없음 — PDF에서 번역/설명·그림 설명을 하면 여기에 페이지 순으로 쌓입니다.";
    listEl.appendChild(empty);
    return;
  }
  const doc = session.root.ownerDocument!;
  for (const n of notes) {
    const row = doc.createElement("button");
    row.type = "button";
    row.className = "pai-sticky-row";
    row.setAttribute("data-sticky-id", n.id);
    const page = doc.createElement("div");
    page.className = "pai-sticky-page";
    const pi = stickyPageIndex(n);
    page.textContent = n.pageLabel || (pi < 9999 ? `p.${pi + 1}` : "p.?");
    const meta = doc.createElement("div");
    meta.className = "pai-sticky-meta";
    const k = doc.createElement("div");
    k.className = "pai-sticky-kind";
    k.textContent = `${kindLabelKo(n.kind)}${n.collapsed ? " · 접힘" : ""}`;
    const q = doc.createElement("div");
    q.className = "pai-sticky-quote";
    q.textContent = (n.quote || n.answer || "")
      .replace(/\s+/g, " ")
      .slice(0, 120);
    meta.appendChild(k);
    meta.appendChild(q);
    row.appendChild(page);
    row.appendChild(meta);
    row.addEventListener("click", () => {
      void (async () => {
        const Z = (globalThis as any).Zotero;
        const reader =
          Z?.Reader?.getByTabID?.(
            Z?.getMainWindow?.()?.Zotero_Tabs?.selectedID,
          ) || Z?.Reader?._readers?.[Z.Reader._readers.length - 1];
        await focusSticky(paper.itemKey, n.id, reader);
        setSessionStatus(
          session,
          `메모로 이동 · ${kindLabelKo(n.kind)} · ${page.textContent}`,
        );
        await refreshStickyList(session);
      })();
    });
    listEl.appendChild(row);
  }
}

/** Show cached index on panel open (no re-extract). */
async function refreshIndexButtonStatus(session: PanelSession): Promise<void> {
  try {
    const paper = getOpenPaperRef();
    if (!paper?.itemKey) {
      setIndexButtonState(session.root, "idle");
      return;
    }
    const store = createZoteroFileStore();
    const cached = await findLatestIndexForPaper(store, paper.itemKey);
    if (!cached) {
      setIndexButtonState(session.root, "idle");
      return;
    }
    const label = formatIndexLabel(cached);
    setIndexButtonState(session.root, "ready", label);
    setSessionStatus(
      session,
      `${label} · 로컬 캐시 사용. 재인덱싱이 필요하면 버튼을 다시 누르세요.`,
    );
  } catch {
    /* leave idle */
  }
}

async function runManualIndex(session: PanelSession): Promise<void> {
  if (session.indexBusy) {
    setSessionStatus(session, "이미 인덱싱이 진행 중입니다…");
    return;
  }
  const paper = getOpenPaperRef();
  if (!paper?.itemKey) {
    setIndexButtonState(session.root, "failed", "인덱싱 실패 · PDF 인식 안 됨");
    setSessionStatus(
      session,
      "인덱싱: 열린 PDF를 찾지 못했습니다. PDF 탭을 클릭해 포커스를 준 뒤 다시 시도하세요. (라이브러리 목록만 선택된 상태면 인식이 안 될 수 있습니다.)",
    );
    return;
  }

  session.indexBusy = true;
  setIndexButtonState(session.root, "running", INDEX_BTN_RUNNING);
  setSessionStatus(
    session,
    `논문 인식됨: ${describeOpenPaperRef(paper)} — 추출·인덱싱 중…`,
  );

  try {
    const store = createZoteroFileStore();
    const index = await ensureIndex({
      store,
      prefs: readRagPrefs(),
      itemKey: paper.itemKey,
      itemID: paper.itemID,
      title: paper.title,
      onStatus: (msg) => {
        const short = msg.length > 32 ? `${msg.slice(0, 30)}…` : msg;
        setIndexButtonState(session.root, "running", short);
        setSessionStatus(session, msg);
      },
    });
    const label = formatIndexLabel(index).replace("인덱싱 됨", "인덱싱 완료");
    setIndexButtonState(session.root, "ready", label);
    const mode = index.retrievalModeUsed === "hybrid" ? "hybrid" : "BM25";
    const n = index.chunks.filter(
      (c) => c.kind === "child" || c.kind === "abstract",
    ).length;
    // Figure mentions for later explain UX
    const full = index.chunks
      .filter((c) => c.kind === "parent" || c.kind === "abstract")
      .map((c) => c.text)
      .join("\n");
    const figs = extractFigureMentions(full, 12);
    const figHint = figs.length
      ? ` · figure 언급 ${figs.length}개 (예: ${figs
          .slice(0, 3)
          .map((f) => f.label)
          .join(", ")})`
      : "";
    setSessionStatus(
      session,
      `인덱싱 완료 (${mode}, ${n} units)${figHint}. 질문하면 캐시를 씁니다.`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diag("ui", "index fail", { paper, msg });
    const short =
      msg.includes("Empty paper extract") || msg.includes("no extractable")
        ? "인덱싱 실패 · PDF 텍스트 없음"
        : msg.includes("저장 실패") || msg.includes("save")
          ? "인덱싱 실패 · 저장 오류"
          : "인덱싱 실패 · 다시 시도";
    setIndexButtonState(session.root, "failed", short);
    setSessionStatus(
      session,
      `인덱싱 실패 (${describeOpenPaperRef(paper)}): ${msg} — PDF 탭을 연 상태로 다시 시도하거나 「진단 로그 복사」로 상세를 확인하세요.`,
    );
  } finally {
    session.indexBusy = false;
    const btn = session.root.querySelector(
      "[data-act='index-paper']",
    ) as HTMLButtonElement | null;
    if (btn && !btn.classList.contains("running")) {
      btn.disabled = false;
      btn.removeAttribute("disabled");
    }
  }
}

async function runAction(
  session: PanelSession,
  mode: TaskMode,
  extra?: { forcedImage?: ImagePayload },
): Promise<void> {
  if (session.busy) {
    setSessionStatus(
      session,
      "다른 작업이 진행 중입니다. 잠시 후 다시 눌러 주세요.",
    );
    return;
  }

  const input = sessionEl<HTMLTextAreaElement>(session, "[data-pai-input]");
  const question = (input?.value || "").trim();
  const selection = getReaderSelectionText();

  if (mode === "chat" && !question && !selection) {
    setSessionStatus(session, "질문을 입력한 뒤 Enter 또는 보내기를 누르세요.");
    input?.focus();
    return;
  }
  if (!isVisionMode(mode) && mode !== "chat" && !selection) {
    setSessionStatus(session, "PDF에서 텍스트를 먼저 드래그해 선택하세요.");
    return;
  }

  let image: ImagePayload | undefined = extra?.forcedImage;
  let imageSource = extra?.forcedImage ? "file" : "";
  let imageDataUrl: string | undefined;
  let figureHints: string[] = [];

  if (isVisionMode(mode)) {
    setSessionStatus(
      session,
      "정확한 figure/table 소스 찾는 중 (주석·선택 영역·파일)…",
    );
    try {
      if (!image) {
        // Precise only — never full-page canvas
        const cap = await obtainCaptureForVision({
          allowFilePicker: true,
        });
        if (cap) {
          image = cap.image;
          imageSource = cap.source;
        }
      }
      if (image) imageDataUrl = imageToDataUrl(image);
      diag("ui", "vision capture", {
        mode,
        hasImage: !!image,
        source: imageSource || null,
      });
    } catch (e) {
      setSessionStatus(
        session,
        `이미지 준비 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    if (!image && !selection) {
      setSessionStatus(
        session,
        "figure/table 이미지가 없습니다. (1) Zotero 이미지 주석, (2) 그림 영역 드래그 선택, (3) 「이미지 파일 선택」 중 하나를 사용하세요. 전체 페이지 캡처는 하지 않습니다.",
      );
      return;
    }
  }

  // Figure grounding: captions + in-text discussion from index (then RAG)
  let figureExtraContext = "";
  if (mode === "figure-explain") {
    try {
      const paper = getOpenPaperRef();
      if (paper?.itemKey) {
        setSessionStatus(session, "그림 관련 캡션·본문 문단 수집 중…");
        const store = createZoteroFileStore();
        const idx = await ensureIndex({
          store,
          prefs: readRagPrefs(),
          itemKey: paper.itemKey,
          itemID: paper.itemID,
          title: paper.title,
        });
        const full = idx.chunks
          .filter((c) => c.kind === "parent" || c.kind === "abstract")
          .map((c) => c.text)
          .join("\n");
        const bundle = buildFigureContextBundle(full, {
          userQuestion: question,
        });
        figureHints = bundle.labels;
        const rag = await attachRagContext({
          mode,
          store,
          query: bundle.ragQuery || question || "figure caption",
          selection: [selection, bundle.labels.join(" ")]
            .filter(Boolean)
            .join("\n"),
          paper,
          ragPrefs: readRagPrefs(),
          onStatus: (msg) => setSessionStatus(session, msg),
        });
        figureExtraContext = mergeFigureEvidence(
          bundle.directBlock,
          rag.contextBlock,
        );
        if (rag.indexLabel) {
          setIndexButtonState(session.root, "ready", rag.indexLabel);
        }
      }
    } catch (e) {
      diag("ui", "figure context fail", String(e));
    }
  }

  const userVisible = formatUserVisible(mode, {
    question,
    selection,
    hasImage: !!image,
    imageSource: imageSource || undefined,
    figureHints,
  });
  session.history.push({
    role: "user",
    content: userVisible,
    imageDataUrl,
    imageCaption: image
      ? `추출 이미지${imageSource ? ` · ${imageSource}` : ""}`
      : undefined,
  });
  session.history.push({ role: "assistant", content: "" });
  renderLog(session);
  setSessionBusy(session, true);
  setSessionStatus(
    session,
    image
      ? `이미지+본문 근거로 설명 생성 중… (${imageSource || "image"})`
      : "응답 생성 중…",
  );

  try {
    const store = createZoteroFileStore();
    const paper = getOpenPaperRef();
    // Vision modes already attached figureExtraContext via runPaperTask.context
    // — pass prebuilt context and skip double RAG by using selection boost lightly
    const selectionBoost =
      mode === "figure-explain"
        ? [selection, figureHints.join(" ")].filter(Boolean).join("\n")
        : selection;
    const result = await runPaperTask({
      mode,
      store,
      selection: selectionBoost || undefined,
      question: question || undefined,
      image,
      paper,
      prefetchedContext: figureExtraContext || undefined,
      history:
        mode === "chat"
          ? session.history.slice(0, -2).filter((h) => h.content)
          : undefined,
      onDelta: (delta) => {
        const last = session.history[session.history.length - 1];
        if (last?.role === "assistant") {
          last.content += delta;
          // Progressive MD is OK — paint is try/catch + plain fallback per bubble
          scheduleRenderLog(session);
        }
      },
      onStatus: (msg) => setSessionStatus(session, msg),
    });

    const last = session.history[session.history.length - 1];
    if (last?.role === "assistant") {
      last.content = scrubIllegalChars(result.answer || last.content);
    }
    session.lastAnswer = last?.content || result.answer;
    // Force immediate final paint (flush debounced stream timer)
    if (session.renderTimer) {
      clearTimeout(session.renderTimer);
      session.renderTimer = null;
    }
    renderLog(session);
    if (input && (mode === "chat" || isVisionMode(mode))) input.value = "";
    if (result.indexLabel) {
      setIndexButtonState(session.root, "ready", result.indexLabel);
    }

    // Persist Q&A history for this paper across restarts
    if (mode === "chat") {
      const key = chatItemKey();
      if (key) void saveChatHistory(key, session.history);
    }

    // Sticky only for explain / figure on the PDF — not translate or chat.
    const pinSticky = mode === "explain" || mode === "figure-explain";
    try {
      const ref = paper || getOpenPaperRef();
      if (pinSticky && ref?.itemKey && result.answer) {
        const Z = (globalThis as any).Zotero;
        const reader =
          Z?.Reader?.getByTabID?.(
            Z?.getMainWindow?.()?.Zotero_Tabs?.selectedID,
          ) || Z?.Reader?._readers?.[Z.Reader._readers.length - 1];
        const kind: StickyKind = mode === "explain" ? "explain" : "figure";
        await upsertSticky(
          {
            itemKey: ref.itemKey,
            kind,
            quote: (selection || question || userVisible).slice(0, 400),
            answer: result.answer,
            x: 48,
            y: 100 + nextCascadeOffset(ref.itemKey),
            pinned: true,
          },
          reader,
        );
        if (reader) await mountStickiesForReader(reader, ref.itemKey);
        setSessionStatus(
          session,
          `완료 · ${result.provider} / ${result.model} · PDF 위 고정 메모에도 표시 (×로 닫기)`,
        );
      } else {
        setSessionStatus(
          session,
          `완료 · ${result.provider} / ${result.model}`,
        );
      }
    } catch {
      setSessionStatus(session, `완료 · ${result.provider} / ${result.model}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const last = session.history[session.history.length - 1];
    if (last?.role === "assistant") last.content = `오류: ${msg}`;
    renderLog(session);
    setSessionStatus(session, msg);
  } finally {
    setSessionBusy(session, false);
  }
}

/** Menu / selection shortcut entry — reuses open panel session or one-shot task. */
export async function triggerMode(mode: TaskMode): Promise<void> {
  const session = getLastPanelSession();
  if (session) {
    await runAction(session, mode);
    return;
  }

  const selection = getReaderSelectionText();
  let image: ImagePayload | undefined;
  if (isVisionMode(mode)) {
    image =
      (await obtainImageForVision({ allowFilePicker: true })) || undefined;
    if (!image && !selection) {
      new ztoolkit.ProgressWindow(config.addonName)
        .createLine({
          text: "그림/수식: 이미지 파일을 선택하거나 관련 텍스트를 선택하세요.",
          type: "fail",
        })
        .show();
      return;
    }
  } else if (!selection && mode !== "chat") {
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({ text: "PDF에서 텍스트를 먼저 선택하세요.", type: "fail" })
      .show();
    return;
  }

  try {
    const store = createZoteroFileStore();
    const result = await runPaperTask({
      mode,
      store,
      selection: selection || undefined,
      image,
      paper: getOpenPaperRef(),
    });
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({ text: result.answer.slice(0, 180), type: "success" })
      .show();
  } catch (e) {
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({
        text: e instanceof Error ? e.message : String(e),
        type: "fail",
      })
      .show();
  }
}

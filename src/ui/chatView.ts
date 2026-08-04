/**
 * Chat-only DOM surface (pane card body or detach dialog host).
 * Renders from ChatModel; document-agnostic (ownerDocument).
 */

import { getKatexCss } from "./katexCss";
import {
  handleCiteClick,
  scrubIllegalChars,
  setMarkdownHtmlWithCites,
} from "./markdown";
import type { ChatModel } from "./chatModel";
import type { ChatTurn } from "./paperTask";
import { diag } from "../utils/diagnostics";

const CHAT_VIEW_CSS = `
.pai-chat-view {
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #1a1a1a;
  background: #f7f7f8;
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 360px;
  box-sizing: border-box;
  padding: 10px;
}
.pai-chat-view * { box-sizing: border-box; }
.pai-chat-view .pai-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.pai-chat-view .pai-title, .pai-chat-view h4 {
  font-weight: 700; font-size: 14px; margin: 0; color: #1a1a1a;
}
.pai-chat-view .pai-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.pai-chat-view .pai-btn {
  border: 1px solid #ddd; background: #fff; border-radius: 8px;
  padding: 6px 10px; font: 12px system-ui; cursor: pointer; color: #1a1a1a;
}
.pai-chat-view .pai-btn.ghost {
  background: transparent; border-color: transparent; color: #555;
}
.pai-chat-view .pai-btn.primary {
  background: #1a73e8; border-color: #1a73e8; color: #fff; font-weight: 600;
}
.pai-chat-view .pai-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.pai-chat-view .pai-log {
  flex: 1 1 auto;
  min-height: 160px;
  max-height: 85vh;
  height: min(50vh, 480px);
  overflow: auto;
  resize: vertical;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 4px;
  background: #fafafa;
  border: 1px solid #eee;
  border-radius: 8px;
}
.pai-chat-view .pai-bubble {
  max-width: 95%; padding: 8px 10px; border-radius: 12px;
  font-size: 12.5px; word-break: break-word;
}
.pai-chat-view .pai-bubble.user {
  align-self: flex-end; background: #e8f0fe; color: #174ea6;
}
.pai-chat-view .pai-bubble.assistant {
  align-self: flex-start; background: #fff; border: 1px solid #e8e8e8;
}
.pai-chat-view .pai-bubble.empty {
  align-self: center; background: transparent; border: none; color: #888;
  text-align: center;
}
.pai-chat-view .pai-md p { margin: 0.4em 0; }
.pai-chat-view .pai-md p:first-child { margin-top: 0; }
.pai-chat-view .pai-composer { display: flex; flex-direction: column; gap: 6px; }
.pai-chat-view .pai-input-row { display: flex; gap: 8px; align-items: flex-end; }
.pai-chat-view textarea.pai-input {
  flex: 1; min-height: 72px; max-height: 180px; resize: vertical;
  border: 1px solid #d0d0d0; border-radius: 10px; padding: 10px 12px;
  font: inherit; background: #fff;
}
.pai-chat-view button.pai-send {
  flex-shrink: 0; min-width: 72px; height: 40px; border: none;
  border-radius: 10px; background: #1a73e8; color: #fff; font-weight: 600;
  cursor: pointer;
}
.pai-chat-view .pai-status { min-height: 1.2em; font-size: 11px; color: #666; }
.pai-chat-view .pai-muted { color: #666; font-size: 11px; }
.pai-chat-view .katex { font-size: 1.05em; }
.pai-chat-view .katex-display { margin: 0.45em 0; overflow-x: auto; }
.pai-chat-view a.paperai-cite {
  color: #1557b0; font-weight: 600; cursor: pointer; text-decoration: underline;
}
`;

function el(
  doc: Document,
  tag: string,
  attrs?: Record<string, string> | null,
  kids?: Array<Node | string | null | undefined>,
): HTMLElement {
  const node = doc.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class" || k === "className") node.setAttribute("class", v);
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    }
  }
  if (kids) {
    for (const c of kids) {
      if (c == null) continue;
      if (typeof c === "string") node.appendChild(doc.createTextNode(c));
      else node.appendChild(c);
    }
  }
  return node;
}

function btn(
  doc: Document,
  act: string,
  label: string,
  className: string,
): HTMLElement {
  return el(
    doc,
    "button",
    { type: "button", class: className, "data-act": act },
    [label],
  );
}

function paintAssistant(doc: Document, content: string): HTMLElement {
  const body = el(doc, "div", { class: "pai-md" });
  setMarkdownHtmlWithCites(body, content || "…");
  return body;
}

function renderHistory(
  log: HTMLElement,
  history: ChatTurn[],
  emptyText: string,
): void {
  const doc = log.ownerDocument!;
  while (log.firstChild) log.removeChild(log.firstChild);
  if (!history.length) {
    log.appendChild(el(doc, "div", { class: "pai-bubble empty" }, [emptyText]));
    return;
  }
  for (const m of history) {
    const bubble = el(doc, "div", {
      class: `pai-bubble ${m.role === "assistant" ? "assistant" : "user"}`,
    });
    const content = scrubIllegalChars(
      m.content || (m.role === "assistant" ? "…" : ""),
    );
    if (m.role === "assistant") {
      bubble.appendChild(paintAssistant(doc, content));
    } else {
      const body = el(doc, "div");
      body.style.whiteSpace = "pre-wrap";
      body.textContent = content;
      bubble.appendChild(body);
    }
    log.appendChild(bubble);
  }
  log.scrollTop = log.scrollHeight;
}

export interface MountChatViewOpts {
  host: HTMLElement;
  model: ChatModel;
  /** Show 「별도 창」 button (pane only). */
  showDetachButton?: boolean;
  paperTitle?: string;
  onSend?: (question: string) => void | Promise<void>;
  onClear?: () => void | Promise<void>;
  onNote?: () => void | Promise<void>;
  onDetach?: () => void | Promise<void>;
  emptyText?: string;
}

export interface ChatViewHandle {
  root: HTMLElement;
  getInput(): string;
  clearInput(): void;
  setStatus(text: string): void;
  destroy(): void;
}

/**
 * Build and mount a self-contained chat UI bound to model.
 */
export function mountChatView(opts: MountChatViewOpts): ChatViewHandle {
  const {
    host,
    model,
    showDetachButton = false,
    paperTitle,
    onSend,
    onClear,
    onNote,
    onDetach,
    emptyText = "아직 대화가 없습니다. 아래에 질문을 쓰고 Enter 또는 보내기를 누르세요.",
  } = opts;
  const doc = host.ownerDocument!;

  while (host.firstChild) host.removeChild(host.firstChild);

  const style = doc.createElement("style");
  style.textContent = `${getKatexCss()}\n${CHAT_VIEW_CSS}`;
  host.appendChild(style);

  const root = el(doc, "div", {
    class: "pai-chat-view",
    "data-pai-chat-view": "1",
  });
  const actions: HTMLElement[] = [];
  if (showDetachButton) {
    actions.push(btn(doc, "chat-detach", "별도 창", "pai-btn ghost"));
  }
  actions.push(btn(doc, "clear", "대화 지우기", "pai-btn ghost"));
  actions.push(btn(doc, "note", "노트 저장", "pai-btn ghost"));

  root.appendChild(
    el(doc, "div", { class: "pai-head" }, [
      el(doc, "div", null, [
        el(doc, "h4", null, ["논문에 질문하기"]),
        paperTitle
          ? el(doc, "div", { class: "pai-muted" }, [paperTitle])
          : null,
      ]),
      el(doc, "div", { class: "pai-actions" }, actions),
    ]),
  );

  const log = el(doc, "div", { class: "pai-log", "data-pai-log": "1" });
  root.appendChild(log);
  root.appendChild(
    el(doc, "div", { class: "pai-muted" }, [
      "대화 창 모서리를 드래그해 높이 조절 · Enter 보내기",
    ]),
  );

  const textarea = el(doc, "textarea", {
    class: "pai-input",
    "data-pai-input": "1",
    placeholder: "예: 이 논문의 contribution을 세 줄로 요약해줘",
    rows: "4",
  }) as HTMLTextAreaElement;
  const sendBtn = btn(doc, "chat", "보내기", "pai-send pai-btn primary");
  root.appendChild(
    el(doc, "div", { class: "pai-composer" }, [
      el(doc, "div", { class: "pai-input-row" }, [textarea, sendBtn]),
    ]),
  );

  const status = el(doc, "div", {
    class: "pai-status",
    "data-pai-status": "1",
  });
  root.appendChild(status);
  host.appendChild(root);

  const setStatus = (text: string) => {
    status.textContent = text;
  };

  const paint = () => {
    renderHistory(log, model.history, emptyText);
    sendBtn.textContent = model.busy ? "…" : "보내기";
    (sendBtn as HTMLButtonElement).disabled = model.busy;
    textarea.disabled = model.busy;
  };

  const unsub = model.subscribe(paint);
  paint();

  const onKey = (ev: Event) => {
    const ke = ev as KeyboardEvent;
    if (ke.key === "Enter" && !ke.shiftKey) {
      ke.preventDefault();
      const q = textarea.value.trim();
      if (q && onSend) void onSend(q);
    }
  };
  textarea.addEventListener("keydown", onKey);

  const onClick = (ev: Event) => {
    if (handleCiteClick(ev, root)) {
      setStatus("근거 링크로 PDF 이동 중…");
      return;
    }
    const t = (ev.target as Element | null)?.closest?.(
      "[data-act]",
    ) as HTMLElement | null;
    if (!t || !root.contains(t)) return;
    const act = t.getAttribute("data-act");
    if (!act) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (act === "chat") {
      const q = textarea.value.trim();
      if (q && onSend) void onSend(q);
    } else if (act === "clear") {
      if (onClear) void onClear();
    } else if (act === "note") {
      if (onNote) void onNote();
    } else if (act === "chat-detach") {
      if (onDetach) void onDetach();
    }
  };
  root.addEventListener("click", onClick, true);
  root.addEventListener("mousedown", onClick, true);

  return {
    root,
    getInput: () => textarea.value.trim(),
    clearInput: () => {
      textarea.value = "";
    },
    setStatus,
    destroy: () => {
      unsub();
      textarea.removeEventListener("keydown", onKey);
      root.removeEventListener("click", onClick, true);
      root.removeEventListener("mousedown", onClick, true);
      try {
        host.removeChild(root);
        host.removeChild(style);
      } catch {
        /* already gone */
      }
      diag("chat", "chatView destroyed", { itemKey: model.itemKey });
    },
  };
}

/**
 * Panel markup + CSS (no task logic).
 * Builds the tree with createElement only — innerHTML is unreliable in
 * some Zotero chrome / item-pane contexts and can leave an empty body.
 */

import { config } from "../../package.json";

export const INDEX_BTN_IDLE = "이 논문 인덱싱";
export const INDEX_BTN_RUNNING = "인덱싱 중…";

export const PANEL_CSS = `
.paperai-pane {
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #1a1a1a !important;
  background: #f7f7f8 !important;
  padding: 10px;
  display: block !important;
  min-height: 640px !important;
  box-sizing: border-box;
  pointer-events: auto !important;
  overflow: auto !important;
  visibility: visible !important;
  opacity: 1 !important;
}
.paperai-pane * { box-sizing: border-box; }
.paperai-pane .pai-stack {
  display: flex !important;
  flex-direction: column;
  gap: 10px;
  visibility: visible !important;
  min-height: 600px;
}
.paperai-pane .pai-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.paperai-pane .pai-title {
  font-weight: 700; font-size: 14px; color: #1a1a1a !important;
}
.paperai-pane .pai-muted { color: #666; font-size: 11px; line-height: 1.4; }
.paperai-pane .pai-card {
  background: #fff !important;
  border: 1px solid #e5e5e5;
  border-radius: 10px;
  padding: 10px;
  display: flex !important;
  flex-direction: column;
  gap: 8px;
  visibility: visible !important;
}
.paperai-pane .pai-card h4 {
  margin: 0; font-size: 12px; font-weight: 600; color: #333 !important;
}
.paperai-pane .pai-summary-body {
  min-height: 72px;
  max-height: 220px;
  overflow: auto;
  padding: 8px 10px;
  background: #fafafa;
  border: 1px solid #eee;
  border-radius: 8px;
  font-size: 12.5px;
  line-height: 1.45;
  user-select: text;
  -moz-user-select: text;
}
.paperai-pane .pai-summary-body .pai-md ul {
  margin: 0.2em 0;
  padding-left: 1.25em;
}
.paperai-pane .pai-summary-body .pai-md li { margin: 0.25em 0; }
.paperai-pane .pai-summary-body.is-empty {
  color: #888; font-size: 12px; display: flex; align-items: center;
}
.paperai-pane .pai-autohl-list {
  display: flex; flex-direction: column; gap: 6px;
  max-height: 200px; overflow: auto;
}
.paperai-pane .pai-autohl-row {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start;
  padding: 6px 8px; background: #fafafa; border: 1px solid #eee;
  border-radius: 8px; font-size: 12px;
}
.paperai-pane .pai-autohl-swatch {
  width: 10px; height: 10px; border-radius: 2px; margin-top: 4px; flex: 0 0 auto;
}
.paperai-pane .pai-autohl-swatch.uline {
  height: 0; border-bottom: 3px solid currentColor; border-radius: 0; width: 14px;
}
.paperai-pane .pai-autohl-meta { flex: 1 1 120px; min-width: 0; }
.paperai-pane .pai-autohl-quote {
  color: #333; display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden;
}
.paperai-pane .pai-autohl-row .pai-actions { margin-left: auto; }
.paperai-pane .pai-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.paperai-pane button.pai-btn,
.paperai-pane button.pai-send {
  cursor: pointer;
  pointer-events: auto;
  border: 1px solid #d0d0d0;
  background: #fff;
  color: #1a1a1a;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 500;
}
.paperai-pane button.pai-btn:hover { background: #f0f0f0; }
.paperai-pane button.pai-btn.primary {
  background: #1a73e8; border-color: #1a73e8; color: #fff;
}
.paperai-pane button.pai-btn.primary:hover { background: #1557b0; }
.paperai-pane button.pai-btn.ghost {
  background: transparent; border-color: transparent; color: #555; padding: 6px 8px;
}
.paperai-pane button.pai-btn:disabled,
.paperai-pane button.pai-send:disabled {
  opacity: 0.55; cursor: not-allowed;
}
.paperai-pane .pai-card.pai-chat {
  flex: 1 1 auto;
  min-height: 420px;
}
.paperai-pane .pai-log {
  min-height: 320px;
  max-height: none;
  height: min(55vh, 560px);
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 4px;
  background: #fafafa;
  border: 1px solid #eee;
  border-radius: 8px;
}
.paperai-pane .pai-bubble {
  max-width: 95%; padding: 8px 10px; border-radius: 12px;
  font-size: 12.5px; word-break: break-word;
  user-select: text;
  -moz-user-select: text;
  cursor: text;
}
.paperai-pane .pai-bubble.user {
  align-self: flex-end; background: #e8f0fe; color: #174ea6;
  border-bottom-right-radius: 4px;
}
.paperai-pane .pai-bubble.assistant {
  align-self: flex-start; background: #fff; border: 1px solid #e8e8e8;
  color: #1a1a1a; border-bottom-left-radius: 4px;
}
.paperai-pane .pai-bubble.empty {
  align-self: center; background: transparent; border: none;
  color: #888; text-align: center; font-size: 12px;
}
/* GFM markdown inside assistant bubbles */
.paperai-pane .pai-md { user-select: text; -moz-user-select: text; cursor: text; }
.paperai-pane .pai-md p { margin: 0.4em 0; }
.paperai-pane .pai-md p:first-child { margin-top: 0; }
.paperai-pane .pai-md p:last-child { margin-bottom: 0; }
.paperai-pane .pai-md h1,
.paperai-pane .pai-md h2,
.paperai-pane .pai-md h3,
.paperai-pane .pai-md h4 {
  margin: 0.65em 0 0.35em; font-weight: 700; line-height: 1.3; color: #1a1a1a;
}
.paperai-pane .pai-md h1 { font-size: 1.15em; }
.paperai-pane .pai-md h2 { font-size: 1.08em; }
.paperai-pane .pai-md h3 { font-size: 1.02em; }
.paperai-pane .pai-md ul, .paperai-pane .pai-md ol {
  margin: 0.35em 0; padding-left: 1.35em;
}
.paperai-pane .pai-md li { margin: 0.15em 0; }
.paperai-pane .pai-md strong { font-weight: 700; color: #111; }
.paperai-pane .pai-md em { font-style: italic; }
.paperai-pane .pai-md code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.92em; background: #f0f0f0; padding: 0 3px; border-radius: 3px;
}
.paperai-pane .pai-md pre {
  overflow: auto; background: #f4f4f4; padding: 8px 10px;
  border-radius: 6px; font-size: 11px; margin: 0.45em 0;
}
.paperai-pane .pai-md pre code { background: transparent; padding: 0; }
.paperai-pane .pai-md table {
  border-collapse: collapse; width: 100%; margin: 0.5em 0;
  font-size: 12px; display: block; overflow-x: auto;
}
.paperai-pane .pai-md th,
.paperai-pane .pai-md td {
  border: 1px solid #ddd; padding: 5px 8px; text-align: left; vertical-align: top;
}
.paperai-pane .pai-md th { background: #f5f5f5; font-weight: 700; }
.paperai-pane .pai-md tr:nth-child(even) td { background: #fafafa; }
.paperai-pane .pai-md hr {
  border: none; border-top: 1px solid #e0e0e0; margin: 0.6em 0;
}
.paperai-pane .pai-md a.paperai-cite,
.paperai-pane .pai-md a[href^="#paperai-page-"],
.paperai-pane .pai-md a[href="#paperai-cite"] {
  color: #1557b0;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  font-weight: 600;
}
.paperai-pane .pai-md a.paperai-cite:hover,
.paperai-pane .pai-md a[href^="#paperai-page-"]:hover {
  color: #0b3d91;
  background: #e8f0fe;
  border-radius: 2px;
}
.paperai-pane .pai-md blockquote {
  margin: 0.4em 0; padding: 0.2em 0 0.2em 0.75em;
  border-left: 3px solid #c5c5c5; color: #444;
}
.paperai-pane .pai-composer { display: flex; flex-direction: column; gap: 6px; }
.paperai-pane .pai-input-row {
  display: flex; gap: 8px; align-items: flex-end;
}
.paperai-pane textarea.pai-input {
  flex: 1; min-height: 88px; max-height: 200px; resize: vertical;
  border: 1px solid #d0d0d0; border-radius: 10px; padding: 10px 12px;
  font: inherit; background: #fff; color: #1a1a1a;
}
.paperai-pane textarea.pai-input:focus {
  outline: 2px solid #aecbfa; border-color: #1a73e8;
}
.paperai-pane button.pai-send {
  flex-shrink: 0; min-width: 72px; height: 40px; border: none;
  border-radius: 10px; background: #1a73e8; color: #fff;
  font-weight: 600; font-size: 13px; cursor: pointer;
}
.paperai-pane button.pai-send:hover { background: #1557b0; }
.paperai-pane .pai-status {
  min-height: 1.2em; font-size: 11px; color: #666;
}
.paperai-pane .katex { font-size: 1.05em; }
.paperai-pane .pai-stream {
  color: #333; opacity: 0.95;
}
.paperai-pane .pai-steps {
  margin: 0; padding-left: 18px; color: #555; font-size: 11px;
}
.paperai-pane .pai-steps li { margin: 2px 0; }
.paperai-pane button.pai-btn.pai-index {
  width: 100%; font-weight: 600; cursor: pointer;
}
.paperai-pane button.pai-btn.pai-index.primary {
  background: #1a73e8; border-color: #1a73e8; color: #fff;
}
.paperai-pane button.pai-btn.pai-index.primary:hover { background: #1557b0; }
.paperai-pane button.pai-btn.pai-index.ready {
  background: #e6f4ea; border-color: #a8dab5; color: #137333;
}
.paperai-pane button.pai-btn.pai-index.running {
  background: #fef7e0; border-color: #f9d976; color: #8a6d00; cursor: wait;
}
.paperai-pane button.pai-btn.pai-index.failed {
  background: #fce8e6; border-color: #f5c2c0; color: #c5221f;
}
.paperai-pane .pai-img-wrap {
  margin: 0 0 8px;
}
.paperai-pane .pai-thumb {
  display: block;
  max-width: 100%;
  max-height: 180px;
  border-radius: 8px;
  border: 1px solid #e0e0e0;
  background: #fafafa;
  object-fit: contain;
}
.paperai-pane .pai-sticky-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow: auto;
  margin-top: 4px;
}
.paperai-pane .pai-sticky-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  width: 100%;
  text-align: left;
  cursor: pointer;
  border: 1px solid #e5e5e5;
  background: #fafafa;
  border-radius: 8px;
  padding: 6px 8px;
  font: 12px/1.35 system-ui, sans-serif;
  color: #1a1a1a;
}
.paperai-pane .pai-sticky-row:hover { background: #f0f4ff; border-color: #c5d4f5; }
.paperai-pane .pai-sticky-page {
  flex-shrink: 0;
  min-width: 36px;
  font-weight: 700;
  font-size: 11px;
  color: #1565c0;
}
.paperai-pane .pai-sticky-meta {
  flex: 1;
  min-width: 0;
}
.paperai-pane .pai-sticky-kind {
  font-weight: 600;
  font-size: 11px;
  color: #444;
}
.paperai-pane .pai-sticky-quote {
  color: #555;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.paperai-pane .pai-img-cap {
  font-size: 10px;
  color: #666;
  margin-top: 4px;
}
`;

type Kids = Array<Node | string | null | undefined>;

function el(
  doc: Document,
  tag: string,
  attrs?: Record<string, string> | null,
  kids?: Kids,
): HTMLElement {
  const node = doc.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "className" || k === "class") node.setAttribute("class", v);
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
  className = "pai-btn",
): HTMLElement {
  return el(
    doc,
    "button",
    { type: "button", class: className, "data-act": act },
    [label],
  );
}

/** Build panel with createElement only; returns root. */
export function buildPanelDom(
  doc: Document,
  container: HTMLElement,
): HTMLElement {
  // Clear container
  while (container.firstChild) container.removeChild(container.firstChild);

  try {
    container.style.pointerEvents = "auto";
    container.style.minHeight = "420px";
    container.style.height = "100%";
    container.style.overflow = "auto";
    container.style.display = "block";
  } catch {
    /* ignore */
  }

  const root = el(doc, "div", {
    id: `${config.addonRef}-pane`,
    class: "paperai-pane",
  });
  try {
    root.style.pointerEvents = "auto";
    root.style.minHeight = "420px";
    root.style.display = "block";
    root.style.overflow = "auto";
    root.style.visibility = "visible";
    root.style.color = "#1a1a1a";
    root.style.background = "#f7f7f8";
  } catch {
    /* ignore */
  }

  // CSS via textContent (not innerHTML)
  const style = doc.createElement("style");
  style.setAttribute("type", "text/css");
  style.textContent = PANEL_CSS;
  root.appendChild(style);

  const stack = el(doc, "div", { class: "pai-stack" });

  // Head
  stack.appendChild(
    el(doc, "div", { class: "pai-head" }, [
      el(doc, "div", { class: "pai-title" }, ["Paper AI"]),
      el(doc, "div", { class: "pai-actions" }, [
        btn(doc, "clear", "대화 지우기", "pai-btn ghost"),
        btn(doc, "note", "노트 저장", "pai-btn ghost"),
        btn(doc, "diag-copy", "진단 로그 복사", "pai-btn ghost"),
      ]),
    ]),
  );

  // Paper summary (top feature)
  stack.appendChild(
    el(doc, "div", { class: "pai-card pai-summary" }, [
      el(doc, "div", { class: "pai-head" }, [
        el(doc, "h4", null, ["논문 요약"]),
        el(doc, "div", { class: "pai-actions" }, [
          btn(doc, "summarize", "요약 생성하기", "pai-btn primary"),
        ]),
      ]),
      el(doc, "p", { class: "pai-muted" }, [
        "논문 전체 근거로 3–5개 bullet 요약. 결과는 이 논문 노트에 저장되어 Zotero Sync로 따라갑니다.",
      ]),
      el(
        doc,
        "div",
        {
          class: "pai-summary-body is-empty",
          "data-pai-summary": "1",
        },
        ["아직 요약이 없습니다. 「요약 생성하기」를 누르세요."],
      ),
    ]),
  );

  // Auto-highlight card
  stack.appendChild(
    el(doc, "div", { class: "pai-card pai-autohl" }, [
      el(doc, "div", { class: "pai-head" }, [
        el(doc, "h4", null, ["자동 하이라이트"]),
        el(doc, "div", { class: "pai-actions" }, [
          btn(doc, "autohl-run", "생성하기", "pai-btn primary"),
          btn(doc, "autohl-clear", "전체 삭제", "pai-btn ghost"),
          btn(doc, "autohl-refresh", "새로고침", "pai-btn ghost"),
        ]),
      ]),
      el(doc, "p", { class: "pai-muted", "data-pai-autohl-legend": "1" }, [
        "■ 주장·결과(노랑) · ─ 방법(파랑 밑줄) · ■ 기여(초록) · ─ 한계(분홍 밑줄). 태그 paper-ai-auto 로 수동 주석과 구분.",
      ]),
      el(
        doc,
        "div",
        {
          class: "pai-autohl-list",
          "data-pai-autohl-list": "1",
        },
        [
          el(doc, "div", { class: "pai-muted" }, [
            "아직 자동 하이라이트가 없습니다. 「생성하기」를 누르세요.",
          ]),
        ],
      ),
    ]),
  );

  // Index card (translate/explain/figure live on PDF reader UI)
  stack.appendChild(
    el(doc, "div", { class: "pai-card" }, [
      el(doc, "h4", null, ["논문 인덱스 (RAG)"]),
      el(doc, "p", { class: "pai-muted" }, [
        "한 번 인덱싱하면 로컬 RAG 캐시(data dir / paperai/rag)에 저장됩니다. 채팅·sticky는 논문 노트(Zotero Sync). 안 눌러도 첫 질문 때 자동 인덱싱합니다.",
      ]),
      el(
        doc,
        "button",
        {
          type: "button",
          class: "pai-btn pai-index primary",
          "data-act": "index-paper",
          "data-pai-index": "1",
          title: "현재 PDF 전체 텍스트를 추출·청킹해 로컬에 저장",
        },
        [INDEX_BTN_IDLE],
      ),
    ]),
  );

  // Sticky notes in paper order
  stack.appendChild(
    el(doc, "div", { class: "pai-card" }, [
      el(doc, "div", { class: "pai-head" }, [
        el(doc, "h4", null, ["PDF 메모 (논문 순서)"]),
        el(doc, "div", { class: "pai-actions" }, [
          btn(doc, "sticky-refresh", "새로고침", "pai-btn ghost"),
          btn(doc, "sticky-toggle-overlay", "PDF에서 숨기기", "pai-btn ghost"),
          btn(doc, "sticky-collapse-all", "모두 접기", "pai-btn ghost"),
          btn(doc, "sticky-expand-all", "모두 펼치기", "pai-btn ghost"),
        ]),
      ]),
      el(doc, "p", { class: "pai-muted" }, [
        "페이지 순. 항목 클릭 → 원문 이동·메모 펼침. 「PDF에서 숨기기」는 오버레이만 끄고 목록은 유지합니다.",
      ]),
      el(
        doc,
        "div",
        {
          class: "pai-sticky-list",
          "data-pai-sticky-list": "1",
        },
        [
          el(doc, "div", { class: "pai-muted" }, [
            "메모 없음 — PDF에서 번역/설명하면 여기에 쌓입니다.",
          ]),
        ],
      ),
    ]),
  );

  // Chat card
  const log = el(doc, "div", { class: "pai-log", "data-pai-log": "1" }, [
    el(doc, "div", { class: "pai-bubble empty" }, [
      "아직 대화가 없습니다. 아래에 질문을 쓰고 Enter 또는 보내기를 누르세요.",
    ]),
  ]);
  const textarea = el(doc, "textarea", {
    class: "pai-input",
    "data-pai-input": "1",
    placeholder: "예: 이 논문의 contribution을 세 줄로 요약해줘",
    rows: "4",
  });
  stack.appendChild(
    el(doc, "div", { class: "pai-card pai-chat" }, [
      el(doc, "h4", null, ["논문에 질문하기"]),
      log,
      el(doc, "div", { class: "pai-composer" }, [
        el(doc, "div", { class: "pai-input-row" }, [
          textarea,
          btn(doc, "chat", "보내기", "pai-send"),
        ]),
        el(doc, "div", { class: "pai-muted" }, [
          "Enter = 보내기 · Shift+Enter = 줄바꿈 · 그림: Select Area 주석 우클릭/사이드바「그림 설명」",
        ]),
      ]),
    ]),
  );

  stack.appendChild(
    el(doc, "div", { class: "pai-status", "data-pai-status": "1" }),
  );

  root.appendChild(stack);
  container.appendChild(root);

  // Hard fail signal if structure missing
  const acts = root.querySelectorAll("[data-act]");
  if (acts.length < 4) {
    const err = el(doc, "div", null, [
      `Paper AI UI build incomplete (controls=${acts.length}).`,
    ]);
    try {
      err.style.cssText =
        "padding:12px;color:#c5221f;background:#fce8e6;border-radius:8px;font:13px system-ui";
    } catch {
      /* ignore */
    }
    root.appendChild(err);
  }

  return root;
}

export type IndexBtnState = "idle" | "running" | "ready" | "failed";

export function setIndexButtonState(
  root: HTMLElement,
  state: IndexBtnState,
  label?: string,
): void {
  const btnEl = root.querySelector(
    "[data-pai-index], [data-act='index-paper']",
  ) as HTMLButtonElement | null;
  if (!btnEl) return;
  btnEl.classList.remove("running", "ready", "failed", "primary");
  if (state === "running") btnEl.classList.add("running");
  else if (state === "ready") btnEl.classList.add("ready");
  else if (state === "failed") btnEl.classList.add("failed");
  else btnEl.classList.add("primary");

  if (state === "running") {
    btnEl.disabled = true;
    btnEl.setAttribute("aria-busy", "true");
  } else {
    btnEl.disabled = false;
    btnEl.removeAttribute("disabled");
    btnEl.removeAttribute("aria-busy");
  }

  if (label != null) btnEl.textContent = label;
  else if (state === "idle") btnEl.textContent = INDEX_BTN_IDLE;
  else if (state === "running") btnEl.textContent = INDEX_BTN_RUNNING;
}

/**
 * Structural self-check used by unit tests (and optional runtime assert).
 * Pure: needs a Document with createElement/querySelector (browser or linkedom).
 */
export function countPanelControls(root: HTMLElement): {
  cards: number;
  actions: number;
  hasIndex: boolean;
  hasChat: boolean;
  hasSummary: boolean;
  hasFigure: boolean;
} {
  return {
    cards: root.querySelectorAll(".pai-card").length,
    actions: root.querySelectorAll("[data-act]").length,
    hasIndex: !!root.querySelector("[data-act='index-paper']"),
    hasChat: !!root.querySelector("[data-act='chat']"),
    hasSummary: !!root.querySelector("[data-act='summarize']"),
    // Figure tools moved to PDF reader (area select / annotation menu)
    hasFigure: false,
  };
}

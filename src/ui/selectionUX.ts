/**
 * Reader selection UX: floating toolbar + optional auto-translate on drag.
 * Hooks PDF iframe mouseup / selectionchange (best-effort across Zotero versions).
 */

import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { getReaderSelectionText, getSelectedReader } from "./reader";
import { triggerMode } from "./panel";
import type { TaskMode } from "../llm/types";

const POPUP_ID = `${config.addonRef}-sel-popup`;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let hookTimer: ReturnType<typeof setInterval> | null = null;
const hookedIframes = new WeakSet<Window>();

function removePopup(doc: Document): void {
  doc.getElementById(POPUP_ID)?.remove();
}

function showPopup(
  hostDoc: Document,
  x: number,
  y: number,
  text: string,
): void {
  removePopup(hostDoc);
  const popup = hostDoc.createElement("div");
  popup.id = POPUP_ID;
  popup.setAttribute("data-paperai-selection", text.slice(0, 80));
  Object.assign(popup.style, {
    position: "fixed",
    left: `${Math.max(8, x)}px`,
    top: `${Math.max(8, y - 40)}px`,
    zIndex: "99999",
    display: "flex",
    gap: "4px",
    padding: "4px 6px",
    background: "#fff",
    border: "1px solid #bbb",
    borderRadius: "6px",
    boxShadow: "0 2px 10px rgba(0,0,0,.15)",
    font: "12px system-ui, sans-serif",
    color: "#111",
  } as CSSStyleDeclaration);

  const mkBtn = (label: string, mode: TaskMode) => {
    const b = hostDoc.createElement("button");
    b.type = "button";
    b.textContent = label;
    Object.assign(b.style, {
      cursor: "pointer",
      padding: "3px 8px",
      border: "1px solid #ccc",
      borderRadius: "4px",
      background: "#f6f6f6",
    } as CSSStyleDeclaration);
    b.addEventListener("mousedown", (e) => {
      // keep selection while clicking
      e.preventDefault();
      e.stopPropagation();
    });
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      removePopup(hostDoc);
      void triggerMode(mode);
    });
    return b;
  };

  // Drag selection: translate + explain only
  popup.appendChild(mkBtn("번역", "translate"));
  popup.appendChild(mkBtn("설명", "explain"));

  const close = hostDoc.createElement("button");
  close.type = "button";
  close.textContent = "×";
  Object.assign(close.style, {
    cursor: "pointer",
    border: "none",
    background: "transparent",
    fontSize: "14px",
    padding: "0 4px",
  } as CSSStyleDeclaration);
  close.addEventListener("click", () => removePopup(hostDoc));
  popup.appendChild(close);

  (hostDoc.body || hostDoc.documentElement)!.appendChild(popup);
}

function handleSelectionEvent(
  iframeWin: Window,
  clientX?: number,
  clientY?: number,
): void {
  const text = (() => {
    try {
      const t = iframeWin.getSelection?.()?.toString?.()?.trim() || "";
      if (t) return t;
    } catch {
      /* fall through */
    }
    return getReaderSelectionText();
  })();

  if (!text || text.length < 2) {
    const mainWins = Zotero.getMainWindows();
    for (const w of mainWins) removePopup(w.document);
    return;
  }

  // Host document for popup = main Zotero window
  const mainWin = Zotero.getMainWindows()[0];
  if (!mainWin) return;
  const hostDoc = mainWin.document;
  const x = clientX ?? 120;
  const y = clientY ?? 120;

  // Map iframe coords roughly into host if needed — use event coords from iframe
  // as approximate screen position via iframe element rect
  let hx = x;
  let hy = y;
  try {
    const reader = getSelectedReader() as unknown as {
      _iframe?: HTMLIFrameElement;
      _iframeWindow?: Window;
    } | null;
    const iframe =
      reader?._iframe ||
      (hostDoc.querySelector(
        "#reader-view iframe, browser[type='content']",
      ) as HTMLIFrameElement | null);
    if (iframe?.getBoundingClientRect) {
      const r = iframe.getBoundingClientRect();
      hx = r.left + x;
      hy = r.top + y;
    }
  } catch {
    /* use raw */
  }

  // Fallback popup only — no auto API call (avoids double request + 350ms delay).
  // Auto-translate is handled by renderTextSelectionPopup → fastTranslate.
  showPopup(hostDoc, hx, hy, text);
}

function attachToIframeWindow(win: Window): void {
  if (hookedIframes.has(win)) return;
  hookedIframes.add(win);

  const onUp = (ev: MouseEvent) => {
    // slight delay so selection finalizes
    setTimeout(() => handleSelectionEvent(win, ev.clientX, ev.clientY), 30);
  };
  win.addEventListener("mouseup", onUp, true);
  win.addEventListener(
    "keyup",
    (ev: Event) => {
      const kev = ev as KeyboardEvent;
      if (kev.key === "Shift" || kev.key.startsWith("Arrow")) {
        setTimeout(() => handleSelectionEvent(win), 30);
      }
    },
    true,
  );
}

function tryHookActiveReader(): void {
  try {
    const reader = getSelectedReader() as unknown as {
      _iframeWindow?: Window;
      _window?: Window;
      _iframe?: HTMLIFrameElement;
    } | null;
    if (!reader) return;
    const win = reader._iframeWindow || reader._window;
    if (win) attachToIframeWindow(win);
    // also walk nested frames
    try {
      const doc = win?.document;
      const frames = doc?.querySelectorAll("iframe") || [];
      frames.forEach((f: Element) => {
        try {
          const fw = (f as HTMLIFrameElement).contentWindow;
          if (fw) attachToIframeWindow(fw);
        } catch {
          /* cross-origin */
        }
      });
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

/**
 * Disabled: this floating 「번역/설명/×」 toolbar duplicated Zotero's official
 * renderTextSelectionPopup and appeared on every click/selection.
 * Sticky notes + official popup handle UX now.
 */
export function startSelectionUX(): void {
  // Ensure no leftover popups from older builds
  try {
    for (const w of Zotero.getMainWindows()) {
      removePopup(w.document);
    }
  } catch {
    /* ignore */
  }
  // Do not attach mouseup hooks / do not show the custom toolbar.
}

export function stopSelectionUX(): void {
  if (hookTimer) {
    clearInterval(hookTimer);
    hookTimer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  for (const w of Zotero.getMainWindows()) {
    removePopup(w.document);
  }
}

export function ensureDefaultSelectionPrefs(): void {
  try {
    if (getPref("autoTranslateOnSelect") === undefined) {
      setPref("autoTranslateOnSelect", true);
    }
  } catch {
    /* prefs map may not include until typed */
  }
}

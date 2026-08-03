/**
 * Per-mount panel session state (not process-global module lets).
 */

import type { ChatTurn } from "./paperTask";

export interface PanelSession {
  history: ChatTurn[];
  lastAnswer: string;
  busy: boolean;
  indexBusy: boolean;
  root: HTMLElement;
  /** Debounced log render timer. */
  renderTimer: ReturnType<typeof setTimeout> | null;
}

/** Last mounted session (for menu trigger when a pane is open). */
let lastSession: PanelSession | null = null;

export function createPanelSession(root: HTMLElement): PanelSession {
  const session: PanelSession = {
    history: [],
    lastAnswer: "",
    busy: false,
    indexBusy: false,
    root,
    renderTimer: null,
  };
  lastSession = session;
  return session;
}

export function getLastPanelSession(): PanelSession | null {
  if (lastSession?.root?.isConnected) return lastSession;
  return null;
}

export function clearLastPanelSession(session: PanelSession): void {
  if (lastSession === session) lastSession = null;
}

export function sessionEl<T extends HTMLElement = HTMLElement>(
  session: PanelSession,
  sel: string,
): T | null {
  return session.root.querySelector(sel) as T | null;
}

export function setSessionStatus(session: PanelSession, text: string): void {
  const el = sessionEl(session, ".pai-status, [data-pai-status]");
  // Prefer id-less class; also try data attribute set by view
  if (el) {
    el.textContent = text;
    return;
  }
  const byClass = session.root.querySelector(".pai-status") as HTMLElement | null;
  if (byClass) byClass.textContent = text;
}

export function setSessionBusy(session: PanelSession, on: boolean): void {
  session.busy = on;
  const send = sessionEl<HTMLButtonElement>(session, "[data-act='chat']");
  if (send) {
    send.disabled = on;
    send.textContent = on ? "…" : "보내기";
  }
  session.root.querySelectorAll("button[data-act]").forEach((el: Element) => {
    const btn = el as HTMLButtonElement;
    const act = btn.getAttribute("data-act") || "";
    if (act === "clear" || act === "note" || act === "diag-copy") return;
    if (act === "index-paper" && session.indexBusy) return;
    if (on) {
      btn.setAttribute("aria-busy", "true");
      btn.style.opacity = "0.7";
    } else {
      btn.removeAttribute("aria-busy");
      btn.style.opacity = "";
      if (act !== "index-paper" || !session.indexBusy) {
        btn.disabled = false;
        btn.removeAttribute("disabled");
      }
    }
  });
}

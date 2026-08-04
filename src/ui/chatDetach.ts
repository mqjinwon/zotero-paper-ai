/**
 * Detached chat window via zotero-plugin-toolkit DialogHelper.
 * Spec: openDialog("about:blank") + loadCallback mount (toolkit 5.x).
 */

import { DialogHelper } from "zotero-plugin-toolkit";
import { createZoteroFileStore } from "../auth/fileStore";
import { getOpenPaperRef } from "../rag/paperRef";
import { diag } from "../utils/diagnostics";
import { ensureActiveChatModel, type ChatModel } from "./chatModel";
import { mountChatView, type ChatViewHandle } from "./chatView";
import { formatUserVisible, runPaperTask } from "./paperTask";
import { saveAnswerAsNote } from "./reader";
import { scrubIllegalChars } from "./markdown";

interface DetachState {
  dialog: DialogHelper;
  view: ChatViewHandle | null;
  model: ChatModel | null;
}

let detachState: DetachState | null = null;

function windowAlive(dialog: DialogHelper | null | undefined): boolean {
  try {
    const w = dialog?.window;
    return !!(w && !w.closed);
  } catch {
    return false;
  }
}

export function isChatDetached(): boolean {
  return windowAlive(detachState?.dialog);
}

export function focusChatDetach(): boolean {
  if (!isChatDetached() || !detachState?.dialog) return false;
  try {
    detachState.dialog.window.focus();
    return true;
  } catch {
    return false;
  }
}

export function closeChatDetachWindow(): void {
  if (!detachState) return;
  try {
    detachState.view?.destroy();
  } catch {
    /* ignore */
  }
  try {
    if (windowAlive(detachState.dialog)) {
      detachState.dialog.window.close();
    }
  } catch {
    /* ignore */
  }
  detachState = null;
  try {
    if (typeof addon !== "undefined") {
      (addon.data as { chatDialog?: DialogHelper }).chatDialog = undefined;
    }
  } catch {
    /* ignore */
  }
}

async function runDetachChat(
  model: ChatModel,
  question: string,
): Promise<void> {
  if (model.busy) return;
  const q = question.trim();
  if (!q) return;

  model.appendTurn({
    role: "user",
    content: formatUserVisible("chat", { question: q }),
  });
  model.appendTurn({ role: "assistant", content: "" });
  model.setBusy(true);
  detachState?.view?.clearInput();
  detachState?.view?.setStatus("응답 생성 중…");

  try {
    const store = createZoteroFileStore();
    const paper = getOpenPaperRef();
    const result = await runPaperTask({
      mode: "chat",
      store,
      question: q,
      paper,
      history: model.history.slice(0, -2).filter((h) => h.content),
      onDelta: (delta) => {
        const last = model.history[model.history.length - 1];
        if (last?.role === "assistant") {
          last.content += delta;
          model.notify();
        }
      },
      onStatus: (msg) => detachState?.view?.setStatus(msg),
    });
    const last = model.history[model.history.length - 1];
    if (last?.role === "assistant") {
      last.content = scrubIllegalChars(result.answer || last.content);
    }
    model.setLastAnswer(last?.content || result.answer);
    model.notify();
    await model.persist();
    detachState?.view?.setStatus(`완료 · ${result.provider} / ${result.model}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const last = model.history[model.history.length - 1];
    if (last?.role === "assistant") last.content = `오류: ${msg}`;
    model.notify();
    detachState?.view?.setStatus(`실패: ${msg}`);
  } finally {
    model.setBusy(false);
  }
}

/**
 * Open (or focus) the chat-only dialog window.
 */
export async function openChatDetachWindow(): Promise<void> {
  if (isChatDetached()) {
    focusChatDetach();
    return;
  }
  // Drop zombie handle
  if (detachState) closeChatDetachWindow();

  const model = await ensureActiveChatModel();
  if (!model || model.itemKey === "unknown") {
    diag("chat", "detach open skipped — no paper");
    try {
      const Z = (globalThis as any).Zotero;
      Z?.getMainWindow?.()?.alert?.(
        "Paper AI: PDF를 연 뒤 「별도 창」을 눌러 주세요.",
      );
    } catch {
      /* ignore */
    }
    return;
  }

  // Ensure history loaded
  if (!model.history.length) await model.restore();

  const paper = getOpenPaperRef();
  const title = paper?.title
    ? `Paper AI · ${paper.title.slice(0, 48)}`
    : "Paper AI · 논문에 질문하기";

  const dialog = new DialogHelper(1, 1);
  dialog.addCell(
    0,
    0,
    {
      tag: "div",
      id: "paperai-chat-detach-host",
      styles: {
        width: "100%",
        height: "100%",
        minHeight: "520px",
        minWidth: "360px",
        display: "flex",
        flexDirection: "column",
      },
    },
    true,
  );

  let view: ChatViewHandle | null = null;

  dialog.setDialogData({
    loadCallback: () => {
      try {
        const win = dialog.window;
        const doc = win.document;
        try {
          const html = doc.documentElement as HTMLElement;
          const body = doc.body as HTMLElement;
          if (html) {
            html.style.height = "100%";
            html.style.margin = "0";
          }
          if (body) {
            body.style.height = "100%";
            body.style.margin = "0";
            body.style.display = "flex";
            body.style.flexDirection = "column";
          }
        } catch {
          /* ignore */
        }

        const host =
          (doc.getElementById(
            "paperai-chat-detach-host",
          ) as HTMLElement | null) || (doc.body as HTMLElement);

        view = mountChatView({
          host,
          model: model!,
          showDetachButton: false,
          paperTitle: paper?.title || undefined,
          onSend: (q) => runDetachChat(model!, q),
          onClear: async () => {
            await model!.clearPersisted();
            view?.setStatus("대화를 지웠습니다 (저장본 포함).");
          },
          onNote: async () => {
            try {
              if (!model!.lastAnswer) {
                throw new Error("저장할 답변이 없습니다.");
              }
              await saveAnswerAsNote("Paper AI", model!.lastAnswer);
              view?.setStatus("마지막 답변을 노트에 저장했습니다.");
            } catch (e) {
              view?.setStatus(e instanceof Error ? e.message : String(e));
            }
          },
        });
        if (detachState) detachState.view = view;
        view.setStatus("별도 창 · 준비됨");
        diag("chat", "detach mounted", { itemKey: model!.itemKey });
      } catch (e) {
        diag("chat", "detach loadCallback fail", String(e));
      }
    },
    unloadCallback: () => {
      try {
        view?.destroy();
      } catch {
        /* ignore */
      }
      view = null;
      detachState = null;
      try {
        if (typeof addon !== "undefined") {
          (addon.data as { chatDialog?: DialogHelper }).chatDialog = undefined;
        }
      } catch {
        /* ignore */
      }
      diag("chat", "detach unloaded");
    },
  });

  dialog.open(title, {
    width: 440,
    height: 640,
    centerscreen: true,
    resizable: true,
    fitContent: false,
    noDialogMode: true,
    alwaysRaised: false,
  });

  detachState = { dialog, view: null, model };
  try {
    if (typeof addon !== "undefined") {
      (addon.data as { chatDialog?: DialogHelper }).chatDialog = dialog;
    }
  } catch {
    /* ignore */
  }
  diag("chat", "detach open", { itemKey: model.itemKey });
}

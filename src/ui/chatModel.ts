/**
 * Shared chat state for item pane + detached window (one history array per itemKey).
 */

import {
  clearChatHistory,
  loadChatHistory,
  saveChatHistory,
} from "./chatStore";
import type { ChatTurn } from "./paperTask";
import { getOpenPaperRef } from "../rag/paperRef";

export type ChatListener = () => void;

export interface ChatModel {
  itemKey: string;
  history: ChatTurn[];
  busy: boolean;
  lastAnswer: string;
  subscribe(fn: ChatListener): () => void;
  notify(): void;
  setBusy(on: boolean): void;
  setHistory(h: ChatTurn[]): void;
  setLastAnswer(s: string): void;
  appendTurn(t: ChatTurn): void;
  clearLocal(): void;
  persist(): Promise<void>;
  restore(): Promise<void>;
  clearPersisted(): Promise<void>;
}

const models = new Map<string, ChatModel>();

function createModel(itemKey: string): ChatModel {
  const listeners = new Set<ChatListener>();
  const model: ChatModel = {
    itemKey,
    history: [],
    busy: false,
    lastAnswer: "",
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    notify() {
      for (const fn of [...listeners]) {
        try {
          fn();
        } catch {
          /* ignore listener errors */
        }
      }
    },
    setBusy(on) {
      model.busy = !!on;
      model.notify();
    },
    setHistory(h) {
      model.history.length = 0;
      model.history.push(...(h || []));
      const last = [...model.history]
        .reverse()
        .find((t) => t.role === "assistant");
      model.lastAnswer = last?.content || model.lastAnswer;
      model.notify();
    },
    setLastAnswer(s) {
      model.lastAnswer = String(s || "");
      model.notify();
    },
    appendTurn(t) {
      model.history.push(t);
      if (t.role === "assistant" && t.content) {
        model.lastAnswer = t.content;
      }
      model.notify();
    },
    clearLocal() {
      model.history.length = 0;
      model.lastAnswer = "";
      model.notify();
    },
    async persist() {
      await saveChatHistory(model.itemKey, model.history);
    },
    async restore() {
      const hist = await loadChatHistory(model.itemKey);
      model.history.length = 0;
      model.history.push(...hist);
      const last = [...hist].reverse().find((t) => t.role === "assistant");
      model.lastAnswer = last?.content || "";
      model.notify();
    },
    async clearPersisted() {
      model.clearLocal();
      await clearChatHistory(model.itemKey);
    },
  };
  return model;
}

export function getChatModelForItem(itemKey: string): ChatModel {
  const key = itemKey || "unknown";
  let m = models.get(key);
  if (!m) {
    m = createModel(key);
    models.set(key, m);
  }
  return m;
}

/** Active paper's model, or null if no open PDF itemKey. */
export function getActiveChatModel(): ChatModel | null {
  try {
    const paper = getOpenPaperRef();
    const key = paper?.itemKey;
    if (!key) return null;
    return getChatModelForItem(key);
  } catch {
    return null;
  }
}

export async function ensureActiveChatModel(): Promise<ChatModel | null> {
  const m = getActiveChatModel();
  if (!m) return null;
  if (!m.history.length) {
    await m.restore();
  }
  return m;
}

/** Drop idle models except keepKeys (optional GC). */
export function pruneChatModels(keepKeys?: Set<string>): void {
  if (!keepKeys) return;
  for (const k of [...models.keys()]) {
    if (!keepKeys.has(k)) models.delete(k);
  }
}

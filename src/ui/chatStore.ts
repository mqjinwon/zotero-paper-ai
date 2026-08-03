/**
 * Persist "논문에 질문하기" chat history per PDF attachment itemKey.
 * Stored under ~/.paperai/chat/<itemKey>.json
 */

import type { FileStore } from "../auth/fileStore";
import { createZoteroFileStore } from "../auth/fileStore";
import { diag } from "../utils/diagnostics";
import type { ChatTurn } from "./paperTask";

const MAX_TURNS = 60;
/** Skip huge data-URL images on disk (keep text). */
const MAX_IMAGE_DATA_CHARS = 80_000;

function chatPath(store: FileStore, itemKey: string): string {
  return store.join(store.homeDir(), ".paperai", "chat", `${itemKey}.json`);
}

function sanitizeTurns(history: ChatTurn[]): ChatTurn[] {
  const slim: ChatTurn[] = [];
  for (const t of history) {
    if (!t?.role || t.content == null) continue;
    const row: ChatTurn = {
      role: t.role === "assistant" ? "assistant" : "user",
      content: String(t.content),
    };
    if (
      t.imageDataUrl &&
      typeof t.imageDataUrl === "string" &&
      t.imageDataUrl.length <= MAX_IMAGE_DATA_CHARS
    ) {
      row.imageDataUrl = t.imageDataUrl;
      if (t.imageCaption) row.imageCaption = String(t.imageCaption);
    }
    slim.push(row);
  }
  // Keep last N turns
  return slim.length > MAX_TURNS ? slim.slice(-MAX_TURNS) : slim;
}

export async function loadChatHistory(itemKey: string): Promise<ChatTurn[]> {
  if (!itemKey || itemKey === "unknown") return [];
  try {
    const store = createZoteroFileStore();
    const path = chatPath(store, itemKey);
    if (!(await store.exists(path))) return [];
    const raw = await store.readText(path);
    const parsed = JSON.parse(raw) as { history?: ChatTurn[] } | ChatTurn[];
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.history)
        ? parsed.history
        : [];
    const out = sanitizeTurns(list);
    diag("chat", "loaded", { itemKey, count: out.length, path });
    return out;
  } catch (e) {
    diag("chat", "load fail", String(e));
    return [];
  }
}

export async function saveChatHistory(
  itemKey: string,
  history: ChatTurn[],
): Promise<void> {
  if (!itemKey || itemKey === "unknown") return;
  try {
    const store = createZoteroFileStore();
    const path = chatPath(store, itemKey);
    const turns = sanitizeTurns(history);
    const payload = {
      itemKey,
      updatedAt: new Date().toISOString(),
      history: turns,
    };
    await store.writeText(path, JSON.stringify(payload, null, 2));
    diag("chat", "saved", { itemKey, count: turns.length });
  } catch (e) {
    diag("chat", "save fail", String(e));
  }
}

export async function clearChatHistory(itemKey: string): Promise<void> {
  if (!itemKey || itemKey === "unknown") return;
  try {
    const store = createZoteroFileStore();
    const path = chatPath(store, itemKey);
    // Overwrite with empty rather than delete (store may lack unlink)
    await store.writeText(
      path,
      JSON.stringify(
        { itemKey, updatedAt: new Date().toISOString(), history: [] },
        null,
        2,
      ),
    );
    diag("chat", "cleared", { itemKey });
  } catch (e) {
    diag("chat", "clear fail", String(e));
  }
}

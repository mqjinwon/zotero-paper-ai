/**
 * Persist "논문에 질문하기" chat history per paper itemKey.
 * Primary: Zotero child note (library sync). Fallback read: file under dataDir.
 */

import { createZoteroFileStore } from "../auth/fileStore";
import {
  loadItemNotePayload,
  saveItemNotePayload,
} from "../storage/itemNoteStore";
import { resolveReadableFile } from "../utils/dataDir";
import { diag } from "../utils/diagnostics";
import type { ChatTurn } from "./paperTask";

const MAX_TURNS = 60;
/** Skip huge data-URL images (keep text). */
const MAX_IMAGE_DATA_CHARS = 80_000;

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
  return slim.length > MAX_TURNS ? slim.slice(-MAX_TURNS) : slim;
}

function parseHistoryPayload(payload: unknown): ChatTurn[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return sanitizeTurns(payload as ChatTurn[]);
  const obj = payload as { history?: ChatTurn[] };
  if (Array.isArray(obj.history)) return sanitizeTurns(obj.history);
  return [];
}

async function loadHistoryFromFile(itemKey: string): Promise<ChatTurn[]> {
  try {
    const store = createZoteroFileStore();
    const path = await resolveReadableFile(store, "chat", `${itemKey}.json`);
    if (!path) return [];
    const raw = await store.readText(path);
    const parsed = JSON.parse(raw) as { history?: ChatTurn[] } | ChatTurn[];
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.history)
        ? parsed.history
        : [];
    const out = sanitizeTurns(list);
    if (out.length) {
      diag("chat", "loaded from file (legacy)", {
        itemKey,
        count: out.length,
        path,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function loadChatHistory(itemKey: string): Promise<ChatTurn[]> {
  if (!itemKey || itemKey === "unknown") return [];
  try {
    const fromNote = parseHistoryPayload(
      await loadItemNotePayload(itemKey, "chat"),
    );
    if (fromNote.length) {
      diag("chat", "loaded from Zotero note", {
        itemKey,
        count: fromNote.length,
      });
      return fromNote;
    }
    const fromFile = await loadHistoryFromFile(itemKey);
    if (fromFile.length) {
      // One-shot migrate into library so next sync carries it
      void saveChatHistory(itemKey, fromFile);
    }
    return fromFile;
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
    const turns = sanitizeTurns(history);
    const payload = {
      itemKey,
      updatedAt: new Date().toISOString(),
      history: turns,
    };
    const ok = await saveItemNotePayload(itemKey, "chat", payload);
    diag("chat", ok ? "saved to Zotero note" : "save failed", {
      itemKey,
      count: turns.length,
    });
  } catch (e) {
    diag("chat", "save fail", String(e));
  }
}

export async function clearChatHistory(itemKey: string): Promise<void> {
  if (!itemKey || itemKey === "unknown") return;
  await saveChatHistory(itemKey, []);
  diag("chat", "cleared", { itemKey });
}

/**
 * Persist paper bullet summary per parent itemKey (Zotero child note).
 */

import {
  loadItemNotePayload,
  saveItemNotePayload,
} from "../storage/itemNoteStore";
import { diag } from "../utils/diagnostics";

export interface PaperSummaryRecord {
  itemKey: string;
  updatedAt: string;
  markdown: string;
  provider?: string;
  model?: string;
}

export async function loadPaperSummary(
  itemKey: string,
): Promise<PaperSummaryRecord | null> {
  if (!itemKey || itemKey === "unknown") return null;
  try {
    const payload = await loadItemNotePayload(itemKey, "summary");
    if (!payload || typeof payload !== "object") return null;
    const obj = payload as Partial<PaperSummaryRecord>;
    const md = String(obj.markdown || "").trim();
    if (!md) return null;
    return {
      itemKey,
      updatedAt: String(obj.updatedAt || ""),
      markdown: md,
      provider: obj.provider ? String(obj.provider) : undefined,
      model: obj.model ? String(obj.model) : undefined,
    };
  } catch (e) {
    diag("summary", "load fail", String(e));
    return null;
  }
}

export async function savePaperSummary(
  itemKey: string,
  markdown: string,
  meta?: { provider?: string; model?: string },
): Promise<void> {
  if (!itemKey || itemKey === "unknown") return;
  const md = String(markdown || "").trim();
  try {
    const payload: PaperSummaryRecord = {
      itemKey,
      updatedAt: new Date().toISOString(),
      markdown: md,
      provider: meta?.provider,
      model: meta?.model,
    };
    const ok = await saveItemNotePayload(itemKey, "summary", payload);
    diag("summary", ok ? "saved" : "save failed", {
      itemKey,
      len: md.length,
    });
  } catch (e) {
    diag("summary", "save fail", String(e));
  }
}

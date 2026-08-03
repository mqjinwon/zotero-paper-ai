/** Helpers to read selection / item context from Zotero Reader. */

import { getOpenPaperRef, rememberReaderAttachmentId } from "../rag/paperRef";
import { getLastReaderSelection } from "./readerEvents";

export function getSelectedReader(): _ZoteroTypes.ReaderInstance | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Z = (globalThis as any).Zotero || Zotero;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = Z?.getMainWindow?.() || globalThis;
    const tabs = win.Zotero_Tabs || (globalThis as any).Zotero_Tabs;
    if (tabs?.selectedID) {
      const reader = Z.Reader.getByTabID(tabs.selectedID);
      if (reader) return reader;
    }
    // Fallback: last open reader
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const readers = (Z.Reader as any)?._readers as
      | _ZoteroTypes.ReaderInstance[]
      | undefined;
    if (readers?.length) return readers[readers.length - 1];
    return null;
  } catch {
    return null;
  }
}

export function getReaderSelectionText(): string {
  // Prefer last selection from official Reader popup event
  const last = getLastReaderSelection();
  if (last) return last;

  const reader = getSelectedReader();
  if (!reader) return "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = reader as any;
    if (typeof ztoolkit?.Reader?.getSelectedText === "function") {
      const t = ztoolkit.Reader.getSelectedText(reader);
      if (t) return String(t).trim();
    }
    if (typeof r.getSelectedText === "function") {
      return String(r.getSelectedText() || "").trim();
    }
    const win = r._iframeWindow || r._window;
    const sel = win?.getSelection?.()?.toString?.() || "";
    return String(sel).trim();
  } catch {
    return "";
  }
}

export function getReaderItem(): Zotero.Item | null {
  try {
    const ref = getOpenPaperRef();
    if (ref?.itemID) {
      rememberReaderAttachmentId(ref.itemID);
      return Zotero.Items.get(ref.itemID) || null;
    }
    const reader = getSelectedReader();
    if (!reader) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = reader as any;
    const itemID = r.itemID || r._item?.id;
    if (!itemID) return null;
    rememberReaderAttachmentId(itemID);
    return Zotero.Items.get(itemID) || null;
  } catch {
    return null;
  }
}

export function getPaperTitle(): string {
  const ref = getOpenPaperRef();
  if (ref?.title) return ref.title;
  const item = getReaderItem();
  if (!item) return "";
  try {
    const parent = item.parentItem || item;
    return parent.getField("title") || "";
  } catch {
    return "";
  }
}

export async function saveAnswerAsNote(
  title: string,
  body: string,
): Promise<void> {
  const item = getReaderItem();
  if (!item) {
    throw new Error("No open PDF item to attach a note to.");
  }
  const parent = item.isAttachment() && item.parentItem ? item.parentItem : item;
  const note = new Zotero.Item("note");
  note.parentID = parent.id;
  const html = `<h2>${escapeHtml(title)}</h2><div>${body
    .split("\n")
    .map((l) => `<p>${escapeHtml(l)}</p>`)
    .join("")}</div>`;
  note.setNote(html);
  await note.saveTx();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

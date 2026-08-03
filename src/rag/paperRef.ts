/**
 * Canonical open-paper identity for index + query paths.
 * Multi-strategy resolution — item pane focus must not lose the open PDF.
 */

import { diag } from "../utils/diagnostics";

export interface OpenPaperRef {
  /** Stable cache key (prefer parent regular-item key). */
  itemKey: string;
  /** Attachment/item id best for fulltext extract. */
  itemID?: number;
  title: string;
  /** How we found it (debug / status). */
  source?: string;
}

/** Last reader attachment id seen from Reader events (selection popup, etc.). */
let lastKnownAttachmentId: number | null = null;

export function rememberReaderAttachmentId(
  id: number | string | null | undefined,
): void {
  const n = Number(id);
  if (Number.isFinite(n) && n > 0) lastKnownAttachmentId = n;
}

export function getLastKnownAttachmentId(): number | null {
  return lastKnownAttachmentId;
}

function mainWindow(): any {
  const Z = (globalThis as any).Zotero;
  try {
    if (typeof Z?.getMainWindow === "function") {
      const w = Z.getMainWindow();
      if (w) return w;
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof Z?.getMainWindows === "function") {
      const wins = Z.getMainWindows();
      if (wins?.length) return wins[0];
    }
  } catch {
    /* ignore */
  }
  return globalThis;
}

function getTabs(): any {
  const win = mainWindow();
  return win?.Zotero_Tabs || (globalThis as any).Zotero_Tabs || null;
}

function itemToRef(item: any, source: string): OpenPaperRef | null {
  if (!item) return null;
  try {
    const isAtt =
      typeof item.isAttachment === "function"
        ? item.isAttachment()
        : !!item.isAttachment;
    const parent = isAtt && item.parentItem ? item.parentItem : item;
    const itemKey = String(parent.key || item.key || item.id || "");
    if (!itemKey) return null;
    let title = "";
    try {
      title = String(
        parent.getField?.("title") || item.getField?.("title") || "",
      );
    } catch {
      title = "";
    }
    return {
      itemKey,
      itemID: Number(item.id),
      title,
      source,
    };
  } catch {
    return null;
  }
}

function refFromItemId(
  Z: any,
  id: number | string,
  source: string,
): OpenPaperRef | null {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    const item = Z.Items.get(n);
    return itemToRef(item, source);
  } catch {
    return null;
  }
}

function itemIdFromReader(r: any): number | null {
  if (!r) return null;
  const candidates = [
    r.itemID,
    r._itemID,
    r._item?.id,
    r._item?._id,
    typeof r.getItemID === "function" ? r.getItemID() : null,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Resolve the paper currently open in the Zotero reader.
 * Tries selected tab → tab data → all open readers → last known id.
 */
export function getOpenPaperRef(): OpenPaperRef | null {
  try {
    const Z = (globalThis as any).Zotero;
    if (!Z?.Items) return null;

    const tabs = getTabs();
    const selectedID = tabs?.selectedID;

    // 1) Reader for selected tab
    if (Z.Reader && selectedID) {
      try {
        const reader = Z.Reader.getByTabID(selectedID);
        const id = itemIdFromReader(reader);
        if (id) {
          rememberReaderAttachmentId(id);
          const ref = refFromItemId(Z, id, "reader-selected-tab");
          if (ref) {
            diag("paperRef", "resolved", ref);
            return ref;
          }
        }
        if (reader?._item) {
          const ref = itemToRef(reader._item, "reader-_item");
          if (ref) {
            rememberReaderAttachmentId(ref.itemID);
            diag("paperRef", "resolved", ref);
            return ref;
          }
        }
      } catch (e) {
        diag("paperRef", "reader-selected-tab err", String(e));
      }
    }

    // 2) Tab metadata (Zotero_Tabs._tabs / getState)
    if (tabs && selectedID) {
      try {
        const list: any[] =
          (typeof tabs.getState === "function" ? tabs.getState() : null) ||
          tabs._tabs ||
          [];
        const tab =
          list.find((t: any) => t?.id === selectedID) ||
          list.find((t: any) => t?.selected);
        const dataId = tab?.data?.itemID ?? tab?.data?.id;
        if (dataId) {
          rememberReaderAttachmentId(dataId);
          const ref = refFromItemId(Z, dataId, "tab-data");
          if (ref) return ref;
        }
        // reader type tab without data — still try type filter
        if (tab?.type === "reader" && tab?.data?.itemID) {
          const ref = refFromItemId(Z, tab.data.itemID, "tab-reader");
          if (ref) return ref;
        }
      } catch {
        /* continue */
      }
    }

    // 3) Any open reader instance (_readers)
    if (Z.Reader?._readers?.length) {
      try {
        // Prefer reader whose tabID is selected
        const readers: any[] = Z.Reader._readers;
        const chosen =
          (selectedID && readers.find((r) => r?.tabID === selectedID)) ||
          readers[readers.length - 1];
        const id = itemIdFromReader(chosen);
        if (id) {
          rememberReaderAttachmentId(id);
          const ref = refFromItemId(Z, id, "reader-_readers");
          if (ref) return ref;
        }
        if (chosen?._item) {
          const ref = itemToRef(chosen._item, "reader-_readers-_item");
          if (ref) {
            rememberReaderAttachmentId(ref.itemID);
            return ref;
          }
        }
      } catch {
        /* continue */
      }
    }

    // 4) Last known from selection popup / previous success
    if (lastKnownAttachmentId) {
      const ref = refFromItemId(Z, lastKnownAttachmentId, "last-known");
      if (ref) return ref;
    }

    // 5) Selected library item if it is (or has) a PDF attachment
    try {
      const pane = Z.getActiveZoteroPane?.() || mainWindow()?.ZoteroPane;
      const selected = pane?.getSelectedItems?.() || [];
      for (const it of selected) {
        if (!it) continue;
        if (typeof it.isAttachment === "function" && it.isAttachment()) {
          const ref = itemToRef(it, "library-selected-attachment");
          if (ref) return ref;
        }
        if (typeof it.getAttachments === "function") {
          const atts = it.getAttachments() || [];
          for (const aid of atts) {
            const att = Z.Items.get(aid);
            if (
              att &&
              /pdf/i.test(
                String(
                  att.attachmentContentType || att.getField?.("title") || "",
                ),
              )
            ) {
              const ref = itemToRef(att, "library-selected-pdf-child");
              if (ref) return ref;
            }
          }
          // any attachment
          if (atts[0]) {
            const ref = refFromItemId(Z, atts[0], "library-selected-first-att");
            if (ref) return ref;
          }
        }
        const ref = itemToRef(it, "library-selected-item");
        if (ref) return ref;
      }
    } catch {
      /* continue */
    }

    diag("paperRef", "unresolved", {
      selectedID: selectedID || null,
      lastKnown: lastKnownAttachmentId,
    });
    return null;
  } catch (e) {
    diag("paperRef", "fatal", String(e));
    return null;
  }
}

/** Human-readable debug string for status line. */
export function describeOpenPaperRef(ref: OpenPaperRef | null): string {
  if (!ref) return "열린 PDF를 찾지 못함";
  return `${ref.title || ref.itemKey} (id=${ref.itemID ?? "?"}, via ${ref.source || "?"})`;
}

/** Pure helper for tests. */
export function paperRefOf(
  itemKey: string,
  opts?: { itemID?: number; title?: string; source?: string },
): OpenPaperRef {
  return {
    itemKey,
    itemID: opts?.itemID,
    title: opts?.title || "",
    source: opts?.source,
  };
}

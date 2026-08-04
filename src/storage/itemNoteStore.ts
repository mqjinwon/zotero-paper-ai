/**
 * Persist plugin state as child notes under the paper parent item.
 * Syncs via Zotero library sync (not WebDAV file sync / dataDir).
 *
 * Kind tags: paper-ai-chat, paper-ai-sticky, paper-ai-summary
 * RAG indexes stay on disk (cheap to rebuild).
 */

import { diag } from "../utils/diagnostics";

export type ItemNoteKind = "chat" | "sticky" | "summary";

export const ITEM_NOTE_TAGS: Record<ItemNoteKind, string> = {
  chat: "paper-ai-chat",
  sticky: "paper-ai-sticky",
  summary: "paper-ai-summary",
};

const KIND_ATTR = "data-paper-ai";
const VERSION = 1;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/** Build note HTML body from a JSON-serializable payload. */
export function encodeItemNoteBody(
  kind: ItemNoteKind,
  payload: unknown,
): string {
  const json = JSON.stringify(payload);
  const label =
    kind === "chat"
      ? "Paper AI chat history (synced with this item — safe to ignore)"
      : kind === "sticky"
        ? "Paper AI sticky notes (synced with this item — safe to ignore)"
        : "Paper AI paper summary (synced with this item — safe to ignore)";
  return (
    `<div ${KIND_ATTR}="${kind}" data-v="${VERSION}">` +
    `<p><i>${escapeHtml(label)}</i></p>` +
    `<pre class="paper-ai-json">${escapeHtml(json)}</pre>` +
    `</div>`
  );
}

/** Extract payload JSON from note HTML. Returns null if not a plugin note. */
export function decodeItemNoteBody(html: string): {
  kind: ItemNoteKind;
  payload: unknown;
} | null {
  if (!html || typeof html !== "string") return null;
  const kindMatch = html.match(
    new RegExp(`${KIND_ATTR}=["'](chat|sticky|summary)["']`, "i"),
  );
  if (!kindMatch) return null;
  const kind = kindMatch[1].toLowerCase() as ItemNoteKind;

  const preMatch = html.match(
    /<pre[^>]*class=["'][^"']*paper-ai-json[^"']*["'][^>]*>([\s\S]*?)<\/pre>/i,
  );
  const raw = preMatch
    ? preMatch[1]
    : (() => {
        const anyPre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
        return anyPre ? anyPre[1] : null;
      })();
  if (!raw) return null;
  try {
    const payload = JSON.parse(unescapeHtml(raw.trim()));
    return { kind, payload };
  } catch {
    try {
      // Some Zotero versions may strip entities partially
      const payload = JSON.parse(raw.trim());
      return { kind, payload };
    } catch {
      return null;
    }
  }
}

function zotero(): any {
  return (globalThis as any).Zotero;
}

/** Resolve library parent item from plugin itemKey (parent key preferred). */
export function resolveParentItem(itemKey: string): any | null {
  if (!itemKey || itemKey === "unknown") return null;
  const Z = zotero();
  if (!Z?.Items) return null;

  const tryKey = (libId: number, key: string): any | null => {
    try {
      if (typeof Z.Items.getByLibraryAndKey === "function") {
        return Z.Items.getByLibraryAndKey(libId, key) || null;
      }
    } catch {
      /* ignore */
    }
    return null;
  };

  const libs: any[] = [];
  try {
    if (typeof Z.Libraries?.getAll === "function") {
      libs.push(...Z.Libraries.getAll());
    }
  } catch {
    /* ignore */
  }
  if (!libs.length) {
    try {
      const id = Z.Libraries?.userLibraryID;
      if (id != null) libs.push({ id });
    } catch {
      /* ignore */
    }
  }

  for (const lib of libs) {
    const libId = Number(lib?.id ?? lib);
    if (!Number.isFinite(libId)) continue;
    let item = tryKey(libId, itemKey);
    if (!item) continue;
    try {
      if (typeof item.isAttachment === "function" && item.isAttachment()) {
        item = item.parentItem || item;
      } else if (typeof item.isNote === "function" && item.isNote()) {
        item = item.parentItem || item;
      }
    } catch {
      /* keep item */
    }
    return item;
  }
  return null;
}

function noteHasKindTag(note: any, kind: ItemNoteKind): boolean {
  const tag = ITEM_NOTE_TAGS[kind];
  try {
    if (typeof note.hasTag === "function") return !!note.hasTag(tag);
    const tags = note.getTags?.() || [];
    return tags.some(
      (t: any) => String(t?.tag ?? t) === tag || String(t) === tag,
    );
  } catch {
    return false;
  }
}

/** Find existing plugin note child under parent. */
export function findItemNote(parent: any, kind: ItemNoteKind): any | null {
  if (!parent) return null;
  const Z = zotero();
  let ids: number[] = [];
  try {
    if (typeof parent.getNotes === "function") {
      ids = parent.getNotes(false) || parent.getNotes() || [];
    }
  } catch {
    try {
      ids = parent.getNotes?.() || [];
    } catch {
      return null;
    }
  }
  for (const id of ids) {
    try {
      const note = Z.Items.get(id);
      if (!note) continue;
      if (noteHasKindTag(note, kind)) return note;
      const html = String(note.getNote?.() || "");
      const decoded = decodeItemNoteBody(html);
      if (decoded?.kind === kind) return note;
    } catch {
      /* next */
    }
  }
  return null;
}

export async function loadItemNotePayload(
  itemKey: string,
  kind: ItemNoteKind,
): Promise<unknown | null> {
  try {
    const parent = resolveParentItem(itemKey);
    if (!parent) {
      diag("itemNote", "no parent", { itemKey, kind });
      return null;
    }
    const note = findItemNote(parent, kind);
    if (!note) return null;
    const html = String(note.getNote?.() || "");
    const decoded = decodeItemNoteBody(html);
    if (!decoded || decoded.kind !== kind) return null;
    diag("itemNote", "loaded", {
      itemKey,
      kind,
      noteKey: note.key,
    });
    return decoded.payload;
  } catch (e) {
    diag("itemNote", "load fail", String(e));
    return null;
  }
}

export async function saveItemNotePayload(
  itemKey: string,
  kind: ItemNoteKind,
  payload: unknown,
): Promise<boolean> {
  try {
    const Z = zotero();
    const parent = resolveParentItem(itemKey);
    if (!parent || !Z?.Item) {
      diag("itemNote", "save skip — no parent", { itemKey, kind });
      return false;
    }
    const html = encodeItemNoteBody(kind, payload);
    let note = findItemNote(parent, kind);
    if (!note) {
      note = new Z.Item("note");
      if (parent.libraryID != null) note.libraryID = parent.libraryID;
      note.parentID = parent.id;
      note.setNote(html);
      try {
        note.addTag(ITEM_NOTE_TAGS[kind]);
      } catch {
        /* tags optional */
      }
      await note.saveTx();
      diag("itemNote", "created", {
        itemKey,
        kind,
        noteKey: note.key,
      });
      return true;
    }
    note.setNote(html);
    try {
      if (!noteHasKindTag(note, kind)) note.addTag(ITEM_NOTE_TAGS[kind]);
    } catch {
      /* ignore */
    }
    await note.saveTx();
    diag("itemNote", "updated", {
      itemKey,
      kind,
      noteKey: note.key,
    });
    return true;
  } catch (e) {
    diag("itemNote", "save fail", String(e));
    return false;
  }
}

/**
 * Create / list / delete Paper AI auto annotations on the PDF attachment.
 */

import { diag } from "../../utils/diagnostics";
import type { ClassifiedHighlight } from "./classify";
import { locateQuoteInOpenPdf } from "./locate";
import {
  AUTO_TAG_ROOT,
  categoryTag,
  commentPrefix,
  getAutoHighlightClass,
  type AutoHighlightCategory,
} from "./taxonomy";

export interface AppliedAutoHighlight {
  key: string;
  category: AutoHighlightCategory;
  quote: string;
  reason: string;
  pageLabel: string;
  color: string;
  type: "highlight" | "underline";
}

/** Zotero 8-char object key (required by Annotations.saveFromJSON on Zotero 9). */
function generateAnnotationKey(Z: any): string {
  try {
    if (typeof Z?.DataObjectUtilities?.generateKey === "function") {
      return String(Z.DataObjectUtilities.generateKey());
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof Z?.Utilities?.randomString === "function") {
      return String(
        Z.Utilities.randomString(8, "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ"),
      );
    }
    if (typeof Z?.randomString === "function") {
      return String(Z.randomString(8));
    }
  } catch {
    /* fall through */
  }
  // Local fallback (same alphabet Zotero uses)
  const chars = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

function getAttachmentItem(reader?: any): any | null {
  try {
    const Z = (globalThis as any).Zotero;
    if (reader?._item) return reader._item;
    if (reader?.itemID) return Z.Items.get(reader.itemID);
    // fallback: open paper attachment
    const win = Z?.getMainWindow?.() || globalThis;
    const tabs = win?.Zotero_Tabs;
    if (tabs?.selectedID && Z?.Reader?.getByTabID) {
      const r = Z.Reader.getByTabID(tabs.selectedID);
      if (r?._item) return r._item;
      if (r?.itemID) return Z.Items.get(r.itemID);
    }
  } catch {
    /* ignore */
  }
  return null;
}

function itemHasAutoTag(ann: any): boolean {
  try {
    if (typeof ann.hasTag === "function" && ann.hasTag(AUTO_TAG_ROOT)) {
      return true;
    }
    const tags = ann.getTags?.() || [];
    return tags.some(
      (t: any) =>
        String(t?.tag ?? t) === AUTO_TAG_ROOT ||
        String(t?.tag ?? t).startsWith(AUTO_TAG_ROOT + "/"),
    );
  } catch {
    return false;
  }
}

function categoryFromAnn(ann: any): AutoHighlightCategory | null {
  try {
    const tags = ann.getTags?.() || [];
    for (const t of tags) {
      const name = String(t?.tag ?? t);
      const m = name.match(/^paper-ai-auto\/(claim|method|novelty|caveat)$/);
      if (m) return m[1] as AutoHighlightCategory;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function listAutoAnnotations(attachment?: any): AppliedAutoHighlight[] {
  const item = attachment || getAttachmentItem();
  if (!item || typeof item.getAnnotations !== "function") return [];
  const out: AppliedAutoHighlight[] = [];
  try {
    for (const ann of item.getAnnotations() || []) {
      if (!itemHasAutoTag(ann)) continue;
      const cat = categoryFromAnn(ann) || "claim";
      const cls = getAutoHighlightClass(cat);
      out.push({
        key: String(ann.key),
        category: cat,
        quote: String(
          ann.annotationText || ann.getField?.("annotationText") || "",
        ).slice(0, 400),
        reason: String(
          ann.annotationComment || ann.getField?.("annotationComment") || "",
        )
          .replace(/^\[Paper AI[^\]]*\]\s*/i, "")
          .slice(0, 120),
        pageLabel: String(
          ann.annotationPageLabel ||
            ann.getField?.("annotationPageLabel") ||
            "?",
        ),
        color: cls.color,
        type: cls.type,
      });
    }
  } catch (e) {
    diag("autoHL", "list fail", String(e));
  }
  return out;
}

export async function deleteAutoAnnotation(key: string): Promise<boolean> {
  try {
    const Z = (globalThis as any).Zotero;
    const item = getAttachmentItem();
    if (!item) return false;
    for (const ann of item.getAnnotations?.() || []) {
      if (String(ann.key) !== key) continue;
      if (!itemHasAutoTag(ann)) return false;
      await ann.eraseTx();
      diag("autoHL", "deleted one", { key });
      return true;
    }
  } catch (e) {
    diag("autoHL", "delete one fail", String(e));
  }
  return false;
}

export async function deleteAllAutoAnnotations(
  attachment?: any,
): Promise<number> {
  const item = attachment || getAttachmentItem();
  if (!item) return 0;
  let n = 0;
  try {
    const anns = [...(item.getAnnotations?.() || [])];
    for (const ann of anns) {
      if (!itemHasAutoTag(ann)) continue;
      try {
        await ann.eraseTx();
        n++;
      } catch (e) {
        diag("autoHL", "erase fail", String(e));
      }
    }
  } catch (e) {
    diag("autoHL", "delete all fail", String(e));
  }
  diag("autoHL", "deleted all", { n });
  return n;
}

export async function applyClassifiedHighlights(opts: {
  items: ClassifiedHighlight[];
  reader?: any;
  onStatus?: (s: string) => void;
  /** v1: wipe previous auto first */
  replace?: boolean;
}): Promise<{ applied: AppliedAutoHighlight[]; skipped: number }> {
  const Z = (globalThis as any).Zotero;
  const item = getAttachmentItem(opts.reader);
  if (!item || !Z?.Annotations?.saveFromJSON) {
    throw new Error(
      "PDF attachment을 찾지 못했거나 Annotations API를 사용할 수 없습니다.",
    );
  }

  if (opts.replace !== false) {
    opts.onStatus?.("기존 자동 하이라이트 삭제 중…");
    await deleteAllAutoAnnotations(item);
  }

  opts.onStatus?.("PDF 위치 매핑·표시 중…");
  const applied: AppliedAutoHighlight[] = [];
  let skipped = 0;

  for (const it of opts.items) {
    const cls = getAutoHighlightClass(it.category);
    const loc = await locateQuoteInOpenPdf(it.quote, it.pageStart);
    if (!loc || !loc.rects?.length) {
      skipped++;
      continue;
    }
    try {
      const key = generateAnnotationKey(Z);
      const json = {
        key,
        id: key,
        type: cls.type,
        text: it.quote.slice(0, 2000),
        comment: `${commentPrefix(it.category)}\n${it.reason || ""}`.slice(
          0,
          4000,
        ),
        color: cls.color,
        pageLabel: loc.pageLabel,
        sortIndex: `${String(loc.pageIndex).padStart(5, "0")}|000000|00000`,
        position: {
          pageIndex: loc.pageIndex,
          rects: loc.rects,
        },
        tags: [
          { name: AUTO_TAG_ROOT, color: "" },
          { name: categoryTag(it.category), color: cls.color },
        ],
        authorName: "Paper AI",
      };
      const ann = await Z.Annotations.saveFromJSON(item, json as any, {
        skipSelect: true,
      });
      applied.push({
        key: String(ann?.key || key),
        category: it.category,
        quote: it.quote,
        reason: it.reason,
        pageLabel: loc.pageLabel,
        color: cls.color,
        type: cls.type,
      });
      diag("autoHL", "saved", {
        key,
        category: it.category,
        page: loc.pageLabel,
      });
    } catch (e) {
      diag("autoHL", "save fail", String(e));
      skipped++;
    }
  }

  // Refresh reader annotations if possible
  try {
    const reader = opts.reader;
    if (reader && typeof reader._updateAnnotations === "function") {
      /* private */
    }
    const Z2 = (globalThis as any).Zotero;
    Z2?.Reader?._readers?.forEach?.((r: any) => {
      try {
        r.setAnnotations?.(item.getAnnotations?.() || []);
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }

  return { applied, skipped };
}

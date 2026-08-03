/**
 * Shared reader selection state (selection popup / sticky tasks).
 */
import { getOpenPaperRef, rememberReaderAttachmentId } from "../rag/paperRef";
import { getPref } from "../utils/prefs";

let lastSelectionText = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastAnnotationParams: any = null;

export function getLastReaderSelection(): string {
  return lastSelectionText;
}

export function setLastReaderSelection(text: string): void {
  lastSelectionText = (text || "").trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setLastAnnotationParams(params: any): void {
  lastAnnotationParams = params || null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getLastAnnotationParams(): any {
  return lastAnnotationParams;
}

export function autoTranslateEnabled(): boolean {
  try {
    return getPref("autoTranslateOnSelect" as never) !== false;
  } catch {
    return true;
  }
}

export function minChars(): number {
  try {
    const n = Number(getPref("autoTranslateMinChars" as never));
    return Number.isFinite(n) && n > 0 ? n : 8;
  } catch {
    return 8;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function itemKeyFromReader(reader: any): string {
  try {
    const id = reader?.itemID ?? reader?._item?.id;
    if (id) rememberReaderAttachmentId(id);
    const ref = getOpenPaperRef();
    if (ref?.itemKey) return ref.itemKey;
    if (reader?._item?.key) return String(reader._item.key);
    if (id) return String(id);
  } catch {
    /* ignore */
  }
  return "unknown";
}

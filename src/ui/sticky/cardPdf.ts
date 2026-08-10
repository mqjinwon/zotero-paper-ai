/**
 * PDF-anchored sticky card position (pure helpers).
 * PDF user space: origin bottom-left (Zotero / PDF.js rects).
 */

import type { StickyCardPdf, StickyNote } from "./types";

/** Place card top-left just right of a quote rect in PDF user space. */
export function cardPdfFromQuoteRect(
  pageIndex: number,
  rect: number[],
  marginPdf = 12,
): StickyCardPdf | null {
  if (!rect || rect.length < 4) return null;
  if (!Number.isFinite(pageIndex)) return null;
  const x1 = rect[0] ?? 0;
  const y1 = rect[1] ?? 0;
  const x2 = rect[2] ?? 0;
  const y2 = rect[3] ?? 0;
  return {
    pageIndex,
    x: Math.max(x1, x2) + marginPdf,
    y: Math.max(y1, y2),
  };
}

export function isValidCardPdf(
  c: StickyCardPdf | null | undefined,
): c is StickyCardPdf {
  return (
    !!c &&
    Number.isFinite(c.pageIndex) &&
    Number.isFinite(c.x) &&
    Number.isFinite(c.y) &&
    c.pageIndex >= 0
  );
}

/** Seed cardPdf from quote rects when missing (migration / new notes). */
export function seedCardPdfFromNote(note: StickyNote): StickyCardPdf | null {
  if (isValidCardPdf(note.cardPdf)) return note.cardPdf;
  const pageIndex =
    note.pdfLocation?.position?.pageIndex ?? note.pdfLocation?.pageIndex;
  const rects = note.pdfLocation?.position?.rects;
  if (typeof pageIndex !== "number" || !Number.isFinite(pageIndex)) return null;
  const r0 = rects?.[0];
  if (!r0) return null;
  return cardPdfFromQuoteRect(pageIndex, r0);
}

export function coerceCardPdf(raw: unknown): StickyCardPdf | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const pageIndex = Number(o.pageIndex);
  const x = Number(o.x);
  const y = Number(o.y);
  if (
    !Number.isFinite(pageIndex) ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return undefined;
  }
  return { pageIndex, x, y };
}

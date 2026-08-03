/**
 * Sticky note types (PDF overlay cards).
 */

export type StickyKind = "translate" | "explain" | "chat" | "figure" | "other";

/** PDF location for navigate() + connector target. */
export interface StickyPdfLocation {
  pageIndex?: number;
  pageLabel?: string;
  position?: {
    pageIndex?: number;
    rects?: number[][];
  };
}

export interface StickyNote {
  id: string;
  itemKey: string;
  kind: StickyKind;
  quote: string;
  answer: string;
  pageLabel?: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  collapsed?: boolean;
  createdAt: string;
  pinned: boolean;
  pdfLocation?: StickyPdfLocation;
  quoteAnchor?: { x: number; y: number };
  imageDataUrl?: string;
  annotationKey?: string;
}

export const STICKY_MIN_W = 220;
export const STICKY_MIN_H = 140;
export const STICKY_DEFAULT_W = 320;
export const STICKY_DEFAULT_H = 280;

export const HOST_ID = "paperai-sticky-host";
export const CARD_ATTR = "data-paperai-sticky-id";
export const SVG_ID = "paperai-sticky-connectors";

export function uid(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function kindLabel(kind: StickyKind): string {
  switch (kind) {
    case "translate":
      return "번역";
    case "explain":
      return "설명";
    case "chat":
      return "Q&A";
    case "figure":
      return "그림";
    default:
      return "Paper AI";
  }
}

export function kindColor(kind: StickyKind): string {
  switch (kind) {
    case "translate":
      return "#1a73e8";
    case "explain":
      return "#0d904f";
    case "chat":
      return "#7b1fa2";
    case "figure":
      return "#e37400";
    default:
      return "#555";
  }
}

export function clampStickySize(w: number, h: number): { w: number; h: number } {
  return {
    w: Math.max(STICKY_MIN_W, Math.min(720, Math.round(w))),
    h: Math.max(STICKY_MIN_H, Math.min(900, Math.round(h))),
  };
}

/**
 * Sticky on-page visibility policy (pure where possible).
 * Cards stay mounted; off-page ones are hidden and reappear on scroll-back.
 */

import {
  pointInViewport,
  rectsIntersect,
  type Point,
  type Rect,
} from "./geometry";

export type StickyVisibilityInput = {
  /** User is dragging this card — always show. */
  dragging: boolean;
  /** Any PDF page node exists in the reader docs. */
  pdfReady: boolean;
  /** 0-based page index, or null if unknown. */
  pageIndex: number | null;
  /**
   * Page box in the same space as viewerRect.
   * null = page not in DOM (virtualized out).
   * zero-size = layout churn — keep previous / show (handled via pageLayoutChurn).
   */
  pageRect: Rect | null;
  pageLayoutChurn: boolean;
  /** PDF viewer container (or window) box; null falls back to "unknown → show". */
  viewerRect: Rect | null;
  /** Live quote anchor in host coords when pageIndex missing. */
  anchorInHost: Point | null;
  hostViewport: { w: number; h: number };
};

/**
 * Single decision function for whether a sticky card should be shown.
 * Unit-tested; DOM adapter builds the input.
 */
export function shouldShowSticky(input: StickyVisibilityInput): boolean {
  if (input.dragging) return true;
  if (!input.pdfReady) return true; // avoid mount flash before pages exist

  if (input.pageIndex != null && Number.isFinite(input.pageIndex)) {
    if (input.pageLayoutChurn) return true;
    if (!input.pageRect) return false; // known page, not in DOM
    if (!input.viewerRect) return true;
    return rectsIntersect(input.pageRect, input.viewerRect, 4);
  }

  if (input.anchorInHost) {
    return pointInViewport(
      input.anchorInHost,
      input.hostViewport.w,
      input.hostViewport.h,
      40,
    );
  }
  return true;
}

/** Apply on/off without fighting collapsed layout (visibility, not display:flex). */
export function applyStickyCardVisible(
  card: HTMLElement,
  visible: boolean,
): void {
  card.style.visibility = visible ? "visible" : "hidden";
  card.style.pointerEvents = visible ? "auto" : "none";
  // Keep out of hit-testing when hidden; display:none would break drag mid-gesture
  card.style.opacity = visible ? "1" : "0";
  card.dataset.paperaiOffPage = visible ? "0" : "1";
}

export function isCardOffPage(card: HTMLElement): boolean {
  return card.dataset.paperaiOffPage === "1";
}

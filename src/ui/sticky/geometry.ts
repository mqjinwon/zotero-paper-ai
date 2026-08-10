/**
 * Sticky host-local geometry (pure).
 * x/y are CSS pixels on the sticky host, not PDF user-space.
 */

export type Point = { x: number; y: number };
export type Rect = { left: number; top: number; right: number; bottom: number };

export function coerceCoord(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Clamp saved coords into the host viewport for *display only*. */
export function clampDisplayPosition(
  x: number,
  y: number,
  vw: number,
  vh: number,
  cardW: number,
  margin = 8,
): Point {
  const maxX = Math.max(margin, vw - cardW - margin);
  const maxY = Math.max(margin, vh - 48);
  return {
    x: Math.max(margin, Math.min(x, maxX)),
    y: Math.max(margin, Math.min(y, maxY)),
  };
}

/**
 * Read the card's CSS left/top (host-local). Prefer style over GBR:
 * nested reader iframes can disagree with clientX.
 */
export function cardStyleOrigin(
  card: HTMLElement,
  fallbackX: number,
  fallbackY: number,
): Point {
  const sx = parseFloat(card.style.left || "");
  const sy = parseFloat(card.style.top || "");
  return {
    x: Number.isFinite(sx) ? Math.round(sx) : Math.round(fallbackX || 0),
    y: Number.isFinite(sy) ? Math.round(sy) : Math.round(fallbackY || 0),
  };
}

/** Delta drag from style origin + pointer client delta. */
export function stickyDragDeltaPosition(
  startLeft: number,
  startTop: number,
  startClientX: number,
  startClientY: number,
  clientX: number,
  clientY: number,
): Point {
  return {
    x: Math.max(0, Math.round(startLeft + (clientX - startClientX))),
    y: Math.max(0, Math.round(startTop + (clientY - startClientY))),
  };
}

/** True when drag delta exceeds click-noise threshold. */
export function dragExceededThreshold(
  start: Point,
  next: Point,
  thresholdPx = 2,
): boolean {
  return (
    Math.abs(next.x - start.x) >= thresholdPx ||
    Math.abs(next.y - start.y) >= thresholdPx
  );
}

export function rectsIntersect(a: Rect, b: Rect, margin = 0): boolean {
  return (
    a.left < b.right + margin &&
    a.right > b.left - margin &&
    a.top < b.bottom + margin &&
    a.bottom > b.top - margin
  );
}

export function clientRectToBox(r: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): Rect {
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

export function pointInViewport(
  p: Point,
  vw: number,
  vh: number,
  margin = 40,
): boolean {
  return (
    p.x >= -margin && p.x <= vw + margin && p.y >= -margin && p.y <= vh + margin
  );
}

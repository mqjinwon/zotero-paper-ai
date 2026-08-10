/**
 * Sticky geometry + visibility policy (functional contracts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cardStyleOrigin,
  clampDisplayPosition,
  coerceCoord,
  dragExceededThreshold,
  stickyDragDeltaPosition,
} from "../../src/ui/sticky/geometry";
import { shouldShowSticky } from "../../src/ui/sticky/visibility";
import { findPageEl } from "../../src/ui/sticky/pageLookup";

describe("sticky geometry", () => {
  it("zero pointer delta keeps display origin (no jump)", () => {
    const next = stickyDragDeltaPosition(100, 200, 130, 210, 130, 210);
    assert.equal(next.x, 100);
    assert.equal(next.y, 200);
  });

  it("moves by client delta only", () => {
    const next = stickyDragDeltaPosition(100, 50, 120, 60, 170, 90);
    assert.equal(next.x, 150);
    assert.equal(next.y, 80);
  });

  it("old clientX - note.x formula jumps when note.x ≠ style left", () => {
    const paintedX = 100;
    const staleNoteX = 500;
    const clientX = 130;
    const jumped = Math.round(clientX - (clientX - staleNoteX));
    assert.equal(jumped, staleNoteX);
    assert.notEqual(jumped, paintedX);
  });

  it("cardStyleOrigin reads CSS left/top, not GBR", () => {
    const card = {
      style: { left: "64px", top: "120px" },
      getBoundingClientRect: () => ({
        left: 999,
        top: 999,
        width: 100,
        height: 40,
      }),
    } as unknown as HTMLElement;
    const o = cardStyleOrigin(card, 1, 2);
    assert.equal(o.x, 64);
    assert.equal(o.y, 120);
  });

  it("clampDisplayPosition only affects paint, not identity of in-range coords", () => {
    const p = clampDisplayPosition(40, 60, 1200, 800, 320);
    assert.equal(p.x, 40);
    assert.equal(p.y, 60);
  });

  it("clampDisplayPosition pulls oversized Mac x into viewport", () => {
    const p = clampDisplayPosition(2000, 100, 900, 700, 320);
    assert.ok(p.x <= 900 - 320 - 8);
    assert.ok(p.x >= 8);
  });

  it("dragExceededThreshold ignores 1px noise", () => {
    assert.equal(
      dragExceededThreshold({ x: 10, y: 10 }, { x: 11, y: 10 }),
      false,
    );
    assert.equal(
      dragExceededThreshold({ x: 10, y: 10 }, { x: 15, y: 10 }),
      true,
    );
  });

  it("coerceCoord recovers numeric strings", () => {
    assert.equal(coerceCoord("42", 0), 42);
    assert.equal(coerceCoord(undefined, 24), 24);
    assert.equal(coerceCoord(NaN, 80), 80);
  });
});

describe("sticky visibility policy", () => {
  const base = {
    dragging: false,
    pdfReady: true,
    pageIndex: 0 as number | null,
    pageRect: {
      left: 0,
      top: 0,
      right: 100,
      bottom: 200,
    },
    pageLayoutChurn: false,
    viewerRect: {
      left: 0,
      top: 0,
      right: 400,
      bottom: 600,
    },
    anchorInHost: null as { x: number; y: number } | null,
    hostViewport: { w: 800, h: 600 },
  };

  it("shows when page intersects viewer", () => {
    assert.equal(shouldShowSticky(base), true);
  });

  it("hides when page fully below viewer", () => {
    assert.equal(
      shouldShowSticky({
        ...base,
        pageRect: { left: 0, top: 900, right: 100, bottom: 1100 },
      }),
      false,
    );
  });

  it("hides when known page not in DOM", () => {
    assert.equal(
      shouldShowSticky({
        ...base,
        pageRect: null,
        pageLayoutChurn: false,
      }),
      false,
    );
  });

  it("shows during layout churn (zero-size page)", () => {
    assert.equal(
      shouldShowSticky({
        ...base,
        pageRect: null,
        pageLayoutChurn: true,
      }),
      true,
    );
  });

  it("always shows while dragging", () => {
    assert.equal(
      shouldShowSticky({
        ...base,
        dragging: true,
        pageRect: null,
      }),
      true,
    );
  });

  it("shows when PDF not ready", () => {
    assert.equal(
      shouldShowSticky({
        ...base,
        pdfReady: false,
        pageRect: null,
      }),
      true,
    );
  });

  it("without pageIndex uses anchor vs host viewport", () => {
    assert.equal(
      shouldShowSticky({
        ...base,
        pageIndex: null,
        pageRect: null,
        anchorInHost: { x: 100, y: 100 },
      }),
      true,
    );
    assert.equal(
      shouldShowSticky({
        ...base,
        pageIndex: null,
        pageRect: null,
        anchorInHost: { x: -500, y: -500 },
      }),
      false,
    );
  });
});

describe("pageLookup", () => {
  it("findPageEl maps 0-based index to data-page-number", () => {
    // minimal fake document
    const pages = new Map<string, HTMLElement>();
    const make = (n: string) => {
      const el = { tag: "div", n } as unknown as HTMLElement;
      pages.set(n, el);
      return el;
    };
    make("1");
    make("2");
    const doc = {
      querySelector: (sel: string) => {
        const m = sel.match(/data-page-number="(\d+)"/);
        if (m) return pages.get(m[1]!) || null;
        return null;
      },
      querySelectorAll: () => [],
    } as unknown as Document;
    assert.equal(findPageEl(doc, 0), pages.get("1"));
    assert.equal(findPageEl(doc, 1), pages.get("2"));
  });
});

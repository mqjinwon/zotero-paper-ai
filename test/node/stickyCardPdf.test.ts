/**
 * PDF-anchored sticky placement (scroll-stable cardPdf).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cardPdfFromQuoteRect,
  coerceCardPdf,
  isValidCardPdf,
  seedCardPdfFromNote,
} from "../../src/ui/sticky/cardPdf";
import type { StickyNote } from "../../src/ui/sticky/types";

describe("cardPdf pure helpers", () => {
  it("places card to the right/top of quote rect in PDF space", () => {
    // rect [x1,y1,x2,y2] bottom-left origin
    const cp = cardPdfFromQuoteRect(2, [100, 200, 180, 240], 12);
    assert.ok(cp);
    assert.equal(cp!.pageIndex, 2);
    assert.equal(cp!.x, 192); // max(100,180)+12
    assert.equal(cp!.y, 240); // max(200,240)
  });

  it("seeds from note.pdfLocation.rects when cardPdf missing", () => {
    const note = {
      pdfLocation: {
        pageIndex: 0,
        position: { pageIndex: 0, rects: [[10, 20, 50, 60]] },
      },
    } as StickyNote;
    const seeded = seedCardPdfFromNote(note);
    assert.ok(seeded);
    assert.equal(seeded!.pageIndex, 0);
    assert.equal(seeded!.x, 62);
    assert.equal(seeded!.y, 60);
  });

  it("keeps existing valid cardPdf", () => {
    const note = {
      cardPdf: { pageIndex: 1, x: 9, y: 8 },
      pdfLocation: {
        position: { pageIndex: 1, rects: [[0, 0, 1, 1]] },
      },
    } as StickyNote;
    const seeded = seedCardPdfFromNote(note);
    assert.deepEqual(seeded, { pageIndex: 1, x: 9, y: 8 });
  });

  it("coerceCardPdf rejects garbage", () => {
    assert.equal(coerceCardPdf(null), undefined);
    assert.equal(coerceCardPdf({ pageIndex: "x", x: 1, y: 2 }), undefined);
    assert.deepEqual(coerceCardPdf({ pageIndex: 0, x: 1.5, y: 2.5 }), {
      pageIndex: 0,
      x: 1.5,
      y: 2.5,
    });
  });

  it("isValidCardPdf", () => {
    assert.equal(isValidCardPdf({ pageIndex: 0, x: 1, y: 2 }), true);
    assert.equal(isValidCardPdf({ pageIndex: -1, x: 1, y: 2 }), false);
    assert.equal(isValidCardPdf(undefined), false);
  });
});

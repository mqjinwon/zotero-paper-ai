import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeItemNoteBody,
  encodeItemNoteBody,
  ITEM_NOTE_TAGS,
} from "../../src/storage/itemNoteStore";

describe("itemNoteStore encode/decode", () => {
  it("round-trips chat payload with unicode and symbols", () => {
    const payload = {
      itemKey: "ABCD",
      history: [
        { role: "user", content: "수식 $x<y$ & 인용" },
        { role: "assistant", content: "답: a > b && c" },
      ],
    };
    const html = encodeItemNoteBody("chat", payload);
    assert.match(html, /data-paper-ai="chat"/);
    assert.match(html, /paper-ai-json/);
    const decoded = decodeItemNoteBody(html);
    assert.ok(decoded);
    assert.equal(decoded!.kind, "chat");
    assert.deepEqual(decoded!.payload, payload);
  });

  it("round-trips sticky list with nested rects", () => {
    const payload = {
      stickies: [
        {
          id: "s1",
          itemKey: "K",
          kind: "explain",
          quote: "q",
          answer: "a",
          x: 10,
          y: 20,
          pinned: true,
          createdAt: "2026-01-01",
          pdfLocation: { position: { rects: [[1, 2, 3, 4]] } },
        },
      ],
    };
    const html = encodeItemNoteBody("sticky", payload);
    const decoded = decodeItemNoteBody(html);
    assert.ok(decoded);
    assert.equal(decoded!.kind, "sticky");
    assert.deepEqual(decoded!.payload, payload);
  });

  it("returns null for ordinary notes", () => {
    assert.equal(decodeItemNoteBody("<p>hello</p>"), null);
    assert.equal(decodeItemNoteBody(""), null);
  });

  it("exports stable tags", () => {
    assert.equal(ITEM_NOTE_TAGS.chat, "paper-ai-chat");
    assert.equal(ITEM_NOTE_TAGS.sticky, "paper-ai-sticky");
    assert.equal(ITEM_NOTE_TAGS.summary, "paper-ai-summary");
  });

  it("round-trips summary payload", () => {
    const payload = {
      itemKey: "K",
      markdown: "- one\n- two\n- three",
      updatedAt: "2026-01-01",
    };
    const html = encodeItemNoteBody("summary", payload);
    const decoded = decodeItemNoteBody(html);
    assert.ok(decoded);
    assert.equal(decoded!.kind, "summary");
    assert.deepEqual(decoded!.payload, payload);
  });
});

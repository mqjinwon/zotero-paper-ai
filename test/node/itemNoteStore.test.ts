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

  it("decodes Zotero-rewritten note (stripped data-paper-ai, raw pre JSON)", () => {
    // Real shape seen for FR-Net chat note after Zotero 7 note processor
    const payload = {
      itemKey: "AJNRGVMA",
      updatedAt: "2026-08-10T08:15:42.406Z",
      history: [
        { role: "user", content: "이 논문의 가장 큰 contribution을 정리해줘." },
        { role: "assistant", content: "contribution 요약" },
      ],
    };
    const html =
      `<div class="zotero-note znv1"><div data-schema-version="9">` +
      `<p><em>Paper AI chat history (synced with this item — safe to ignore)</em></p>\n` +
      `<pre>${JSON.stringify(payload)}</pre>\n` +
      `</div></div>`;
    assert.equal(html.includes("data-paper-ai"), false);
    const decoded = decodeItemNoteBody(html);
    assert.ok(decoded, "must decode without data-paper-ai attr");
    assert.equal(decoded!.kind, "chat");
    assert.deepEqual(decoded!.payload, payload);
  });

  it("decodes rewritten sticky via label + stickies field", () => {
    const payload = {
      itemKey: "AJNRGVMA",
      stickies: [{ id: "s1", answer: "a", pinned: true }],
    };
    const html =
      `<div data-schema-version="9"><p><em>Paper AI sticky notes (synced with this item — safe to ignore)</em></p>` +
      `<pre>${JSON.stringify(payload)}</pre></div>`;
    const decoded = decodeItemNoteBody(html, "sticky");
    assert.ok(decoded);
    assert.equal(decoded!.kind, "sticky");
    assert.equal(
      (decoded!.payload as { stickies: unknown[] }).stickies.length,
      1,
    );
  });

  it("uses kindHint when markup markers are gone", () => {
    const payload = { history: [{ role: "user", content: "hi" }] };
    const html = `<pre>${JSON.stringify(payload)}</pre>`;
    const decoded = decodeItemNoteBody(html, "chat");
    assert.ok(decoded);
    assert.equal(decoded!.kind, "chat");
  });
});

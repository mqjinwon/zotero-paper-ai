/**
 * Unit tests for shared ChatModel (no Zotero / no Dialog).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getChatModelForItem } from "../../src/ui/chatModel.ts";

describe("chatModel", () => {
  it("shares one instance per itemKey and notifies subscribers", () => {
    const a = getChatModelForItem("TESTKEY1");
    const b = getChatModelForItem("TESTKEY1");
    assert.equal(a, b);

    let n = 0;
    const unsub = a.subscribe(() => {
      n++;
    });
    a.appendTurn({ role: "user", content: "hello" });
    a.appendTurn({ role: "assistant", content: "world" });
    assert.equal(a.history.length, 2);
    assert.equal(a.lastAnswer, "world");
    assert.ok(n >= 2);

    a.setBusy(true);
    assert.equal(a.busy, true);
    assert.ok(n >= 3);

    a.clearLocal();
    assert.equal(a.history.length, 0);
    assert.equal(a.lastAnswer, "");
    unsub();
    const before = n;
    a.appendTurn({ role: "user", content: "x" });
    assert.equal(n, before); // unsubscribed
    a.clearLocal();
  });

  it("setHistory replaces turns and updates lastAnswer", () => {
    const m = getChatModelForItem("TESTKEY2");
    m.setHistory([
      { role: "user", content: "q" },
      { role: "assistant", content: "a1" },
    ]);
    assert.equal(m.history.length, 2);
    assert.equal(m.lastAnswer, "a1");
    m.clearLocal();
  });
});

describe("chatDetach module surface", () => {
  it("exports DialogHelper-based open API", async () => {
    const mod = await import("../../src/ui/chatDetach.ts");
    assert.equal(typeof mod.openChatDetachWindow, "function");
    assert.equal(typeof mod.closeChatDetachWindow, "function");
    assert.equal(typeof mod.isChatDetached, "function");
    assert.equal(typeof mod.focusChatDetach, "function");
    // Source contract: DialogHelper import must exist (bundled for Zotero)
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../../src/ui/chatDetach.ts", import.meta.url),
      "utf8",
    );
    assert.match(src, /from "zotero-plugin-toolkit"/);
    assert.match(src, /new DialogHelper/);
    assert.match(src, /fitContent:\s*false/);
    assert.match(src, /noDialogMode:\s*true/);
  });
});

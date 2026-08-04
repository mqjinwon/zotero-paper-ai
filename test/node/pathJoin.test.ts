import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { createZoteroFileStore } from "../../src/auth/fileStore";

afterEach(() => {
  delete (globalThis as any).IOUtils;
  delete (globalThis as any).PathUtils;
  delete (globalThis as any).Zotero;
  delete (globalThis as any).Services;
});

describe("createZoteroFileStore PathUtils.join", () => {
  it("joins multi-segment relative without PathUtils multi-seg args", () => {
    const joinCalls: Array<[string, string]> = [];
    (globalThis as any).PathUtils = {
      homeDir: "/home/jin",
      join(a: string, b: string) {
        if (/[/\\]/.test(b)) {
          throw new Error(
            "PathUtils.join: Could not append to path: NS_ERROR_FILE_UNRECOGNIZED_PATH",
          );
        }
        joinCalls.push([a, b]);
        return `${a.replace(/\/+$/, "")}/${b}`;
      },
      parent(p: string) {
        const i = p.lastIndexOf("/");
        return i <= 0 ? "/" : p.slice(0, i);
      },
    };
    (globalThis as any).IOUtils = {
      exists: async () => false,
      readUTF8: async () => "",
      writeUTF8: async () => {},
      move: async () => {},
      makeDirectory: async () => {},
      getChildren: async () => [],
    };

    const store = createZoteroFileStore();
    assert.equal(
      store.join("/home/jin", "Documents/paper/zotero/paperai"),
      "/home/jin/Documents/paper/zotero/paperai",
    );
    // Every PathUtils.join second arg is a single segment
    for (const [, b] of joinCalls) {
      assert.ok(!/[/\\]/.test(b), `segment must be single: ${b}`);
    }

    assert.equal(
      store.resolvePath("~/Documents/paper/zotero/paperai"),
      "/home/jin/Documents/paper/zotero/paperai",
    );
  });
});

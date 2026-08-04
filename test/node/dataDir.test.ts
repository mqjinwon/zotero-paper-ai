import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, afterEach } from "node:test";
import { createNodeFileStore } from "../../src/auth/nodeFileStore";
import {
  describePaperAiDataDir,
  paperAiPath,
  resolvePaperAiRoot,
  resolveReadableFile,
  setTestDataDirOverride,
} from "../../src/utils/dataDir";

afterEach(() => {
  setTestDataDirOverride(null);
  delete (globalThis as any).Zotero;
});

describe("dataDir resolution", () => {
  it("defaults to ~/.paperai when no Zotero DataDirectory", async () => {
    const store = await createNodeFileStore();
    const root = resolvePaperAiRoot(store);
    assert.equal(root, store.join(store.homeDir(), ".paperai"));
    assert.match(describePaperAiDataDir(store), /legacy home/);
  });

  it("uses Zotero.DataDirectory.dir / paperai when available", async () => {
    const store = await createNodeFileStore();
    (globalThis as any).Zotero = {
      DataDirectory: { dir: "/data/Zotero" },
      Prefs: { get: () => "" },
    };
    const root = resolvePaperAiRoot(store);
    assert.equal(root, store.join("/data/Zotero", "paperai"));
    assert.match(describePaperAiDataDir(store), /Zotero data dir/);
  });

  it("pref dataDir overrides Zotero data dir", async () => {
    const store = await createNodeFileStore();
    (globalThis as any).Zotero = {
      DataDirectory: { dir: "/data/Zotero" },
      Prefs: {
        get: (k: string) =>
          k.endsWith(".dataDir") ? "~/Sync/paperai-data" : "",
      },
    };
    const root = resolvePaperAiRoot(store);
    // Custom path that does not already end with paperai → nest paperai/
    assert.equal(
      root,
      store.join(store.resolvePath("~/Sync/paperai-data"), "paperai"),
    );
    assert.match(describePaperAiDataDir(store), /custom/);
  });

  it("pref dataDir ending with paperai is used as-is", async () => {
    const store = await createNodeFileStore();
    (globalThis as any).Zotero = {
      DataDirectory: { dir: "/data/Zotero" },
      Prefs: {
        get: (k: string) => (k.endsWith(".dataDir") ? "/sync/my-paperai" : ""),
      },
    };
    // basename is my-paperai not paperai → still nest
    assert.equal(
      resolvePaperAiRoot(store),
      store.join("/sync/my-paperai", "paperai"),
    );
    (globalThis as any).Zotero.Prefs.get = (k: string) =>
      k.endsWith(".dataDir") ? "/sync/foo/paperai" : "";
    assert.equal(resolvePaperAiRoot(store), "/sync/foo/paperai");
  });

  it("test override wins for unit tests", async () => {
    const store = await createNodeFileStore();
    setTestDataDirOverride("/tmp/override-paperai");
    assert.equal(resolvePaperAiRoot(store), "/tmp/override-paperai");
    assert.equal(
      paperAiPath(store, "chat", "X.json"),
      store.join("/tmp/override-paperai", "chat", "X.json"),
    );
  });

  it("relative dataDir expands to absolute under home", async () => {
    const store = await createNodeFileStore();
    (globalThis as any).Zotero = {
      DataDirectory: { dir: "/data/Zotero" },
      Prefs: {
        get: (k: string) => (k.endsWith(".dataDir") ? "rel/cache" : ""),
      },
    };
    assert.equal(
      resolvePaperAiRoot(store),
      store.join(store.homeDir(), "rel", "cache", "paperai"),
    );
  });

  it("relative dataDir matching Zotero data dir suffix uses Zotero path", async () => {
    const store = await createNodeFileStore();
    (globalThis as any).Zotero = {
      DataDirectory: { dir: "/home/jin/Documents/paper/zotero" },
      Prefs: {
        get: (k: string) => (k.endsWith(".dataDir") ? "paper/zotero" : ""),
      },
    };
    assert.equal(
      resolvePaperAiRoot(store),
      store.join("/home/jin/Documents/paper/zotero", "paperai"),
    );
  });

  it("resolveReadableFile falls back to legacy ~/.paperai", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperai-dd-"));
    try {
      const store = await createNodeFileStore();
      const home = dir;
      const testStore = {
        ...store,
        homeDir: () => home,
        join: (...parts: string[]) => join(...parts),
        resolvePath: (p: string) => p,
      };
      // Primary: pretend Zotero data dir is elsewhere
      (globalThis as any).Zotero = {
        DataDirectory: { dir: join(dir, "zotero-data") },
        Prefs: { get: () => "" },
      };
      const legacyChat = join(home, ".paperai", "chat");
      await mkdir(legacyChat, { recursive: true });
      await writeFile(
        join(legacyChat, "KEY1.json"),
        JSON.stringify({ history: [] }),
        "utf-8",
      );

      const found = await resolveReadableFile(testStore, "chat", "KEY1.json");
      assert.ok(found);
      assert.ok(found!.includes(".paperai"));
      assert.ok(found!.endsWith("KEY1.json"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

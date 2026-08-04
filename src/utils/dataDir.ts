/**
 * Paper AI on-disk data root (chat / sticky / rag).
 *
 * Resolution order:
 * 1. Pref `dataDir` if non-empty (absolute, ~/…, or relative → home)
 * 2. `{Zotero.DataDirectory}/paperai` when running in Zotero
 * 3. `~/.paperai` (legacy / Node tests / no DataDirectory)
 *
 * Reads fall back to legacy `~/.paperai` when the primary path is missing
 * so existing installs keep working after the default moves under the
 * Zotero data directory.
 */

import type { FileStore } from "../auth/fileStore";
import { isAbsoluteFsPath } from "../auth/fileStore";

const SUBDIR = "paperai";
const LEGACY_DOT = ".paperai";

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Unit-test override; null = normal resolution. */
let testDataDirOverride: string | null = null;

export function setTestDataDirOverride(path: string | null): void {
  testDataDirOverride = path;
}

function readDataDirPref(): string {
  try {
    const Z = (globalThis as any).Zotero;
    if (!Z?.Prefs?.get) return "";
    const v = Z.Prefs.get("extensions.zotero.paperai.dataDir", true);
    return v == null ? "" : String(v).trim();
  } catch {
    return "";
  }
}

/**
 * Zotero library data directory (same as Preferences → Advanced →
 * Files and Folders → Data Directory Location).
 */
export function resolveZoteroDataDirectory(): string | null {
  try {
    const Z = (globalThis as any).Zotero;
    if (!Z) return null;

    const dd = Z.DataDirectory;
    if (dd) {
      if (typeof dd.dir === "string" && dd.dir) return dd.dir;
      if (dd.dir?.path) return String(dd.dir.path);
      if (typeof dd.defaultDir === "string" && dd.defaultDir) {
        return dd.defaultDir;
      }
    }

    if (typeof Z.getZoteroDirectory === "function") {
      const f = Z.getZoteroDirectory();
      if (f?.path) return String(f.path);
      if (typeof f === "string" && f) return f;
    }
  } catch {
    /* not in Zotero chrome */
  }
  return null;
}

export function legacyPaperAiRoot(store: FileStore): string {
  return store.join(store.homeDir(), LEGACY_DOT);
}

/**
 * Resolve user dataDir pref to an absolute root ending with paperai/.
 * Relative paths are allowed (→ home, or match Zotero data dir suffix).
 */
export function resolveCustomDataDir(
  store: FileStore,
  customRaw: string,
): string {
  const custom = customRaw.trim();
  const zData = resolveZoteroDataDirectory();

  // If relative/partial path matches the configured Zotero data directory
  // (e.g. pref "paper/zotero" and data dir …/Documents/paper/zotero),
  // use that absolute Zotero location instead of inventing ~/paper/zotero.
  if (zData) {
    const z = normPath(zData);
    const c = normPath(custom);
    if (c && (z === c || z.endsWith("/" + c))) {
      return store.join(zData, SUBDIR);
    }
  }

  let root = store.resolvePath(custom);
  // Avoid writing rag/ into a broad tree; nest under paperai/ when needed.
  const base =
    root
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || "";
  if (base.toLowerCase() !== SUBDIR) {
    root = store.join(root, SUBDIR);
  }
  return root;
}

/**
 * Write target + default read root for rag (and legacy file migration).
 * Chat/sticky primary store is Zotero item notes — see itemNoteStore.
 */
export function resolvePaperAiRoot(store: FileStore): string {
  if (testDataDirOverride) return testDataDirOverride;

  const custom = readDataDirPref();
  if (custom) {
    return resolveCustomDataDir(store, custom);
  }

  const zData = resolveZoteroDataDirectory();
  if (zData) {
    return store.join(zData, SUBDIR);
  }

  return legacyPaperAiRoot(store);
}

export function paperAiPath(store: FileStore, ...parts: string[]): string {
  return store.join(resolvePaperAiRoot(store), ...parts);
}

/**
 * Prefer primary file; if missing and primary ≠ legacy, try ~/.paperai/…
 * Returns null if neither exists.
 */
export async function resolveReadableFile(
  store: FileStore,
  ...parts: string[]
): Promise<string | null> {
  const primary = paperAiPath(store, ...parts);
  if (await store.exists(primary)) return primary;

  const primaryRoot = resolvePaperAiRoot(store);
  const legacyRoot = legacyPaperAiRoot(store);
  if (primaryRoot !== legacyRoot) {
    const legacy = store.join(legacyRoot, ...parts);
    if (await store.exists(legacy)) return legacy;
  }
  return null;
}

/** Roots to scan for indexes (primary first, then legacy). */
export function paperAiRagRoots(store: FileStore): string[] {
  const primary = paperAiPath(store, "rag");
  const legacy = store.join(legacyPaperAiRoot(store), "rag");
  if (primary === legacy) return [primary];
  return [primary, legacy];
}

/** Human label for prefs pane / diagnostics. */
export function describePaperAiDataDir(store: FileStore): string {
  const custom = readDataDirPref();
  const root = resolvePaperAiRoot(store);
  if (custom) return `custom (RAG) → ${root}`;
  if (resolveZoteroDataDirectory()) {
    return `Zotero data dir / ${SUBDIR} (RAG) → ${root}`;
  }
  return `legacy home (RAG) → ${root}`;
}

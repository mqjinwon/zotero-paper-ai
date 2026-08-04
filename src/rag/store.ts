/**
 * Persist paper indexes under {dataRoot}/rag/{itemKey}-{hash16}.json
 * (see utils/dataDir — default: Zotero data dir / paperai).
 */

import type { FileStore } from "../auth/fileStore";
import {
  paperAiPath,
  paperAiRagRoots,
  resolveReadableFile,
} from "../utils/dataDir";
import type { PaperIndex } from "./types";

export function ragRoot(store: FileStore): string {
  return paperAiPath(store, "rag");
}

export function indexPath(
  store: FileStore,
  paperId: string,
  pdfHash: string,
): string {
  const hash16 = pdfHash.slice(0, 16);
  return store.join(ragRoot(store), `${paperId}-${hash16}.json`);
}

export async function loadIndex(
  store: FileStore,
  paperId: string,
  pdfHash: string,
): Promise<PaperIndex | null> {
  const hash16 = pdfHash.slice(0, 16);
  const path = await resolveReadableFile(
    store,
    "rag",
    `${paperId}-${hash16}.json`,
  );
  if (!path) return null;
  try {
    const raw = await store.readText(path);
    const idx = JSON.parse(raw) as PaperIndex;
    if (idx.version !== 1 || idx.pdfHash !== pdfHash) return null;
    if (idx.paperId !== paperId) return null;
    if (!Array.isArray(idx.chunks)) return null;
    return idx;
  } catch {
    return null;
  }
}

export async function saveIndex(
  store: FileStore,
  index: PaperIndex,
): Promise<string> {
  const path = indexPath(store, index.paperId, index.pdfHash);
  await store.writeText(path, JSON.stringify(index));
  return path;
}

/**
 * Load any cached index for a paperId (itemKey), without knowing pdfHash.
 * Used for panel UI ("already indexed") — query path still re-hashes and
 * validates exact file identity via ensureIndex.
 */
export async function findLatestIndexForPaper(
  store: FileStore,
  paperId: string,
): Promise<PaperIndex | null> {
  if (!paperId || !store.listDir) return null;
  const prefix = `${paperId}-`;
  for (const root of paperAiRagRoots(store)) {
    let names: string[] = [];
    try {
      names = await store.listDir(root);
    } catch {
      continue;
    }
    const candidates = names
      .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
      .sort();
    for (const name of candidates.reverse()) {
      try {
        const raw = await store.readText(store.join(root, name));
        const idx = JSON.parse(raw) as PaperIndex;
        if (idx.version !== 1 || idx.paperId !== paperId) continue;
        if (!Array.isArray(idx.chunks) || !idx.chunks.length) continue;
        return idx;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

/** Short label for index button / status. */
export function formatIndexLabel(index: PaperIndex): string {
  const mode = index.retrievalModeUsed === "hybrid" ? "hybrid" : "BM25";
  const n = index.chunks.filter(
    (c) => c.kind === "child" || c.kind === "abstract",
  ).length;
  return `인덱싱 됨 · ${mode} · ${n} chunks`;
}

/**
 * FNV-1a 32-bit hex + length for cache key (not crypto).
 * Stable across sessions for same text content.
 */
export function simpleHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (
    `00000000${(h >>> 0).toString(16)}`.slice(-8) + text.length.toString(16)
  );
}

/** Serialize for round-trip tests (stable JSON). */
export function serializeIndex(index: PaperIndex): string {
  return JSON.stringify(index);
}

export function deserializeIndex(raw: string): PaperIndex {
  const idx = JSON.parse(raw) as PaperIndex;
  if (idx.version !== 1 || !Array.isArray(idx.chunks)) {
    throw new Error("Invalid PaperIndex JSON");
  }
  return idx;
}

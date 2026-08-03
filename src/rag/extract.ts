/**
 * Full-paper text extraction adapter.
 * Production: Zotero fulltext index / cache / indexPDF / reader PDF.js.
 * Tests: inject stub via buildExtractedDoc.
 */

import { diag } from "../utils/diagnostics";
import { simpleHash } from "./store";
import type { ExtractedDoc } from "./types";

export class EmptyExtractError extends Error {
  constructor(paperId: string, detail?: string) {
    super(
      `Empty paper extract for ${paperId}: no extractable text. ` +
        (detail ||
          "PDF may lack a text layer (scanned), or fulltext index is empty. " +
            "Try re-index, or open the PDF tab and run indexing again."),
    );
    this.name = "EmptyExtractError";
  }
}

export interface ExtractInput {
  paperId: string;
  title?: string;
  fullText?: string;
  pages?: Array<{ page: number; text: string }>;
  source?: ExtractedDoc["source"];
}

export function buildExtractedDoc(input: ExtractInput): ExtractedDoc {
  const pages = input.pages || [];
  let fullText = (input.fullText || "").trim();
  if (!fullText && pages.length) {
    fullText = pages
      .map((p) => p.text)
      .join("\n")
      .trim();
  }
  if (!fullText) {
    throw new EmptyExtractError(input.paperId || "unknown");
  }
  const pdfHash = simpleHash(fullText);
  return {
    paperId: input.paperId,
    title: input.title || "",
    fullText,
    pages,
    source: input.source || (pages.length ? "file-text" : "stub"),
    pdfHash,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readUtf8Path(path: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const IOUtils = (globalThis as any).IOUtils;
  if (!IOUtils?.readUTF8) return "";
  try {
    const t = await IOUtils.readUTF8(path);
    return String(t || "").trim();
  } catch {
    return "";
  }
}

async function tryFulltextForId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Z: any,
  itemID: number,
): Promise<{ text: string; how: string }> {
  const fulltext = Z.Fulltext || Z.FullText;
  if (!fulltext || !itemID) return { text: "", how: "no-fulltext-api" };

  const item = Z.Items.get(itemID);
  // 1) Cache file
  try {
    if (item && typeof fulltext.getItemCacheFile === "function") {
      const f = fulltext.getItemCacheFile(item);
      const path = f?.path || f;
      if (path) {
        const t = await readUtf8Path(String(path));
        if (t.length > 40) {
          diag("extract", "cache hit", { itemID, chars: t.length });
          return { text: t, how: "ft-cache" };
        }
      }
    }
  } catch (e) {
    diag("extract", "cache read fail", String(e));
  }

  // 2) Named getters
  for (const name of [
    "getItemContent",
    "getIndexedContent",
    "getItemUnprocessedContent",
  ]) {
    if (typeof fulltext[name] !== "function") continue;
    try {
      const content = await fulltext[name](itemID);
      let text = "";
      if (typeof content === "string") text = content.trim();
      else if (content?.content) text = String(content.content).trim();
      else if (content?.text) text = String(content.text).trim();
      else if (typeof content?.data === "string") text = content.data.trim();
      if (text.length > 40) {
        diag("extract", `fulltext.${name}`, { itemID, chars: text.length });
        return { text, how: name };
      }
    } catch (e) {
      diag("extract", `fulltext.${name} err`, String(e));
    }
  }
  return { text: "", how: "empty" };
}

async function tryIndexThenRead(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Z: any,
  itemID: number,
): Promise<{ text: string; how: string }> {
  const fulltext = Z.Fulltext || Z.FullText;
  const item = Z.Items.get(itemID);
  if (!fulltext || !item) return { text: "", how: "no-item" };

  try {
    let path = "";
    if (typeof item.getFilePathAsync === "function") {
      const p = await item.getFilePathAsync();
      if (p) path = String(p);
    } else if (typeof item.getFilePath === "function") {
      const p = item.getFilePath();
      if (p) path = String(p);
    }
    diag("extract", "file path", { itemID, path: path || null });

    if (path && typeof fulltext.indexPDF === "function") {
      try {
        const ok = await fulltext.indexPDF(path, itemID, true);
        diag("extract", "indexPDF", { itemID, ok });
      } catch (e) {
        diag("extract", "indexPDF err", String(e));
      }
    }

    if (typeof fulltext.indexItems === "function") {
      try {
        await fulltext.indexItems([itemID], {
          complete: true,
          ignoreErrors: true,
        });
        diag("extract", "indexItems done", { itemID });
      } catch (e) {
        diag("extract", "indexItems err", String(e));
      }
    }

    if (typeof fulltext.indexFromProcessorCache === "function") {
      try {
        await fulltext.indexFromProcessorCache(itemID);
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    diag("extract", "reindex fail", String(e));
  }

  return tryFulltextForId(Z, itemID);
}

function collectItemIdsForExtract(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Z: any,
  opts: { itemKey: string; itemID?: number },
): number[] {
  const ids: number[] = [];
  const push = (id: unknown) => {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0 && !ids.includes(n)) ids.push(n);
  };
  if (opts.itemID) push(opts.itemID);

  try {
    let item =
      (opts.itemID && Z.Items.get(opts.itemID)) ||
      (opts.itemKey && Z.Items.getByLibraryAndKey?.(1, opts.itemKey));
    if (!item && opts.itemKey && typeof Z.Items.getByLibraryAndKey === "function") {
      try {
        const libs = Z.Libraries?.getAll?.() || [];
        for (const lib of libs) {
          item = Z.Items.getByLibraryAndKey(lib.id, opts.itemKey);
          if (item) break;
        }
      } catch {
        /* ignore */
      }
    }
    if (!item) return ids;
    push(item.id);

    const isAtt =
      typeof item.isAttachment === "function"
        ? item.isAttachment()
        : !!item.isAttachment;

    if (isAtt) {
      if (item.parentItem) push(item.parentItem.id);
    } else {
      try {
        const atts =
          typeof item.getAttachments === "function" ? item.getAttachments() : [];
        for (const aid of atts) {
          push(aid);
          try {
            const att = Z.Items.get(aid);
            if (
              att &&
              typeof att.attachmentContentType === "string" &&
              /pdf/i.test(att.attachmentContentType)
            ) {
              ids.unshift(Number(aid));
            }
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return ids;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mainWin(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Z = (globalThis as any).Zotero;
  try {
    return Z?.getMainWindow?.() || globalThis;
  } catch {
    return globalThis;
  }
}

async function extractViaReaderPdfJs(): Promise<{
  fullText: string;
  pages: Array<{ page: number; text: string }>;
}> {
  const pages: Array<{ page: number; text: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Z = (globalThis as any).Zotero;
  const win = mainWin();
  const tabs = win?.Zotero_Tabs || (globalThis as any).Zotero_Tabs;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readers: any[] = [];
  try {
    if (tabs?.selectedID && Z?.Reader?.getByTabID) {
      const r = Z.Reader.getByTabID(tabs.selectedID);
      if (r) readers.push(r);
    }
    if (Z?.Reader?._readers?.length) {
      for (const r of Z.Reader._readers) {
        if (!readers.includes(r)) readers.push(r);
      }
    }
  } catch (e) {
    diag("extract", "reader list err", String(e));
  }

  for (const r of readers) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const apps: any[] = [];
      const pushApp = (w: unknown) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const app = (w as any)?.PDFViewerApplication;
          if (app && !apps.includes(app)) apps.push(app);
        } catch {
          /* ignore */
        }
      };
      pushApp(r?._internalReader?._primaryView?._iframeWindow);
      pushApp(r?._internalReader?._primaryView?._iframe?.contentWindow);
      pushApp(r?._internalReader?._lastView?._iframeWindow);
      pushApp(r?._iframeWindow);
      pushApp(r?._window);
      pushApp(r?._iframe?.contentWindow);
      // Nested iframes under shell (sidebar layout)
      try {
        const shellDoc =
          r?._iframeWindow?.document || r?._iframe?.contentDocument;
        for (const fr of Array.from(
          shellDoc?.querySelectorAll?.("iframe") || [],
        )) {
          pushApp((fr as HTMLIFrameElement).contentWindow);
        }
      } catch {
        /* ignore */
      }

      for (const pdfViewer of apps) {
        const pdfDoc = pdfViewer?.pdfDocument;
        if (!pdfDoc || typeof pdfDoc.numPages !== "number") {
          diag("extract", "pdf.js app without doc", {
            hasViewer: !!pdfViewer?.pdfViewer,
          });
          continue;
        }
        diag("extract", "pdf.js doc", { pages: pdfDoc.numPages });
        const buf: string[] = [];
        const pageBuf: Array<{ page: number; text: string }> = [];
        const maxPages = Math.min(pdfDoc.numPages, 250);
        for (let p = 1; p <= maxPages; p++) {
          try {
            const page = await pdfDoc.getPage(p);
            const tc = await page.getTextContent();
            const pageText = (tc.items || [])
              .map((it: { str?: string }) => it.str || "")
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();
            if (pageText) {
              pageBuf.push({ page: p, text: pageText });
              buf.push(pageText);
            }
          } catch {
            /* skip page */
          }
        }
        const fullText = buf.join("\n").trim();
        if (fullText.length > 40) {
          diag("extract", "pdf.js text ok", {
            chars: fullText.length,
            pages: pageBuf.length,
          });
          return { fullText, pages: pageBuf };
        }
      }
    } catch (e) {
      diag("extract", "pdf.js err", String(e));
    }
  }
  return { fullText: "", pages: [] };
}

export async function extractPaperFromZotero(opts: {
  itemKey: string;
  title?: string;
  itemID?: number;
}): Promise<ExtractedDoc> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Z = (globalThis as any).Zotero;
  if (!Z) {
    throw new Error("Zotero global not available for paper extract");
  }

  diag("extract", "start", {
    itemKey: opts.itemKey,
    itemID: opts.itemID ?? null,
    title: opts.title || "",
  });

  let fullText = "";
  let source: ExtractedDoc["source"] = "empty";
  let pages: Array<{ page: number; text: string }> = [];
  const attempts: string[] = [];

  const ids = collectItemIdsForExtract(Z, opts);
  diag("extract", "candidate ids", ids);

  // A) Prefer open-reader PDF.js first — per-page spans power cite hyperlinks
  {
    const r = await extractViaReaderPdfJs();
    attempts.push(`reader-pdfjs:${r.fullText.length}:pages=${r.pages.length}`);
    if (r.fullText.length > 40) {
      fullText = r.fullText;
      pages = r.pages;
      source = "reader";
    }
  }

  // B) existing fulltext / cache (no page map — cite jumps use text search)
  if (!fullText) {
    for (const id of ids) {
      const r = await tryFulltextForId(Z, id);
      attempts.push(`id=${id}:${r.how}:${r.text.length}`);
      if (r.text.length > 40) {
        fullText = r.text;
        source = "zotero-fulltext";
        break;
      }
    }
  }

  // C) force reindex then read
  if (!fullText) {
    for (const id of ids) {
      const r = await tryIndexThenRead(Z, id);
      attempts.push(`reindex id=${id}:${r.how}:${r.text.length}`);
      if (r.text.length > 40) {
        fullText = r.text;
        source = "zotero-fulltext";
        break;
      }
    }
  }

  diag("extract", "done", {
    source,
    chars: fullText.length,
    pages: pages.length,
    attempts,
  });

  if (!fullText.trim()) {
    throw new EmptyExtractError(
      opts.itemKey,
      `attempts=[${attempts.join("; ")}]. Open the PDF tab (so PDF.js can expose text) or ensure the PDF has a text layer.`,
    );
  }

  return buildExtractedDoc({
    paperId: opts.itemKey,
    title: opts.title,
    fullText,
    pages,
    source,
  });
}

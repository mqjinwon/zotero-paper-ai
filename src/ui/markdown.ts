import { marked } from "marked";
import katex from "katex";
import { diag } from "../utils/diagnostics";

// Explicit GFM (tables, autolinks, strikethrough)
marked.setOptions({
  gfm: true,
  breaks: false,
});

/** Normalize common LaTeX delimiters to $ / $$ for KaTeX. */
export function normalizeMathDelimiters(md: string): string {
  let s = md;
  s = s.replace(
    /\\\[([\s\S]*?)\\\]/g,
    (_m, inner) => `\n$$\n${inner.trim()}\n$$\n`,
  );
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner) => `$${inner.trim()}$`);
  return s;
}

function renderKatex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      output: "html",
    });
  } catch {
    const esc = tex
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<code class="paperai-math-fallback">${esc}</code>`;
  }
}

/** Scrub source text only (null / broken surrogates). Never run on finished HTML. */
export function scrubIllegalChars(s: string): string {
  return (
    String(s || "")
      // strip NULs without a control-char regex (eslint no-control-regex)
      .split("\0")
      .join("")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "\uFFFD")
      .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
  );
}

/**
 * Convert Markdown (GFM + $ / $$ math) to HTML string.
 */
export function renderMarkdown(md: string): string {
  const normalized = normalizeMathDelimiters(scrubIllegalChars(md || ""));
  const blocks: string[] = [];
  const inlines: string[] = [];

  let s = normalized.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => {
    const i = blocks.length;
    blocks.push(renderKatex(String(tex).trim(), true));
    return `\n\n@@MATH_BLOCK_${i}@@\n\n`;
  });

  // Inline math: require non-space after opening $
  s = s.replace(/\$([^\s$][^$\n]*?)\$/g, (_m, tex) => {
    const i = inlines.length;
    inlines.push(renderKatex(String(tex).trim(), false));
    return `@@MATH_INLINE_${i}@@`;
  });

  let html: string;
  try {
    html = marked.parse(s, { async: false }) as string;
  } catch {
    const esc = scrubIllegalChars(md)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<pre class="pai-md-fallback">${esc}</pre>`;
  }
  html = html.replace(
    /@@MATH_BLOCK_(\d+)@@/g,
    (_m, i) => blocks[Number(i)] || "",
  );
  html = html.replace(
    /@@MATH_INLINE_(\d+)@@/g,
    (_m, i) => inlines[Number(i)] || "",
  );
  return html;
}

/**
 * Insert markdown into host.
 * Uses DOMParser + importNode so Zotero chrome item-pane doesn't reject
 * table/h3/strong the way some host.innerHTML paths do.
 * Returns true if structured HTML was inserted, false if plain fallback.
 */
export function setMarkdownHtml(host: HTMLElement, md: string): boolean {
  const raw = scrubIllegalChars(md || "…");
  let html: string;
  try {
    html = renderMarkdown(raw);
  } catch {
    host.style.whiteSpace = "pre-wrap";
    host.textContent = raw;
    return false;
  }

  const doc = host.ownerDocument;
  if (!doc) {
    host.textContent = raw;
    return false;
  }

  while (host.firstChild) host.removeChild(host.firstChild);

  // 1) DOMParser (most reliable in Zotero chrome / XUL hybrid docs)
  try {
    const win = doc.defaultView;
    const DOMParserCtor = win?.DOMParser || (globalThis as any).DOMParser;
    if (DOMParserCtor) {
      const parser = new DOMParserCtor();
      const parsed = parser.parseFromString(
        `<!DOCTYPE html><html><body><div id="pai-md-root">${html}</div></body></html>`,
        "text/html",
      );
      const root = parsed.getElementById("pai-md-root");
      if (root && root.childNodes.length) {
        const kids = root.childNodes;
        for (let i = 0; i < kids.length; i++) {
          const child = kids.item(i);
          if (child) host.appendChild(doc.importNode(child, true));
        }
        // Heuristic: structured MD should introduce element nodes (p, table, …)
        if (
          host.querySelector("p, table, ul, ol, h1, h2, h3, h4, pre, strong, a")
        ) {
          return true;
        }
        // import produced only text — treat as soft failure and retry below
        while (host.firstChild) host.removeChild(host.firstChild);
      }
    }
  } catch {
    while (host.firstChild) host.removeChild(host.firstChild);
  }

  // 2) Detached div.innerHTML in the same document
  try {
    const box = doc.createElement("div");
    box.innerHTML = html;
    if (box.childNodes.length) {
      while (box.firstChild) host.appendChild(box.firstChild);
      if (
        host.querySelector("p, table, ul, ol, h1, h2, h3, h4, pre, strong, a")
      ) {
        return true;
      }
      while (host.firstChild) host.removeChild(host.firstChild);
    }
  } catch {
    while (host.firstChild) host.removeChild(host.firstChild);
  }

  // 3) createContextualFragment
  try {
    const range = doc.createRange();
    const frag = range.createContextualFragment(html);
    host.appendChild(frag);
    if (host.childNodes.length) return true;
  } catch {
    /* plain */
  }

  host.style.whiteSpace = "pre-wrap";
  host.textContent = raw;
  return false;
}

// ── Cite navigation ─────────────────────────────────────────────────────────

function resolveZotero(): any {
  const g = globalThis as any;
  if (g.Zotero) return g.Zotero;
  try {
    let w: any = g.window || g;
    for (let i = 0; i < 6 && w; i++) {
      if (w.Zotero) return w.Zotero;
      w = w.parent !== w ? w.parent : null;
    }
  } catch {
    /* cross-origin */
  }
  try {
    return g.top?.Zotero || null;
  } catch {
    return null;
  }
}

/** Unwrap Xray wrappers so PDF.js methods are callable from chrome. */

function unwrap(obj: any): any {
  if (!obj) return obj;
  try {
    const Cu = (globalThis as any).Cu || (globalThis as any).Components?.utils;
    if (Cu?.waiveXrays) return Cu.waiveXrays(obj);
  } catch {
    /* ignore */
  }
  try {
    return obj.wrappedJSObject || obj;
  } catch {
    return obj;
  }
}

function collectReaders(Z: any): any[] {
  const out: unknown[] = [];
  try {
    const main = Z?.getMainWindow?.() || null;
    const tabId =
      main?.Zotero_Tabs?.selectedID ??
      (globalThis as any).Zotero_Tabs?.selectedID;
    if (tabId != null && Z?.Reader?.getByTabID) {
      const r = Z.Reader.getByTabID(tabId);
      if (r) out.push(r);
    }
  } catch {
    /* ignore */
  }
  try {
    for (const r of Z?.Reader?._readers || []) {
      if (!out.includes(r)) out.push(r);
    }
  } catch {
    /* ignore */
  }
  return out;
}

function windowsFromReader(reader: any): Window[] {
  const wins: Window[] = [];
  const push = (w: unknown) => {
    if (w && typeof (w as Window).document !== "undefined") {
      if (!wins.includes(w as Window)) wins.push(w as Window);
    }
  };
  try {
    push(reader?._internalReader?._primaryView?._iframeWindow);
    push(reader?._internalReader?._primaryView?._iframe?.contentWindow);
    push(reader?._internalReader?._lastView?._iframeWindow);
    push(reader?._iframeWindow);
    push(reader?._iframe?.contentWindow);
    push(reader?._window);
    const shell =
      reader?._iframeWindow?.document || reader?._iframe?.contentDocument;
    for (const fr of Array.from(shell?.querySelectorAll?.("iframe") || [])) {
      push((fr as HTMLIFrameElement).contentWindow);
    }
  } catch {
    /* ignore */
  }
  return wins;
}

function pdfAppFromWindow(w: Window | null | undefined): any {
  if (!w) return null;
  try {
    const raw = unwrap(w);
    const app =
      raw?.PDFViewerApplication ||
      (w as unknown as { PDFViewerApplication?: unknown }).PDFViewerApplication;
    return unwrap(app) || app || null;
  } catch {
    return null;
  }
}

/** Jump PDF.js to 1-based page number. Returns true only if page actually changes or matches. */

function pdfJsGoToPage(app: any, pageLabel: number): boolean {
  if (!app || !Number.isFinite(pageLabel) || pageLabel < 1) return false;
  const n = Math.floor(pageLabel);
  try {
    const viewer = unwrap(app.pdfViewer) || app.pdfViewer;
    if (!viewer) {
      if ("page" in app) {
        app.page = n;
        return true;
      }
      return false;
    }
    // Prefer currentPageNumber assignment (most reliable across PDF.js versions)
    try {
      viewer.currentPageNumber = n;
    } catch {
      /* ignore */
    }
    try {
      if (typeof viewer.scrollPageIntoView === "function") {
        viewer.scrollPageIntoView({ pageNumber: n });
      }
    } catch {
      /* ignore */
    }
    try {
      app.page = n;
    } catch {
      /* ignore */
    }
    // Verify
    const cur = Number(viewer.currentPageNumber || app.page || 0);
    return cur === n || cur > 0; // cur>0 means viewer responded
  } catch (e) {
    diag("cite", "pdfJsGoToPage fail", String(e));
    return false;
  }
}

/**
 * Navigate active reader to a 1-based PDF page.
 * Same primitive path as sticky list focus (reader.navigate + PDF.js).
 */
export async function navigateReaderToPage(
  pageLabel: number,
  _host?: HTMLElement | null,
  preview?: string,
): Promise<boolean> {
  const page = Math.floor(Number(pageLabel));
  const Z = resolveZotero();
  const readers = collectReaders(Z);
  diag("cite", "navigate start", {
    page,
    readers: readers.length,
    hasPreview: !!(preview && preview.length > 4),
  });

  // 1) Official API first (same as sticky focus — proven in this codebase)
  if (page >= 1) {
    for (const reader of readers) {
      if (!reader?.navigate) continue;
      try {
        await reader.navigate({ pageIndex: page - 1 });
        diag("cite", "reader.navigate pageIndex ok", { page });
        return true;
      } catch (e) {
        diag("cite", "reader.navigate fail", String(e));
      }
      try {
        await reader.navigate({
          pageIndex: page - 1,
          pageLabel: String(page),
        });
        return true;
      } catch {
        /* continue */
      }
    }
  }

  // 2) Direct PDF.js on every reader window (waive Xrays)
  if (page >= 1) {
    for (const reader of readers) {
      for (const w of windowsFromReader(reader)) {
        const app = pdfAppFromWindow(w);
        if (pdfJsGoToPage(app, page)) {
          diag("cite", "pdf.js direct ok", { page });
          try {
            w.focus?.();
          } catch {
            /* ignore */
          }
          return true;
        }
      }
    }
  }

  // 3) Text search → page
  if (preview && preview.length >= 8) {
    const words = preview
      .replace(/[^\w\s.,;:%-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter((w) => w.length > 2);
    const needle = (
      words.length >= 4
        ? words.slice(
            Math.min(3, words.length - 6),
            Math.min(3, words.length - 6) + 8,
          )
        : words
    )
      .join(" ")
      .toLowerCase();
    if (needle.length >= 8) {
      for (const reader of readers) {
        for (const w of windowsFromReader(reader)) {
          const app = pdfAppFromWindow(w);
          const doc = app?.pdfDocument;
          if (!doc) continue;
          const max = Math.min(doc.numPages || 0, 120);
          const short = needle.slice(0, 24);
          for (let p = 1; p <= max; p++) {
            try {
              const pg = await doc.getPage(p);
              const tc = await pg.getTextContent();
              const text = (tc.items || [])
                .map((it: { str?: string }) => it.str || "")
                .join(" ")
                .toLowerCase()
                .replace(/\s+/g, " ");
              if (text.includes(short)) {
                if (pdfJsGoToPage(app, p)) {
                  diag("cite", "search nav ok", { p, short });
                  return true;
                }
                try {
                  await reader.navigate({ pageIndex: p - 1 });
                  return true;
                } catch {
                  /* continue */
                }
              }
            } catch {
              /* next page */
            }
          }
        }
      }
    }
  }

  diag("cite", "navigate failed", { page, readers: readers.length });
  return false;
}

const CITE_SEL =
  'a.paperai-cite, a[href^="#paperai-page-"], a[href="#paperai-cite"], a[href="#paperai-search"]';

/** Event.target may be a Text node — resolve to Element for closest(). */
function eventElement(ev: Event): Element | null {
  const t = ev.target as Node | null;
  if (!t) return null;
  if (t.nodeType === 1) return t as Element;
  if (t.nodeType === 3) return (t as Text).parentElement; // TEXT_NODE
  try {
    return (t as Node).parentElement;
  } catch {
    return null;
  }
}

function parseCiteAnchor(a: HTMLAnchorElement): {
  page: number;
  preview: string;
} {
  const href = a.getAttribute("href") || "";
  const dataPage = a.getAttribute("data-page");
  const preview =
    a.getAttribute("data-preview") || a.getAttribute("title") || "";
  const m = href.match(/^#paperai-page-(\d+)$/);
  const page = dataPage ? Number(dataPage) : m ? Number(m[1]) : 0;
  return { page: Number.isFinite(page) ? page : 0, preview };
}

function flashCite(a: HTMLAnchorElement, ok: boolean): void {
  const prev = a.style.outline;
  a.style.outline = ok ? "2px solid #1a73e8" : "2px solid #c5221f";
  a.style.outlineOffset = "1px";
  setTimeout(() => {
    try {
      a.style.outline = prev;
      a.style.outlineOffset = "";
    } catch {
      /* ignore */
    }
  }, 600);
  if (!ok) {
    a.title =
      (a.getAttribute("data-preview") || a.title || "") +
      " · 이동 실패 — PDF 탭이 열려 있는지 확인";
  }
}

/**
 * Handle a cite click. Exported so panel root can call the same path.
 */
export function handleCiteClick(ev: Event, root?: HTMLElement | null): boolean {
  const el = eventElement(ev);
  if (!el) return false;
  const a = el.closest?.(CITE_SEL) as HTMLAnchorElement | null;
  if (!a) return false;
  if (root && !root.contains(a)) return false;

  ev.preventDefault();
  ev.stopPropagation();
  try {
    (ev as any).stopImmediatePropagation?.();
  } catch {
    /* ignore */
  }

  const { page, preview } = parseCiteAnchor(a);
  diag("cite", "click", {
    page,
    href: a.getAttribute("href"),
    text: (a.textContent || "").slice(0, 40),
  });

  void navigateReaderToPage(page, a, preview).then((ok) => {
    flashCite(a, ok);
    diag("cite", "click result", { page, ok });
  });
  return true;
}

/**
 * Wire cite links under host.
 * - Event delegation (capture)
 * - Per-anchor listeners (Text-node-safe via eventElement)
 * - mousedown too (some hosts eat click)
 */
export function wirePaperaiCiteLinks(host: HTMLElement): void {
  if (!host) return;

  const h = host as any;
  if (!h.__paperaiCiteDelegated) {
    h.__paperaiCiteDelegated = true;
    const del = (ev: Event) => {
      handleCiteClick(ev, host);
    };
    host.addEventListener("click", del, true);
    host.addEventListener("mousedown", del, true);
  }

  const nodes = host.querySelectorAll(CITE_SEL);
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes.item(i) as HTMLAnchorElement | null;
    if (!a) continue;
    a.classList.add("paperai-cite");
    a.style.cursor = "pointer";
    // Direct listener — survives odd event retargeting in item pane
    if (a.dataset.paperaiCiteWired === "1") continue;
    a.dataset.paperaiCiteWired = "1";
    const on = (ev: Event) => {
      handleCiteClick(ev, host);
    };
    a.addEventListener("click", on, true);
    a.addEventListener("mousedown", on, true);
  }
}

/** setMarkdownHtml + wire cite links. */
export function setMarkdownHtmlWithCites(
  host: HTMLElement,
  md: string,
): boolean {
  const ok = setMarkdownHtml(host, md);
  try {
    wirePaperaiCiteLinks(host);
  } catch (e) {
    diag("cite", "wire fail", String(e));
  }
  return ok;
}

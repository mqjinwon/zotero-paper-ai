import { marked } from "marked";
import katex from "katex";
import { diag } from "../utils/diagnostics";
import { navigateReaderToEvidence } from "./citeNavigate";

// Explicit GFM (tables, autolinks, strikethrough)
marked.setOptions({
  gfm: true,
  breaks: false,
});

/**
 * Normalize Mathpix / KaTeX-friendly delimiters to $ / $$ for rendering.
 * Handles: \( \), \[ \], ```math/latex/tex fences, equation/align envs.
 */
export function normalizeMathDelimiters(md: string): string {
  let s = md;
  const protectedBlocks: string[] = [];
  const protect = (chunk: string): string => {
    const i = protectedBlocks.length;
    protectedBlocks.push(chunk);
    return `@@MATH_PROTECT_${i}@@`;
  };

  // Keep existing $$ … $$ intact while rewriting other forms
  s = s.replace(/\$\$[\s\S]+?\$\$/g, (m) => protect(m));

  // Fenced math (Mathpix / common LLM habit)
  s = s.replace(
    /```(?:math|latex|tex|katex)\s*\r?\n([\s\S]*?)```/gi,
    (_m, inner) => protect(`\n$$\n${String(inner).trim()}\n$$\n`),
  );

  // Display: \[ … \]
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner) =>
    protect(`\n$$\n${String(inner).trim()}\n$$\n`),
  );

  // Inline: \( … \)
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner) =>
    protect(`$${String(inner).trim()}$`),
  );

  // \begin{equation[*]} … \end{equation[*]} → display math (strip env; KaTeX-friendly)
  s = s.replace(
    /\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g,
    (_m, inner) => protect(`\n$$\n${String(inner).trim()}\n$$\n`),
  );

  // align / aligned / gather / multline — keep env, wrap in $$
  s = s.replace(
    /\\begin\{(align\*?|aligned|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}/g,
    (_m, env, body) =>
      protect(`\n$$\n\\begin{${env}}${body}\\end{${env}}\n$$\n`),
  );

  s = s.replace(/@@MATH_PROTECT_(\d+)@@/g, (_m, i) => {
    return protectedBlocks[Number(i)] ?? "";
  });
  return s;
}

function renderKatex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
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

/**
 * Navigate active reader to evidence: sentence-level text locate (auto-HL)
 * + temporary yellow flash. Falls back to page-only when quote is missing.
 */
export async function navigateReaderToPage(
  pageLabel: number,
  _host?: HTMLElement | null,
  preview?: string,
): Promise<boolean> {
  return navigateReaderToEvidence(pageLabel, preview);
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
    text: (a.textContent || "").slice(0, 60),
    preview: (preview || "").slice(0, 48),
  });

  void navigateReaderToEvidence(page, preview).then((ok) => {
    flashCite(a, ok);
    diag("cite", "click result", {
      page,
      ok,
      hasQuote: !!(preview && preview.length >= 12),
    });
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

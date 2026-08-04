/**
 * Section → paragraph → sentence hierarchical chunking (parent–child).
 * Policy: section-para-sent-v5 — broader heading detection; cites use [E#] at retrieve time.
 */

import { CHUNK_POLICY, type Chunk, type ExtractedDoc } from "./types";

export { CHUNK_POLICY };

/** Named academic headings (optional leading number / roman). */
const NAMED_SECTION_RE =
  /^(?:(?:\d+(?:\.\d+){0,3}|[IVXLC]+)\.?\s+)?(Abstract|Introduction|Related\s+Works?|Background|Preliminaries|Method(?:s|ology)?|Approach|Experiments?|Evaluation|Results?|Discussion|Conclusion|Conclusions|Limitations|Appendix|References|Acknowledgments?)\b/i;

/**
 * True if a single line looks like a section heading (pure; unit-tested).
 * Accepts: named sections, "2 Method", "2. Method", "IV. Experiments", short ALL CAPS.
 */
export function isSectionHeadingLine(line: string): boolean {
  const t = String(line || "").trim();
  if (!t || t.length >= 80) return false;
  // Full sentence / trailing period usually body prose
  if (/[.!?;:]$/.test(t) && t.length > 40) return false;

  if (NAMED_SECTION_RE.test(t)) return true;

  // Numbered heading: "2 Method", "2. Method", "2.1 Residual Forces"
  if (/^\d+(\.\d+){0,3}\.?\s+[A-Z][\w'’\-/,:+ ]{1,60}$/.test(t)) {
    // Reject pure enumerations like "1 2 3" or numeric-only
    const rest = t.replace(/^\d+(\.\d+){0,3}\.?\s+/, "");
    if (/[A-Za-z]{2,}/.test(rest) && rest.split(/\s+/).length <= 10) {
      return true;
    }
  }

  // Roman numeral heading: "IV Experiments", "III. Method"
  if (/^[IVXLC]{1,6}\.?\s+[A-Z][\w'’\-/,:+ ]{1,60}$/.test(t)) {
    return true;
  }

  // Short ALL-CAPS line (common PDF headings), not a long shouty sentence
  if (
    /^[A-Z0-9][A-Z0-9\s\-&/]{2,50}$/.test(t) &&
    !/[.!?]$/.test(t) &&
    t.split(/\s+/).length <= 8 &&
    /[A-Z]{3,}/.test(t)
  ) {
    // Avoid catching figure labels like "FIG 1" alone as whole-paper section — still ok as section start
    return true;
  }

  return false;
}

export function estimateTokens(text: string): number {
  // Rough: ~4 chars/token for mixed EN
  return Math.max(1, Math.ceil(text.length / 4));
}

function normalizeWs(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface ChunkOptions {
  childTokens?: number;
  parentMaxTokens?: number;
  overlapTokens?: number;
}

/** Children stay small so locators stay precise. */
const DEFAULTS: Required<ChunkOptions> = {
  childTokens: 280,
  parentMaxTokens: 2000,
  overlapTokens: 48,
};

interface SectionBlock {
  name: string;
  text: string;
  pageStart?: number;
  pageEnd?: number;
}

/** Split on blank lines; fall back to single block. */
export function splitParagraphs(text: string): string[] {
  const t = normalizeWs(text);
  if (!t) return [];
  const parts = t
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [t];
}

/**
 * Lightweight sentence splitter (EN academic prose).
 * Keeps abbreviations like e.g. / i.e. / Fig. from over-splitting somewhat.
 */
export function splitSentences(text: string): string[] {
  const t = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return [];
  // Protect common abbreviations
  const protected_ = t
    .replace(/\be\.g\./gi, "e\uE000g\uE000")
    .replace(/\bi\.e\./gi, "i\uE000e\uE000")
    .replace(/\bFig\./g, "Fig\uE000")
    .replace(/\bEq\./g, "Eq\uE000")
    .replace(/\bSec\./g, "Sec\uE000")
    .replace(/\bet al\./gi, "et al\uE000");
  // Sentence split: next token starts with letter/digit/open-bracket/quote
  const raw = protected_.split(/(?<=[.!?])\s+(?=[[A-Z0-9(“"])/);
  return raw
    .map((s) =>
      s
        .replace(/\uE000/g, ".")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

/** Split raw text into section-ish blocks via heading heuristics. */
export function splitIntoSections(
  fullText: string,
  pages?: Array<{ page: number; text: string }>,
): SectionBlock[] {
  const text = normalizeWs(fullText);
  if (!text) return [];

  if (pages && pages.length > 0) {
    return splitPagedSections(pages);
  }

  const lines = text.split("\n");
  const blocks: SectionBlock[] = [];
  let curName = "Body";
  let buf: string[] = [];

  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) blocks.push({ name: curName, text: t });
    buf = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (isSectionHeadingLine(trimmed)) {
      flush();
      curName = trimmed.replace(/\s+/g, " ");
      continue;
    }
    buf.push(line);
  }
  flush();

  if (!blocks.some((b) => /abstract/i.test(b.name))) {
    const first = blocks[0];
    if (first && first.text.length > 200) {
      const m = first.text.match(
        /(?:^|\n)(Abstract[\s\S]{0,40}?\n)([\s\S]{100,2500}?)(?=\n(?:1\.?\s+)?Introduction\b|\n\d+\s+)/i,
      );
      if (m) {
        blocks.unshift({ name: "Abstract", text: m[0].trim() });
      }
    }
  }

  return blocks.length ? blocks : [{ name: "Body", text }];
}

function splitPagedSections(
  pages: Array<{ page: number; text: string }>,
): SectionBlock[] {
  const blocks: SectionBlock[] = [];
  let curName = "Body";
  let buf: string[] = [];
  let pageStart = pages[0]?.page ?? 1;
  let pageEnd = pageStart;

  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) {
      blocks.push({ name: curName, text: t, pageStart, pageEnd });
    }
    buf = [];
  };

  for (const p of pages) {
    const lines = normalizeWs(p.text).split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (isSectionHeadingLine(trimmed)) {
        flush();
        curName = trimmed.replace(/\s+/g, " ");
        pageStart = p.page;
        pageEnd = p.page;
        continue;
      }
      if (!buf.length) pageStart = p.page;
      pageEnd = p.page;
      buf.push(line);
    }
  }
  flush();
  return blocks.length
    ? blocks
    : [
        {
          name: "Body",
          text: pages.map((p) => p.text).join("\n"),
        },
      ];
}

function packByTokens(
  pieces: string[],
  maxTokens: number,
): Array<{ text: string; from: number; to: number }> {
  const out: Array<{ text: string; from: number; to: number }> = [];
  let buf: string[] = [];
  let from = 0;
  let tokens = 0;

  const flush = (to: number) => {
    if (!buf.length) return;
    out.push({ text: buf.join("\n\n").trim(), from, to });
    buf = [];
    tokens = 0;
  };

  for (let i = 0; i < pieces.length; i++) {
    const t = estimateTokens(pieces[i]);
    if (buf.length && tokens + t > maxTokens) {
      flush(i - 1);
      from = i;
    }
    if (!buf.length) from = i;
    buf.push(pieces[i]);
    tokens += t;
    // oversized single piece still emitted alone
    if (tokens >= maxTokens && buf.length === 1) {
      flush(i);
      from = i + 1;
    }
  }
  if (buf.length) flush(pieces.length - 1);
  return out;
}

/** First sentence (or two if short) — needle for PDF cite locate / auto-HL. */
function anchorFrom(text: string): string {
  const sents = splitSentences(text);
  const first = (sents[0] || text).replace(/\s+/g, " ").trim();
  if (first.length >= 80 || sents.length < 2) {
    return first.slice(0, 320);
  }
  const second = (sents[1] || "").replace(/\s+/g, " ").trim();
  return `${first} ${second}`.trim().slice(0, 320);
}

/**
 * Build parent/child chunks with paragraph + sentence locators.
 */
export function chunkDocument(doc: ExtractedDoc, opts?: ChunkOptions): Chunk[] {
  const o = { ...DEFAULTS, ...opts };
  const sections = splitIntoSections(doc.fullText, doc.pages);
  const chunks: Chunk[] = [];
  let seq = 0;
  const id = () => `${doc.paperId}-${++seq}`;

  for (const sec of sections) {
    const isAbstract = /abstract/i.test(sec.name);
    const paras = splitParagraphs(sec.text);
    if (!paras.length) continue;

    // Parents: pack consecutive paragraphs
    const parentPacks = packByTokens(paras, o.parentMaxTokens);
    for (let pi = 0; pi < parentPacks.length; pi++) {
      const pack = parentPacks[pi];
      const parentId = id();
      const sectionLabel =
        sec.name + (parentPacks.length > 1 ? ` (${pi + 1})` : "");
      const paraStart = pack.from + 1;
      const paraEnd = pack.to + 1;
      chunks.push({
        id: parentId,
        text: pack.text,
        section: sectionLabel,
        pageStart: sec.pageStart,
        pageEnd: sec.pageEnd,
        paraStart,
        paraEnd,
        anchorText: anchorFrom(pack.text),
        kind: isAbstract ? "abstract" : "parent",
        tokenEstimate: estimateTokens(pack.text),
      });

      // Children: per paragraph, pack sentences if long
      for (let p = pack.from; p <= pack.to; p++) {
        const para = paras[p];
        const paraNum = p + 1;
        const sents = splitSentences(para);
        if (!sents.length) continue;

        if (estimateTokens(para) <= o.childTokens) {
          chunks.push({
            id: id(),
            text: para,
            section: sec.name,
            pageStart: sec.pageStart,
            pageEnd: sec.pageEnd,
            paraStart: paraNum,
            paraEnd: paraNum,
            sentStart: 1,
            sentEnd: sents.length,
            anchorText: anchorFrom(para),
            parentId,
            kind: isAbstract ? "abstract" : "child",
            tokenEstimate: estimateTokens(para),
          });
          continue;
        }

        // Pack sentences into child-sized windows
        let sBuf: string[] = [];
        let sFrom = 0;
        let sTok = 0;
        const flushSent = (sTo: number) => {
          if (!sBuf.length) return;
          const text = sBuf.join(" ").trim();
          chunks.push({
            id: id(),
            text,
            section: sec.name,
            pageStart: sec.pageStart,
            pageEnd: sec.pageEnd,
            paraStart: paraNum,
            paraEnd: paraNum,
            sentStart: sFrom + 1,
            sentEnd: sTo + 1,
            anchorText: anchorFrom(text),
            parentId,
            kind: isAbstract ? "abstract" : "child",
            tokenEstimate: estimateTokens(text),
          });
          sBuf = [];
          sTok = 0;
        };

        for (let si = 0; si < sents.length; si++) {
          const st = estimateTokens(sents[si]);
          if (sBuf.length && sTok + st > o.childTokens) {
            flushSent(si - 1);
            sFrom = si;
          }
          if (!sBuf.length) sFrom = si;
          sBuf.push(sents[si]);
          sTok += st;
          if (sTok >= o.childTokens && sBuf.length === 1) {
            flushSent(si);
            sFrom = si + 1;
          }
        }
        if (sBuf.length) flushSent(sents.length - 1);
      }
    }
  }

  return chunks;
}

/** Section names present among chunks (for tests / diagnostics). */
export function sectionNames(chunks: Chunk[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of chunks) {
    const base = c.section.replace(/\s*\(\d+\)\s*$/, "");
    if (!seen.has(base)) {
      seen.add(base);
      out.push(base);
    }
  }
  return out;
}

/** Human locator for tooltips / diagnostics (EN). */
export function formatLocator(c: {
  section: string;
  paraStart?: number;
  paraEnd?: number;
  sentStart?: number;
  sentEnd?: number;
  pageStart?: number;
  pageEnd?: number;
}): string {
  const base = c.section.replace(/\s*\(\d+\)\s*$/, "");
  const parts: string[] = [base];
  if (c.paraStart != null) {
    if (c.paraEnd != null && c.paraEnd !== c.paraStart) {
      parts.push(`¶${c.paraStart}–${c.paraEnd}`);
    } else {
      parts.push(`¶${c.paraStart}`);
    }
  }
  if (c.sentStart != null && (c.paraEnd == null || c.paraEnd === c.paraStart)) {
    if (c.sentEnd != null && c.sentEnd !== c.sentStart) {
      parts.push(`s${c.sentStart}–${c.sentEnd}`);
    } else {
      parts.push(`s${c.sentStart}`);
    }
  }
  if (c.pageStart != null) {
    if (c.pageEnd != null && c.pageEnd !== c.pageStart) {
      parts.push(`p.${c.pageStart}–${c.pageEnd}`);
    } else {
      parts.push(`p.${c.pageStart}`);
    }
  }
  return parts.join(" · ");
}

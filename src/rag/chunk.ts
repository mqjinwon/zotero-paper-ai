/**
 * Section-first hierarchical chunking (parent–child).
 * Policy: section-parent-child-v2 — full paper coverage + child overlap.
 */

import { CHUNK_POLICY, type Chunk, type ExtractedDoc } from "./types";

export { CHUNK_POLICY };

const SECTION_RE =
  /^(?:(?:\d+(?:\.\d+){0,3}|[IVXLC]+)\s+)?(Abstract|Introduction|Related\s+Work|Background|Preliminaries|Method(?:s|ology)?|Approach|Experiments?|Evaluation|Results?|Discussion|Conclusion|Conclusions|Limitations|Appendix|References|Acknowledgments?)\b/i;

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

/** v2: slightly tighter children + ~15% overlap to reduce boundary misses. */
const DEFAULTS: Required<ChunkOptions> = {
  childTokens: 400,
  parentMaxTokens: 2000,
  overlapTokens: 64,
};

interface SectionBlock {
  name: string;
  text: string;
  pageStart?: number;
  pageEnd?: number;
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
    if (trimmed.length > 0 && trimmed.length < 80 && SECTION_RE.test(trimmed)) {
      flush();
      curName = trimmed.replace(/\s+/g, " ");
      continue;
    }
    buf.push(line);
  }
  flush();

  // Detect abstract at start if no Abstract section
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
      if (
        trimmed.length > 0 &&
        trimmed.length < 80 &&
        SECTION_RE.test(trimmed)
      ) {
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

function splitRecursive(
  text: string,
  maxTokens: number,
  overlapTokens: number,
): string[] {
  const est = estimateTokens(text);
  if (est <= maxTokens) return [text];

  const targetChars = maxTokens * 4;
  const overlapChars = overlapTokens * 4;
  const seps = ["\n\n", "\n", ". ", " "];
  const parts: string[] = [];

  let rest = text;
  while (estimateTokens(rest) > maxTokens) {
    const cut = Math.min(rest.length, targetChars);
    const window = rest.slice(0, cut);
    let best = -1;
    for (const sep of seps) {
      const idx = window.lastIndexOf(sep);
      if (idx > targetChars * 0.4) {
        best = idx + sep.length;
        break;
      }
    }
    if (best < 0) best = cut;
    parts.push(rest.slice(0, best).trim());
    const nextStart = Math.max(0, best - overlapChars);
    rest = rest.slice(nextStart).trim();
    if (!rest) break;
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

export function chunkDocument(doc: ExtractedDoc, opts?: ChunkOptions): Chunk[] {
  const o = { ...DEFAULTS, ...opts };
  const sections = splitIntoSections(doc.fullText, doc.pages);
  const chunks: Chunk[] = [];
  let seq = 0;
  const id = () => `${doc.paperId}-${++seq}`;

  for (const sec of sections) {
    const parentPieces = splitRecursive(
      sec.text,
      o.parentMaxTokens,
      o.overlapTokens,
    );

    for (let pi = 0; pi < parentPieces.length; pi++) {
      const parentText = parentPieces[pi];
      const parentId = id();
      const isAbstract = /abstract/i.test(sec.name);
      const sectionLabel =
        sec.name + (parentPieces.length > 1 ? ` (${pi + 1})` : "");
      chunks.push({
        id: parentId,
        text: parentText,
        section: sectionLabel,
        pageStart: sec.pageStart,
        pageEnd: sec.pageEnd,
        kind: isAbstract ? "abstract" : "parent",
        tokenEstimate: estimateTokens(parentText),
      });

      const children = splitRecursive(
        parentText,
        o.childTokens,
        o.overlapTokens,
      );
      for (const c of children) {
        chunks.push({
          id: id(),
          text: c,
          section: sec.name,
          pageStart: sec.pageStart,
          pageEnd: sec.pageEnd,
          parentId,
          kind: isAbstract ? "abstract" : "child",
          tokenEstimate: estimateTokens(c),
        });
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

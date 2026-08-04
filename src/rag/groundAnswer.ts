/**
 * Post-hoc answer → paper-sentence grounding.
 *
 * Links are NOT matched to pre-built RAG cite ids.
 * After the model answers from paper context, we:
 *  1) extract claim spans from the answer
 *  2) find the best supporting *paper sentence*
 *  3) link only when score clears a gate
 *  4) navigate using that paper sentence as the locate needle
 */

import { buildBm25, bm25Scores, tokenize } from "./bm25";
import type { IndexedChunk, PaperIndex } from "./types";

export interface PaperSentence {
  text: string;
  pageStart?: number;
  pageEnd?: number;
  section?: string;
  chunkId?: string;
}

export interface GroundedLink {
  /** Phrase inside the answer that becomes the hyperlink */
  answerPhrase: string;
  /** Verbatim-ish paper sentence used as PDF locate needle */
  paperSentence: string;
  pageStart?: number;
  pageEnd?: number;
  section?: string;
  score: number;
}

export interface GroundAnswerOptions {
  /** Minimum combined score to emit a link (0–1 scale-ish). Default 0.42 */
  minScore?: number;
  /** Max links per answer. Default 6 */
  maxLinks?: number;
  /** Min paper sentence length. Default 28 */
  minPaperChars?: number;
  /** Min answer claim length. Default 12 */
  minClaimChars?: number;
}

const DEFAULTS: Required<GroundAnswerOptions> = {
  minScore: 0.42,
  maxLinks: 6,
  minPaperChars: 28,
  minClaimChars: 12,
};

export function normalizeGroundText(s: string): string {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Split prose into sentence-like units. */
export function splitSentences(text: string): string[] {
  const t = String(text || "")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (!t) return [];
  const parts = t.split(/(?<=[.!?。！？])\s+|\n+/);
  return parts
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 12);
}

/**
 * Build paper sentence list from an index.
 * Prefer child/abstract (precise); fall back to parent splits if sparse.
 */
export function sentencesFromIndex(
  index: PaperIndex | null | undefined,
): PaperSentence[] {
  if (!index?.chunks?.length) return [];
  return sentencesFromChunks(index.chunks);
}

export function sentencesFromChunks(chunks: IndexedChunk[]): PaperSentence[] {
  const out: PaperSentence[] = [];
  const seen = new Set<string>();
  const pushFrom = (c: IndexedChunk, preferShort: boolean) => {
    const pieces = preferShort
      ? c.anchorText
        ? [c.anchorText, ...splitSentences(c.text)]
        : splitSentences(c.text)
      : splitSentences(c.text);
    for (const raw of pieces) {
      const text = raw.replace(/\s+/g, " ").trim();
      if (text.length < 28) continue;
      // Cap very long parent "sentences"
      const clipped =
        text.length > 420 ? `${text.slice(0, 419).trim()}…` : text;
      const key = normalizeGroundText(clipped).slice(0, 160);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        text: clipped,
        pageStart: c.pageStart,
        pageEnd: c.pageEnd,
        section: c.section,
        chunkId: c.id,
      });
    }
  };

  const fine = chunks.filter(
    (c) => c.kind === "child" || c.kind === "abstract",
  );
  for (const c of fine) pushFrom(c, true);

  if (out.length < 8) {
    for (const c of chunks.filter((c) => c.kind === "parent")) {
      pushFrom(c, false);
    }
  }
  return out;
}

/**
 * Claim spans from an assistant answer (bullets + sentences).
 * Strips existing HTML and leftover [n] / markdown cite noise.
 */
export function extractClaimSpans(
  answer: string,
  opts?: { minChars?: number },
): string[] {
  const minChars = opts?.minChars ?? DEFAULTS.minClaimChars;
  let plain = String(answer || "");
  // strip HTML tags if any
  plain = plain.replace(/<[^>]+>/g, " ");
  // strip markdown links keep label: [text](url) → text
  plain = plain.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // strip bare cite markers
  plain = plain.replace(/\[E?\d+\]/gi, " ");
  plain = plain.replace(/\[§[^\]]+\]/g, " ");
  // Keep newlines for bullet splitting; collapse only horizontal whitespace
  plain = plain
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!plain) return [];

  const spans: string[] = [];
  const lines = plain.split(/\n+/);
  for (const line of lines) {
    const cleaned = line
      .replace(/^\s*[-*•·]\s+/, "")
      .replace(/^\s*\d+[.)]\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) continue;
    if (cleaned.length <= 220) {
      spans.push(cleaned);
    } else {
      for (const s of splitSentences(cleaned)) spans.push(s);
    }
  }
  // Also sentence-split short multi-sentence paragraphs without newlines
  if (spans.length <= 1 && plain.length > 80) {
    for (const s of splitSentences(plain)) {
      if (!spans.includes(s)) spans.push(s);
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of spans) {
    const t = s.trim();
    if (t.length < minChars) continue;
    // skip pure questions / meta
    if (/^(what|how|why|who|when|where|which)\b/i.test(t) && t.endsWith("?")) {
      continue;
    }
    const key = normalizeGroundText(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t.length > 240 ? `${t.slice(0, 239).trim()}…` : t);
  }
  return out;
}

/** Fraction of claim tokens found in paper sentence. */
export function tokenPrecision(claim: string, paper: string): number {
  const ct = tokenize(claim);
  const pt = new Set(tokenize(paper));
  if (ct.length < 2 || pt.size < 2) return 0;
  let hit = 0;
  for (const t of ct) if (pt.has(t)) hit++;
  return hit / ct.length;
}

export function tokenJaccard(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size < 2 || B.size < 2) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Longest run of consecutive shared tokens (normalized by claim token count). */
export function consecutiveTokenOverlap(claim: string, paper: string): number {
  const ct = tokenize(claim);
  const pt = tokenize(paper);
  if (ct.length < 2 || pt.length < 2) return 0;
  let best = 0;
  for (let i = 0; i < ct.length; i++) {
    for (let j = 0; j < pt.length; j++) {
      let k = 0;
      while (
        i + k < ct.length &&
        j + k < pt.length &&
        ct[i + k] === pt[j + k]
      ) {
        k++;
      }
      if (k > best) best = k;
    }
  }
  return Math.min(1, best / Math.max(2, Math.min(ct.length, 8)));
}

/**
 * Combined grounding score in ~[0,1].
 * High only when the claim is substantially supported by the paper sentence.
 */
export function groundingScore(claim: string, paper: string): number {
  const prec = tokenPrecision(claim, paper);
  const jac = tokenJaccard(claim, paper);
  const run = consecutiveTokenOverlap(claim, paper);
  // Need some precision; pure jaccard on short generic words is weak
  if (prec < 0.28 && run < 0.35) return 0;
  return Math.min(1, prec * 0.5 + jac * 0.25 + run * 0.25);
}

/**
 * Pick a short phrase inside the answer claim that is also grounded in the paper sentence.
 * Prefers multi-token consecutive overlap; falls back to distinctive claim tokens present in paper.
 */
export function pickLinkPhrase(claim: string, paper: string): string | null {
  const ct = tokenize(claim);
  const pt = tokenize(paper);
  if (ct.length < 2 || pt.length < 2) return null;

  // 1) Longest consecutive token run (≥2)
  let bestRun: string[] = [];
  for (let i = 0; i < ct.length; i++) {
    for (let j = 0; j < pt.length; j++) {
      let k = 0;
      while (
        i + k < ct.length &&
        j + k < pt.length &&
        ct[i + k] === pt[j + k]
      ) {
        k++;
      }
      if (k >= 2 && k > bestRun.length) {
        bestRun = ct.slice(i, i + k);
      }
    }
  }
  if (bestRun.length >= 2) {
    const phrase = recoverPhraseFromTokens(claim, bestRun);
    if (phrase && phrase.length >= 6) return phrase.slice(0, 80);
  }

  // 2) Distinctive tokens (len≥4) shared, recover a window in claim
  const pset = new Set(pt);
  const shared = ct.filter((t) => t.length >= 4 && pset.has(t));
  if (shared.length >= 2) {
    const phrase = recoverPhraseFromTokens(claim, shared.slice(0, 5));
    if (phrase && phrase.length >= 6) return phrase.slice(0, 80);
  }

  // 3) Single strong multi-char technical term
  const strong = ct.find((t) => t.length >= 7 && pset.has(t));
  if (strong) {
    const phrase = recoverPhraseFromTokens(claim, [strong]);
    if (phrase) return phrase.slice(0, 80);
  }

  return null;
}

/** Map token sequence back to a surface substring of `claim` (case-insensitive). */
function recoverPhraseFromTokens(
  claim: string,
  tokens: string[],
): string | null {
  if (!tokens.length) return null;
  const lower = claim.toLowerCase();
  // Try joining tokens with spaces as substring search variants
  const joined = tokens.join(" ");
  let idx = lower.indexOf(joined);
  if (idx >= 0) {
    return claim.slice(idx, idx + joined.length);
  }
  // Walk claim finding first token then expand
  const first = tokens[0];
  idx = lower.search(new RegExp(`\\b${escapeRegExp(first)}\\b`, "i"));
  if (idx < 0) {
    idx = lower.indexOf(first);
  }
  if (idx < 0) return tokens.join(" ");

  // Expand forward through claim while covering tokens order
  let end = idx;
  let ti = 0;
  const cl = claim.toLowerCase();
  while (ti < tokens.length && end < claim.length) {
    const t = tokens[ti];
    const slice = cl.slice(end);
    const m = slice.match(new RegExp(`^(\\W*)(${escapeRegExp(t)})`, "i"));
    if (m) {
      end += m[0].length;
      ti++;
    } else if (ti === 0) {
      end = idx + first.length;
      ti = 1;
    } else {
      break;
    }
  }
  const surface = claim.slice(idx, end).trim();
  return surface.length >= 3 ? surface : tokens.join(" ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MatchResult {
  claim: string;
  paper: PaperSentence;
  score: number;
  phrase: string;
}

/**
 * For one claim, find best paper sentence above threshold.
 */
export function matchClaimToPaper(
  claim: string,
  paperSents: PaperSentence[],
  bm25Index: ReturnType<typeof buildBm25> | null,
  minScore: number,
): MatchResult | null {
  if (!claim || !paperSents.length) return null;

  let candidates = paperSents;
  // BM25 prefilter when corpus is large
  if (bm25Index && paperSents.length > 12) {
    const scores = bm25Scores(bm25Index, claim);
    const ranked = scores
      .map((s, i) => ({ s, i }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 20)
      .filter((x) => x.s > 0)
      .map((x) => paperSents[x.i]);
    if (ranked.length) candidates = ranked;
  }

  let best: MatchResult | null = null;
  for (const ps of candidates) {
    const score = groundingScore(claim, ps.text);
    if (score < minScore) continue;
    const phrase = pickLinkPhrase(claim, ps.text);
    if (!phrase) continue;
    // Phrase must actually appear in the claim surface
    if (!claim.toLowerCase().includes(phrase.toLowerCase())) continue;
    if (!best || score > best.score) {
      best = { claim, paper: ps, score, phrase };
    }
  }
  return best;
}

function escapeHtml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function encodeRectsAttr(rects?: number[][] | null): string {
  if (!rects?.length) return "";
  try {
    return JSON.stringify(
      rects
        .slice(0, 6)
        .map((r) =>
          r.slice(0, 4).map((n) => Math.round(Number(n) * 100) / 100),
        ),
    );
  } catch {
    return "";
  }
}

/** HTML phrase link whose navigate needle is the *paper* sentence. */
export function htmlGroundLink(link: GroundedLink): string {
  const href =
    link.pageStart != null
      ? `#paperai-page-${link.pageStart}`
      : "#paperai-search";
  const pageAttr =
    link.pageStart != null ? ` data-page="${link.pageStart}"` : "";
  const previewAttr = ` data-preview="${escapeHtml(link.paperSentence)}"`;
  const title = escapeHtml(
    [
      link.section,
      link.pageStart != null ? `p.${link.pageStart}` : "",
      link.paperSentence,
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 400),
  );
  return (
    `<a class="paperai-cite paperai-cite-phrase" href="${href}" title="${title}"` +
    `${pageAttr}${previewAttr}>${escapeHtml(link.answerPhrase)}</a>`
  );
}

/**
 * Apply non-overlapping grounded links into the answer text.
 * Operates on plain (or md) text; inserts HTML anchors.
 */
export function applyGroundedLinks(
  answer: string,
  links: GroundedLink[],
): string {
  if (!answer || !links.length) return answer;
  // Sort by phrase length desc so longer phrases win first
  const ordered = [...links].sort(
    (a, b) => b.answerPhrase.length - a.answerPhrase.length,
  );
  let out = answer;
  const usedRanges: Array<{ start: number; end: number }> = [];

  for (const link of ordered) {
    const phrase = link.answerPhrase;
    if (!phrase || phrase.length < 3) continue;
    const lower = out.toLowerCase();
    const needle = phrase.toLowerCase();
    let from = 0;
    let placed = false;
    while (from < lower.length) {
      const idx = lower.indexOf(needle, from);
      if (idx < 0) break;
      const end = idx + phrase.length;
      // skip if inside an existing tag / already linked region
      const before = out.slice(Math.max(0, idx - 3), idx);
      if (before.includes("<a") || /[=>]$/.test(before)) {
        from = end;
        continue;
      }
      // rough: if between <a ...> and </a>
      const lastOpen = out.lastIndexOf("<a ", idx);
      const lastClose = out.lastIndexOf("</a>", idx);
      if (lastOpen > lastClose) {
        from = end;
        continue;
      }
      const overlaps = usedRanges.some(
        (r) => !(end <= r.start || idx >= r.end),
      );
      if (overlaps) {
        from = end;
        continue;
      }
      // Preserve original surface casing from `out`
      const surface = out.slice(idx, end);
      const html = htmlGroundLink({ ...link, answerPhrase: surface });
      out = out.slice(0, idx) + html + out.slice(end);
      usedRanges.push({ start: idx, end: idx + html.length });
      placed = true;
      break;
    }
    void placed;
  }
  return out;
}

export function evidenceTrayFromGrounds(links: GroundedLink[]): string {
  if (!links.length) return "";
  // Dedupe by paper sentence
  const seen = new Set<string>();
  const items: string[] = [];
  for (const g of links) {
    const key = normalizeGroundText(g.paperSentence).slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = [g.section, g.pageStart != null ? `p.${g.pageStart}` : ""]
      .filter(Boolean)
      .join(" · ");
    const q =
      g.paperSentence.length > 160
        ? `${g.paperSentence.slice(0, 159).trim()}…`
        : g.paperSentence;
    items.push(
      `<li>${htmlGroundLink(g)}${
        meta ? ` <span class="pai-cite-meta">${escapeHtml(meta)}</span>` : ""
      } — ${escapeHtml(q)}</li>`,
    );
  }
  if (!items.length) return "";
  return [
    `<details class="paperai-evidence-tray">`,
    `<summary>근거 ${items.length}</summary>`,
    `<ol class="paperai-evidence-list">`,
    ...items,
    `</ol>`,
    `</details>`,
  ].join("\n");
}

/**
 * Main entry: free-text answer + paper sentences → phrase links + tray.
 */
export function groundAnswerToPaper(
  answer: string,
  paperSentences: PaperSentence[],
  opts?: GroundAnswerOptions,
): {
  answer: string;
  ragFooter: string;
  links: GroundedLink[];
  claims: number;
  matched: number;
} {
  const cfg = { ...DEFAULTS, ...opts };
  const raw = String(answer || "");
  if (!raw.trim() || !paperSentences.length) {
    return {
      answer: raw,
      ragFooter: "",
      links: [],
      claims: 0,
      matched: 0,
    };
  }

  const claims = extractClaimSpans(raw, { minChars: cfg.minClaimChars });
  const corpus = paperSentences.filter(
    (p) => (p.text || "").length >= cfg.minPaperChars,
  );
  const bm25 = corpus.length > 12 ? buildBm25(corpus.map((p) => p.text)) : null;

  const matches: MatchResult[] = [];
  const usedPaper = new Set<string>();
  for (const claim of claims) {
    if (matches.length >= cfg.maxLinks) break;
    const m = matchClaimToPaper(claim, corpus, bm25, cfg.minScore);
    if (!m) continue;
    const pkey = normalizeGroundText(m.paper.text).slice(0, 120);
    // Allow same paper sentence only once
    if (usedPaper.has(pkey)) continue;
    // Avoid linking very generic short phrases
    if (m.phrase.length < 4) continue;
    usedPaper.add(pkey);
    matches.push(m);
  }

  // Prefer higher scores if over max
  matches.sort((a, b) => b.score - a.score);
  const top = matches.slice(0, cfg.maxLinks);

  const links: GroundedLink[] = top.map((m) => ({
    answerPhrase: m.phrase,
    paperSentence: m.paper.text,
    pageStart: m.paper.pageStart,
    pageEnd: m.paper.pageEnd,
    section: m.paper.section,
    score: m.score,
  }));

  // Strip leftover bare cite markers the model may still emit
  const cleaned = raw
    .replace(/\[E?\d+\](?!\()/gi, "")
    .replace(/\[§[^\]]+\](?!\()/g, "")
    // strip model phrase-cite markdown: keep phrase text only
    .replace(
      /\[([^\]]{1,120})\]\(\s*(?:#(?:cite-|e|paperai-cite-)?|cite:)\d+\s*\)/gi,
      "$1",
    );

  const body = applyGroundedLinks(cleaned, links);
  const tray = evidenceTrayFromGrounds(links);
  return {
    answer: tray ? `${body}\n\n${tray}` : body,
    ragFooter: tray,
    links,
    claims: claims.length,
    matched: links.length,
  };
}

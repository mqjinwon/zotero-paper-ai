/**
 * Pull figure/table captions and in-text discussion from paper body text.
 * Pure helpers — used to ground vision explain with the right paragraphs.
 */

export interface FigureMention {
  label: string;
  /** Caption line(s) near the label */
  caption: string;
}

export interface FigureContextBundle {
  mentions: FigureMention[];
  /** Paragraphs that discuss figures/tables (body references) */
  relatedParagraphs: string[];
  /** Labels only, for UI hints */
  labels: string[];
  /** BM25 / hybrid query boost string */
  ragQuery: string;
  /** Extra evidence block injected before RAG (deterministic) */
  directBlock: string;
}

const LABEL_RE =
  /(?:Figure|Fig\.?|FIGURE|Table|TABLE|표|그림)\s*[\dA-Za-z]+(?:\s*[\.\-]\s*[\dA-Za-z]+)?/gi;

/** Captions often start a line: "Figure 1. Training curves…" */
const CAPTION_LINE_RE =
  /(?:^|\n)\s*((?:Figure|Fig\.?|FIGURE|Table|TABLE|표|그림)\s*[\dA-Za-z.]+)\s*[\.\:\-]?\s*([^\n]{0,320})/g;

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function extractFigureMentions(
  fullText: string,
  limit = 24,
): FigureMention[] {
  if (!fullText?.trim()) return [];
  const out: FigureMention[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(CAPTION_LINE_RE.source, "g");
  while ((m = re.exec(fullText)) !== null) {
    const label = m[1].replace(/\s+/g, " ").trim();
    const caption = normalizeWs(`${label} ${m[2] || ""}`).slice(0, 360);
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, caption });
    if (out.length >= limit) break;
  }
  return out;
}

/** Split body into paragraphs; keep those that cite figures/tables. */
export function findFigureDiscussions(
  fullText: string,
  opts?: { preferLabels?: string[]; limit?: number },
): string[] {
  if (!fullText?.trim()) return [];
  const limit = opts?.limit ?? 10;
  const prefer = (opts?.preferLabels || []).map((l) => l.toLowerCase());
  const paras = fullText
    .split(/\n{2,}/)
    .map((p) => normalizeWs(p))
    .filter((p) => p.length > 40);

  const scored: Array<{ p: string; score: number }> = [];
  for (const p of paras) {
    if (!LABEL_RE.test(p)) {
      LABEL_RE.lastIndex = 0;
      continue;
    }
    LABEL_RE.lastIndex = 0;
    let score = 1;
    const low = p.toLowerCase();
    for (const lab of prefer) {
      if (lab && low.includes(lab.toLowerCase())) score += 3;
    }
    // Prefer discussion / result style language
    if (/show|depict|illustrat|compare|result|ablation|see fig|as shown/i.test(p)) {
      score += 1;
    }
    // Skip pure reference lists
    if (/^\[\d+\]/.test(p) || (p.match(/\[\d+\]/g) || []).length > 4) {
      score -= 2;
    }
    if (score > 0) scored.push({ p: p.slice(0, 900), score });
  }
  scored.sort((a, b) => b.score - a.score);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { p } of scored) {
    const key = p.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Build grounding text for figure explain: captions + body mentions + RAG query.
 */
export function buildFigureContextBundle(
  fullText: string,
  opts?: {
    pageLabel?: string;
    userQuestion?: string;
    /** Labels guessed from comment / OCR later */
    preferLabels?: string[];
    maxMentions?: number;
    maxParas?: number;
  },
): FigureContextBundle {
  const mentions = extractFigureMentions(
    fullText,
    opts?.maxMentions ?? 16,
  );
  let prefer = opts?.preferLabels?.filter(Boolean) || [];
  if (!prefer.length) {
    prefer = mentions.map((m) => m.label);
  }
  const relatedParagraphs = findFigureDiscussions(fullText, {
    preferLabels: prefer,
    limit: opts?.maxParas ?? 8,
  });
  const labels = [
    ...new Set([
      ...prefer,
      ...mentions.map((m) => m.label),
    ]),
  ].slice(0, 12);

  const captionBlock = mentions
    .slice(0, 10)
    .map((m) => m.caption)
    .join("\n");
  const bodyBlock = relatedParagraphs.join("\n\n");

  const directParts = [
    "=== Figure / table captions & paper discussion (deterministic extract) ===",
  ];
  if (opts?.pageLabel) directParts.push(`Page focus: p.${opts.pageLabel}`);
  if (captionBlock) {
    directParts.push("Captions:");
    directParts.push(captionBlock);
  }
  if (bodyBlock) {
    directParts.push("In-text discussion:");
    directParts.push(bodyBlock);
  }
  if (!captionBlock && !bodyBlock) {
    directParts.push("(No explicit Figure/Table captions found in extract.)");
  }

  const ragQuery = [
    opts?.userQuestion || "",
    "figure caption table chart diagram plot axis legend",
    labels.join(" "),
    captionBlock.slice(0, 400),
    relatedParagraphs[0]?.slice(0, 200) || "",
    opts?.pageLabel ? `page ${opts.pageLabel}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    mentions,
    relatedParagraphs,
    labels,
    ragQuery,
    directBlock: directParts.join("\n"),
  };
}

/** Merge deterministic figure extract with BM25/hybrid evidence block. */
export function mergeFigureEvidence(
  directBlock: string,
  ragContextBlock: string,
): string {
  const a = (directBlock || "").trim();
  const b = (ragContextBlock || "").trim();
  if (a && b) return `${a}\n\n${b}`;
  return a || b;
}

/**
 * High-quality post-hoc grounding orchestration.
 * claims → normalize → candidates → judge (pool) → PDF lock (seq) → HTML apply
 */

import type { EmbedConfig } from "../embed";
import { embedTexts } from "../embed";
import { groundAnswerToPaper } from "../groundAnswer";
import { applyLockedEvidence } from "./apply";
import { retrieveCandidates } from "./candidates";
import { claimsFromAnswerRules, parseClaimsJson } from "./claims";
import {
  buildJudgeSystem,
  buildJudgeUser,
  parseJudgment,
} from "./judge";
import { completeJson } from "./llmJson";
import {
  applyNormalizeResult,
  buildNormalizeSystem,
  buildNormalizeUser,
} from "./normalize";
import { lockJudgmentToPdf, type LocateHit } from "./pdfLock";
import type {
  Claim,
  GroundingDiagnostics,
  GroundingLlm,
  GroundingResult,
  Judgment,
  LockedEvidence,
  PaperSentenceRef,
} from "./types";

const CLAIM_SYSTEM = [
  "Extract atomic research claims from the assistant answer.",
  "Each claim is one testable assertion grounded in the paper discussion.",
  "Drop meta lines (summaries, transitions, questions).",
  "Respond JSON only:",
  '{"claims":[{"text":"…","type":"method|result|definition|comparison|other","must_terms":[],"numbers":[]}]}',
  "Max 8 claims. Prefer the answer language for text.",
].join(" ");

/** Bounded async map — preserves order; concurrency-limited workers. */
async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const n = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function emptyResult(
  answer: string,
  extra?: Partial<GroundingResult>,
): GroundingResult {
  return {
    answer,
    links: [],
    claims: [],
    judgments: [],
    matched: 0,
    diagnostics: {
      usedDense: false,
      claimCount: 0,
      candidateCounts: [],
      locateFailures: 0,
    },
    ...extra,
  };
}

function legacyFallback(
  answer: string,
  paperSentences: PaperSentenceRef[],
): GroundingResult {
  const legacy = groundAnswerToPaper(
    answer,
    paperSentences.map((s) => ({
      text: s.text,
      pageStart: s.pageStart,
      pageEnd: s.pageEnd,
      section: s.section,
      chunkId: s.chunkId,
    })),
  );
  // Lexical only — no PDF locate; honest locateOk false, no rects.
  const links: LockedEvidence[] = legacy.links.map((g, i) => ({
    claimId: `legacy${i + 1}`,
    answerPhrase: g.answerPhrase,
    paperSentence: g.paperSentence,
    pageStart: g.pageStart,
    pageEnd: g.pageEnd,
    section: g.section,
    locateOk: false,
    source: "legacy-lexical",
  }));
  return {
    answer: legacy.answer,
    links,
    claims: [],
    judgments: [],
    matched: legacy.matched,
    diagnostics: {
      usedDense: false,
      claimCount: legacy.claims,
      candidateCounts: [],
      locateFailures: 0,
    },
  };
}

async function extractClaims(
  answer: string,
  llm: GroundingLlm,
  maxClaims: number,
): Promise<Claim[]> {
  try {
    const raw = await completeJson(
      llm,
      CLAIM_SYSTEM,
      `Answer to extract claims from:\n\n${answer.slice(0, 6000)}`,
    );
    const parsed = parseClaimsJson(raw, maxClaims);
    if (parsed.length) return parsed;
  } catch {
    /* rule fallback */
  }
  return claimsFromAnswerRules(answer, maxClaims);
}

async function normalizeClaims(
  claims: Claim[],
  llm: GroundingLlm,
): Promise<Claim[]> {
  if (!claims.length) return claims;
  try {
    const raw = await completeJson(
      llm,
      buildNormalizeSystem(),
      buildNormalizeUser(claims),
    );
    return applyNormalizeResult(claims, raw);
  } catch {
    return claims.map((c) => ({
      ...c,
      textEn: c.textEn || c.text,
    }));
  }
}

async function tryDenseEmbeddings(
  claims: Claim[],
  corpus: PaperSentenceRef[],
  embedCfg: EmbedConfig,
): Promise<{
  usedDense: boolean;
  claimEmbeds: Map<string, number[]>;
  corpusEmbeddings: Array<number[] | undefined>;
}> {
  const claimEmbeds = new Map<string, number[]>();
  const corpusEmbeddings: Array<number[] | undefined> = corpus.map(
    (s) => s.embedding,
  );

  // Prefer pre-attached sentence embeddings when all present
  const allHave = corpus.length > 0 && corpus.every((s) => s.embedding?.length);
  if (allHave) {
    try {
      const texts = claims.map((c) => c.textEn || c.text);
      const vecs = await embedTexts(texts, embedCfg);
      claims.forEach((c, i) => {
        if (vecs[i]?.length) claimEmbeds.set(c.id, vecs[i]);
      });
      return {
        usedDense: claimEmbeds.size > 0,
        claimEmbeds,
        corpusEmbeddings,
      };
    } catch {
      return { usedDense: false, claimEmbeds, corpusEmbeddings };
    }
  }

  // On-the-fly: claim + corpus (cap 80 sents)
  const cap = 80;
  const subset = corpus.slice(0, cap);
  try {
    const claimTexts = claims.map((c) => c.textEn || c.text);
    const sentTexts = subset.map((s) => s.text);
    const vecs = await embedTexts([...claimTexts, ...sentTexts], embedCfg);
    claims.forEach((c, i) => {
      if (vecs[i]?.length) claimEmbeds.set(c.id, vecs[i]);
    });
    const offset = claimTexts.length;
    for (let i = 0; i < subset.length; i++) {
      const v = vecs[offset + i];
      if (v?.length) corpusEmbeddings[i] = v;
    }
    return {
      usedDense: claimEmbeds.size > 0,
      claimEmbeds,
      corpusEmbeddings,
    };
  } catch {
    return {
      usedDense: false,
      claimEmbeds: new Map(),
      corpusEmbeddings: corpus.map((s) => s.embedding),
    };
  }
}

const JUDGE_CONCURRENCY = 3;

export async function groundAnswerHighQuality(opts: {
  answer: string;
  paperSentences: PaperSentenceRef[];
  llm?: GroundingLlm | null;
  embedCfg?: EmbedConfig | null;
  /** async locate; if omitted, skip PDF lock and produce zero links (fail closed) */
  locate?: (quote: string) => Promise<LocateHit | null>;
  maxClaims?: number;
  judgeTopK?: number;
  /**
   * When llm null, fall back to legacy groundAnswerToPaper.
   * Default **false** (fail closed — keep answer body, no cite links).
   */
  allowLegacyFallback?: boolean;
}): Promise<GroundingResult> {
  const answer = String(opts.answer || "");
  const corpus = opts.paperSentences || [];
  const maxClaims = opts.maxClaims ?? 8;
  const judgeTopK = opts.judgeTopK ?? 5;
  const allowLegacy = opts.allowLegacyFallback === true;

  if (!answer.trim()) {
    return emptyResult(answer);
  }
  if (!corpus.length) {
    return emptyResult(answer);
  }

  if (!opts.llm) {
    if (allowLegacy) {
      return legacyFallback(answer, corpus);
    }
    return emptyResult(answer);
  }

  const llm = opts.llm;
  let claims = await extractClaims(answer, llm, maxClaims);
  claims = await normalizeClaims(claims, llm);

  let usedDense = false;
  let claimEmbeds = new Map<string, number[]>();
  let corpusEmbeddings: Array<number[] | undefined> | null = null;

  if (opts.embedCfg?.apiKey) {
    const dense = await tryDenseEmbeddings(claims, corpus, opts.embedCfg);
    usedDense = dense.usedDense;
    claimEmbeds = dense.claimEmbeds;
    corpusEmbeddings = dense.corpusEmbeddings;
  }

  // Phase 1: retrieve + judge in parallel (concurrency 3)
  type JudgeRow = {
    claim: Claim;
    judgment: Judgment;
    candidateCount: number;
  };

  const judgeRows = await mapPool(claims, JUDGE_CONCURRENCY, async (claim) => {
    const candidates = retrieveCandidates(claim, corpus, {
      topN: 15,
      embedClaim: claimEmbeds.get(claim.id) || null,
      corpusEmbeddings: usedDense ? corpusEmbeddings : null,
    });
    const top = candidates.slice(0, judgeTopK);

    if (!top.length) {
      return {
        claim,
        judgment: {
          claimId: claim.id,
          label: "none" as const,
          sentenceId: null,
          paperSentence: null,
          confidence: 0,
        },
        candidateCount: 0,
      } satisfies JudgeRow;
    }

    const allowed = new Map(top.map((c) => [c.sentence.id, c.sentence.text]));
    let judgment: Judgment;
    try {
      const raw = await completeJson(
        llm,
        buildJudgeSystem(),
        buildJudgeUser(claim, top),
      );
      judgment = parseJudgment(raw, claim, allowed);
    } catch {
      judgment = {
        claimId: claim.id,
        label: "none",
        sentenceId: null,
        paperSentence: null,
        confidence: 0,
      };
    }
    return {
      claim,
      judgment,
      candidateCount: candidates.length,
    } satisfies JudgeRow;
  });

  // Phase 2: sequential PDF lock (avoid PDF.js races)
  const judgments: Judgment[] = [];
  const locks: LockedEvidence[] = [];
  const candidateCounts: number[] = [];
  let locateFailures = 0;
  const usedPaper = new Set<string>();

  for (const row of judgeRows) {
    judgments.push(row.judgment);
    candidateCounts.push(row.candidateCount);

    const { claim, judgment } = row;
    if (judgment.label !== "support" || !judgment.paperSentence) {
      continue;
    }

    const pkey = judgment.paperSentence
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .slice(0, 120);
    if (usedPaper.has(pkey)) continue;

    // Fail closed without locate
    if (!opts.locate) {
      locateFailures++;
      continue;
    }

    const locked = await lockJudgmentToPdf({
      claim,
      judgment,
      locate: opts.locate,
    });
    if (!locked) {
      locateFailures++;
      continue;
    }
    usedPaper.add(pkey);
    // Prefer page from corpus ref when locate page is missing but sentence has pageStart
    if (locked.pageStart == null && judgment.sentenceId) {
      const ref = corpus.find((s) => s.id === judgment.sentenceId);
      if (ref?.pageStart != null) {
        locked.pageStart = ref.pageStart;
        locked.pageEnd = ref.pageEnd;
        locked.section = ref.section;
      }
    } else if (judgment.sentenceId) {
      const ref = corpus.find((s) => s.id === judgment.sentenceId);
      if (ref) {
        locked.section = ref.section;
        if (locked.pageEnd == null) locked.pageEnd = ref.pageEnd;
      }
    }
    locks.push(locked);
  }

  const applied = applyLockedEvidence(answer, locks);
  const diagnostics: GroundingDiagnostics = {
    usedDense,
    judgeModel: llm.model,
    claimCount: claims.length,
    candidateCounts,
    locateFailures,
  };

  return {
    answer: applied.answer,
    links: locks,
    claims,
    judgments,
    matched: locks.length,
    diagnostics,
  };
}

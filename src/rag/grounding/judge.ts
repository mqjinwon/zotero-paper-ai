import type { Candidate, Claim, Judgment, SupportLabel } from "./types";

export const JUDGE_SYSTEM = [
  "You are an evidence judge for a scientific paper.",
  "Given a claim and candidate paper sentences, pick at most one sentence that entails the claim.",
  'Respond JSON only: {"label":"support|partial|none","sentence_id":"…"|null,"confidence":0-1}',
  "sentence_id MUST be one of the provided ids or null.",
  "Prefer none when unsure. support only if the sentence alone justifies the claim.",
].join(" ");

const LABELS = new Set<SupportLabel>(["support", "partial", "none"]);

function asLabel(v: unknown): SupportLabel {
  const s = String(v || "none").toLowerCase() as SupportLabel;
  return LABELS.has(s) ? s : "none";
}

/**
 * Parse LLM judge JSON. Unknown sentence ids force label=none.
 * `allowedIds` maps sentence id → paper sentence text.
 */
export function parseJudgment(
  raw: unknown,
  claim: Claim,
  allowedIds: Map<string, string>,
): Judgment {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  let label = asLabel(obj.label);
  const confRaw = Number(obj.confidence);
  const confidence = Number.isFinite(confRaw)
    ? Math.max(0, Math.min(1, confRaw))
    : 0;

  let sentenceId: string | null = null;
  const sid = obj.sentence_id ?? obj.sentenceId;
  if (sid != null && String(sid).trim()) {
    const id = String(sid).trim();
    if (allowedIds.has(id)) {
      sentenceId = id;
    } else {
      // Hallucinated id → fail closed
      label = "none";
      sentenceId = null;
    }
  }

  if (label === "none") {
    sentenceId = null;
  }
  if ((label === "support" || label === "partial") && !sentenceId) {
    label = "none";
  }

  const paperSentence = sentenceId ? allowedIds.get(sentenceId) || null : null;

  return {
    claimId: claim.id,
    label,
    sentenceId,
    paperSentence,
    confidence,
  };
}

export function buildJudgeSystem(): string {
  return JUDGE_SYSTEM;
}

export function buildJudgeUser(claim: Claim, candidates: Candidate[]): string {
  const cands = candidates.map((c) => ({
    id: c.sentence.id,
    text: c.sentence.text,
    section: c.sentence.section || null,
    page: c.sentence.pageStart ?? null,
  }));
  return [
    "Judge whether any candidate paper sentence supports the claim.",
    "Claim:",
    JSON.stringify(
      {
        id: claim.id,
        text: claim.text,
        text_en: claim.textEn,
        type: claim.type,
        must_terms: claim.mustTerms,
        numbers: claim.numbers,
      },
      null,
      2,
    ),
    "Candidates:",
    JSON.stringify(cands, null, 2),
  ].join("\n");
}

export type ClaimType =
  | "method"
  | "result"
  | "definition"
  | "comparison"
  | "other";

export interface Claim {
  id: string;
  text: string;
  textEn: string;
  type: ClaimType;
  mustTerms: string[];
  numbers: string[];
}

export interface PaperSentenceRef {
  id: string;
  text: string;
  pageStart?: number;
  pageEnd?: number;
  section?: string;
  chunkId?: string;
  fromEvidence?: boolean;
  embedding?: number[];
}

export interface Candidate {
  sentence: PaperSentenceRef;
  scoreFusion: number;
  scoreBm25: number;
  scoreDense?: number;
  scorePrior: number;
}

export type SupportLabel = "support" | "partial" | "none";

export interface Judgment {
  claimId: string;
  label: SupportLabel;
  sentenceId: string | null;
  paperSentence: string | null;
  confidence: number;
}

export interface LockedEvidence {
  claimId: string;
  answerPhrase: string;
  paperSentence: string;
  pageStart?: number;
  pageEnd?: number;
  section?: string;
  rects?: number[][];
  /** true only if PDF locate succeeded */
  locateOk: boolean;
  /** Provenance: real PDF lock vs legacy lexical (no PDF verify). */
  source: "hq-locked" | "legacy-lexical";
}

export interface GroundingDiagnostics {
  usedDense: boolean;
  judgeModel?: string;
  claimCount: number;
  candidateCounts: number[];
  locateFailures: number;
}

export interface GroundingResult {
  answer: string;
  links: LockedEvidence[];
  claims: Claim[];
  judgments: Judgment[];
  matched: number;
  diagnostics: GroundingDiagnostics;
}

/** Minimal LLM port for grounding (wraps LLMClient.complete). */
export type GroundingLlm = {
  complete: (opts: {
    model?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  }) => Promise<string>;
  model?: string;
};

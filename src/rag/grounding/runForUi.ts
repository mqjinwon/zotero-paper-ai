/**
 * Single UI entry for post-hoc evidence grounding.
 * paperTask / sticky / figure call this only — no duplicated locate/legacy blocks.
 *
 * Legacy lexical path lives only in pipeline.ts (llm null + allowLegacyFallback).
 * This module never calls groundAnswerToPaper.
 */

import { locateQuoteInOpenPdf } from "../autoHighlight/locate";
import { resolveEmbedConfig } from "../config";
import type { PaperSentence } from "../groundAnswer";
import type { RagPrefs } from "../types";
import { groundAnswerHighQuality } from "./pipeline";
import type { LocateHit } from "./pdfLock";
import {
  isPaperSentenceRefArray,
  toSentenceRefs,
} from "./sentences";
import {
  formatGroundingErrorStatus,
  formatGroundingProgressStatus,
  formatGroundingResultStatus,
} from "./status";
import type {
  GroundingDiagnostics,
  GroundingLlm,
  PaperSentenceRef,
} from "./types";

/** Wrap an LLMClient-like complete() as GroundingLlm. */
export function fromLLMClient(
  client: {
    complete: (opts: {
      model?: string;
      messages: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }>;
    }) => Promise<string>;
  },
  model: string,
): GroundingLlm {
  return {
    complete: (o) =>
      client.complete({
        model: o.model || model,
        messages: o.messages,
      }),
    model,
  };
}

export type GroundAnswerForUiOpts = {
  answer: string;
  /** Legacy PaperSentence[] or already-built PaperSentenceRef[]. */
  paperSentences: PaperSentence[] | PaperSentenceRef[];
  evidence?: Array<{ chunk?: { id?: string } }>;
  client: {
    complete: (opts: {
      model?: string;
      messages: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }>;
    }) => Promise<string>;
  };
  model: string;
  ragPrefs?: RagPrefs | null;
  /**
   * Passed through to HQ pipeline only (llm null → legacyFallback there).
   * Default **false**. Catch path never enables legacy.
   */
  allowLegacyFallback?: boolean;
  onStatus?: (msg: string) => void;
  /** Inject locate (tests); default: locateQuoteInOpenPdf try/catch → null. */
  locate?: (quote: string) => Promise<LocateHit | null>;
};

export type GroundAnswerForUiResult = {
  answer: string;
  matched: number;
  claimCount: number;
  diagnostics: GroundingDiagnostics;
  /** Empty when tray is inlined into answer (normal path). */
  ragFooter: string;
};

function emptyDiagnostics(): GroundingDiagnostics {
  return {
    usedDense: false,
    claimCount: 0,
    candidateCounts: [],
    locateFailures: 0,
  };
}

function resolveSentenceRefs(
  paperSentences: PaperSentence[] | PaperSentenceRef[],
  evidenceIds: Set<string>,
): PaperSentenceRef[] {
  if (isPaperSentenceRefArray(paperSentences)) {
    return paperSentences;
  }
  return toSentenceRefs(paperSentences, evidenceIds);
}

/**
 * Canonical UI grounding: evidence ids → sentence refs → HQ pipeline → status.
 *
 * Always emits (when onStatus provided):
 * 1. progress at start
 * 2. result on success
 * 3. error / 없음 on fail-closed throw
 *
 * Never silently enables legacy in catch (allowLegacyFallback only for pipeline llm-null).
 */
export async function groundAnswerForUi(
  opts: GroundAnswerForUiOpts,
): Promise<GroundAnswerForUiResult> {
  const answer = String(opts.answer || "");
  const allowLegacy = opts.allowLegacyFallback === true;
  const onStatus = opts.onStatus;

  if (!answer.trim() || !opts.paperSentences?.length) {
    return {
      answer,
      matched: 0,
      claimCount: 0,
      diagnostics: emptyDiagnostics(),
      ragFooter: "",
    };
  }

  onStatus?.(formatGroundingProgressStatus());

  const evidenceIds = new Set(
    (opts.evidence || [])
      .map((e) => e.chunk?.id)
      .filter(Boolean) as string[],
  );
  const paperSentences = resolveSentenceRefs(
    opts.paperSentences,
    evidenceIds,
  );
  const llm = fromLLMClient(opts.client, opts.model);
  const embedCfg = opts.ragPrefs ? resolveEmbedConfig(opts.ragPrefs) : null;

  const locate: (quote: string) => Promise<LocateHit | null> =
    opts.locate ||
    (async (quote) => {
      try {
        return await locateQuoteInOpenPdf(quote);
      } catch {
        return null;
      }
    });

  try {
    const grounded = await groundAnswerHighQuality({
      answer,
      paperSentences,
      llm,
      embedCfg: embedCfg?.apiKey ? embedCfg : null,
      locate,
      allowLegacyFallback: allowLegacy,
    });
    const claimCount =
      grounded.claims.length || grounded.diagnostics.claimCount || 0;
    const result: GroundAnswerForUiResult = {
      answer: grounded.answer,
      matched: grounded.matched,
      claimCount,
      diagnostics: grounded.diagnostics,
      ragFooter: "",
    };
    onStatus?.(
      formatGroundingResultStatus({
        matched: result.matched,
        claimCount: result.claimCount,
        diagnostics: result.diagnostics,
      }),
    );
    return result;
  } catch (e) {
    // Fail closed: keep original answer, no links. Legacy only in pipeline.
    onStatus?.(formatGroundingErrorStatus(e));
    return {
      answer,
      matched: 0,
      claimCount: 0,
      diagnostics: emptyDiagnostics(),
      ragFooter: "",
    };
  }
}

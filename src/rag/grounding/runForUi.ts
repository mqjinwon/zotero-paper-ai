/**
 * Single UI entry for post-hoc evidence grounding.
 * paperTask / sticky / figure call this only — no duplicated locate/legacy blocks.
 */

import { locateQuoteInOpenPdf } from "../autoHighlight/locate";
import { resolveEmbedConfig } from "../config";
import {
  groundAnswerToPaper,
  type PaperSentence,
} from "../groundAnswer";
import type { RagPrefs } from "../types";
import { groundAnswerHighQuality } from "./pipeline";
import type { LocateHit } from "./pdfLock";
import {
  isPaperSentenceRefArray,
  toSentenceRefs,
} from "./sentences";
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
   * When true, allow legacy lexical grounding if LLM missing or HQ throws.
   * Default **false** (fail closed).
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
 * Never silently enables legacy (allowLegacyFallback defaults false).
 */
export async function groundAnswerForUi(
  opts: GroundAnswerForUiOpts,
): Promise<GroundAnswerForUiResult> {
  const answer = String(opts.answer || "");
  const allowLegacy = opts.allowLegacyFallback === true;

  if (!answer.trim() || !opts.paperSentences?.length) {
    return {
      answer,
      matched: 0,
      claimCount: 0,
      diagnostics: emptyDiagnostics(),
      ragFooter: "",
    };
  }

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
    // Tray is already combined into answer by applyLockedEvidence
    const ragFooter = "";
    return {
      answer: grounded.answer,
      matched: grounded.matched,
      claimCount:
        grounded.claims.length || grounded.diagnostics.claimCount || 0,
      diagnostics: grounded.diagnostics,
      ragFooter,
    };
  } catch (e) {
    if (allowLegacy) {
      try {
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
        opts.onStatus?.(
          legacy.matched
            ? `근거 링크 ${legacy.matched}/${legacy.claims} (legacy)`
            : "근거 링크 없음",
        );
        return {
          answer: legacy.answer,
          matched: legacy.matched,
          claimCount: legacy.claims,
          diagnostics: {
            ...emptyDiagnostics(),
            claimCount: legacy.claims,
          },
          ragFooter: legacy.ragFooter || "",
        };
      } catch {
        /* fall through to fail-closed */
      }
    }
    opts.onStatus?.(
      e instanceof Error
        ? `근거 판정 실패: ${e.message}`
        : "근거 링크 없음",
    );
    return {
      answer,
      matched: 0,
      claimCount: 0,
      diagnostics: emptyDiagnostics(),
      ragFooter: "",
    };
  }
}

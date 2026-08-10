import type { GroundingDiagnostics } from "./types";

/** Progress line while claim → judge → PDF lock runs. */
export function formatGroundingProgressStatus(): string {
  return "근거 판정(claim·judge·PDF) 중…";
}

/** Final status after grounding (matched / claims / locate fails / dense). */
export function formatGroundingResultStatus(g: {
  matched: number;
  claimCount: number;
  diagnostics: GroundingDiagnostics;
}): string {
  if (!g.matched && !g.claimCount) {
    return "근거 링크 없음";
  }
  let msg = `근거 링크 ${g.matched}/${g.claimCount}`;
  if (g.diagnostics.locateFailures) {
    msg += ` · locate실패 ${g.diagnostics.locateFailures}`;
  }
  if (g.diagnostics.usedDense) {
    msg += " · dense";
  }
  return msg;
}

/** Fail-closed / error status for UI. */
export function formatGroundingErrorStatus(err?: unknown): string {
  if (err instanceof Error && err.message) {
    return `근거 판정 실패: ${err.message}`;
  }
  return "근거 링크 없음";
}

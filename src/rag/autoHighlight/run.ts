/**
 * End-to-end auto-highlight pipeline.
 */

import type { FileStore } from "../../auth/fileStore";
import { ensureIndex } from "../index";
import { getOpenPaperRef } from "../paperRef";
import { readRagPrefs } from "../prefs";
import { applyClassifiedHighlights, type AppliedAutoHighlight } from "./apply";
import { classifyPassages } from "./classify";
import { selectCandidatePassages } from "./select";

export interface AutoHighlightRunResult {
  applied: AppliedAutoHighlight[];
  skipped: number;
  candidateCount: number;
  classifiedCount: number;
}

export async function runAutoHighlight(opts: {
  store: FileStore;
  reader?: any;
  onStatus?: (s: string) => void;
}): Promise<AutoHighlightRunResult> {
  const paper = getOpenPaperRef();
  if (!paper?.itemKey) {
    throw new Error(
      "열린 PDF를 찾지 못했습니다. PDF 탭을 선택한 뒤 다시 시도하세요.",
    );
  }

  opts.onStatus?.("논문 인덱싱 / 후보 수집 중…");
  const index = await ensureIndex({
    store: opts.store,
    prefs: readRagPrefs(),
    itemKey: paper.itemKey,
    itemID: paper.itemID,
    title: paper.title,
    onStatus: opts.onStatus,
  });

  const candidates = selectCandidatePassages(index);
  if (!candidates.length) {
    throw new Error(
      "인덱스는 있으나 후보 문단이 없습니다. 텍스트 레이어가 있는 PDF인지 확인하세요.",
    );
  }

  const classified = await classifyPassages({
    store: opts.store,
    candidates,
    onStatus: opts.onStatus,
  });

  const { applied, skipped } = await applyClassifiedHighlights({
    items: classified,
    reader: opts.reader,
    onStatus: opts.onStatus,
    replace: true,
  });

  if (!applied.length) {
    throw new Error(
      `분류 ${classified.length}개 중 저장에 성공한 하이라이트가 없습니다 ` +
        `(위치 매핑 실패 또는 주석 저장 오류 ${skipped}). ` +
        `PDF 탭을 연 채로 다시 시도하세요.`,
    );
  }

  opts.onStatus?.(
    `자동 하이라이트 ${applied.length}개 표시` +
      (skipped ? ` · 위치 실패 ${skipped}개` : ""),
  );

  return {
    applied,
    skipped,
    candidateCount: candidates.length,
    classifiedCount: classified.length,
  };
}

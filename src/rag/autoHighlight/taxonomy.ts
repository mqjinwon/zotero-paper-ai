/**
 * Auto-highlight taxonomy: 4 semantic classes × (highlight | underline).
 * Defaults are learning-science oriented; colors/caps/types overridable via prefs.
 */

import { getPref } from "../../utils/prefs";

export type AutoHighlightCategory = "claim" | "method" | "novelty" | "caveat";

export type AnnotationDrawType = "highlight" | "underline";

export interface AutoHighlightClass {
  id: AutoHighlightCategory;
  /** Zotero annotation type */
  type: AnnotationDrawType;
  /** Zotero-compatible hex color */
  color: string;
  labelKo: string;
  labelEn: string;
  /** Short legend line for panel */
  legendKo: string;
}

export const AUTO_TAG_ROOT = "paper-ai-auto";

export function categoryTag(id: AutoHighlightCategory): string {
  return `${AUTO_TAG_ROOT}/${id}`;
}

/** Built-in defaults (also used when prefs empty / outside Zotero). */
export const DEFAULT_AUTO_HIGHLIGHT_CLASSES: Record<
  AutoHighlightCategory,
  AutoHighlightClass
> = {
  claim: {
    id: "claim",
    type: "highlight",
    color: "#ffd400",
    labelKo: "주장·결과",
    labelEn: "Claim / result",
    legendKo: "■ 주장·결과 (노랑 하이라이트)",
  },
  method: {
    id: "method",
    type: "underline",
    color: "#2ea8e5",
    labelKo: "방법·정의",
    labelEn: "Method / definition",
    legendKo: "─ 방법·정의 (파랑 밑줄)",
  },
  novelty: {
    id: "novelty",
    type: "highlight",
    color: "#5fb236",
    labelKo: "기여·새로움",
    labelEn: "Novelty / contribution",
    legendKo: "■ 기여·새로움 (초록 하이라이트)",
  },
  caveat: {
    id: "caveat",
    type: "underline",
    color: "#ff6666",
    labelKo: "한계·가정",
    labelEn: "Limitation / assumption",
    legendKo: "─ 한계·가정 (분홍 밑줄)",
  },
};

/** @deprecated use getAutoHighlightClass / getAutoHighlightClasses — kept for tests */
export const AUTO_HIGHLIGHT_CLASSES = DEFAULT_AUTO_HIGHLIGHT_CLASSES;

export const AUTO_HIGHLIGHT_ORDER: AutoHighlightCategory[] = [
  "claim",
  "method",
  "novelty",
  "caveat",
];

/** Default caps (prefs can override). */
export const DEFAULT_AUTO_MAX_TOTAL = 16;
export const DEFAULT_AUTO_MAX_PER_CATEGORY = 4;
/** @deprecated use getAutoMaxTotal() */
export const AUTO_MAX_TOTAL = DEFAULT_AUTO_MAX_TOTAL;
/** @deprecated use getAutoMaxPerCategory() */
export const AUTO_MAX_PER_CATEGORY = DEFAULT_AUTO_MAX_PER_CATEGORY;
export const AUTO_MIN_QUOTE_CHARS = 24;

const PREF_COLOR: Record<AutoHighlightCategory, string> = {
  claim: "autoHlClaimColor",
  method: "autoHlMethodColor",
  novelty: "autoHlNoveltyColor",
  caveat: "autoHlCaveatColor",
};

const PREF_TYPE: Record<AutoHighlightCategory, string> = {
  claim: "autoHlClaimType",
  method: "autoHlMethodType",
  novelty: "autoHlNoveltyType",
  caveat: "autoHlCaveatType",
};

function prefStr(key: string, fallback = ""): string {
  try {
    const v = getPref(key as never);
    if (v == null || v === "") return fallback;
    return String(v).trim();
  } catch {
    return fallback;
  }
}

function prefInt(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  try {
    const n = Number(getPref(key as never));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  } catch {
    return fallback;
  }
}

/** Normalize #rgb / #rrggbb / rgb(...) → #rrggbb lowercase. */
export function normalizeHexColor(raw: string, fallback: string): string {
  const s = String(raw || "").trim();
  if (!s) return fallback;
  let m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const [r, g, b] = m[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) return `#${m[1]}`.toLowerCase();
  m = s.match(/^#([0-9a-f]{8})$/i);
  if (m) return `#${m[1].slice(0, 6)}`.toLowerCase();
  return fallback;
}

function parseDrawType(
  raw: string,
  fallback: AnnotationDrawType,
): AnnotationDrawType {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (s === "highlight" || s === "underline") return s;
  return fallback;
}

export function getAutoMaxTotal(): number {
  return prefInt("autoHlMaxTotal", DEFAULT_AUTO_MAX_TOTAL, 1, 64);
}

export function getAutoMaxPerCategory(): number {
  return prefInt("autoHlMaxPerCategory", DEFAULT_AUTO_MAX_PER_CATEGORY, 1, 32);
}

export function getAutoHighlightClass(
  id: AutoHighlightCategory,
): AutoHighlightClass {
  const base = DEFAULT_AUTO_HIGHLIGHT_CLASSES[id];
  const color = normalizeHexColor(
    prefStr(PREF_COLOR[id], base.color),
    base.color,
  );
  const type = parseDrawType(prefStr(PREF_TYPE[id], base.type), base.type);
  const mark = type === "highlight" ? "■" : "─";
  const styleKo = type === "highlight" ? "하이라이트" : "밑줄";
  return {
    ...base,
    color,
    type,
    legendKo: `${mark} ${base.labelKo} (${styleKo})`,
  };
}

export function getAutoHighlightClasses(): Record<
  AutoHighlightCategory,
  AutoHighlightClass
> {
  return {
    claim: getAutoHighlightClass("claim"),
    method: getAutoHighlightClass("method"),
    novelty: getAutoHighlightClass("novelty"),
    caveat: getAutoHighlightClass("caveat"),
  };
}

export function isAutoHighlightCategory(s: string): s is AutoHighlightCategory {
  return s in DEFAULT_AUTO_HIGHLIGHT_CLASSES;
}

export function commentPrefix(id: AutoHighlightCategory): string {
  const c = getAutoHighlightClass(id);
  return `[Paper AI · auto · ${id}] ${c.labelKo}`;
}

export function legendLines(): string[] {
  return AUTO_HIGHLIGHT_ORDER.map((id) => getAutoHighlightClass(id).legendKo);
}

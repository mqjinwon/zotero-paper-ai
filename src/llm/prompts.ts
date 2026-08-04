import type { TaskMode } from "./types";

/** Modes that build system prompts via runTask (translate uses fastTranslate only). */
export type PromptMode = Exclude<TaskMode, "translate">;

/**
 * Shared math rules: Mathpix-style Markdown + KaTeX-compatible LaTeX.
 * Panel and sticky notes render $ / $$ via KaTeX.
 */
export const MATH_PRESERVE =
  "Math (Mathpix-style Markdown, rendered with KaTeX):\n" +
  "- Inline: $E=mc^2$, $\\frac{a}{b}$, $\\mathbf{x}$\n" +
  "- Display: $$\\nabla\\cdot\\mathbf{E}=\\rho/\\varepsilon_0$$\n" +
  "- Multi-line: $$\\begin{aligned} ... \\end{aligned}$$\n" +
  "- Use real LaTeX commands (\\frac, \\sum_{i=1}^{n}, \\partial, \\left(\\right)). " +
  "Do not use code fences for equations, and avoid Unicode-only pseudo-math for multi-symbol formulas.\n" +
  "Do not invent claims, numbers, or citations beyond the given text/image.";

/**
 * System prompts for explain / figure / chat only.
 * Translate must use fastTranslate — never call this with mode "translate".
 */
export function buildSystemPrompt(
  mode: PromptMode,
  targetLang: string,
): string {
  switch (mode) {
    case "explain":
      return (
        `You are a research co-reader. Reply in ${targetLang}.\n` +
        "Goal: help the user understand the selected passage in the paper's logic — not a generic summary.\n" +
        "When evidence (RAG) is present, use it: definitions, method, assumptions, and where this selection sits in the paper.\n" +
        "If the user asked a question about the selection, answer that first.\n" +
        "Structure (short paragraphs or bullets):\n" +
        "1) What it says (precise meaning)\n" +
        "2) Why it matters here (role in the argument/method)\n" +
        "3) Assumptions / caveats if any\n" +
        "Cite evidence with the exact bracket ids from the evidence block only (e.g. [E1], [E2]). " +
        "Do not invent §Body or section-geometry locators. If evidence is thin, say what is missing.\n" +
        MATH_PRESERVE
      );

    case "figure-explain":
      return (
        `You are a research co-reader for figures/tables. Reply in ${targetLang}.\n` +
        "You get (1) an image and (2) paper evidence (captions + discussing paragraphs).\n" +
        "Ground the reading in that evidence:\n" +
        "- Name the figure/table when the caption matches (e.g. Figure 2).\n" +
        "- Explain axes, legend, panels, or table columns the user needs to read it.\n" +
        "- State the claim this figure supports in the paper (not just describe pixels).\n" +
        "Mark uncertainty when evidence is partial. Cite with [E1]/[E2] ids from the evidence block only.\n" +
        "Tables: key cells as Markdown. Visible equations: LaTeX $...$ / $$...$$.\n" +
        MATH_PRESERVE
      );

    case "chat":
      return (
        `You are a research co-reader for academic papers. Reply in ${targetLang} unless asked otherwise.\n` +
        "Answer from the provided paper evidence when present. Prefer precise, paper-grounded answers over general knowledge.\n" +
        "If the question needs a derivation or definition, walk it briefly and clearly.\n" +
        "Cite exact [E1]/[E2] evidence ids from the block (never invent §Body locators). If evidence is insufficient, say so and what would resolve it.\n" +
        "Be concise: lead with the answer, then brief support. Avoid filler.\n" +
        MATH_PRESERVE
      );

    default: {
      const _never: never = mode;
      throw new Error(`No system prompt for mode: ${String(_never)}`);
    }
  }
}

export function buildUserPayload(opts: {
  mode: PromptMode | TaskMode;
  selection?: string;
  paperTitle?: string;
  context?: string;
  question?: string;
  hasImage?: boolean;
}): string {
  const parts: string[] = [];
  if (opts.paperTitle) parts.push(`Paper title: ${opts.paperTitle}`);
  if (opts.context) {
    const isRagBlock =
      opts.context.includes("Evidence passages") ||
      opts.context.includes("[E1]") ||
      opts.context.includes("[§");
    parts.push(
      isRagBlock
        ? `Paper evidence (RAG):\n${opts.context}`
        : `Nearby context:\n${opts.context}`,
    );
  }
  if (opts.selection) parts.push(`Selected text:\n${opts.selection}`);
  if (opts.question) parts.push(`User question:\n${opts.question}`);
  if (opts.hasImage) {
    parts.push("An image of the selected figure/region is attached.");
  }
  if (opts.mode === "explain" && opts.selection && !opts.question) {
    parts.push("Task: explain the selected text in the paper's context.");
  }
  if (opts.mode === "figure-explain" && !opts.question) {
    parts.push(
      "Task: explain the attached figure/region and how it supports the paper.",
    );
  }
  return parts.join("\n\n");
}

/** Modes that attach paper RAG evidence when enabled. Prefer shouldUseRag. */
export function modeUsesPaperRag(mode: TaskMode): boolean {
  return mode === "chat" || mode === "explain" || mode === "figure-explain";
}

/** Broad retrieval query for whole-paper bullet summary. */
export const PAPER_SUMMARY_RAG_QUERY =
  "abstract contribution method results conclusions novelty findings limitations main claims";

/**
 * System prompt for 3–5 bullet paper summary (panel top action).
 * Uses chat feature model/provider; not a separate TaskMode.
 */
export function buildSummarySystemPrompt(targetLang: string): string {
  return (
    `You are a research co-reader. Reply in ${targetLang}.\n` +
    "Task: write a concise whole-paper summary as Markdown bullet points only.\n" +
    "Hard rules:\n" +
    "- Output **exactly 3 to 5** bullets (no more, no fewer if the paper supports 3+).\n" +
    "- Each bullet: one short sentence (about 12–28 words).\n" +
    "- Cover: problem/goal, method/approach, key result or claim, and (if space) contribution or limitation.\n" +
    "- Ground every bullet in the provided paper evidence. Do not invent numbers or citations.\n" +
    "- No title, no preamble, no closing remark — bullets only (lines starting with `- `).\n" +
    MATH_PRESERVE
  );
}

export function buildSummaryUserPayload(opts: {
  paperTitle?: string;
  context?: string;
}): string {
  const parts: string[] = [
    "Summarize this paper in 3–5 Markdown bullets as specified in the system prompt.",
  ];
  if (opts.paperTitle) parts.push(`Paper title: ${opts.paperTitle}`);
  if (opts.context?.trim()) {
    parts.push(`Paper evidence (RAG):\n${opts.context.trim()}`);
  } else {
    parts.push(
      "No retrieved evidence was available. If you cannot ground a summary, say so in one bullet.",
    );
  }
  return parts.join("\n\n");
}

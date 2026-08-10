import type { GroundingLlm } from "./types";

/**
 * Call LLM and parse a JSON object from the response.
 * Strips optional ``` / ```json fences before JSON.parse.
 */
export async function completeJson(
  llm: GroundingLlm,
  system: string,
  user: string,
): Promise<unknown> {
  const raw = await llm.complete({
    model: llm.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const text = String(raw || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] || text).trim();
  return JSON.parse(body);
}

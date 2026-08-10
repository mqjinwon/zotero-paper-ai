import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { groundAnswerHighQuality } from "../../src/rag/grounding/pipeline";
import type { PaperSentenceRef } from "../../src/rag/grounding/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "../fixtures/grounding/sample-gold.json");

interface GoldCase {
  id: string;
  answer: string;
  goldSentenceId: string;
  language: string;
  mockTextEn?: string;
}

interface GoldFixture {
  paperSentences: PaperSentenceRef[];
  cases: GoldCase[];
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as GoldFixture;

describe("grounding gold skeleton", () => {
  for (const c of fixture.cases) {
    it(`${c.id}: mock pipeline locks gold sentence ${c.goldSentenceId}`, async () => {
      const gold = fixture.paperSentences.find(
        (s) => s.id === c.goldSentenceId,
      );
      assert.ok(gold, `gold sentence ${c.goldSentenceId}`);

      let step = 0;
      const llm = {
        complete: async () => {
          step++;
          if (step === 1) {
            return JSON.stringify({
              claims: [
                {
                  text: c.answer,
                  type: "method",
                  must_terms: [],
                  numbers: [],
                },
              ],
            });
          }
          if (step === 2) {
            return JSON.stringify({
              claims: [
                {
                  id: "c1",
                  text_en: c.mockTextEn || c.answer,
                  must_terms: [],
                  numbers: [],
                },
              ],
            });
          }
          return JSON.stringify({
            label: "support",
            sentence_id: c.goldSentenceId,
            confidence: 0.95,
          });
        },
      };

      const r = await groundAnswerHighQuality({
        answer: c.answer,
        paperSentences: fixture.paperSentences,
        llm,
        locate: async () => ({
          pageIndex: (gold!.pageStart ?? 1) - 1,
          pageLabel: String(gold!.pageStart ?? 1),
          rects: [[10, 20, 100, 40]],
          matchedText: gold!.text,
        }),
      });

      assert.equal(r.matched, 1, `matched for ${c.id}`);
      assert.ok(
        r.links[0]?.paperSentence.includes(gold!.text.slice(0, 24)) ||
          r.answer.includes("data-preview="),
      );
      assert.match(r.answer, /paperai-cite-phrase/);
      assert.match(
        r.answer,
        new RegExp(
          gold!.text.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ),
      );
    });
  }
});

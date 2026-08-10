import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rrfFuse } from "../../src/rag/grounding/rrf";

describe("rrfFuse", () => {
  it("boosts items that appear high in multiple lists", () => {
    // s2 appears in both lists (rank1 in a, rank0 in b) → highest RRF.
    // Plan fixture had s1/s2 symmetric ranks (equal scores); adjusted so multi-list wins clearly.
    const a = ["s1", "s2", "s3"];
    const b = ["s2", "s4", "s5"];
    const out = rrfFuse([a, b], 60);
    assert.equal(out[0].id, "s2");
    assert.ok(out.find((x) => x.id === "s1"));
    assert.ok(out.find((x) => x.id === "s4"));
  });
});

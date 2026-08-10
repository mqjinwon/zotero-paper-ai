import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claimsFromAnswerRules,
  parseClaimsJson,
} from "../../src/rag/grounding/claims";

describe("parseClaimsJson", () => {
  it("accepts valid claims array", () => {
    const claims = parseClaimsJson({
      claims: [
        {
          text: "MCP predicts mass-contact.",
          type: "method",
          must_terms: ["MCP"],
          numbers: [],
        },
      ],
    });
    assert.equal(claims.length, 1);
    assert.equal(claims[0].id, "c1");
    assert.equal(claims[0].mustTerms[0], "MCP");
    assert.equal(claims[0].textEn, claims[0].text); // filled later by normalize
  });

  it("drops empty text and caps maxClaims", () => {
    const claims = parseClaimsJson(
      {
        claims: [
          { text: "", type: "other" },
          { text: "A result finding here", type: "result" },
          { text: "B result finding there", type: "result" },
        ],
      },
      1,
    );
    assert.equal(claims.length, 1);
  });
});

describe("claimsFromAnswerRules", () => {
  it("builds claims from bullets", () => {
    const c = claimsFromAnswerRules(
      "- residual force learning helps\n- latency under 1 ms\n",
    );
    assert.ok(c.length >= 2);
    assert.match(c[0].text, /residual force/i);
  });
});

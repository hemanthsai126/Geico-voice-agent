import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchGeicoAutoKnowledge } from "../src/geicoKnowledge.js";

describe("GEICO knowledge search", () => {
  it("returns auto-insurance snippets for relevant questions", async () => {
    const results = await searchGeicoAutoKnowledge("What does collision coverage cover?");

    assert.ok(results.length > 0);
    assert.match(results[0].snippet.toLowerCase(), /collision|coverage/);
    assert.equal(results[0].retrievalMethod, "keyword");
  });

  it("returns no snippets for empty questions", async () => {
    const results = await searchGeicoAutoKnowledge("");

    assert.deepEqual(results, []);
  });
});

// The bench runner's attribution rule, pinned without the private store.
//
// Two mistakes were made on this ground, both by measuring the two sides of a
// comparison with different instruments: reporting the OLD rule with today's
// tokenizer, then attributing a pair to shared METADATA by comparing an
// old-tokenizer haystack against a new-tokenizer content set. These are the
// fixtures review used, so the pair stays honest without a store to read.
import { describe, expect, test } from "bun:test";
import {
  legacyContentTokens,
  legacyHaystackTokens,
  legacyWords,
} from "../../bench/lib/legacy-tokenizer.ts";
import { contentTokens, jaccard } from "../../src/recall/dedupe.ts";
import type { Memory } from "../../src/store/model/memory.ts";

function mem(scope: string, content: string): Memory {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    type: "context",
    scope,
    content,
    status: "settled",
    file: "",
    index: 0,
  };
}

describe("legacy tokenizer", () => {
  test("it splits on every delimiter except the underscore", () => {
    // Hyphens, slashes and spaces all contribute words; the underscore does
    // not. That is why "this store has no snake_case scope" was never an
    // exemption from scope vocabulary standing in for content.
    expect(legacyWords("alpha-bravo/charlie_delta delta echo")).toEqual([
      "alpha",
      "bravo",
      "charlie_delta",
      "delta",
      "echo",
    ]);
  });

  test("the haystack carries scope and type, the content set does not", () => {
    const m = mem("deploy", "restart the ingest worker");
    const hay = legacyHaystackTokens(m);
    const body = legacyContentTokens(m);
    expect(hay.has("deploy")).toBe(true);
    expect(hay.has("context")).toBe(true);
    expect(body.has("deploy")).toBe(false);
    expect(body.has("context")).toBe(false);
    expect([...body].every((t) => hay.has(t))).toBe(true);
  });

  test("attribution holds the tokenizer fixed, which is the whole point", () => {
    // Hyphenated against spaced. The old tokenizer splits both to the same six
    // words, so the CONTENT carries this pair and it is not metadata-driven.
    // Today's tokenizer keeps the hyphenated identifier whole, so scoring one
    // side with each instrument calls it metadata-driven at 0.667.
    const a = mem("fixture", "alpha-bravo charlie-delta echo-foxtrot");
    const b = mem("fixture", "alpha bravo charlie delta echo foxtrot");
    expect(jaccard(legacyContentTokens(a), legacyContentTokens(b))).toBe(1);
    expect(jaccard(contentTokens(a), contentTokens(b)).toFixed(3)).toBe(
      "0.667",
    );
  });
});

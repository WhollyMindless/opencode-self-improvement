// guided-rules POC (FINDINGS 2026-11-08 §4): the user's lines decide what is
// guided; the model phrases but cannot veto; a quote the user never wrote is
// refused, not silently stripped. Pure functions — the end-to-end path is
// covered in capture.test.ts.
import { describe, expect, test } from "bun:test";
import {
  findGuidedQuotes,
  mergeGuidedCandidates,
  normWs,
  validateGuidedQuotes,
} from "../src/capture/guided-rules.ts";
import type { CaptureCandidate } from "../src/capture/prompt.ts";

const T3_HINT =
  "One thing I know about this repo: the correct sales tax rate is 8.25% (0.0825), applied after discounts and rounded to cents at the end — the hidden suite encodes that, so if the code says otherwise, the code is what is broken.";

const T7_HINT =
  "One thing I know about this repo: the reorder rule is inclusive — reorder when available stock is at or below reorderPoint, i.e. AT the point itself, not only strictly below it. The hidden suite encodes that, so if the code says otherwise, the code is what is broken.";

describe("findGuidedQuotes", () => {
  test("a stated rate yields its verbatim sentence", () => {
    const q = findGuidedQuotes(`user: ${T3_HINT}`);
    expect(q).toHaveLength(1);
    expect(T3_HINT).toContain(q[0]!.slice(0, 40));
    expect(q[0]).toContain("8.25");
  });
  test("a rule stated without any number still qualifies (t7 class)", () => {
    const q = findGuidedQuotes(`user: ${T7_HINT}`);
    expect(q.length).toBeGreaterThan(0);
    expect(q[0]).toContain("reorder");
  });
  test("plain prose and job-scoped imperatives yield nothing", () => {
    expect(
      findGuidedQuotes("user: can you take a look at this repo please"),
    ).toEqual([]);
    expect(
      findGuidedQuotes("user: do not create a test directory here"),
    ).toEqual([]);
  });
  test("quotes are capped and stay verbatim substrings", () => {
    const long = `user: ${"x".repeat(500)} must be 42 ${"y".repeat(500)}.`;
    const q = findGuidedQuotes(long);
    expect(q.length).toBe(1);
    expect(q[0]!.length).toBeLessThanOrEqual(300);
    expect(normWs(long).includes(q[0]!)).toBe(true);
  });
  test("at most three quotes per pass", () => {
    const q = findGuidedQuotes(
      "the rate is 1.5%\nthe rate is 2.5%\nthe rate is 3.5%\nthe rate is 4.5%",
    );
    expect(q).toHaveLength(3);
  });
});

describe("mergeGuidedCandidates", () => {
  const base: CaptureCandidate = {
    type: "context",
    scope: "billing",
    content: "Checkout applies a sales tax rate of 8.25 percent.",
  };
  test("a model phrasing with the same number gains the quote and the flag", () => {
    const quote = "the correct sales tax rate is 8.25% (0.0825)";
    const out = mergeGuidedCandidates([quote], [{ ...base }]);
    // The model phrased the fact but left the flag off — the exact 5/7 miss
    // mode. The pre-pass cannot veto-proof the phrasing row alone, so the
    // deterministic fallback row carries the fact with the true quote.
    expect(out).toHaveLength(1);
    expect(out[0]!.guided).toBe(true);
    expect(out[0]!.original).toBe(quote);
    expect(out[0]!.content).toBe(base.content);
  });
  test("a guided model candidate with the verbatim quote keeps its phrasing", () => {
    const quote = "the correct sales tax rate is 8.25% (0.0825)";
    const out = mergeGuidedCandidates(
      [quote],
      [{ ...base, guided: true, original: quote }],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ ...base, guided: true, original: quote });
  });
  test("a guided model candidate matching on numbers gains the quote", () => {
    const quote = "the correct sales tax rate is 8.25% (0.0825)";
    const out = mergeGuidedCandidates([quote], [{ ...base, guided: true }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.original).toBe(quote);
  });
});

describe("validateGuidedQuotes", () => {
  const userText = "user: the correct sales tax rate is 8.25% (0.0825) today";
  test("a verbatim quote survives, normalised", () => {
    const { kept, refused } = validateGuidedQuotes(
      [
        {
          type: "context",
          scope: "billing",
          content: "Tax is stated as 8.25% by the user, per checkout rules.",
          guided: true,
          original: "the  correct   sales tax rate is 8.25%",
        },
      ],
      userText,
    );
    expect(refused).toEqual([]);
    expect(kept[0]!.original).toBe("the correct sales tax rate is 8.25%");
  });
  test("a paraphrase is refused, not stripped", () => {
    const { kept, refused } = validateGuidedQuotes(
      [
        {
          type: "context",
          scope: "billing",
          content: "The user says the tax rate equals eight and a quarter.",
          guided: true,
          original: "the tax rate equals eight and a quarter",
        },
      ],
      userText,
    );
    expect(kept).toEqual([]);
    expect(refused).toHaveLength(1);
  });
  test("a guided row with no quote is the model's own judgment and passes", () => {
    const { kept, refused } = validateGuidedQuotes(
      [
        {
          type: "learning",
          scope: "build",
          content: "The suite must run through bun, not npm, per the user.",
          guided: true,
        },
      ],
      userText,
    );
    expect(kept).toHaveLength(1);
    expect(refused).toEqual([]);
  });
});

// #409 dedup lane (RESULTS §17). The pass is off unless OPENCODE_MEMORY_DEDUP
// is set, so the first property is the one that matters for a release: with the
// flag unset, the window is byte-identical to the plain top-limit slice.
import { describe, expect, test } from "bun:test";
import {
  dedupeThreshold,
  dedupeWindow,
  jaccard,
} from "../src/recall/dedupe.ts";
import type { Memory } from "../src/store/model/memory.ts";

function mem(scope: string, content: string): Memory {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    type: "learning",
    scope,
    content,
    status: "settled",
    file: "",
    index: 0,
  };
}

const COPY_A = mem(
  "review",
  "pr-watch cursor 2026-11-04T11:15Z all nine admitted PRs quiet #277 #280 #281",
);
const COPY_B = mem(
  "review",
  "pr-watch cursor 2026-11-04T11:35Z all nine admitted PRs quiet #277 #280 #281",
);
const OTHER = mem(
  "review",
  "merge gate requires two approvals and a green bench comment",
);
const DISTANT = mem(
  "build",
  "pr-watch cursor 2026-11-04T11:15Z all nine admitted PRs quiet #277 #280 #281",
);

describe("dedupeThreshold", () => {
  test("unset or disabled means off", () => {
    expect(dedupeThreshold({})).toBe(0);
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "" })).toBe(0);
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "0" })).toBe(0);
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "nope" })).toBe(0);
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "1.5" })).toBe(0);
  });

  test("reads the flag", () => {
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "0.8" })).toBe(0.8);
  });
});

describe("dedupeWindow", () => {
  test("threshold 0 is the plain slice, in order", () => {
    const ranked = [OTHER, COPY_A, DISTANT, COPY_B];
    expect(dedupeWindow(ranked, 3, 0)).toEqual(ranked.slice(0, 3));
  });

  test("skips a near-copy and refills the window", () => {
    const ranked = [COPY_A, COPY_B, OTHER, DISTANT];
    const out = dedupeWindow(ranked, 3, 0.8);
    expect(out).toEqual([COPY_A, OTHER, DISTANT]);
    expect(out.length).toBe(3);
  });

  test("parallel wording in a different scope is not a duplicate", () => {
    const ranked = [COPY_A, DISTANT, OTHER];
    expect(dedupeWindow(ranked, 2, 0.8)).toEqual([COPY_A, DISTANT]);
  });

  test("drops nothing below the threshold", () => {
    const ranked = [OTHER, DISTANT, COPY_A];
    expect(dedupeWindow(ranked, 3, 0.95)).toEqual(ranked);
  });

  test("returns fewer rows rather than repeating one", () => {
    expect(dedupeWindow([COPY_A, COPY_B], 5, 0.8)).toEqual([COPY_A]);
  });

  test("jaccard is symmetric and 1 for identical text", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["a", "b"]);
    expect(jaccard(a, b)).toBe(1);
    expect(jaccard(a, new Set(["b", "c"]))).toBeCloseTo(1 / 3, 10);
  });
});

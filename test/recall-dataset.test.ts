// Dataset integrity gates for the published recall benchmark: the eval is only
// trustworthy if the data itself is consistent, deterministic, and leak-free
// (variant distractors carry a "note-" tag no query uses, so gold matching by
// content can never hit a variant).
import { describe, expect, test } from "bun:test";
import { buildStore, MEMORIES, QUERIES } from "../bench/recall-dataset.ts";

describe("recall dataset integrity", () => {
  test("memory ids are unique", () => {
    expect(new Set(MEMORIES.map((m) => m.id)).size).toBe(MEMORIES.length);
  });

  test("every query's gold exists; every memory is queried at least twice", () => {
    const ids = new Set(MEMORIES.map((m) => m.id));
    const goldCount = new Map<string, number>();
    for (const { gold } of QUERIES) {
      expect(ids.has(gold)).toBe(true);
      goldCount.set(gold, (goldCount.get(gold) ?? 0) + 1);
    }
    for (const m of MEMORIES) expect(goldCount.get(m.id) ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("no query text is a verbatim memory body (eval measures recall, not copy)", () => {
    for (const { q } of QUERIES) {
      for (const m of MEMORIES) expect(m.content).not.toBe(q);
    }
  });

  test("no query references the variant tag, so variant distractors are never gold", () => {
    for (const { q } of QUERIES) expect(q).not.toContain("note-");
  });

  test("buildStore is deterministic and sizes correctly", () => {
    const a = buildStore(200);
    const b = buildStore(200);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBe(200);
    // contents stay unique so content-based gold matching is unambiguous
    expect(new Set(a.map((m) => m.content)).size).toBe(200);
    // all authored memories survive into stores >= their count
    expect(buildStore(600).length).toBe(600);
  });

  test("content memory never leaks real home paths (synthetic dataset promise)", () => {
    for (const m of MEMORIES) expect(m.content).not.toMatch(/\/Users\/|\/home\/[\w-]/);
  });
});

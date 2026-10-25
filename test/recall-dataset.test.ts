// Dataset integrity gates for the published recall benchmark: the eval is only
// trustworthy if the data itself is consistent, deterministic, and leak-free
// (variant distractors carry a "note-" tag no query uses, so gold matching by
// content can never hit a variant).
import { describe, expect, test } from "bun:test";
import { buildStore, KEYWORDS, keywordsFor, MEMORIES, QUERIES } from "../bench/recall-dataset.ts";

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

// The `kw` arm is the only place in this benchmark where a human wrote extra
// text that helps the gold row win, so the authoring rule from
// bench/recall-dataset.ts is enforced mechanically: keywords are shaped like
// write-time aliases, they exist for every gold row, and none of them is the
// eval's own phrasing copied backwards.
describe("write-time keyword integrity (#40)", () => {
  test("every gold memory carries 3-5 keywords of its own", () => {
    for (const m of MEMORIES) {
      const kw = KEYWORDS[m.id];
      expect(kw, m.id).toBeDefined();
      expect(kw!.length, m.id).toBeGreaterThanOrEqual(3);
      expect(kw!.length, m.id).toBeLessThanOrEqual(5);
    }
  });

  test("no keyword set belongs to a memory that does not exist", () => {
    const ids = new Set(MEMORIES.map((m) => m.id));
    for (const id of Object.keys(KEYWORDS)) expect(ids.has(id), id).toBe(true);
  });

  test("each keyword is one clean indexable phrase (store caps apply)", () => {
    for (const [id, list] of Object.entries(KEYWORDS)) {
      for (const k of list) {
        expect(k.trim(), `${id}:${k}`).toBe(k);
        expect(k.length, `${id}:${k}`).toBeLessThanOrEqual(48);
        expect(/[^\x20-\x7e]/.test(k), `${id}:${k}`).toBe(false);
        expect(k, `${id}:${k}`).toBe(k.toLowerCase());
      }
      expect(new Set(list).size, id).toBe(list.length);
    }
  });

  test("a variant inherits its base memory's keywords (the bridge competes with equals)", () => {
    expect(keywordsFor("m07")).toBe(KEYWORDS.m07);
    expect(keywordsFor("m07#13")).toBe(KEYWORDS.m07);
    const variant = buildStore(200).find((m) => m.id.startsWith("m07#"));
    expect(variant).toBeDefined();
    expect(variant!.kw).toEqual(KEYWORDS.m07);
  });

  // NOTE on what these gates deliberately do NOT claim: a rule like "no keyword
  // may resemble a query" is unenforceable in the honest direction — a good
  // alias is *supposed* to be how someone would ask, and 15 of these sets do
  // collide with the eval's phrasing. Whether the gain comes from meaning or
  // from extra tokens is answered instead by the permutation control in
  // test/negative-eval.test.ts (every row gets someone else's aliases).
});

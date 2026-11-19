import { describe, expect, test } from "bun:test";
import { applyRefFixes, chainEnd } from "../scripts/ref-fixer.ts";
import { checkablePathRefs } from "../src/gate/resolver.ts";

// The rewrite edits the user's stored prose, so it is the dangerous half of
// ref-fixer. The contract these tests pin: a ref the gate does not CHECK must
// never be EDITED either. The gate is the only thing that could refuse a bad
// rewrite, and it cannot refuse what it does not look at.
describe("applyRefFixes", () => {
  test("a ref nested inside a longer ref is not rewritten twice", () => {
    const content = "see gate/gate.ts plus live src/gate/gate.ts for both";
    const out = applyRefFixes(
      content,
      new Map([["gate/gate.ts", "src/gate/gate.ts"]]),
    );
    expect(out).toBe(
      "see src/gate/gate.ts plus live src/gate/gate.ts for both",
    );
    expect(out).not.toContain("src/src/");
  });

  test("an absolute path is left byte-identical: the gate never checks it, so it could never refuse a mangle", () => {
    const content =
      "on the old box /Users/x/proj/src/lock.ts and here src/lock.ts";
    const out = applyRefFixes(
      content,
      new Map([["src/lock.ts", "src/store/lock.ts"]]),
    );
    expect(out).toBe(
      "on the old box /Users/x/proj/src/lock.ts and here src/store/lock.ts",
    );
  });

  test("a :line suffix stays attached to the new path", () => {
    const out = applyRefFixes(
      "the lock is held in src/lock.ts:42 by withStoreBatch",
      new Map([["src/lock.ts", "src/store/lock.ts"]]),
    );
    expect(out).toBe(
      "the lock is held in src/store/lock.ts:42 by withStoreBatch",
    );
  });

  test("URLs, env-rooted paths and bare filenames are untouched", () => {
    const content =
      "https://example.com/a/b.ts and $BUILD_ROOT/src/a.ts and undo.ts but real src/a.ts";
    const fixes = new Map([
      ["src/a.ts", "src/core/a.ts"],
      ["a/b.ts", "x/b.ts"],
      ["undo.ts", "src/store/undo.ts"],
    ]);
    expect(applyRefFixes(content, fixes)).toBe(
      "https://example.com/a/b.ts and $BUILD_ROOT/src/a.ts and undo.ts but real src/core/a.ts",
    );
  });

  test("every occurrence of a checked ref is rewritten", () => {
    const out = applyRefFixes(
      "src/lock.ts guards it; src/lock.ts is the only writer",
      new Map([["src/lock.ts", "src/store/lock.ts"]]),
    );
    expect(out).toBe(
      "src/store/lock.ts guards it; src/store/lock.ts is the only writer",
    );
  });

  test("an empty fix map returns the content unchanged", () => {
    const content = "nothing to do in src/lock.ts";
    expect(applyRefFixes(content, new Map())).toBe(content);
  });

  test("the rewrite only ever touches refs the gate itself reports", () => {
    const content = "gate/gate.ts and /abs/src/lock.ts and src/store/lock.ts";
    const checked = new Set(checkablePathRefs(content));
    expect(checked).toEqual(new Set(["gate/gate.ts", "src/store/lock.ts"]));
    const out = applyRefFixes(
      content,
      new Map([["gate/gate.ts", "src/gate/gate.ts"]]),
    );
    // Whatever comes out, the gate's own view of the string must still resolve:
    // no new unchecked shape was introduced for it to miss.
    expect(checkablePathRefs(out)).toEqual([
      "src/gate/gate.ts",
      "src/store/lock.ts",
    ]);
  });
});

describe("chainEnd", () => {
  const yes = (): boolean => true;
  test("no chain returns null", () => {
    expect(chainEnd("a.ts", new Map(), yes)).toBeNull();
  });
  test("a two-hop chain resolves to the end", () => {
    const m = new Map([
      ["src/hits.ts", "src/hits/ledger.ts"],
      ["src/hits/ledger.ts", "src/telemetry/ledger.ts"],
    ]);
    expect(chainEnd("src/hits.ts", m, yes)).toBe("src/telemetry/ledger.ts");
  });
  test("a cycle returns null rather than a wrong path", () => {
    const m = new Map([
      ["a/x.ts", "b/x.ts"],
      ["b/x.ts", "c/x.ts"],
      ["c/x.ts", "a/x.ts"],
    ]);
    expect(chainEnd("a/x.ts", m, yes)).toBeNull();
  });
  test("a chain whose end does not exist returns null: an intermediate is not a repair target", () => {
    const m = new Map([["a/x.ts", "b/x.ts"]]);
    expect(chainEnd("a/x.ts", m, () => false)).toBeNull();
  });
});

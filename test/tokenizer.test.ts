// Identifier tokenisation (#409, RESULTS §15).
//
// `words()` is the matcher's single vocabulary: the injection scorer, the
// credit attribution and the consolidation similarity all read it. It used to
// lowercase and split on `[^a-z0-9_]+`, which left `_` inside a token and never
// touched case — so `getUserAccount`, `get_user_account` and `get-user-account`
// were three unrelated tokens, and a memory citing a dotted config key or a
// path shared nothing with a session that typed it.
//
// The lane measured free harm reduction (wrong rows for no-gold queries 0.60 ->
// 0.44 per call at unchanged recall), so these tests pin the mechanism and the
// two edges that must NOT move: short tokens stay dropped, and plain prose
// tokenises exactly as before.
import { describe, expect, test } from "bun:test";
import { scoreMemories, words } from "../src/recall/score.ts";
import type { Memory } from "../src/store/model/memory.ts";

const mem = (content: string, over: Partial<Memory> = {}): Memory => ({
  ts: "2026-01-01T00:00:00.000Z",
  type: "learning",
  scope: "api",
  content,
  status: "settled",
  file: "",
  index: 0,
  ...over,
});

describe("identifier tokenisation (#409)", () => {
  test("every identifier spelling produces the same parts", () => {
    for (const id of [
      "getUserAccount",
      "get_user_account",
      "get-user-account",
      "get.user.account",
      "GET_USER_ACCOUNT",
    ])
      expect(words(id)).toEqual(["get", "user", "account"]);
  });

  test("an acronym run splits before its trailing word, not inside", () => {
    expect(words("HTTPServer")).toEqual(["http", "server"]);
  });

  test("a path is matchable by its components", () => {
    expect(words("src/recall/score.ts")).toEqual(["src", "recall", "score"]);
  });

  test("the short-token floor is unchanged", () => {
    expect(words("db name")).toEqual(["name"]);
  });

  test("plain prose tokenises exactly as before the change", () => {
    // "db" and "3" fall to the >2 floor, which the change does not touch.
    expect(words("Rate limiter reads from Redis DB 3.")).toEqual([
      "rate",
      "limiter",
      "reads",
      "from",
      "redis",
    ]);
  });

  test("a memory citing an identifier is found by a session that spells it out", () => {
    const rows = [
      mem("getUserAccount reads the row cache and falls back to postgres"),
      mem("release-please bumps versions on merge to main"),
    ];
    const top = scoreMemories("why does get user account return null", rows, 3);
    expect(top[0]).toBe(rows[0]);
  });

  test("and the same row is still found when the session types the identifier itself", () => {
    const rows = [
      mem("the cache key is built by get_user_account in the api layer"),
      mem("release-please bumps versions on merge to main"),
    ];
    const top = scoreMemories("getUserAccount cache key", rows, 3);
    expect(top[0]).toBe(rows[0]);
  });
});

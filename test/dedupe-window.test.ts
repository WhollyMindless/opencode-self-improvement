// #409 dedup lane (RESULTS §17). The pass is off unless OPENCODE_MEMORY_DEDUP
// is set, so the first property is the one that matters for a release: with the
// flag unset, the window is byte-identical to the plain top-limit slice. The
// rest pin the adversarial review's findings: a prohibition is never a copy of
// the permission it denies, rows with nothing to compare are never suppressed,
// a misconfigured threshold cannot turn the pass on, and the NEWEST copy of a
// clash survives (§17's adoption rule).
import { describe, expect, test } from "bun:test";
import {
  dedupeThreshold,
  dedupeWindow,
  jaccard,
  contentTokens,
} from "../src/recall/dedupe.ts";
import type { Memory } from "../src/store/model/memory.ts";

function mem(
  scope: string,
  content: string,
  ts = "2026-01-01T00:00:00.000Z",
): Memory {
  return {
    ts,
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
// The review's negation pair, widened so the shared prose alone clears 0.8:
// the prohibition must survive even when everything but `never` is identical.
const PERMIT = mem(
  "git",
  "when releasing from a shared branch force push main after rebasing the release tag onto the approved commit and announce the new head in the PR",
);
const PROHIBIT = mem(
  "git",
  "when releasing from a shared branch never force push main after rebasing the release tag onto the approved commit and announce the new head in the PR",
);

describe("dedupeThreshold", () => {
  test("unset or disabled means off", () => {
    expect(dedupeThreshold({})).toBe(0);
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "" })).toBe(0);
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "0" })).toBe(0);
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "nope" })).toBe(0);
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "1.5" })).toBe(0);
  });
  test("values below the floor are a misconfiguration, not an aggressive setting", () => {
    // At 1e-9 a single shared fragment suppressed rows.
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "1e-9" })).toBe(0);
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "0.3" })).toBe(0);
  });
  test("reads the flag", () => {
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "0.8" })).toBe(0.8);
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "0.5" })).toBe(0.5);
  });
});

describe("contentTokens", () => {
  test("type and scope are not tokens", () => {
    const t = contentTokens(mem("review", "merge gate approvals"));
    expect(t.has("review")).toBe(false);
    expect(t.has("learning")).toBe(false);
    expect(t.has("merge")).toBe(true);
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

  test("the newest copy of a clash survives, not the highest-ranked", () => {
    const older = mem("review", COPY_A.content, "2026-11-04T11:15:00.000Z");
    const newer = mem("review", COPY_B.content, "2026-11-04T11:35:00.000Z");
    // The stale row ranks first; the pass must return the fresh one.
    expect(dedupeWindow([older, newer], 2, 0.8)).toEqual([newer]);
  });

  test("a prohibition is not a copy of the permission it denies", () => {
    // Token sets differ only by `never`; without the polarity guard the pair
    // reaches Jaccard >= 0.8 and the prohibition is the one deleted.
    const out = dedupeWindow([PERMIT, PROHIBIT], 2, 0.8);
    expect(out).toEqual([PERMIT, PROHIBIT]);
  });

  test("rows differing only by a short numeric fact are not copies", () => {
    // Review #415: words() drops chunks of length <= 2, so "db 3" and "db 4"
    // leave identical token sets and the older row was suppressed through the
    // handler. Widened past the MIN_CONTENT floor so the short-chunk guard,
    // not the floor, is what keeps both rows.
    const db3 = mem(
      "redis",
      "the rate limiter reads its counters from redis db 3 with a five second eviction window",
    );
    const db4 = mem(
      "redis",
      "the rate limiter reads its counters from redis db 4 with a five second eviction window",
    );
    expect(jaccard(contentTokens(db3), contentTokens(db4))).toBe(1);
    expect(dedupeWindow([db3, db4], 2, 0.8)).toEqual([db3, db4]);
  });

  test("rows with no comparable content are never suppressed", () => {
    // Non-Latin prose tokenises to nothing under words(); the pre-floor version
    // scored two unrelated Chinese rows in one scope at 1.0 and deleted one.
    const cjk1 = mem("auth", "登录令牌在刷新后必须轮换并且旧令牌立即失效");
    const cjk2 = mem("auth", "数据库连接池的最大连接数应该根据并发量调整");
    expect(dedupeWindow([cjk1, cjk2], 2, 0.8)).toEqual([cjk1, cjk2]);
  });

  test("parallel wording in a different scope is not a duplicate", () => {
    const ranked = [COPY_A, DISTANT, OTHER];
    expect(dedupeWindow(ranked, 2, 0.8)).toEqual([COPY_A, DISTANT]);
  });

  test("the threshold boundary is pinned at a measured pair", () => {
    // 13 shared tokens, 4 unique between them: Jaccard 13/17 = 0.765.
    const base =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike";
    const a = mem("review", `${base} november oscar`);
    const b = mem("review", `${base} papa quebec`);
    expect(jaccard(contentTokens(a), contentTokens(b))).toBeCloseTo(
      13 / 17,
      10,
    );
    expect(dedupeWindow([a, b], 2, 0.8)).toEqual([a, b]); // kept at 0.8
    expect(dedupeWindow([a, b], 2, 0.7)).toEqual([a]); // suppressed at 0.7
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

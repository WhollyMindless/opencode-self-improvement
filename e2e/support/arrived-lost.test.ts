// Deterministic pins for the arrived-lost predicate, no host booted: the four
// attempt shapes the real-host retry can leave behind, fed as evidence lines
// to the same predicate the printed rate uses. `bun test ./e2e/` runs this
// next to the module it pins; the real-host file can only print an honest
// rate while these stay green.
import { describe, expect, test } from "bun:test";
import { formatLine, type Fields } from "../../src/core/logfmt/format.ts";
import { arrivedLostBetween } from "./arrived-lost.ts";

const TS = "2026-01-01T00:00:00.000Z";

const seen = (discard: string): string =>
  formatLine({ ts: TS, ev: "auto_capture_seen", session: "s1", discard });

const skipped = (reason: string): string =>
  formatLine({
    ts: TS,
    ev: "auto_capture_skipped",
    session: "s1",
    trigger: "idle",
    reason,
  });

const START = formatLine({ ts: TS, ev: "auto_capture_start", session: "s1" });

describe("arrived-lost classification", () => {
  test("attributed discards account for their own arrival", () => {
    for (const discard of ["cooldown", "no_sid"])
      expect(
        arrivedLostBetween([], [seen(discard)]),
        `discard=${discard} names why nothing followed, so it is not a loss`,
      ).toBe(false);
  });

  test("a deliberate skip accounts for the arrival before it", () => {
    expect(
      arrivedLostBetween([], [seen("none"), skipped("transcript_too_thin")]),
    ).toBe(false);
    // Order-independent: the trail is concatenated evidence files, not one
    // stream, so settlement must not depend on which line the reader saw first.
    expect(
      arrivedLostBetween([], [skipped("transcript_too_thin"), seen("none")]),
    ).toBe(false);
  });

  test("a start accounts for its arrival even without completion", () => {
    expect(arrivedLostBetween([], [seen("none"), START])).toBe(false);
  });

  test("only a proceeding arrival with nothing after it is a loss", () => {
    expect(arrivedLostBetween([], [seen("none")])).toBe(true);
  });

  test("an arrival already present in before does not count again", () => {
    expect(arrivedLostBetween([seen("none")], [seen("none")])).toBe(false);
  });

  test("text quoting the fields inside another value is not an arrival", () => {
    // The rule reads parsed fields, not whole lines: a line whose discard is
    // attributed must not count because some other field's text mentions the
    // losing shape.
    const decoy: Fields = {
      ts: TS,
      ev: "auto_capture_seen",
      session: "s1",
      discard: "cooldown",
      note: "discard=none, no start, no skip",
    };
    expect(arrivedLostBetween([], [formatLine(decoy)])).toBe(false);
  });

  test("paired trail: an intentional skip and a genuine loss count exactly 1", () => {
    // Two attempts on one trail, as the retry sees them: the first arrival is
    // settled by a deliberate skip, the second is the loss the counter exists
    // to expose. Summing the predicate over attempt boundaries is what the
    // real-host loop does with its counter.
    const t0: string[] = [];
    const t1 = [...t0, seen("none"), skipped("transcript_too_thin")];
    const t2 = [...t1, seen("none")];
    const classified = [arrivedLostBetween(t0, t1), arrivedLostBetween(t1, t2)];
    expect(classified).toEqual([false, true]);
    expect(classified.filter(Boolean).length).toBe(1);
  });
});

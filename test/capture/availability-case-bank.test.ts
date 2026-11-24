// The case bank, run where CI can actually see it.
//
// The bank lives in `bench/fixtures/availability-cases.ts` and the policy bench
// reports it. That is not enough: `.github/workflows/ci.yml` runs no bench at all,
// so a verdict that drifted would fail nothing but a command nobody is required to
// type. This file is the same cases, asserted, in the suite CI does run — about one
// second for all of them.
//
// One repo per distinct tracked passage, keyed by the bytes it tracks. Sharing
// one tree per CASE would let a candidate match a DIFFERENT case's line and
// report a verdict for the wrong reason; sharing one directory between cases
// whose tracked bytes are identical cannot, because the haystack is the same
// haystack. The spawn count, not the matcher, is what these tests spend.
//
// The reason is asserted as well as the verdict. The reason assertion
// found seven cases named for the declared-command branch sitting on README prose,
// so the text branch answered them and a mutation replacing `gateHit(...)` with a
// null gate left this file green. `expectReason` is what closes that, and the
// branch-coverage test at the bottom is what stops the whole branch disappearing.
import { expect, test } from "bun:test";
import {
  AVAILABILITY_CASES,
  type AvailabilityCase,
} from "../../bench/fixtures/availability-cases.ts";
import { indexFor } from "./availability-repo.ts";

function verdictFor(c: AvailabilityCase) {
  return indexFor(c.tree, c.files).check(c.candidate);
}

// One test per entry, so a failure names the case AND the case that found
// it. A single aggregate assertion would report "19/21" and leave the reader to
// find which veto moved.
for (const c of AVAILABILITY_CASES) {
  test(`availability: ${c.id}`, () => {
    const verdict = verdictFor(c);
    expect(
      verdict !== null,
      `${c.id}: ${c.source} — expected ${c.expectTag ? "a restatable verdict" : "no verdict (keep the row)"}, got ${verdict ? `${verdict.reason} matched [${verdict.matched}]` : "none"}`,
    ).toBe(c.expectTag);
    if (c.expectReason) {
      expect(
        verdict?.reason,
        `${c.id}: expected the ${c.expectReason} branch specifically — got ${verdict?.reason ?? "none"}, so this case is testing the other half of the check while carrying this name`,
      ).toBe(c.expectReason);
    }
    if (c.expectWhere) {
      expect(
        verdict?.where,
        `${c.id}: expected the refusal to cite [${c.expectWhere}] — got [${verdict?.where ?? "none"}], so the evidence line does not name every declaration this verdict rested on`,
      ).toBe(c.expectWhere);
    }
  });
}

// The bank's own shape. A bank of only "must tag" cases passes on a check that
// tags everything; one of only "must not" passes on a check that tags nothing.
test("the case bank can say both things", () => {
  const tags = AVAILABILITY_CASES.filter((c) => c.expectTag).length;
  const keeps = AVAILABILITY_CASES.filter((c) => !c.expectTag).length;
  expect(AVAILABILITY_CASES.length).toBeGreaterThanOrEqual(12);
  expect(tags).toBeGreaterThanOrEqual(3);
  expect(keeps).toBeGreaterThanOrEqual(6);
  expect(new Set(AVAILABILITY_CASES.map((c) => c.id)).size).toBe(
    AVAILABILITY_CASES.length,
  );
});

// The control that would have caught a blind bank without any of the above: the bank
// must actually reach BOTH branches. If `gateHit` is removed, or `parseGates`
// stops reading the manifests, no case returns `declared_gate` and this fails —
// where before it stayed green, because prose answered every gate case.
// Spawns, not matcher work: run alone, without the per-case tests warming the
// repo cache, this walks every case and builds a repo for each distinct set of
// tracked bytes.
test("the case bank reaches both branches of the check", () => {
  const reasons = AVAILABILITY_CASES.map((c) => verdictFor(c)?.reason).filter(
    (r): r is "in_tracked_file" | "declared_gate" => r !== undefined,
  );
  expect(
    reasons.filter((r) => r === "declared_gate").length,
    `no case produced a declared_gate verdict, so the gate branch is untested — ${reasons.length} verdicts, all from prose`,
  ).toBeGreaterThanOrEqual(2);
  expect(
    reasons.filter((r) => r === "in_tracked_file").length,
    "no case produced an in_tracked_file verdict",
  ).toBeGreaterThanOrEqual(2);
}, 120_000);

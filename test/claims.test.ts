// The cost-claim discipline (#392), enforced rather than hoped for.
//
// Three numbers were published and corrected inside one day, because a metric
// that silently undercounts by 93% still produces a plausible number and a
// plausible number gets quoted. "Be more careful" is not a fix. These tests are
// the fix: they run in CI on every push, they cost nothing, and they fail on the
// README text itself.
//
// What they hold:
//   1. the effectiveness section quotes exactly two results, each with n and seat;
//   2. no dollar figure and no token-saving sentence anywhere in the README;
//   3. "cheaper" appears only where an n, a seat and a metric share the line;
//   4. the rules themselves are written down where a contributor reads them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const README = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
const LINES = README.split("\n");

/** The section's own lines, up to the next `## ` heading. */
function section(heading: string): string[] {
  const start = LINES.findIndex((l) => l.startsWith(heading));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of LINES.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    out.push(line);
  }
  return out;
}

const WORTH = section("## What memory is worth, measured");

describe("the effectiveness section quotes exactly two results", () => {
  test("the section exists", () => {
    expect(WORTH.length).toBeGreaterThan(5);
  });

  test("transport: floor and seeded result, with n", () => {
    const text = WORTH.join("\n");
    expect(text).toContain("Transport");
    expect(text).toContain("0/5");
    expect(text).toContain("5/5");
    expect(text).toContain("5 per arm");
    // The floor is the result. A transport claim without it is not transport.
    expect(text.toLowerCase()).toContain("empty store");
  });

  test("reuse: the neutral median, with n", () => {
    const text = WORTH.join("\n");
    expect(text).toContain("Reuse");
    expect(text).toContain("0.98");
    expect(text).toContain("6 pairs");
  });

  test("the seat is named inside the section", () => {
    // Without a seat these are adjectives, not measurements.
    expect(WORTH.join("\n")).toMatch(/evo\/[A-Za-z0-9.\-_]+/);
  });

  test("exactly two result rows — a third claim has to move this test first", () => {
    const rows = WORTH.filter((l) =>
      /^\|\s*\*\*(Transport|Reuse)\.\*\*/.test(l),
    );
    expect(rows.length).toBe(2);
    // And nothing else in the section pretends to be a measured result row.
    const dataRows = WORTH.filter(
      (l) => /^\|\s*[^|\s-]/.test(l) && !/^\|\s*Result/.test(l),
    );
    expect(dataRows.length).toBe(2);
  });
});

describe("no cost claim the corrected metric cannot support", () => {
  test("no dollar figure anywhere in the README", () => {
    // A local seat has no cache price. Any dollar figure in this file is either
    // hosted-provider-measured (none exists) or invented.
    const hits = LINES.filter((l) => /\$\s?\d/.test(l));
    expect(hits).toEqual([]);
  });

  test("no sentence asserts a token saving", () => {
    const pattern =
      /(\d+(?:\.\d+)?\s?%\s*(?:fewer|less|cheaper|reduction|drop)\s+(?:input\s+)?tokens)|(saves?\s+[\d,.]+\s+tokens)|(tokens?\s+(?:saved|reduced))/i;
    const hits = LINES.filter((l) => pattern.test(l));
    expect(hits).toEqual([]);
  });

  test("a percentage is never attached to tokens without saying bytes", () => {
    // "12.3% fewer characters" is a byte measurement and must stay labelled as
    // one: bytes on a deterministic workload are not tokens and not a bill.
    const hits = LINES.filter(
      (l) =>
        /\d+(?:\.\d+)?%\s*(?:fewer|less)\b/.test(l) &&
        /token/i.test(l) &&
        !/not tokens|bytes/i.test(l),
    );
    expect(hits).toEqual([]);
  });
});

describe("the word cheaper carries its evidence", () => {
  // The rules list is allowed to NAME the words it bans; that is the only
  // exemption, and it is anchored to the rules heading rather than to a comment
  // a future editor can sprinkle anywhere.
  const rulesStart = LINES.findIndex((l) =>
    l.includes("**Rules for any cost claim"),
  );

  test("the rules list exists, so the exemption has an anchor", () => {
    expect(rulesStart).toBeGreaterThan(0);
  });

  test("every other line with 'cheaper' names an n, a seat and a metric", () => {
    const offenders: string[] = [];
    LINES.forEach((line, i) => {
      if (!/cheaper/i.test(line)) return;
      if (i >= rulesStart && i <= rulesStart + 8) return;
      const hasN = /\bn\s*[=≥>]\s*\d|n=\d+\s*pairs|\dn\b.{0,20}pairs/i.test(
        line,
      );
      const hasSeat = /seat|evo\/|llama|hosted provider/i.test(line);
      const hasMetric = /work\s*=|generation|uncached|cache read|metric/i.test(
        line,
      );
      if (!(hasN && hasSeat && hasMetric))
        offenders.push(`${i + 1}: ${line.slice(0, 90)}`);
    });
    expect(offenders).toEqual([]);
  });
});

describe("the rules are written down where contributors hit them", () => {
  test("the n floor is stated", () => {
    expect(WORTH.join("\n")).toMatch(/n=6 pairs per arm|n\s*=\s*6 pairs/);
  });

  test("the resolution label is stated", () => {
    expect(WORTH.join("\n")).toContain("20% resolution");
  });

  test("cache state is named as a confounder, because that is what produced the worst claim", () => {
    // #365's 20,506 -> 10,009 "saving" was two runs in different cache states.
    expect(WORTH.join("\n").toLowerCase()).toContain("cache state");
  });

  test("the corrected metric is defined in words, not implied", () => {
    expect(WORTH.join("\n")).toContain(
      "session generation + capture generation",
    );
  });
});

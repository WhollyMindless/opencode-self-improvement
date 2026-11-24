// The whole-assertion contract, pinned by sweep rather than by example.
//
// A refusal claims the tree states the row. Containment alone cannot prove
// that: a row's claim is always no longer than the tree's sentence, so every
// row that drops material scoping over the span it matched — a condition, a
// frequency, the `not` of a prohibition whose cue it replaced with one of its
// own — passed as a restatement, and a refusal destroys the fact. Examples
// pinned single sentences; the defect lived in the relation between two, so a
// maintainer could re-open it without failing anything in the file's own
// vocabulary. This file pins the relation: for every tracked passage in the
// case bank, NO proper word-substring of a sentence is refused as
// `in_tracked_file` unless it states that sentence — every non-FILLER word of
// the sentence present in the substring. Verbatim controls must keep
// refusing: a sweep that passes by refusing nothing is a dead matcher.
//
// The whitelist the allowance consults is the matcher's own `FILLER`. A build
// that does not export it is read as exporting none, and the pin then demands
// exact sentence equality — which the old containment rule cannot meet, so
// the pin fails on the defect instead of loading past it.
import { expect, test } from "bun:test";
import { AVAILABILITY_CASES } from "../../bench/fixtures/availability-cases.ts";
import * as available from "../../src/capture/available.ts";
import { indexFor } from "./availability-repo.ts";

const FILLER: Set<string> =
  (available as { FILLER?: Set<string> }).FILLER ?? new Set<string>();

/** Mirrors `norm()`: the haystack is the tree normalised, so the sweep's
 * sentences and substrings are built from the text the matcher actually sees.
 * A newline survives only as a hard break — blank line, terminated line, or
 * block marker — exactly as `norm()` decides; the wrapped-prose fixtures pin
 * that model itself, so the mirror cannot quietly agree with a wrong one. */
function normTree(s: string): string {
  const lower = s.toLowerCase().replace(/[*_`]/g, "");
  return lower
    .replace(/\s+/g, (run, offset) => {
      if (!run.includes("\n")) return " ";
      if ((run.match(/\n/g) ?? []).length > 1) return "\n";
      const prev = lower.charCodeAt(offset - 1);
      if (prev === 46 || prev === 59 || prev === 58) return "\n";
      const next = lower[offset + run.length];
      if (next === "#" || next === "-" || next === ">" || next === "|")
        return "\n";
      return " ";
    })
    .trim();
}

/** The assertion edges the coverage test walks on: `. ; :` and the newline.
 * Not the comma — an antecedent before a comma scopes over what follows it. */
function sentencesOf(normalised: string): string[] {
  return normalised
    .split(/[.;:\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The words that carry a claim, split the way `statesClaim` splits. */
function claimWords(text: string): string[] {
  return text.split(/[^a-z0-9']+/).filter((w) => w !== "" && !FILLER.has(w));
}

// One repo per distinct tracked passage, shared with the case bank: the sweep
// is a README-only path and the matcher is deterministic over the same bytes,
// so a second repo for an identical passage costs two `git` spawns and proves
// nothing the first did not.
//
// The timeout is for the spawns, not the matcher: the sweep builds one repo
// per distinct passage and then sweeps every proper substring in memory, and a
// Windows runner spends well over 200 ms per `git init` plus `git add`. The
// default 20 s budget measured short there at 89 repos.
test("no proper substring of a tracked sentence is refused unless it states that sentence", () => {
  const seen = { substrings: 0, refused: 0 };
  const swept = new Set<string>();
  for (const c of AVAILABILITY_CASES) {
    if (swept.has(c.tree)) continue;
    swept.add(c.tree);
    const index = indexFor(c.tree);
    const sentences = sentencesOf(normTree(c.tree));
    for (const sentence of sentences) {
      const words = sentence.split(" ").filter(Boolean);
      for (let i = 0; i < words.length; i++) {
        for (let j = i; j < words.length; j++) {
          if (i === 0 && j === words.length - 1) continue;
          const sub = words.slice(i, j + 1).join(" ");
          seen.substrings++;
          const verdict = index.check(sub);
          if (verdict === null) continue;
          seen.refused++;
          const nf = claimWords(sub);
          const statesASentence = sentences.some(
            (s) =>
              claimWords(s).length === nf.length &&
              claimWords(s).every((w, k) => w === nf[k]),
          );
          expect(
            statesASentence,
            `${c.id}: substring [${sub}] of sentence [${sentence}] was refused as ${verdict.reason} citing [${verdict.matched}], but it drops a claiming word from every sentence of its tree — only FILLER may be dropped from a refusal`,
          ).toBe(true);
        }
      }
    }
  }
  // The sweep must actually have run, and must actually have met refusals it
  // allowed (the verbatim-minus-FILLER shapes), or it proves nothing.
  expect(seen.substrings).toBeGreaterThan(500);
  expect(seen.refused).toBeGreaterThan(0);
}, 120_000);

test("an empty or whitespace-only candidate is kept, not refused on a vacuous match", () => {
  const index = indexFor("Rebuild the index weekly.\n");
  expect(index.check("")).toBeNull();
  expect(index.check("   ")).toBeNull();
  expect(index.check("\n \t\n")).toBeNull();
  // Control: the same index still refuses the restatement it should.
  expect(index.check("Rebuild the index weekly.")?.reason).toBe(
    "in_tracked_file",
  );
});

test("a refusal cites every claim it credited, not only the first", () => {
  const index = indexFor("The pool size is 8: the timeout is 30 seconds.\n");
  const verdict = index.check("The pool size is 8: the timeout is 30 seconds.");
  expect(verdict?.reason).toBe("in_tracked_file");
  expect(String(verdict?.matched)).toContain("pool size");
  expect(String(verdict?.matched)).toContain("timeout");
});

test("a multi-line verbatim restatement of a multi-line passage is refused", () => {
  const index = indexFor(
    "Staging export pool: cobalt.\nProduction export pool: ask operations.\n",
  );
  expect(
    index.check("Staging export pool: cobalt. Production export pool: ask ops.")
      ?.reason,
  ).toBeUndefined();
  expect(
    index.check(
      "Staging export pool: cobalt. Production export pool: ask operations.",
    )?.reason,
  ).toBe("in_tracked_file");
});

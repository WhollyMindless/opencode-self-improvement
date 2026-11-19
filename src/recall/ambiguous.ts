// The render side of an additive clash: `dedupeWindowGrouped` keeps both rows
// and reports the pair, and this names WHY the reader is seeing two rows that
// look alike. Without it the pass has silently swapped one wrong deletion for an
// unexplained duplicate, which is harder to debug than either.
//
// Shape follows `conflictLine` in ./conflicts.ts — both facts, the evidence, an
// Action — with one deliberate difference: a CONFLICT verdict is fixed by its
// class, and this one is not. The reader chooses, because the distinction that
// decided it (a second thing versus a corrected thing) is visible in the token
// sets but not in the prose.
import type { Memory } from "../store/model/memory.ts";
import { flattenMemoryText } from "../store/sanitize.ts";
import { contentTokens } from "./dedupe.ts";

/**
 * Cap on each token list. A pair that reaches the threshold while differing
 * widely would otherwise dump most of its vocabulary into the result; the cap
 * keeps the line readable and the count tells the reader what was withheld.
 */
export const MAX_MARKER_TOKENS = 6;

function leftovers(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((t) => !b.has(t));
}

function list(tokens: string[]): string {
  const shown = tokens.slice(0, MAX_MARKER_TOKENS);
  const held = tokens.length - shown.length;
  return `${shown.join(", ")}${held > 0 ? ` (+${held} more)` : ""}`;
}

/**
 * One line, naming each row by its 1-based position in the returned window.
 * The scope is store text and is flattened like every other rendered field: one
 * row is one line, so a stored newline cannot forge a section here either.
 */
export function ambiguousLine(
  a: Memory,
  b: Memory,
  posA: number,
  posB: number,
): string {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  const onlyA = leftovers(ta, tb);
  const onlyB = leftovers(tb, ta);
  const sides: string[] = [];
  if (onlyA.length) sides.push(`only in ${posA}: ${list(onlyA)}`);
  if (onlyB.length) sides.push(`only in ${posB}: ${list(onlyB)}`);
  return (
    `AMBIGUOUS (${flattenMemoryText(a.scope)}): rows ${posA} and ${posB} share ` +
    `shape but neither restates the other${sides.length ? ` — ${sides.join("; ")}` : ""}. ` +
    `Action: neither supersedes the other. Pick by what you are actually doing; ` +
    `if both apply, use both.`
  );
}

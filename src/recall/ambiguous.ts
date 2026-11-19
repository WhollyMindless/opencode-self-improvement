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

function list(tokens: string[]): string {
  const shown = tokens.slice(0, MAX_MARKER_TOKENS);
  const held = tokens.length - shown.length;
  return `${shown.join(", ")}${held > 0 ? ` (+${held} more)` : ""}`;
}

/**
 * One line for one additive family, naming each member by its 1-based position
 * in the returned window. A family is however many rows the pass kept together,
 * so the line count tracks the number of unexplained groups rather than the
 * number of pairs inside them: five mutually additive rows are one line, not
 * ten. The scope is store text and is flattened like every other rendered
 * field: one row is one line, so a stored newline cannot forge a section here
 * either.
 */
export function ambiguousLine(members: Memory[], positions: number[]): string {
  const sets = members.map((m) => contentTokens(m));
  // Each side lists what THAT member has that none of the others have, so a
  // nested chain prints one side rather than one per member: every row but the
  // largest is wholly contained in the union of the rest. The line therefore
  // grows with the vocabulary of the family, not with its size.
  const sides: string[] = [];
  sets.forEach((t, i) => {
    const others = new Set<string>();
    sets.forEach((o, j) => {
      if (j !== i) for (const tok of o) others.add(tok);
    });
    const only = [...t].filter((tok) => !others.has(tok));
    if (only.length) sides.push(`only in ${positions[i]}: ${list(only)}`);
  });
  const where =
    positions.length === 2
      ? `rows ${positions[0]} and ${positions[1]}`
      : `rows ${positions.slice(0, -1).join(", ")} and ${positions[positions.length - 1]}`;
  const rest =
    positions.length === 2
      ? "neither restates the other"
      : "none restates the others";
  return (
    `AMBIGUOUS (${flattenMemoryText(members[0]!.scope)}): ${where} share ` +
    `shape but ${rest}${sides.length ? ` — ${sides.join("; ")}` : ""}. ` +
    `Action: neither supersedes the other. Pick by what you are actually doing; ` +
    `if both apply, use both.`
  );
}

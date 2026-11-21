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
import { cmpTs } from "../core/cmp-ts.ts";

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
 * Whether the newest member of a family drops tokens an older member carries.
 *
 * Containment alone cannot tell the two situations apart: "the longer row adds a
 * second case" and "the newer row corrected the older one" produce the same pair
 * of token sets, and the marker used to resolve that in one direction for both.
 * Recency does discriminate. A newer row that is wholly contained in an older
 * one removed something, and a removal is exactly what a correction looks like.
 *
 * Returns null when the newest row cannot be identified — a family sharing one
 * timestamp carries no direction, and guessing would be worse than the neutral
 * instruction.
 */
function droppedByNewest(
  members: Memory[],
  sets: Set<string>[],
): { newest: number; sources: number[]; tokens: string[] } | null {
  let newest = 0;
  for (let i = 1; i < members.length; i++)
    if (cmpTs(members[i]!.ts, members[newest]!.ts) > 0) newest = i;
  if (
    members.some(
      (m, i) => i !== newest && cmpTs(m.ts, members[newest]!.ts) === 0,
    )
  )
    return null;
  const now = sets[newest]!;
  const sources: number[] = [];
  const tokens: string[] = [];
  sets.forEach((o, i) => {
    if (i === newest || o.size <= now.size) return;
    if (![...now].every((t) => o.has(t))) return;
    sources.push(i);
    for (const t of o) if (!now.has(t) && !tokens.includes(t)) tokens.push(t);
  });
  return tokens.length ? { newest, sources, tokens } : null;
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
  const rowsLabel = (idx: number[]): string =>
    idx.length === 1
      ? `row ${positions[idx[0]!]}`
      : `rows ${idx
          .slice(0, -1)
          .map((i) => positions[i])
          .join(", ")} and ${positions[idx[idx.length - 1]!]}`;
  const where = rowsLabel(positions.map((_, i) => i));
  const rest =
    positions.length === 2
      ? "neither restates the other"
      : "none restates the others";
  // Two readings fit the same token sets, and they need opposite instructions.
  // When the newest row is the one that left something out, saying "neither
  // supersedes the other" states as fact the one thing the text cannot
  // establish, so the line names the removal and leaves the verdict open.
  const drop = droppedByNewest(members, sets);
  const action = drop
    ? `Action: ${rowsLabel([drop.newest])} drops ${list(drop.tokens)} from ${rowsLabel(drop.sources)} — ` +
      `that may be a correction rather than a narrower case. Verify which before ` +
      `relying on either; both stay available.`
    : `Action: neither supersedes the other. Pick by what you are actually doing; ` +
      `if both apply, use both.`;
  return (
    `AMBIGUOUS (${flattenMemoryText(members[0]!.scope)}): ${where} share ` +
    `shape but ${rest}${sides.length ? ` — ${sides.join("; ")}` : ""}. ` +
    action
  );
}

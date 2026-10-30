// The tokenizer moved out of gates.ts verbatim so the rejection-sketch
// (tombstones.ts) scores similarity with EXACTLY the same notion of a "token"
// the write gates use. One definition on purpose: if the two ever disagreed, a
// near-match could be claimed in one place and denied in the other, and the
// reason a write was refused would stop being reproducible.
//
// Deliberately its own module rather than exported from gates.ts, because
// gates.ts now depends on tombstones.ts — a shared leaf keeps that one-way.

// Filler words that carry no claim. Used where a score must not be diluted by
// prose glue (delta-token selection in gates.ts; the rejection sketch in
// tombstones.ts, which filters them so a stopword-heavy rewording of a rejected
// value still matches it). NOT used by tokens() itself: GATE-3's rivalry floors
// have always scored on the unfiltered token set, and this move preserves that.
export const STOPWORDS: ReadonlySet<string> = new Set([
  "use",
  "using",
  "the",
  "a",
  "an",
  "in",
  "of",
  "to",
  "with",
  "on",
  "and",
  "or",
  "for",
  "is",
  "are",
]);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.]+/)
    .filter((t) => t.length > 0);
}

// Case-preserving tokens, for reporting asserted values back to the user.
export function rawTokens(text: string): string[] {
  return text.split(/[^A-Za-z0-9_.]+/).filter(Boolean);
}

export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

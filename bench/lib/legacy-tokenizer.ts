// The tokenizer as it shipped before `fc59b84`, vendored from
// `git show 3ff96ef:src/recall/score.ts`.
//
// A bench arm that reports what the OLD rule did has to score with the OLD
// tokenizer. Today's `words()` emits one token the old one never did — the whole
// identifier form — which shifts every short-row score by one token in both the
// numerator and the denominator.
//
// This lives in its own module rather than inside a runner because attribution
// is the second trap on the same ground: comparing an old-tokenizer haystack
// against a new-tokenizer content set calls a pair "metadata-driven" because the
// measurement changed between the two sides. Both sides come from here, so a
// test can pin that they are the same tokenizer.
import type { Memory } from "../../src/store/model/memory.ts";

export function legacyWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 2);
}

/** The historical haystack: scope, type, content and keywords. */
export function legacyHaystackTokens(m: Memory): Set<string> {
  return new Set(
    legacyWords(
      `${m.scope} ${m.type} ${m.content}${m.kw?.length ? ` ${m.kw.join(" ")}` : ""}`,
    ),
  );
}

/**
 * The same row minus `scope` and `type`, with the SAME tokenizer. Subtracting
 * this from `legacyHaystackTokens` is what "metadata carried it over the line"
 * means; mixing tokenizers across the subtraction is the error this module
 * exists to prevent.
 */
export function legacyContentTokens(m: Memory): Set<string> {
  return new Set(
    legacyWords(`${m.content}${m.kw?.length ? ` ${m.kw.join(" ")}` : ""}`),
  );
}

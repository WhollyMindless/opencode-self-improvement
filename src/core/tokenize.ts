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
  const lower = text.toLowerCase();
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i <= lower.length; i++) {
    const word = i < lower.length && isWordChar(lower.charCodeAt(i));
    if (word && start < 0) start = i;
    else if (!word && start >= 0) {
      out.push(lower.slice(start, i));
      start = -1;
    }
  }
  return out;
}

/** Ordered, case-sensitive atoms of a simple literal command. Shell syntax
 * outside this subset does not supply an argument vector. */
export function literalCommandArgs(text: string): string[] | null {
  const command = text.trim();
  if (!command || /[^-A-Za-z0-9_.@:/+=, \t]/.test(command)) return null;
  return command.split(/[ \t]+/);
}

// ---------------------------------------------------------------------------
// One figure grammar, stated once.
//
// A figure is a word run that carries a digit — `30`, `3.12`, `9ae0998`,
// `1,024` — where `.` and `,` belong to the run only while the run keeps
// reading as a number: a separator joins when a digit sits on each side
// (`1,024`, `1.4.3`), and a `.` that merely ends a sentence is prose, not the
// tail of the figure (`1.5.` states `1.5`). `tokens()` alone is not this: it
// splits `1,024` at the comma and glues the sentence dot of `1.5.` onto the
// figure, and a matcher that reads those two edges differently in two places
// will refuse a truncation of `1` as a restatement of `1,024` while keeping a
// verbatim restatement of `1.5`. Every decision about where a figure begins or
// ends — the availability matcher's claim splitter, its hit-coverage veto and
// the figure-subset check below — reads `figureExtent`, so the edges cannot
// drift apart.
// ---------------------------------------------------------------------------

const CODE_COMMA = 44;
const CODE_DOT = 46;
const CODE_ZERO = 48;
const CODE_NINE = 57;
const CODE_UPPER_A = 65;
const CODE_UPPER_Z = 90;
const CODE_LOWER_A = 97;
const CODE_LOWER_Z = 122;
const CODE_UNDERSCORE = 95;

function isDigit(code: number): boolean {
  return code >= CODE_ZERO && code <= CODE_NINE;
}

/** A character `tokens()` keeps inside a token: a digit, a letter, `_` or `.`.
 *  This char class IS the split rule — `tokens()` splits wherever it is false. */
export function isWordChar(code: number): boolean {
  return (
    isDigit(code) ||
    (code >= CODE_LOWER_A && code <= CODE_LOWER_Z) ||
    (code >= CODE_UPPER_A && code <= CODE_UPPER_Z) ||
    code === CODE_UNDERSCORE ||
    code === CODE_DOT
  );
}

/** Does the `,` at `i` join two digits, making `1,024` one figure? */
function joinsDigits(text: string, i: number): boolean {
  return (
    text.charCodeAt(i) === CODE_COMMA &&
    i > 0 &&
    i + 1 < text.length &&
    isDigit(text.charCodeAt(i - 1)) &&
    isDigit(text.charCodeAt(i + 1))
  );
}

function isRunChar(text: string, i: number): boolean {
  return isWordChar(text.charCodeAt(i)) || joinsDigits(text, i);
}

/**
 * The extent of the figure at `pos`, or null when `pos` is not part of one.
 * A figure is the maximal run of word characters around `pos` — joined across
 * a `,` between digits — that carries a digit, with the dots of a sentence
 * ending trimmed: `1,024`, `1.4.3` and `9ae0998` are figures; the `.` that
 * closes `The ratio is 1.5.` is not part of one, so the extent of the run at
 * that dot is `1.5`, not `1.5.`.
 */
export function figureExtent(
  text: string,
  pos: number,
): { start: number; end: number } | null {
  if (pos < 0 || pos >= text.length || !isRunChar(text, pos)) return null;
  let start = pos;
  while (start > 0 && isRunChar(text, start - 1)) start--;
  let end = pos + 1;
  while (end < text.length && isRunChar(text, end)) end++;
  while (end > start && text.charCodeAt(end - 1) === CODE_DOT) end--;
  if (end === start) return null;
  for (let i = start; i < end; i++)
    if (isDigit(text.charCodeAt(i))) return { start, end };
  return null;
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

// ---------------------------------------------------------------------------
// The two things token overlap cannot see.
//
// The rejection sketch decides "same statement reworded" from shared tokens, and
// for the two shapes below that judgement is wrong in the same direction — it
// scores a CORRECTION higher than a rewording:
//
//   "retains audit records for 30 days" -> "…for 90 days"      sketch 0.800
//   "must enable anonymous access"      -> "…must disable …"   sketch 0.778
//   (a genuine rewording measures 0.500-0.615)
//
// So the sketch alone can never separate them: the pairs above are not lower
// scoring, they are different. What separates them is that a load-bearing VALUE
// moved, so the two value dimensions are extracted here and the tombstone keeps
// one per row. Both are word-level and closed-vocabulary on purpose: this is not
// an attempt to understand a claim, only to notice when the words that carry its
// number or its sign are not the same words.
// ---------------------------------------------------------------------------

/** Every figure a statement asserts, deduped, sorted and canonical: the
 *  quantities, versions, ids and durations carried by `figureExtent` runs,
 *  with grouping commas removed so `1,024` reads as `1024` and a sentence dot
 *  excluded so `1.5.` reads as `1.5`. Two texts state the same figure exactly
 *  when their canonical values match; a figure cannot be assembled out of
 *  separate integers because only a run the text itself states is read. A
 *  change here is a different fact, not a rephrasing. */
export function numericTokens(text: string): string[] {
  const lower = text.toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < lower.length; ) {
    // A digit anchors the whole run, including any identifier prefix.
    const ext = isDigit(lower.charCodeAt(i)) ? figureExtent(lower, i) : null;
    if (ext === null) {
      i++;
      continue;
    }
    out.add(lower.slice(ext.start, ext.end).replace(/,/g, ""));
    i = Math.max(ext.end, i + 1);
  }
  return [...out].sort();
}

export const POL_POS = "pos";
export const POL_NEG = "neg";

// Antonym stems whose opposition is unambiguous: flipping one turns the statement
// into a different fact. Deliberately no open-ended stemming and no generic
// comparatives ("more"/"less") or particles ("on"/"off") — those appear in
// ordinary prose, and a spurious sign is the expensive error: it releases a value
// a human rejected. (A sign that is merely ABSENT leaves the sketch to decide,
// which is the shipped behaviour.)
const POLARITY: ReadonlyMap<string, string> = new Map<string, string>(
  [
    ["enable enables enabled enabling", "disable disables disabled disabling"],
    [
      "allow allows allowed allowing",
      "deny denies denied denying disallow disallows disallowed",
    ],
    [
      "permit permits permitted permitting",
      "refuse refuses refused refusing forbid forbids forbidden prohibit prohibits prohibited prohibiting",
    ],
    ["accept accepts accepted accepting", "reject rejects rejected rejecting"],
    [
      "include includes included including",
      "exclude excludes excluded excluding",
    ],
    ["add adds added adding", "remove removes removed removing"],
    [
      "start starts started starting begin begins began beginning",
      "stop stops stopped stopping halt halts halted halting cease ceases ceased ceasing",
    ],
    [
      "require requires required requiring",
      "waive waives waived waiving exempt exempts exempted exempting",
    ],
    ["keep keeps kept keeping", "drop drops dropped dropping"],
    ["true", "false"],
    ["always", "never"],
  ].flatMap(([pos, neg]) => [
    ...pos.split(" ").map((w) => [w, POL_POS] as [string, string]),
    ...neg.split(" ").map((w) => [w, POL_NEG] as [string, string]),
  ]),
);

// Words that reverse the claim word after them. `tokens()` splits apostrophes
// away, so "doesn't" arrives as "doesn" + "t" and the contraction stem is the
// token to match. "never" is both a negator and a NEG term in its own right.
const NEGATORS: ReadonlySet<string> = new Set([
  "not",
  "no",
  "never",
  "without",
  "cannot",
  "nor",
  "none",
  "doesn",
  "didn",
  "don",
  "isn",
  "aren",
  "wasn",
  "weren",
  "shouldn",
  "wouldn",
  "couldn",
  "hasn",
  "haven",
  "hadn",
  "mustn",
  "wont",
]);

// Copula/auxiliaries keep a negation alive across them: "must not be enabled" is
// still a prohibition. Any other word ends the window.
const NEGATION_SPAN: ReadonlySet<string> = new Set([
  "be",
  "been",
  "being",
  "is",
  "are",
  "am",
  "was",
  "were",
  "do",
  "does",
  "did",
  "to",
]);

/**
 * The set of polarity signs a statement asserts, deduped and sorted, so `["pos"]`
 * means it asserts something permitted/active/affirmative, `["neg"]` the opposite,
 * `["neg","pos"]` both, and `[]` that it asserts neither.
 *
 * Signs carry NO word identity, and that is what makes the signature safe to use
 * as a veto: "enable", "allow" and "permit" all reduce to `pos`, so restating a
 * rejected instruction with a synonym is still the same claim, while
 * enable↔disable cannot be mistaken for one. "not enable" reduces to `neg` and so
 * matches a rejected "disable" — a reversal expressed differently is still the
 * rejected reversal, not a correction of it.
 *
 * The domain is two values, which is why recording it in a durable log gives
 * nothing back about the prose.
 */
export function polaritySigns(text: string): string[] {
  const signs = new Set<string>();
  let negated = false;
  // A negator that is itself a table term — "never" asserts a prohibition AND
  // negates what follows — holds its own sign BACK. If something in its span
  // consumes the negation, that flipped predicate is its whole contribution:
  // counting the word too would make "must never disable" assert a prohibition
  // and a permission at once, so it would stop matching the "must enable" claim
  // it restates. Nothing consumed it ("the job never runs"), and the word's own
  // ban is all there is.
  let held: string | undefined;
  for (const t of tokens(text)) {
    const sign = POLARITY.get(t);
    if (NEGATORS.has(t)) {
      if (held) signs.add(held);
      negated = true;
      held = sign;
      continue;
    }
    if (sign) {
      signs.add(negated ? (sign === POL_POS ? POL_NEG : POL_POS) : sign);
      negated = false;
      held = undefined;
      continue;
    }
    // A copula keeps the negation alive across it ("must not be enabled"); any
    // other word closes the span, releasing a held dual-role negator as its own
    // sign.
    if (!NEGATION_SPAN.has(t)) {
      if (held) signs.add(held);
      negated = false;
      held = undefined;
    }
  }
  if (held) signs.add(held);
  return [...signs].sort();
}

// Two-concept admission for the recall tool's matcher (#409, case bank).
//
// The tool scores a row by counting how many of the query's words appear in it
// as substrings, and returns anything that scores above zero. One shared word is
// enough, so `watermark 283 287 head` returns every row that mentions a head,
// and `fixer ready tickets queue blocked` returns rows about the GitHub CLI and
// about npm publishing. Measured on 404 real recall queries taken from 30 days of
// session transcripts and labelled by two independent readers,
// a large share of what the tool returned was judged irrelevant rather than
// answering.
//
// The injection path already refuses single-concept matches once a query is long
// enough to be a deliberate search (LONG_QUERY_TOKENS in score.ts). This applies
// that rule to the tool, so the two paths agree on when nothing is a good enough
// answer. It changes admission only: ranking, scoring and the window size are
// untouched. ON by default — the two paths disagreeing was the bug, and a
// quality fix that nobody flips on is not a fix. Explicit opt-out:
//
//   OPENCODE_MEMORY_QUERY_GATE=off   (also 0 / no / n / false)
//
// WHY THE GATE COUNTS WORDS AND THE SCORER COUNTS SUBSTRINGS
//
// These are different questions, and using the tool's own substring test here was
// the first version's mistake. Scoring asks how strongly a row matches, and
// substring matching is deliberate there: it is how `getUserAccount` finds a row
// written `get_user_account`. Admission asks how many DISTINCT CONCEPTS the query
// and the row share, and a substring is not a concept. Counting substrings made
// the gate satisfiable by two accidents: `on` occurs inside `context` and inside
// `decision`, so every row of those types shared it; `pr` occurs inside
// `preference`; and `283` occurs inside `build2837`, so the query that motivated
// this change, `watermark 283 287 head`, still admitted the row it was supposed to
// refuse. The gate therefore compares whole words, and drops the query's stopwords
// and fragments, which is exactly the vocabulary the injection scorer counts.
//
// Whole words are also what makes the number queries work. `#277` tokenises to
// `277`, so a PR-number search still matches the row that cites it, while `283` no
// longer matches `#2830`.
//
// STATUS: measured on the case bank; see the PR for the current numbers. The
// first version's numbers were measured with substring counting and are void.
// See https://github.com/abogartz/opencode-self-improvement/issues/409.
import type { Memory } from "../store/model/memory.ts";
import { LONG_QUERY_TOKENS, QUERY_STOPWORDS, words } from "./score.ts";

export const GATE_ENV = "OPENCODE_MEMORY_QUERY_GATE";

/**
 * ON by default. Off only for an explicit negative: the off words (`off`, `no`,
 * `n`, `false`) and any number equal to zero — `0`, `00`, `0.0` all mean off,
 * which is what a shell user writing `=no` means. Unset, empty, or anything
 * else is on: a default-ON quality path must not be disableable by typo.
 */
export function gateEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[GATE_ENV]?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === "off" || raw === "no" || raw === "n" || raw === "false")
    return false;
  const n = Number(raw);
  if (Number.isFinite(n)) return n !== 0;
  return true;
}

/**
 * The text a recall query is matched against: type, scope, prose and the
 * author-supplied keyword aliases, lower-cased. The tool's scorer shares this one
 * definition so a row can never be scored against one string and admitted against
 * another. Distinct from score.ts's `haystack`, which orders the same fields for
 * the injection scorer.
 */
function recallHaystackRaw(m: Memory): string {
  const kw = m.kw?.length ? ` ${m.kw.join(" ")}` : "";
  return `${m.type} ${m.scope} ${m.content}${kw}`;
}

export function recallHaystack(m: Memory): string {
  return recallHaystackRaw(m).toLowerCase();
}

// Split into whole words at whitespace and punctuation. Underscore stays inside a
// word so the identifier a user searches for — `db_id`, `OPENCODE_MEMORY_DIR` —
// survives as the single concept it is (splitting it is the regression that
// blocked PR #417); a dash separates, because prose writes `get-user-account` as
// the three words it means. `build2837` stays one word, which is why `283` can no
// longer match it.
const WORD = /[^a-z0-9_]+/;

/**
 * The query's distinct concepts: lower-cased whole words, with fragments and the
 * scorer's own stopword list removed. A gate that counted `on` or `i` was counting
 * punctuation and grammar, not concepts.
 */
export function queryConcepts(query: string): string[] {
  const out: string[] = [];
  for (const w of query.toLowerCase().split(WORD))
    if (w.length > 2 && !QUERY_STOPWORDS.has(w) && !out.includes(w))
      out.push(w);
  return out;
}

/** The row's concepts, as a set for whole-word membership tests. */
export function rowConcepts(m: Memory): Set<string> {
  // Union of two vocabularies (#426 review). The #417 scorer tokenizer over
  // the ORIGINAL-case haystack carries whole identifiers plus camel/separator
  // segments, so a prose query is admitted against an identifier written in
  // any style. But words() segments at EVERY separator: `table.db_id` yields
  // table/db/id, never `db_id` whole, and an exact `db_id` query is one
  // concept — so the WORD split (underscore inside, everything else a
  // separator) is unioned back in. Both sides keep their length floor, so
  // `build2837` still shares nothing with `283` and admission stays word-level.
  const out = new Set(words(recallHaystackRaw(m)));
  for (const w of recallHaystack(m).split(WORD)) if (w.length > 2) out.add(w);
  return out;
}

/** How many of `concepts` the row contains as whole words (or identifier segments). */
export function sharedConcepts(
  m: Memory,
  concepts: readonly string[],
  row?: Set<string>,
): number {
  const words = row ?? rowConcepts(m);
  let shared = 0;
  for (const w of concepts) if (words.has(w)) shared++;
  return shared;
}

/**
 * True when the row may be returned. A query of LONG_QUERY_TOKENS or more
 * concepts is a deliberate search, so a row must share two of them; a shorter
 * query is too vague to hold a row to two. `concepts` is passed in so the split
 * happens once per call rather than once per candidate.
 */
export function admitsRow(
  m: Memory,
  concepts: readonly string[],
  row?: Set<string>,
): boolean {
  // A query that reduces to zero concepts ("how do I") abstains on every row.
  // That is intended: the scorer matched it on grammar alone — `i` occurs inside
  // most English prose — and grammar-only matches are the noise this gate exists
  // to refuse. "No matching memories" is the honest answer to a contentless
  // query, and the tool already returns it when nothing scores.
  const need = concepts.length >= LONG_QUERY_TOKENS ? 2 : 1;
  return sharedConcepts(m, concepts, row) >= need;
}

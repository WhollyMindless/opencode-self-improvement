// Two-concept admission for the recall tool's matcher.
//
// A query of LONG_QUERY_TOKENS concepts or more is a deliberate search: a row
// must share two whole-word concepts with it to be returned. Shorter queries
// keep one-concept admission. Explicit lookup also accepts a complete authored
// alias that identifies a single candidate. Automatic injection stays stricter.
//
// ON by default. Off only for an explicit negative (see gateEnabled): a
// quality fix that nobody flips on is not a fix, and a typo must not disable
// it.
//
// TRAP: admission counts whole words; the scorer counts substrings on
// purpose. A substring is not a concept — `on` occurs inside `context`, `pr`
// inside `preference`, `283` inside `build2837` — so the gate must not reuse
// the matcher's own substring test. Whole words keep number queries exact:
// the concept `277` matches a row citing that number and not `2830`.
//
// History and measurements: docs/adr/0001.
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
// survives as the single concept it is (splitting it breaks exact identifier
// queries); a dash separates, because prose writes `get-user-account` as
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
  // Union of two vocabularies. The scorer tokenizer over
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

/** A literal query term may name one visible row by its complete authored alias. */
export function exactAliasMatches(
  query: string,
  concepts: readonly string[],
  rows: readonly Memory[],
): Set<Memory> {
  const matches = new Set<Memory>();
  if (concepts.length < LONG_QUERY_TOKENS) return matches;
  const terms = new Set(
    (query.toLowerCase().match(/[a-z0-9_.\-/]+/g) ?? [])
      .map((id) => id.replace(/^[./-]+|[./-]+$/g, ""))
      .filter((id) => id.length > 2 && !QUERY_STOPWORDS.has(id)),
  );
  const owners = new Map<string, Memory>();
  for (const row of rows)
    for (const alias of row.kw ?? [])
      if (terms.has(alias)) owners.set(alias, row);
  if (!owners.size) return matches;
  for (const row of rows) {
    const indexed = rowConcepts(row);
    for (const [alias, owner] of owners)
      if (row !== owner && indexed.has(alias)) owners.delete(alias);
    if (!owners.size) break;
  }
  for (const owner of owners.values()) matches.add(owner);
  return matches;
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

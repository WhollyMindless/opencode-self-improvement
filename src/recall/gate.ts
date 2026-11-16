// Two-concept admission for the recall tool's matcher (#409, case bank).
//
// The tool scores a row by counting how many of the query's words appear in it
// as substrings, and returns anything that scores above zero. One shared word is
// enough, so `watermark 283 287 head` returns every row that mentions a `head`,
// and `fixer ready tickets queue blocked` returns rows about the GitHub CLI and
// about npm publishing. Measured on 404 real recall queries taken from 30 days of
// session transcripts and labelled by two independent readers (poc-409/casebank),
// 42% of the rows the tool returned were judged irrelevant and a further 30%
// related-but-not-an-answer.
//
// The injection path already refuses single-concept matches once a query is long
// enough to be a deliberate search (LONG_QUERY_TOKENS in score.ts). This applies
// that rule to the tool, so the two paths agree on when nothing is a good enough
// answer. It changes admission only: ranking, scoring and the window size are
// untouched, and the flag-off path is the shipped behaviour.
//
//   OPENCODE_MEMORY_QUERY_GATE=1   (unset or 0 = shipped behaviour)
//
// On the case bank's held-out half (227 real queries, relevance labels from two
// unrelated readers over a pinned store snapshot), measured by running this
// handler itself with the flag flipped once per query: queries shown an answer
// 148 before and 149 after, and an answer at rank 1 125 before and 125 after —
// zero discordant pairs against recall — while returned rows fall from 571 to 480
// and non-answering rows from 363 to 272. The rate at which a query with no
// answer in the store is still shown a window drops from 0.847 to 0.678, paired
// 10-to-0 (McNemar p=0.002). Every row the gate promotes into the window from
// below rank 3 is labelled too: 9 queries gain a row, one an answer, one something
// useful, eight junk. See https://github.com/abogartz/opencode-self-improvement/issues/409.
import type { Memory } from "../store/model/memory.ts";
import { LONG_QUERY_TOKENS } from "./score.ts";

export const GATE_ENV = "OPENCODE_MEMORY_QUERY_GATE";

/** Off unless the variable holds something other than 0, false or off. */
export function gateEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[GATE_ENV]?.trim().toLowerCase();
  if (!raw) return false;
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * The text a recall query is matched against: type, scope, prose and the
 * author-supplied keyword aliases, lower-cased. The tool's scorer and this gate
 * share one definition so a row can never be scored against one string and
 * admitted against another. Distinct from score.ts's `haystack`, which orders the
 * same fields for the injection scorer's tokenizer.
 */
export function recallHaystack(m: Memory): string {
  const kw = m.kw?.length ? ` ${m.kw.join(" ")}` : "";
  return `${m.type} ${m.scope} ${m.content}${kw}`.toLowerCase();
}

/**
 * The query's distinct lower-cased words, split exactly the way the tool's
 * matcher splits it. Deliberately not the injection scorer's tokenizer: the gate
 * has to count the same units the scorer searches for, or a row could be admitted
 * for a token the scorer never looked at.
 */
export function queryTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

/** How many of `tokens` occur anywhere in the row's searchable text. */
export function sharedTokens(m: Memory, tokens: readonly string[]): number {
  const hay = recallHaystack(m);
  let shared = 0;
  for (const w of tokens) if (hay.includes(w)) shared++;
  return shared;
}

/**
 * True when the row may be returned. A query of LONG_QUERY_TOKENS or more words
 * is a deliberate search, so a row must share two of its words; a shorter query
 * is too vague to hold a row to two. `tokens` is passed in so the split happens
 * once per call rather than once per candidate.
 */
export function admitsRow(m: Memory, tokens: readonly string[]): boolean {
  const need = tokens.length >= LONG_QUERY_TOKENS ? 2 : 1;
  return sharedTokens(m, tokens) >= need;
}

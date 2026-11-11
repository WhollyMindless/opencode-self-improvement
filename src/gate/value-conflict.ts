// Row-vs-row numeric conflict (#390): a correction must retire the row it
// corrects IN THE DATA, not only in its wording.
//
// R3 (`results-stale-x5/`, values 2150 → 1900) showed the store keeping BOTH
// values, the correction winning only because a language model happened to
// write "this supersedes the earlier 2150 bps figure" and retrieval happened
// to prefer it. R3c narrowed the real exposure: with a 30-day gap the newer
// row wins 10/10 either order; the failure is the same-instant tie (3/10) and
// any retrieval that surfaces the stale row alone. GATE-3 rivalry never fires
// here because it only competes `decision`/`preference` rows, and corrections
// of remembered facts are `context`/`learning`.
//
// This retires the older row at write time with an explicit `superseded_by`
// pointer, so injection cannot carry the stale value alone — superseded rows
// fail `isInjectable`. It changes no outcome that timestamp resolution had
// already settled (R3c: newer wins 10/10); it makes the win structural.
//
// The guard is threefold, because a retirement destroys nothing but hides the
// row from every future session:
//   1. anchor — both rows must name the SAME symbol token (SCREAMING_CASE or
//      a dotted member). "max_retries is 3" and "timeout is 30" in one scope
//      share no anchor and coexist.
//   2. value — the numbers attached to that anchor must actually disagree
//      (`valuesAgree === false`); "21.5%" and "2150" are one fact restated.
//   3. sentence — with the numbers stripped, the two rows must say the SAME
//      thing (#400 review round 2, WhollyMindless). Every non-numeric word
//      outside a closed ignore list (prose glue, copulas) must appear in BOTH
//      rows or in a closed EDITORIAL set — words that narrate the act of
//      correcting ("corrected", "actually", "supersedes") and nothing about
//      the fact. One unmatched content word and the rows coexist.
//      This replaces the old jaccard floor (0.71 let "3 in production" retire
//      "5 in staging") AND the environment dictionary (empty qualifier sets
//      let "3 for tenant Alpha" retire "5 for tenant Beta" — a dictionary can
//      never establish same-context, because the qualifier vocabulary is
//      open: tenants, regions, editions, customers). Same-context is now
//      ESTABLISHED, not looked up: a difference the words cannot explain is
//      a difference in the fact. Retirement requires the correction to be
//      the only thing that changed; anything coexisting is the pre-#390
//      state — both rows inject, retrieval prefers the newer — never a
//      hidden fact.
import { USER_GUIDED_TAG } from "../core/tags.ts";
import { STOPWORDS, tokens } from "../core/tokenize.ts";
import type { Memory } from "../store/model/memory.ts";
import { valuesAgree } from "../recall/conflicts.ts";

export interface ValueConflict {
  /** The live row to retire. */
  ts: string;
  symbol: string;
  /** The number the retiring row asserted. */
  from: string;
  /** The number the incoming row asserts. */
  to: string;
}

// How far after a symbol a number may sit and still be that symbol's value.
// Same window as the capture claim check (#393) on purpose: one rule for
// "this number belongs to this name".
const WINDOW = 48;

// Words carrying no qualifying information: prose glue (the shared GATE-3
// stopword set) plus copulas/auxiliaries, so "was 3" -> "is now 5" stays one
// correction. "should" stays OUT: desired-vs-actual is a real distinction.
const IGNORE: ReadonlySet<string> = new Set([
  ...STOPWORDS,
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "has",
  "have",
  "had",
]);

// Words that narrate the ACT of correcting without qualifying the fact.
// Closed and small on purpose: every word here says "this replaced something"
// and nothing about WHICH fact. A qualifier can never hide in this set
// because the set names no dimension of the world.
const EDITORIAL: ReadonlySet<string> = new Set([
  "corrected",
  "correction",
  "actually",
  "now",
  "updated",
  "update",
  "previously",
  "earlier",
  "supersedes",
  "superseded",
  "fixed",
  "typo",
  "wrong",
  "incorrectly",
  "mistake",
  "rather",
  "instead",
]);

/**
 * The qualifying content of a row: every token that is not prose glue and
 * not a pure number ("2150", "-5", "0.082" — the values guard 2 already
 * compared). `tokens()` keeps dots, so "points." arrives with its period;
 * edge dots are stripped before comparison while interior dots keep dotted
 * members intact. "v2" is NOT a pure number and stays — a version qualifier
 * is exactly the kind of difference that must block retirement.
 */
function residualWords(content: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokens(content)) {
    const bare = t.replace(/^\.+|\.+$/g, "");
    if (!bare || IGNORE.has(bare)) continue;
    if (/^[-+]?\d+(?:\.\d+)?$/.test(bare)) continue;
    out.add(bare);
  }
  return out;
}

/**
 * Guard 3: the correction must be the ONLY thing that changed. Every word
 * one row says and the other does not must be editorial narration; a single
 * content word unique to one row ("production", "tenant", "alpha", "v2")
 * means the rows qualify different facts, and nothing retires.
 */
function sameSentenceExceptValue(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (!b.has(t) && !EDITORIAL.has(t)) return false;
  for (const t of b) if (!a.has(t) && !EDITORIAL.has(t)) return false;
  return true;
}

/**
 * The value each symbol in a row asserts: the first number within WINDOW
 * after the symbol (falling back to the first before it). Built per call —
 * a module-level `g` regex carries `lastIndex` between calls, which made the
 * #393 check depend on which row was checked last.
 *
 * The sign is part of the value: "-5" and "5" disagree (#399's class — an
 * unsigned extractor grants agreement across a sign flip).
 */
export function symbolValues(content: string): Map<string, string> {
  const out = new Map<string, string>();
  const SYMBOL =
    /\b([A-Z][A-Z0-9_]{2,}|[A-Za-z_$][A-Za-z0-9_$]*\.[a-z][A-Za-z0-9_$]*)\b/g;
  let match: RegExpExecArray | null = SYMBOL.exec(content);
  while (match) {
    const sym = match[1] ?? "";
    const after = content.slice(
      match.index + match[0].length,
      match.index + match[0].length + WINDOW,
    );
    const before = content.slice(
      Math.max(0, match.index - WINDOW),
      match.index,
    );
    const num =
      after.match(/[-+]?\d+(?:\.\d+)?/)?.[0] ??
      before.match(/[-+]?\d+(?:\.\d+)?/)?.[0];
    if (num !== undefined && !out.has(sym)) out.set(sym, num);
    match = SYMBOL.exec(content);
  }
  return out;
}

/**
 * Which live rows the incoming candidate corrects. The caller passes rows
 * already filtered to the candidate's scope, type-compared here.
 *
 * Guided rows are protected from inferred writes: a captured inference must
 * not bury what the user stated — the user is the stronger claim. A guided
 * candidate may retire anything, including a stale guided row.
 */
export function valueConflicts(
  candidate: { type: string; content: string; tags?: string[] },
  live: readonly Memory[],
): ValueConflict[] {
  const guided = candidate.tags?.includes(USER_GUIDED_TAG) === true;
  const mine = symbolValues(candidate.content);
  if (mine.size === 0) return [];
  const myWords = residualWords(candidate.content);
  const out: ValueConflict[] = [];
  for (const m of live) {
    if (m.superseded_by) continue;
    if (m.type !== candidate.type) continue;
    if (!guided && m.tags?.includes(USER_GUIDED_TAG)) continue;
    const theirs = symbolValues(m.content);
    if (theirs.size === 0) continue;
    let hit: { symbol: string; from: string } | undefined;
    for (const [sym, val] of theirs) {
      const said = mine.get(sym);
      if (said === undefined) continue;
      if (valuesAgree(said, val) === false) {
        hit = { symbol: sym, from: val };
        break;
      }
    }
    if (!hit) continue;
    if (!sameSentenceExceptValue(myWords, residualWords(m.content))) continue;
    out.push({
      ts: m.ts,
      symbol: hit.symbol,
      from: hit.from,
      to: mine.get(hit.symbol) ?? "",
    });
  }
  return out;
}

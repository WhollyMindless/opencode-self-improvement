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
// The guard is fourfold, because a retirement destroys nothing but hides the
// row from every future session:
//   1. anchor — both rows must name the SAME symbol token (SCREAMING_CASE or
//      a dotted member). "max_retries is 3" and "timeout is 30" in one scope
//      share no anchor and coexist.
//   2. value — the numbers attached to that anchor must actually disagree
//      (`valuesAgree === false`); "21.5%" and "2150" are one fact restated.
//   3. shape — with the numbers stripped, the rows must be the SAME SENTENCE
//      (jaccard ≥ the CONFLICT floor GATE-3 uses). "VAT_BPS was introduced in
//      2024" against "VAT_BPS ... is 2150 basis points" measures ~0.07 there
//      and must NOT retire anything — the misfire class #393 accepted for a
//      refusal is not accepted for a retirement.
//   4. context (#400 review, WhollyMindless) — neither row may scope the value
//      to a DIFFERENT environment. "MAX_RETRIES is 3 in production" and
//      "...is 5 in staging" pass guards 1–3 (jaccard 0.71) and are two valid
//      facts, not a correction; retiring the production row hid it from every
//      later session. Retirement requires the environments to agree: both
//      unscoped, or naming at least one environment in common. One row scoped
//      and one bare also coexists — the bare row may be the default, and
//      hiding a default behind one environment's value is the same defect.
//      The vocabulary is closed and small; other qualifier classes (regions,
//      editions, tenants) are NOT detected — the direction of every miss is
//      coexistence, the pre-#390 state, never a hidden fact.
import { USER_GUIDED_TAG } from "../core/tags.ts";
import { jaccard, tokens } from "../core/tokenize.ts";
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
// Same floor as GATE-3's CONFLICT_OVERLAP_FLOOR: below it the two rows are
// different statements that merely share a noun, not one fact restated.
const SIM_FLOOR = 0.3;

// Environment qualifiers (guard 4). Closed vocabulary, deliberately small:
// every word here names a deployment environment in ordinary prose. Words
// that also carry ordinary meanings ("stage", "test", "live" as a verb) stay
// out — a spurious qualifier only ever coexists rows, so the list errs
// toward the words whose mismatch is unambiguous.
const ENV_WORDS: ReadonlySet<string> = new Set([
  "production",
  "prod",
  "staging",
  "stg",
  "development",
  "dev",
  "testing",
  "qa",
  "uat",
  "sandbox",
  "local",
  "localhost",
  "canary",
  "preview",
]);

/** The environments a row scopes its values to. `tokens()` keeps dots (they
 * carry dotted members), so a sentence-final "staging." arrives with its
 * period — compare on the bare word. */
function envQualifiers(content: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokens(content)) {
    const bare = t.replace(/^\.+|\.+$/g, "");
    if (ENV_WORDS.has(bare)) out.add(bare);
  }
  return out;
}

/** Guard 4: retirement needs the environments to agree. */
function sameEnvironment(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 && b.size === 0) return true;
  for (const e of a) if (b.has(e)) return true;
  return false;
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
  const myShape = tokens(candidate.content).filter((t) => !/\d/.test(t));
  const myEnv = envQualifiers(candidate.content);
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
    const itsShape = tokens(m.content).filter((t) => !/\d/.test(t));
    if (jaccard(myShape, itsShape) < SIM_FLOOR) continue;
    if (!sameEnvironment(myEnv, envQualifiers(m.content))) continue;
    out.push({
      ts: m.ts,
      symbol: hit.symbol,
      from: hit.from,
      to: mine.get(hit.symbol) ?? "",
    });
  }
  return out;
}

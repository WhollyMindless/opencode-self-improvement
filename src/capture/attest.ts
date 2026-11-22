// attest — decides whether a guided candidate has earned the hint channel.
//
// `user-guided` is not a description, it is a grant: the newest guided rows ride
// EVERY later session's injection prefix whether or not that session's prompt
// mentions them, ahead of the lexically-relevant picks, and exempt from the
// budget demotion applied to rows the working tree already states. Every later
// session pays for the slot in prompt bytes and in a prompt-cache miss.
//
// What grants it today — the capture model emitted `guided: true` and the row's
// verbatim quote occurs in one of the user's turns — admits every sentence a
// session contains, because a task brief IS a user turn. Boilerplate written for
// a harness ("trust the code's invariants over the docs") passes it unchanged:
// the user did type those words, and no later session can check them against
// anything. Provenance that nothing can contradict is exactly the shape a wrong
// row needs in order to always ride.
//
// So the tag is earned by CHECKABILITY, not by attribution. A guided row keeps
// it when it carries a handle a later session can verify outside the prose:
//
//   - a value. A number, in the user's own words or in the declared claim. The
//     contradiction surface already code-checks these against the tree, and a
//     rate, a limit or a requirement is the kind of thing only the user can
//     supply.
//   - a name the session used. One of the candidate's declared retrieval
//     keywords appears in the tool ledger, so the convention was exercised, not
//     merely asserted. "we use bun here" is confirmable by a `bun` command;
//     "trust the code over the docs" is confirmable by nothing, which is the
//     reason it should not hold a slot every later session pays for.
//
// Undecidable means kept, in both directions:
//   - a candidate that declared no keywords cannot be disproved, and keywords
//     are optional in the capture contract, so demanding them would demote every
//     row whose wording the model judged self-explanatory;
//   - a keyword that happens to appear in an unrelated tool call keeps a tag it
//     did not earn, which is today's behaviour, not a new defect.
// The asymmetry is deliberate. A wrong demotion costs one row its always-ride
// lane; the row is still stored, still recalled by relevance, and the next pass
// can grant the tag again. A wrong grant costs every later session and puts an
// unchecked sentence in the lane this store has measured being obeyed over the
// code.
import type { CaptureCandidate } from "./prompt.ts";

/** One ledger entry, as the session state records it. */
export interface LedgerEntry {
  tool: string;
  cmd?: string;
  arg?: string;
}

/**
 * The ledger as one lower-cased haystack: the tool that ran, the command, and
 * the argument that identified its target. Output text is deliberately absent —
 * a tool that READ a file containing the sentence would otherwise vouch for the
 * sentence, and reading is not exercising a convention.
 *
 * Total: junk entries are skipped, never a throw.
 */
export function ledgerText(calls: readonly LedgerEntry[]): string {
  if (!Array.isArray(calls)) return "";
  const parts: string[] = [];
  for (const c of calls) {
    if (!c || typeof c !== "object") continue;
    for (const v of [c.tool, c.cmd, c.arg]) {
      if (typeof v === "string" && v.trim()) parts.push(v.trim().toLowerCase());
    }
  }
  return parts.join(" ");
}

/** A stated number: the user supplied a value, which is checkable by definition. */
export function statesValue(text: string): boolean {
  return /\d/.test(text);
}

// Word-boundary test on a haystack with no `\b`: `_` is a word character here
// but a path separator in `src/pricing_test.ts`, and `pricing_test` must not
// attest a keyword `test`. A hit is a whole path segment or whole word.
function wholeTerm(hay: string, term: string): boolean {
  if (!term) return false;
  let from = hay.indexOf(term);
  while (from >= 0) {
    const before = from === 0 ? " " : hay[from - 1];
    const after = from + term.length;
    const next = after >= hay.length ? " " : hay[after];
    if (!/[\w-]/.test(before) && !/[\w-]/.test(next)) return true;
    from = hay.indexOf(term, from + 1);
  }
  return false;
}

/**
 * The declared keyword that the ledger corroborates, or null. Keywords shorter
 * than three characters are skipped: they match too much of a command line to
 * establish that the session used the thing they name.
 */
export function corroboratedKeyword(
  keywords: readonly string[] | undefined,
  ledger: string,
): string | null {
  if (!keywords || !keywords.length || !ledger) return null;
  for (const raw of keywords) {
    if (typeof raw !== "string") continue;
    const term = raw.trim().toLowerCase();
    if (term.length < 3) continue;
    if (wholeTerm(ledger, term)) return term;
  }
  return null;
}

export type AttestVerdict =
  | { attested: true; via: "value" | "ledger" | "undecidable" }
  | { attested: false };

/**
 * Whether a guided candidate keeps the hint-channel tag. Non-guided candidates
 * are outside this decision and come back `undecidable`, so a caller can run
 * the whole candidate list through it and act only on `attested: false`.
 */
export function guidedAttestation(
  candidate: CaptureCandidate,
  ledger: string,
): AttestVerdict {
  if (candidate.guided !== true) return { attested: true, via: "undecidable" };
  // A value is a NUMBER. `claim` is contractually the user's value, but it
  // arrives from the model, so it earns the grant only by stating a figure the
  // contradiction surface can actually compare — prose in that field is the same
  // unchecked sentence as prose anywhere else.
  const words = `${candidate.claim ?? ""} ${candidate.original ?? ""} ${candidate.content}`;
  if (statesValue(words)) return { attested: true, via: "value" };
  if (!candidate.kw || !candidate.kw.length)
    return { attested: true, via: "undecidable" };
  // No ledger means no window into what the session did, not a session that did
  // nothing: the tail is capped and a caller may hold no state for this id. With
  // nothing to compare against there is no evidence either way, so the grant
  // stands rather than resting on an absence.
  if (!ledger) return { attested: true, via: "undecidable" };
  if (corroboratedKeyword(candidate.kw, ledger))
    return { attested: true, via: "ledger" };
  return { attested: false };
}

/**
 * Clears the guided standing of every candidate the ledger cannot corroborate.
 * The verbatim quote goes with it: injection renders it as "user said", which is
 * the attribution this decision just refused. The comparison fields ride guided
 * rows only, so they are cleared for the same reason. The prose stays — this
 * removes a privilege, never a fact.
 *
 * Returns the number of rows demoted so the caller can record it; a demotion
 * that leaves no trace is the failure mode the evidence line exists for.
 */
export function withholdUngroundedGuidance(
  candidates: CaptureCandidate[],
  ledger: string,
): number {
  let withheld = 0;
  for (const c of candidates) {
    if (c.guided !== true) continue;
    if (guidedAttestation(c, ledger).attested) continue;
    c.guided = false;
    c.original = undefined;
    c.ref = undefined;
    c.claim = undefined;
    c.klass = undefined;
    withheld++;
  }
  return withheld;
}

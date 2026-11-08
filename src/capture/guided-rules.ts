// guided-rules — deterministic guided-candidate pre-pass (POC, FINDINGS
// 2026-11-08 §4). Plugin option `captureGuidedRules`, default OFF.
//
// Mystery 2's last stochastic link is capture EMISSION: the capture model
// flagged the user-stated fact guided in 5 of 7 runs (attr + ARM F). The
// field's convergent fix is "LLM proposes, rules dispose" (arXiv 2604.27906
// schema-grounded memory; neuro-symbolic extraction, Nat. Comm. Med. 2025;
// MEDIQA-SYNUR 2026 exact-evidence grounding): decide WHAT must be guided
// deterministically from the user's own lines, let the model only PHRASE it,
// and validate the quote on the write path so a miss becomes a retriable
// event, not a silent omission.
//
// Contract:
// - findGuidedQuotes scans user text (the REQUESTS prose plus transcript
//   user: lines) sentence by sentence; a sentence stating a value or a rule
//   yields its VERBATIM text (whitespace-normalised, capped).
// - mergeGuidedCandidates lets the model phrase a pre-pass quote (matched by
//   its own verbatim original or by numeric overlap) but never clear the
//   guided flag or drop the quote: an unmatched quote gets a deterministic
//   fallback row.
// - All functions are TOTAL like the rest of capture: junk input yields
//   []/passthrough, never a throw.
import { type CaptureCandidate } from "./prompt.ts";

/** Same normalisation the runtime quote check uses. */
export function normWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Cap mirrors the store's original field; a quote is a substring, so a
 * truncation at a space boundary stays verbatim. */
export const GUIDED_QUOTE_CHARS = 300;

// Decidable stated-fact shapes (the class the bench's guidance lives in):
// a number/rate/currency, or an explicit rule assertion. Deliberately
// narrow — the guided lane is capped and budgeted, but a rule that flags
// ordinary prose would still be noise by construction.
const VALUE_RE = /\d+(?:[.,]\d+)?\s*%|\d+\.\d+|[$€£]\s*\d/;
const RULE_RE =
  /\b(must be|must equal|must include|has to be|is set to|is exactly|the correct\b|is inclusive|not only\b|always|never|the rule is)\b/i;

/**
 * Verbatim sentences from the user's own text that state a value or a rule.
 * `userText` is the REQUESTS prose plus the transcript's user: lines — never
 * assistant output, so a stored quote can only be what the user said.
 */
export function findGuidedQuotes(userText: string): string[] {
  const out: string[] = [];
  for (const raw of userText.split(/(?<=[.!?])\s+|\n/)) {
    const s = normWs(raw.replace(/^\s*user:\s*/i, ""));
    if (s.length < 12 || s.length > 2000) continue;
    if (!VALUE_RE.test(s) && !RULE_RE.test(s)) continue;
    // Imperatives scoping THIS job are instructions, not stated facts
    // ("do not create tests"); the capture contract expires them with the task.
    if (/^(do|don't|dont|never create|only touch)\b/i.test(s)) continue;
    const quote =
      s.length > GUIDED_QUOTE_CHARS
        ? normWs(s.slice(0, GUIDED_QUOTE_CHARS).replace(/\s\S*$/, ""))
        : s;
    if (quote.length >= 12 && !out.includes(quote)) out.push(quote);
    // Bound the lane the way injection bounds it (GUIDED_INJECT_CAP): a user
    // message that states five facts is a fixture, not a session.
    if (out.length === 3) break;
  }
  return out;
}

const NUMBERS_RE = /\d+(?:[.,]\d+)?/g;

function numbers(s: string): Set<string> {
  return new Set(s.match(NUMBERS_RE) ?? []);
}

/**
 * One row per pre-pass quote. A model candidate that already carries the
 * verbatim quote keeps its phrasing; one that states the same numbers keeps
 * its phrasing and gains the quote + the guided flag EVEN IF the model left
 * the flag off — clearing guidance by omission is exactly the measured miss
 * mode. An unmatched quote becomes a deterministic fallback row, so the
 * emission the model skipped still lands.
 */
export function mergeGuidedCandidates(
  quotes: string[],
  candidates: CaptureCandidate[],
): CaptureCandidate[] {
  const out = [...candidates];
  for (const quote of quotes) {
    const nums = numbers(quote);
    const match = out.find(
      (c) =>
        (c.original !== undefined && normWs(c.original) === quote) ||
        (nums.size > 0 && [...numbers(c.content)].some((n) => nums.has(n))),
    );
    if (match) {
      match.guided = true;
      match.original = quote;
      continue;
    }
    const content = `User-stated guidance: "${quote}"`.slice(0, 600);
    out.push({
      type: "context",
      scope: "user-guidance",
      content,
      guided: true,
      original: quote,
    });
  }
  return out;
}

/**
 * The write-path validator (design §4.3): a guided candidate carrying a
 * quote the user never wrote is refused, not silently stripped — the
 * deterministic pre-pass re-offers the fact with the true quote on the same
 * pass, which makes the miss a retriable event. A guided candidate with NO
 * quote is the model's own judgment and passes (unchanged behavior).
 * Returns the survivors plus the refused quotes for evidence.
 */
export function validateGuidedQuotes(
  candidates: CaptureCandidate[],
  userText: string,
): { kept: CaptureCandidate[]; refused: string[] } {
  const hay = normWs(userText);
  const kept: CaptureCandidate[] = [];
  const refused: string[] = [];
  for (const c of candidates) {
    if (c.guided === true && c.original !== undefined) {
      const q = normWs(c.original);
      if (!hay.includes(q)) {
        refused.push(q);
        continue;
      }
      c.original = q;
    }
    kept.push(c);
  }
  return { kept, refused };
}

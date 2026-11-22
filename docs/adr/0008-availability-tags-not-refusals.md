# ADR 0008 — Availability verdicts tag rows; they never refuse them

Status: superseded by [ADR 0009](0009-availability-refusals-under-the-hardened-matcher.md) (2026-11). Code: `src/capture/available.ts`.

## Decision

When the working tree already states a captured fact, the row is STORED and TAGGED (`available`), never dropped. Retrieval sorts tagged rows last within their score band.

## Why

Measured on this repo's live store (1,166 real captured rows): the original refusal rule rejected 30 rows and 29 of those were wrong — the note "OpenCode V2 (v2.0.26) does NOT run LSP servers" was refused because it merely contained the string `bun test`. A wrong match therefore costs a tag, not a fact. A silently dropped candidate leaves no trace to recover from.

## History

Four review rounds on the original rule found the same defect each time — text that was merely short or partly matched was read as already known — and each round patched one instance:

- Partial matching refuses new facts riding a restated fragment (a README rule + "; Finance confirmed the supplier rate is 1900"). Both rules used to refuse on one hit.
- A length cutoff dropped `Never` from `Never \`npm run deploy\`.` (cutoff 16 characters); an empty residual list was then read as proof the whole candidate was restatable. A short fragment is where a prohibition, a window or a number lives. The length test was removed; "states nothing" is the FILLER test, not a length.
- Command spans stripped after ONE declared gate was found erased undeclared prerequisites from the row before deciding.
- A bare `indexOf` matches INSIDE the opposite assertion: with `We do not use tabs for indentation.` in the README, the candidate `Use tabs for indentation.` was refused as available — the store would have held the reversal of the rule the gate had just read. A hit must begin and end on a word boundary and agree in POLARITY.
- The RESTRICTION list the design replaces tried to decide whether a candidate says anything NEW; an open vocabulary can never do that — any word left off the list reopens the class. The replacement is a whitelist for FILLER, the only direction a word list can safely go: a word left off it is read as a claim and the row is kept.

Temporal/conditional words and modals are deliberately absent from the reversal list: a manifest declares THAT a command exists, never when it may be run.

Evidence: issues #397 and #402.

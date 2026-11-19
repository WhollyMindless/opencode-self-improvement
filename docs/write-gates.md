# Write gates and promotion evidence

A memory is a claim about your code, so it is checked the way a pull request
is: does the reference resolve, is something already on file stale, is it a
duplicate, and does it land or come back with a reason. The four gates and the
undo contract stay in the README. This file is what the audit trail keeps, and
what an update carries with it.

## What promotion evidence samples

Promotion evidence keeps a bounded sample of call IDs: the ten most recent code-engagement calls, plus the latest gate check, the latest recorded gate FAIL/fix/PASS recovery, and the latest recorded tool FAIL/PASS retry (at most 16 distinct IDs). `evidence_refs_count` is the total number of recorded session calls before sampling, including non-code tools; the sampled IDs are audit pointers, not a complete history. Grounding and memory attribution still use the full in-memory ledger. Existing evidence day-files are left unchanged: this upgrade does not backfill, compact, or delete historical audit records.

## When a cited path stops existing

A settled claim about code must point at a file the repository has, so a write naming a missing path is refused with `ref_path_missing`. That check runs on writes only. A row that was correct when it was saved goes stale on its own the moment a later refactor moves the file, and nothing notices: recall keeps quoting a path the reader cannot open.

`scripts/ref-fixer.ts` repairs the mechanical cases. The default is a dry run; `--apply` writes through the same gated update path as `memory_update`, so the old row is superseded rather than edited and `memory_undo` stays the recovery path. It repoints a path under two rules, and each is narrow for a specific reason:

1. **A scored rename.** Git records a rename scored at least `R90` whose chain ends at a file that exists today and whose basename is unchanged. The floor is measured rather than guessed: this repository's renames cluster at `R090`..`R100` — the domain restructure, where the only content change is the import lines inside the moved file — and the outliers below it (`R058`, `R072`, `R080`, `R086`, `R088`) are files git scored as renames after much of their content was rewritten. The basename matters because it is what a query matches on — `src/lock.ts` to `src/store/lock.ts` still says "lock", so the row stays findable by the words that found it before.
2. **A loose citation.** The path never existed anywhere in git history and exactly one tracked file ends with it: `gate/gate.ts` for `src/gate/gate.ts`. Both halves are load-bearing. Without the history check, a path the gate once refused as hallucinated would be handed a verified reference; without the single-candidate check, the fixer would pick a directory on the row's behalf.

Anything else is reported, never rewritten. A path occupied by more than one generation — moved away and recreated at the same path, whether it moved away again or was later deleted — is one of those: rows written against each generation cite the same string and describe different files, and nothing in a row's text says which generation it belongs to. The recreate-then-delete shape leaves no second rename record, so it is caught by asking whether history touches the path after its newest rename, not by counting renames. A rename that also renamed the file (`src/logfmt.ts` to `src/core/logfmt/publish.ts`) changes what the sentence asserts, and a path that once existed and is gone was retired on purpose — a row about it is the record that it existed, and rewording that is a decision, not a repair.

The edit itself is span-based, not a substring replace. Only the references `checkablePathRefs` reports are touched, at the offsets they occupy. That is the safety property: a replace over the whole string also hits a ref nested inside a longer one (`gate/gate.ts` inside `src/gate/gate.ts` becomes `src/src/gate/gate.ts`) and rewrites absolute paths that the checker deliberately skips — so the gate could never refuse the damage, because it never sees those.

Two limits worth knowing before trusting a clean report. Rows are selected by repository key, defaulting to the current directory: rows stamped for another repository, and rows with no stamp at all, are never scanned, because no tree here owns their paths. And a repointed row can still be refused, with a reason that is informative rather than a bug — the row cites a second path the rules will not touch, or it is a `learning` or `blocker` row where a content change brings the symptom-first rule into play. Both are no-ops, listed with their reason, and a run with refusals exits non-zero so a scripted caller cannot read them as success.

## What an update carries forward

`memory_update` picks its row by `query`: the row's id, a clock fragment such as `00:11:22.123`, or a unique substring of its text. Omit it and the newest entry of that scope and type is the target. A query that matches nothing, or that matches several rows, writes nothing and says so — an ambiguous selector is never resolved by picking one.

A prose edit carries the previous row's ordinary tags, issue link, retrieval keywords, open/settled standing and repository forward to the new row, so updating a `global` row from one machine keeps it global for every other. Capture-only guidance provenance is stripped by the replacement: an ordinary edit cannot re-mint a `user-guided` tag or a contradiction verdict.

Naming a row that an earlier update already superseded reports the duplicate when the live successor already holds exactly that content. When only the metadata you named differs, the update runs against the successor instead of dead-ending.

If a failure happens after the new row is already durable, the reply says `PARTIAL`. The message names what failed, the replacement stands on disk, and `memory_undo` (merge or force) brings the old row back.

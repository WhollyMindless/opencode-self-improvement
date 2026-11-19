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

`scripts/ref-fixer.ts` repairs the mechanical cases. The default is a dry run; `--apply` writes through the same gated update path as `memory_update`, so the old row is superseded rather than edited and `memory_undo` stays the recovery path.

It repoints a path only when git records a rename whose chain ends at a file that exists today and whose basename is unchanged. Same basename is the safety property: `src/lock.ts` to `src/store/lock.ts` still says "lock", so the words a query matches on survive the rewrite. A rename that also renamed the file, and a path with no rename in history, are reported instead of rewritten — a row about a deliberately retired artifact is accurate history, and rewording it is a decision, not a repair.

A repointed row can still be refused, and the reason is informative rather than a bug. If the row cites a second path that is also gone, the gate refuses the write for the reason the first repair did not clear. A `learning` or `blocker` row is refused by the symptom rule when the rewrite is a content change and the text no longer opens with the observable trigger. Both are no-ops, listed with their reason.

## What an update carries forward

`memory_update` picks its row by `query`: the row's id, a clock fragment such as `00:11:22.123`, or a unique substring of its text. Omit it and the newest entry of that scope and type is the target. A query that matches nothing, or that matches several rows, writes nothing and says so — an ambiguous selector is never resolved by picking one.

A prose edit carries the previous row's ordinary tags, issue link, retrieval keywords, open/settled standing and repository forward to the new row, so updating a `global` row from one machine keeps it global for every other. Capture-only guidance provenance is stripped by the replacement: an ordinary edit cannot re-mint a `user-guided` tag or a contradiction verdict.

Naming a row that an earlier update already superseded reports the duplicate when the live successor already holds exactly that content. When only the metadata you named differs, the update runs against the successor instead of dead-ending.

If a failure happens after the new row is already durable, the reply says `PARTIAL`. The message names what failed, the replacement stands on disk, and `memory_undo` (merge or force) brings the old row back.

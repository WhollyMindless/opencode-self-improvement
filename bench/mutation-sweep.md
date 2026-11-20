# Mutation sweep record

Manual pre-release evidence, kept out of `bench/results.md` on purpose:
`bun bench/runners/inject-cost.ts` rewrites that file in full, and the
record below must survive a regeneration. The ritual that produces it is
in `docs/pre-release-ritual.md`.

## Mutation sweep — 2026-11-18 (hygiene branch, post-poc-409)

Canonical mutation score: **49/52 = 94.2%** (53 mutants; 1 equivalent excluded, 0 load errors). Wall 5169 s (baseline 91.6 s + 53 mutants × suite on one scratch worktree). `--validate` and `--selftest` green beforehand.

Unpinned invariants (survivors):

| mutant | class | invariant nothing killed |
| --- | --- | --- |
| `publish-rename-since-blind` | D2 | anchored retry re-checks the destination before renaming: a premise that moved aborts |
| `viewer-snapshot-grammar-off` | D3 | restore names are pinned to the snapshot grammar at the wire |
| `restore-escapes-root` | D3 | a restore cannot write outside the memory root |

Equivalent mutant (excluded): `budget-header-fit-boundary` — when the header alone fills the budget, both builds produce identical observable block content; pinning it would pin the `">"` token, not a behavior.

Follow-up: the two D3 survivors concern the restore path and get tests in the phase-4 follow-up; `publish-rename-since-blind` needs a store with a destination that moves mid-retry.

## Survivor follow-up — the three unpinned invariants (2026-11-18)

The sweep above left three unpinned invariants. Each is
now resolved; a targeted `--mutant=` run on this branch gives the evidence.

| mutant | outcome | evidence |
| --- | --- | --- |
| `viewer-snapshot-grammar-off` | **killed** | `test/store/snapshot-restore-grammar.test.ts` asserts the EXACT wire body. With the check off, the request reaches the store, whose rejection repeats the submitted name — for `..`, a directory name, so a filesystem path lands in the HTTP body. |
| `restore-escapes-root` | **equivalent** (excluded) | Unreachable by construction: the restore target is the `<YYYY-MM-DD>.logfmt` capture, which cannot carry a separator, so `isWithin(rootReal, target)` is always true. It is a backstop behind the grammar; the grammar is pinned, and the sweep warns if an equivalent-marked mutant ever dies. |
| `publish-rename-since-blind` | **survives on POSIX** | The retry runs only when `IS_WINDOWS`, so a macOS/Linux sweep has no reachable path to score. `test/inject/publish-since-anchor.test.ts` pins it directly (touched mid-window aborts; a bare reader lands) and runs on `windows-latest` CI. |

Two lessons, both from review: a substring assertion cannot distinguish two
layers that reject the same input with the same status and a message that
contains the outer string — pin the exact response. And a store test that
passes a temp dir while the store resolves `$OPENCODE_MEMORY_DIR` rejects
everything with "not found" and proves nothing; the rejected names must be
planted where the store will actually look for them.

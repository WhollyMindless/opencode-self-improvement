# Injection cost — measured

Reproduce with `bun bench/runners/inject-cost.ts` (deterministic: fixed-seed LCG,
synthetic timestamps, no wall clock in the output — reruns are byte-identical).
The numbers come from the plugin's real injection code (`src/inject.ts`):
a seeded store of 50 memories, a simulated session of
20 user prompts with 3 mid-session store writes, and the default
1200-character budget. The relevance block is budgeted by priority inside
the selector (`selectRelevant`, #388) and then rendered newest-first, so B/C/D
measure the shipped budget path and not a trim of the rendered string. Every
column is measured on the FULL memory section
(digest + frontier + relevance block) — the bytes a request actually sends,
because prompt caching is a property of those bytes and not of the block alone.

| Policy | Recomputes | Cache busts | Injected chars (20 turns) | Avg/turn | Worst section |
| --- | ---: | ---: | ---: | ---: | ---: |
| A — recompute per prompt, uncapped (naive) | 20 | 19 | 60996 | 3049.8 | 3404 |
| B — block frozen on store fingerprint, digest rebuilt per turn (pre-#162) | 4 | 3 | 55478 | 2773.9 | 2867 |
| C — section frozen on rendered bytes (pre-#165) | 4 | 3 | 55258 | 2762.9 | 2856 |
| D — C + riding bytes: the session's own additions are free (shipped) | 1 | 0 | 53500 | 2675.0 | 2675 |

A "cache bust" is a turn whose memory-section bytes differ from the turn
before: each one re-bills the whole conversation as fresh input.

The three mid-session writes are made BY the session being measured, which is
how memory actually gets written — the model saves what it just learned. All
three turn out to change what that session is shown (a new row shifts the
document frequencies and reorders the top-5), so B and C each pay 3
busts for them. D pays 0: a fact the session produced itself is
already in its transcript. What D still pays for is a riding row being corrected,
blocklisted or redacted, or another session writing a row — those survive the
subtraction and still land on the next request, pinned by `test/inject/epoch.test.ts`.

D injects 12.3% fewer characters than the naive policy.

Compaction anchor (capped at 2500 chars): 2304 chars,
pushed once per compaction rather than per turn.

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

# Window dedup replayed against the live store

Measured 2026-11-19 on the maintainer's store, repository key `5699fad3a258`, Bun 1.4.3, no model and no paid seat.

Reproduce: `bun bench/runners/dedup-live-replay.ts` (active rows), with `--all` to include superseded
history and `--repo-only` to drop rows that carry no repository stamp. The runner reads the live store,
so it is not a CI job and its counts are a dated snapshot: this store gained 8 active rows for this
repository during the day this file was written. Quote a number from here with its date, or not at all.

## Why this was run

`docs/adr/0002-window-dedup.md` justified the 0.8 default with a live replay — "0.8 suppresses only
near-identical copies" — citing the `#409` record section 17 and PR #426, with no date and no store
named. The rule's vocabulary changed in `fc59b84`, which moved the comparison from `haystack()` (which
includes the row's own `type` and `scope`) to `contentTokens()` (content and keywords only). An
undated replay is not evidence a later reader can check.

## Scan set

The unit is the recall window, not the store. A repo-scoped read sees the repository's rows **and**
rows with no repository stamp (`src/recall/relevant.ts`), so both are scanned. Rows stamped for a
different repository are excluded: they never share this window. `--repo-only` drops the un-stamped
rows, and the difference matters — see below.

## Result

| arm | what it scores | active, repo + global<br>1,313 rows / 238 scopes | active, repo only<br>1,261 rows / 231 scopes | history included, repo + global<br>1,658 rows |
| --- | --- | ---: | ---: | ---: |
| **A** | `contentTokens` + the shipped guards | **2** candidates ≥ 0.8 | **0**, highest 0.647 | 145, of which **143 have a superseded side** |
| **B** | `haystack` + the shipped guards | 2 | 0, highest 0.667 | 145 |
| **C** | the **pre-`fc59b84` tokenizer**, **no guards** — replayed with the vendored `words()` | 113 | 83 | 451 |

Arm C replays the old tokenizer rather than approximating it. An earlier version scored the old
eligibility with today's `haystack()` and `words()`, and that is not the same rule: today's tokenizer
emits the whole identifier form as a token, which the old one did not, so every short-row score moves
by one token in both numerator and denominator. The vendored copy in the runner is `git show
3ff96ef:src/recall/score.ts`'s `words()`. The counts above are from the replay; under today's tokenizer
the same arm reported 108 active and 434 with history. A review fixture pinned the difference: two
unrelated rows in an eight-word hyphenated scope score 9/11 = 0.818 under the historical deduper, and
the replay reproduces 0.818 where the approximation printed 0.833.

## What the two active candidates are

Both are rows with no repository stamp, which is why `--repo-only` reports zero and why excluding them
was wrong.

1. **A true duplicate, `gufo-ops`, Jaccard 1.000.** Two active, injectable `context` rows, 742 and 746
   characters, same timestamp, the same cutover written twice. This is the pass doing its job — and it
   is the counterexample to any claim that the write gate keeps near-copies from coexisting. It did not
   keep these two out.
2. **A false positive, `BabylonDocs`, Jaccard 0.824.** Two active, injectable `pattern` rows:
   `BabylonDocs build command: run "npm run build" from the repo root` and
   `BabylonDocs build:example-images command: run "npm run build:example-images" from the repo root`.
   These are two different commands. They share a scope, a sentence shape and most of their vocabulary,
   so they clear the threshold. Ranking puts the newer row first and dedup drops the row that clashes
   with it, so what disappears is `npm run build` — the plain build command — while the niche
   `build:example-images` variant keeps the slot. Verified by running `dedupeWindow` over the scope for
   three different queries; the same row loses every time. Every shipped guard passes on this pair: both
   rows are above `MIN_CONTENT`, both carry the same polarity, and their dropped-chunk multisets match.

So the published sentence is not merely unproven. On the store's own rows, at the shipped threshold,
0.8 suppresses a pair that is **not** a near-copy.

## Which guard is load-bearing

Of the 113 active pairs the pre-`fc59b84` rule would have suppressed, today's rule stops: 78 at the
dropped-chunk guard, 28 at the `MIN_CONTENT` floor, 0 at polarity. In the repository's own rows it is
78 of 83 at the dropped-chunk guard. The pass is inert on this store because of the **guards**, not
because the store happens to hold no near-copies.

## Is the `fc59b84` failure live in this store?

Not among the pairs examined. The old vocabulary scored `type` and `scope`, so a pair can reach the threshold on shared metadata while its content stays distinct. Of the 113 active C candidates, **19** fall below 0.8 on content alone — the widest gap being 0.833 metadata against 0.771 content. Every one of them is a `pr-watch` cursor row differing by a run timestamp: near-copies by any reading, pushed just over the line by metadata rather than pulled there by unrelated content.

The shape `fc59b84` removed is a scope whose tokens stand in for content. An earlier version of this file claimed this store was exempt because it holds no `snake_case` scope, and that claim was **wrong** in two ways, both found by review.

First, `words()` splits on any non-alphanumeric delimiter, and on camelCase, so hyphens and capitals contribute stand-in words exactly as underscores do. **144 of this store's 242 scopes** already yield more than one token — `opencode-self-improvement`, `npm-publish`, `BabylonDocs` among them.

Second, "more than one word" is not the threshold either. The precondition is scope vocabulary **dominating** row content, and the runner walks the crossing instead of asserting it. Two unrelated one-word rows sharing one scope, scored with the replayed old tokenizer:

| distinct scope words | old tokenizer | old rule | today's tokenizer would say |
| ---: | ---: | --- | ---: |
| 4 | 0.714 | keeps both | 0.750 |
| 5 | 0.750 | keeps both | 0.778 |
| 6 | 0.778 | keeps both | 0.800 |
| 7 | **0.800** | **suppresses them** | 0.818 |
| 8 | 0.818 | suppresses them | 0.833 |

So a **seven**-word scope is enough to make two unrelated rows look like copies of each other, and the shipped content-only rule keeps both at every length (their content score is 0.000). The crossing sits at seven, not six: the row above it was computed with today's tokenizer, which emits the whole hyphenated form as an extra token and so inflates both sides of the ratio. Review caught it against the historical implementation, and the table now comes from the vendored `words()`.

What survives of the original claim is the narrow version: **no candidate in this store is metadata-driven that way**, because the 19 that reach the threshold on metadata are `pr-watch` cursor rows, near-copies by any reading. With 144 scopes already contributing stand-in vocabulary, that is luck of row length, not a structural exemption — which is a weaker claim than the one this file made before, and the correct one.

## Why the threshold is not the fix

Raising the default was evaluated on 2026-11-19 and rejected. The pair worth releasing scores
**0.8235**. The pair the suite pins in `test/dedupe-tool.test.ts` — `the deploy runbook rotates the
signing key every friday after the backup window` against the same sentence with `monday`, a fact that
*changed*, where the ADR requires the newer row to take the slot — scores **0.8333**.

The gap is 0.0098. A threshold does exist that keeps the runbook suppression and releases the build
pair: it must sit above 0.8235 and at or below 0.8333. That is a window one hundredth wide, fitted to
two observations — the next pair that lands in the gap is decided by noise, and the choice would be
defended by a constant nobody can justify. The value that looked clean, 0.9, releases both: the runbook
pair stops being suppressed and the §17 behavior stops shipping.

The two rows are the same shape — one sentence, one long token swapped out. In one case the swap
replaced a fact; in the other it added one. A token-overlap score cannot see the difference, so the fix
is not a number.

## What decides this store instead

Suppression is only considered when the two rows share the same multiset of dropped 1-2 character
fragments. Two rows differing by a timestamp have different fragments, so they are never compared: all
78 candidates in the repository's own `review` scope are stopped by that guard, not by the threshold.
The `BabylonDocs` pair has no dropped fragments at all — both multisets are empty, so the guard passes
trivially and the pair reaches the score.

That is an inversion worth naming. The motivation recorded in the ADR is rows that "differ only by a
timestamp" crowding distinct facts out of the window, and the guard introduced to stop `DB 3` from
swallowing `DB 4` exempts precisely those. What still gets suppressed is prose with no digits or short
fragments in it — which is exactly where the false positive lives.

## What this does not establish

- It does not re-derive the 0.8 threshold. That rests on the dated `#409` section 17 replay, which is
  the evidence for the number; this scan neither confirms nor refutes it.
- It does not evaluate the vocabulary change on its own. A and B agree everywhere (2 and 2 active, 145 and 145
  with history), because the pairs that collide here are content duplicates where metadata adds
  nothing. B is deliberately "old vocabulary under today's guards": it isolates the tokenizer, not the
  rule. Arm C is the one that scores the old rule with the old eligibility.
- It says nothing about ranking. A candidate pair only loses a slot if both rows reach one window
  together, which depends on the query.

## Consequence

The ADR keeps its 0.8 line with the date and store named, and no longer publishes counts from this
scan. The `BabylonDocs` pair is filed as a recall-quality issue with the threshold option closed out:
raising it was measured, and it costs the §17 behavior for a 0.0098 margin.

One mechanism worth naming, confirmed independently during review: the write gate's duplicate check is
exact and keyed by type, while this pass compares across types. Identical prose filed once as a
`context` and once as a `decision` is therefore promoted twice and stays active twice — which is how
the `gufo-ops` pair above got there, and why the pass is not redundant with the gate.

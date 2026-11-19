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
| **C** | `haystack`, **no guards** — the rule that actually shipped before `fc59b84` | 108 | 78 | 434 |

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
   so they clear the threshold, and the pass hides the newer one — the reader never learns
   `build:example-images` exists. Every shipped guard passes on this pair: both rows are above
   `MIN_CONTENT`, both carry the same polarity, and their dropped-chunk multisets match.

So the published sentence is not merely unproven. On the store's own rows, at the shipped threshold,
0.8 suppresses a pair that is **not** a near-copy.

## Which guard is load-bearing

Of the 108 active pairs the pre-`fc59b84` rule would have suppressed, today's rule stops: 78 at the
dropped-chunk guard, 28 at the `MIN_CONTENT` floor, 0 at polarity. In the repository's own rows it is
78 of 78 at the dropped-chunk guard. The pass is inert on this store because of the **guards**, not
because the store happens to hold no near-copies.

## Is the `fc59b84` failure live in this store?

No, and the runner measures it rather than asserting it. The old vocabulary scored `type` and `scope`, so a pair can reach the threshold on shared metadata while its content stays distinct. Of the 108 active C candidates, **12** fall below 0.8 on content alone — the widest gap being 0.813 metadata against 0.792 content. Every one of them is a `pr-watch` cursor row differing by a run timestamp: near-copies by any reading, pushed just over the line by metadata rather than pulled there by unrelated content.

The failure `fc59b84` actually fixed needs a different shape — two unrelated rows sharing one `snake_case` scope, whose tokens the identifier tokenizer splits into words that stand in for content. This store has **zero** scopes containing an underscore, so the shape cannot occur here at all. That is why the fixture, not this replay, is the evidence for that fix.

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
scan. The `BabylonDocs` pair is filed as a threshold-quality issue: it is the one thing this replay
actually measured.

One mechanism worth naming, confirmed independently during review: the write gate's duplicate check is
exact and keyed by type, while this pass compares across types. Identical prose filed once as a
`context` and once as a `decision` is therefore promoted twice and stays active twice — which is how
the `gufo-ops` pair above got there, and why the pass is not redundant with the gate.

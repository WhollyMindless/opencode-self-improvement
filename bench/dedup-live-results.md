# Window dedup replayed against the live store

Measured 2026-11-19 on the maintainer's store, repository key `5699fad3a258`, Bun 1.4.3, no model and no paid seat.
Reproduce: `bun bench/runners/dedup-live-replay.ts [repo-path]`. The runner reads the live store, so it is not a CI job.

## Why this was run

`docs/adr/0002-window-dedup.md` justifies the 0.8 default with a live replay: "0.8 suppresses only near-identical
copies", evidence cited as the `#409` record section 17 and PR #426. That replay predates the vocabulary change in
`fc59b84`, which moved the comparison from `haystack()` (which includes the row's own `type` and `scope`) to
`contentTokens()` (content and keywords only). The ADR cites a live replay without a date or a store, so nobody can
tell whether the sentence still describes anything.

## Method

Group active rows of one repository by scope. For every pair in a scope, apply the shipped guards in the shipped
order — `MIN_CONTENT` on both sides, same polarity, same dropped chunks — then score the pair twice: with the shipped
`contentTokens`, and with the pre-`fc59b84` `haystack` vocabulary. A pair is a suppression candidate when a score
reaches 0.8, because if both rows ever occupy one recall window together, one of them is hidden.

## Result

| | shipped `contentTokens` | pre-`fc59b84` `haystack` |
| --- | ---: | ---: |
| active rows | 1253 | 1253 |
| scopes | 230 | 230 |
| comparable same-scope pairs | 190 | 190 |
| pairs at or above 0.8 | **0** | **0** |
| highest score observed | 0.647 | — |

Same scan with superseded history included, so 1551 rows:

| | count |
| --- | ---: |
| pairs at or above 0.8 | 138 |
| of which at least one side is superseded | **138** |
| highest score observed | 1.000 |

## What this establishes

The active store contains no near-copies at all. The nearest pair in 190 comparable ones sits at 0.647, well under the
threshold. Every pair that does reach 0.8 lives in supersession history, and all 138 of them have a superseded side.

The reason is structural, not lucky. The write gate's supersede path means a near-copy replaces the row it duplicates
rather than coexisting with it, so two near-copies are never both active in one scope. Window dedup therefore has
nothing to do on this store: the condition it was written for is prevented upstream of it.

## What this does not establish

It does not confirm or refute the 0.8 guidance. A replay over a store with zero suppression candidates measures
nothing, in either direction — the same trap the ADR already names for the off-arm ("with default-ON, an unset arm
measures nothing"). The guidance rests on the replay recorded in the `#409` record section 17 on the date it ran, and
that record is the evidence, not this scan.

It also does not evaluate the vocabulary change. Both vocabularies produce the same 138 pairs here, because the pairs
that collide are true content duplicates where metadata adds nothing. The failure `fc59b84` fixed — two unrelated rows
in one snake_case scope scoring 1.0 on scope tokens alone — needs rows that share a scope and nothing else, and this
store's active set does not contain them. The fixture in `test/` is that evidence.

## Consequence for the ADR

The 0.8 line stays, with its date and its store named, so the next reader does not re-run this scan expecting a result
from it.

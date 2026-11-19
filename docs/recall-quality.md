# Recall quality: what the keyword matcher gives up

A keyword matcher finds a memory when the words overlap. That is its whole
trick, and its whole weakness: "how we deploy" and "ship to staging" are the
same fact with no word in common. This file is what that costs, measured, and
what you can do about it at write time.

The headline table stays in the README. Full methodology and all store sizes:
`bench/recall-results.md`, reproduced with `bun run bench:recall`.

## Write-time keywords are the answer to paraphrase

`memory_remember` asks each row for 3–5 `kw` aliases: other names for the same
thing, other verb forms, the literal command. Keywords are indexed and never
rendered into the prompt, so they cost nothing to store and nothing to inject.

**Bench** — the same matcher over the same store, with the only changed
variable being the index:

- strict (zero shared words) R@1 0% → 26%
- near (one overlap) R@1 28% → 67%

A permutation control — every row given someone else's aliases — scores
29%/35%, so the gain is meaning rather than extra tokens. Auto-capture asks for
the same list, so these numbers are measured through the tool path rather than
through capture. The limit is narrowed, not removed.

## Abstaining is a feature

Free-text prompts that share one concept with a memory abstain rather than
force a guess. Wrong top-memory fell to 6%. The cost is silence in cases where
a lucky guess would have been right; `memory_recall` still covers them when you
ask on purpose.

### Explicit exact-keyword lookup

For the 21 transport queries with 10 gold memories and 180 keyword-bearing
distractors, the explicit `memory_recall` tool returned the gold in its first
three results for 14 queries, up from 13 with the ordinary two-concept gate.
The newly recovered query uses `throttling` to find the Redis rate-limit row.
The exception requires a whole authored keyword that occurs in one visible
candidate after scope and type filtering.

The automatic injection scorer remains stricter. With a 300-character budget
it abstains on the throttling query and on two unrelated prompts about CPU
frequency throttling and stadium lighting fixtures. The explicit lookup can
still return an unrelated row when the same word has another meaning.
Reproduce the targeted check with
`bun test test/recall-gate.test.ts -t "transport keyword lookup"`.
The broader injection benchmark above is unchanged.

## Why the default window is 5 rows

A live audit joined 1,090 recall events to their session transcripts. A
returned row at rank 1 shows up in a later tool call at 3.4x the rate of a
random store row, ranks 2–3 at 2.4x, and ranks 11–20 at 1.16x — noise against a
0.129 null. The old default returned 17.7 rows per call, so most of the window
was context nobody read.

At limit 5, recall@1 and recall@3 are unchanged, precision rises 4.1% → 13.1%,
and 74% of the returned characters disappear. Every gold row the cut dropped sat
at ranks 6–20. Pass `limit` for a wider sweep ([#409](https://github.com/abogartz/opencode-self-improvement/issues/409)).

## Caveats on the eval

The dataset is synthetic — 52 memories and 105 queries about a fictional
project — its class mix is deliberately adversarial, and scoring is
single-gold. Read the numbers as a comparison between matchers on one fixed
set, not as a prediction about your repository.

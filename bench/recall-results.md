# Recall quality: shipped matcher vs alternatives (zero dependencies, zero models)

Dataset: 52 gold memories, 105 queries; classes assigned by MEASURED token overlap with the gold (>=2 shared content tokens = lexical, 1 = near, 0 = strict paraphrase). k=3 mirrors the production injection limit. BM25 k1=1.2 b=0.75 fixed before the eval. naive = previous shipped matcher; prod = current shipped matcher (query-side stopword abstention, two-concept evidence gate for free-text queries, IDF-weighted ranking, recency tie-break); prod+kw = the same matcher with each row's authored write-time `kw` aliases indexed (bench/recall-dataset.ts records the authoring rule: keywords come from the memory's own content, never from the queries).

## Store size 50

| Query class | n | naive R@3 | prod R@1 | prod R@3 | BM25 R@1 | BM25 R@3 | prod recovers | BM25 recovers | all miss | prod abstains |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 45 | 100% | 98% | 100% | 98% | 100% | 0 | 0 | 0 | 0 |
| near | 18 | 72% | 28% | 28% | 61% | 89% | 1 | 11 | 2 | 12 |
| strict | 38 | 8% | 0% | 0% | 3% | 5% | 0 | 2 | 36 | 34 |
| **all** | 101 | 60% | 49% | 50% | 55% | 62% | 1 | 13 | 38 | 46 |

Wrong-memory-first (top-1 noise): naive 46% -> prod 6% -> prod+kw 6%.

Vocabulary bridge — same matcher, `kw` aliases indexed (the strict wall is what it attacks):

| Query class | n | prod R@1 | prod+kw R@1 | prod R@3 | prod+kw R@3 | kw recovers | prod abstains | prod+kw abstains |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 45 | 98% | 98% | 100% | 100% | 0 | 0 | 0 |
| near | 18 | 28% | 67% | 28% | 72% | 8 | 12 | 3 |
| strict | 38 | 0% | 24% | 0% | 24% | 9 | 34 | 27 |
| **all** | 101 | 49% | 64% | 50% | 66% | 17 | 46 | 30 |

Efficiency — R@3 hits per 1k injected characters (window k=3; abstention = a miss that costs nothing):

> How to read this: a matcher that abstains spends no characters, so its ratio flatters it — prod's decent per-1k next to a 0% R@3 IS the abstention strategy: few bytes, few answers, and a turn that learned nothing. Read hits-per-1k together with total characters: the bridge costs roughly 30% more injected bytes at store 200 (~60% at 50) and returns slightly MORE hits per 1k than abstention, because the bytes it does spend land on rows that answer.

| Query class | n | chars prod | chars prod+kw | naive /1k | prod /1k | prod+kw /1k | BM25 /1k |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 45 | 6216 | 7193 | 3.11 | 7.24 | 6.26 | 3.22 |
| near | 18 | 904 | 2795 | 2.18 | 5.53 | 4.65 | 2.73 |
| strict | 38 | 616 | 2292 | 0.24 | 0.00 | 3.93 | 0.17 |
| **all** | 101 | 7736 | 12280 | 1.85 | 6.46 | 5.46 | 1.97 |

Negative controls (the metric must rank, not always pass):

| Arm | R@1 | R@3 |
| --- | ---: | ---: |
| prod (shipped) | 49% | 50% |
| prod + authored kw | 64% | 66% |
| naive (previous) | 50% | 60% |
| prod + shuffled kw (control: same tokens, wrong meanings), must be lower than prod | 28% | 50% |
| constant (control), must be lower than prod | 3% | 7% |
| anti-naive (control), must be lower than prod | 12% | 20% |

## Store size 200

| Query class | n | naive R@3 | prod R@1 | prod R@3 | BM25 R@1 | BM25 R@3 | prod recovers | BM25 recovers | all miss | prod abstains |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 48 | 94% | 98% | 98% | 98% | 98% | 2 | 0 | 1 | 0 |
| near | 18 | 72% | 28% | 28% | 56% | 78% | 1 | 9 | 4 | 12 |
| strict | 39 | 5% | 0% | 0% | 3% | 3% | 0 | 1 | 38 | 35 |
| **all** | 105 | 57% | 50% | 50% | 55% | 59% | 3 | 10 | 43 | 47 |

Wrong-memory-first (top-1 noise): naive 49% -> prod 6% -> prod+kw 6%.

Vocabulary bridge — same matcher, `kw` aliases indexed (the strict wall is what it attacks):

| Query class | n | prod R@1 | prod+kw R@1 | prod R@3 | prod+kw R@3 | kw recovers | prod abstains | prod+kw abstains |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 48 | 98% | 98% | 98% | 98% | 1 | 0 | 0 |
| near | 18 | 28% | 67% | 28% | 72% | 8 | 12 | 3 |
| strict | 39 | 0% | 26% | 0% | 26% | 10 | 35 | 27 |
| **all** | 105 | 50% | 66% | 50% | 67% | 19 | 47 | 30 |

Efficiency — R@3 hits per 1k injected characters (window k=3; abstention = a miss that costs nothing):

> How to read this: a matcher that abstains spends no characters, so its ratio flatters it — prod's decent per-1k next to a 0% R@3 IS the abstention strategy: few bytes, few answers, and a turn that learned nothing. Read hits-per-1k together with total characters: the bridge costs roughly 30% more injected bytes at store 200 (~60% at 50) and returns slightly MORE hits per 1k than abstention, because the bytes it does spend land on rows that answer.

| Query class | n | chars prod | chars prod+kw | naive /1k | prod /1k | prod+kw /1k | BM25 /1k |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 48 | 18966 | 18896 | 2.36 | 2.48 | 2.49 | 2.48 |
| near | 18 | 2163 | 5747 | 1.93 | 2.31 | 2.26 | 2.03 |
| strict | 39 | 1549 | 4552 | 0.14 | 0.00 | 2.20 | 0.07 |
| **all** | 105 | 22678 | 29195 | 1.49 | 2.29 | 2.40 | 1.54 |

Negative controls (the metric must rank, not always pass):

| Arm | R@1 | R@3 |
| --- | ---: | ---: |
| prod (shipped) | 50% | 50% |
| prod + authored kw | 66% | 67% |
| naive (previous) | 50% | 57% |
| prod + shuffled kw (control: same tokens, wrong meanings), must be lower than prod | 29% | 35% |
| constant (control), must be lower than prod | 3% | 7% |
| anti-naive (control), must be lower than prod | 0% | 0% |

## Store size 500

| Query class | n | naive R@3 | prod R@1 | prod R@3 | BM25 R@1 | BM25 R@3 | prod recovers | BM25 recovers | all miss | prod abstains |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 48 | 94% | 98% | 98% | 98% | 98% | 2 | 0 | 1 | 0 |
| near | 18 | 72% | 28% | 28% | 72% | 78% | 1 | 9 | 4 | 12 |
| strict | 39 | 5% | 0% | 0% | 3% | 3% | 0 | 1 | 38 | 35 |
| **all** | 105 | 57% | 50% | 50% | 58% | 59% | 3 | 10 | 43 | 47 |

Wrong-memory-first (top-1 noise): naive 49% -> prod 6% -> prod+kw 7%.

Vocabulary bridge — same matcher, `kw` aliases indexed (the strict wall is what it attacks):

| Query class | n | prod R@1 | prod+kw R@1 | prod R@3 | prod+kw R@3 | kw recovers | prod abstains | prod+kw abstains |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 48 | 98% | 98% | 98% | 98% | 1 | 0 | 0 |
| near | 18 | 28% | 61% | 28% | 67% | 8 | 12 | 3 |
| strict | 39 | 0% | 26% | 0% | 26% | 10 | 35 | 27 |
| **all** | 105 | 50% | 65% | 50% | 66% | 19 | 47 | 30 |

Efficiency — R@3 hits per 1k injected characters (window k=3; abstention = a miss that costs nothing):

> How to read this: a matcher that abstains spends no characters, so its ratio flatters it — prod's decent per-1k next to a 0% R@3 IS the abstention strategy: few bytes, few answers, and a turn that learned nothing. Read hits-per-1k together with total characters: the bridge costs roughly 30% more injected bytes at store 200 (~60% at 50) and returns slightly MORE hits per 1k than abstention, because the bytes it does spend land on rows that answer.

| Query class | n | chars prod | chars prod+kw | naive /1k | prod /1k | prod+kw /1k | BM25 /1k |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 48 | 18966 | 18896 | 2.36 | 2.48 | 2.49 | 2.48 |
| near | 18 | 2163 | 5798 | 1.93 | 2.31 | 2.07 | 2.03 |
| strict | 39 | 1549 | 4552 | 0.14 | 0.00 | 2.20 | 0.07 |
| **all** | 105 | 22678 | 29246 | 1.49 | 2.29 | 2.36 | 1.54 |

Negative controls (the metric must rank, not always pass):

| Arm | R@1 | R@3 |
| --- | ---: | ---: |
| prod (shipped) | 50% | 50% |
| prod + authored kw | 65% | 66% |
| naive (previous) | 50% | 57% |
| prod + shuffled kw (control: same tokens, wrong meanings), must be lower than prod | 30% | 36% |
| constant (control), must be lower than prod | 3% | 7% |
| anti-naive (control), must be lower than prod | 0% | 0% |


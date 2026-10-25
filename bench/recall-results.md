# Recall quality: shipped matcher vs alternatives (zero dependencies, zero models)

Dataset: 52 gold memories, 105 queries; classes assigned by MEASURED token overlap with the gold (>=2 shared content tokens = lexical, 1 = near, 0 = strict paraphrase). k=3 mirrors the production injection limit. BM25 k1=1.2 b=0.75 fixed before the eval. naive = previous shipped matcher; prod = current shipped matcher (query-side stopword abstention, two-concept evidence gate for free-text queries, IDF-weighted ranking).

## Store size 50

| Query class | n | naive R@3 | prod R@1 | prod R@3 | BM25 R@1 | BM25 R@3 | prod recovers | BM25 recovers | all miss | prod abstains |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 45 | 100% | 98% | 100% | 98% | 100% | 0 | 0 | 0 | 0 |
| near | 18 | 72% | 28% | 28% | 61% | 89% | 1 | 11 | 2 | 12 |
| strict | 38 | 8% | 0% | 0% | 3% | 5% | 0 | 2 | 36 | 34 |
| **all** | 101 | 60% | 49% | 50% | 55% | 62% | 1 | 13 | 38 | 46 |

Wrong-memory-first (top-1 noise): naive 46% -> prod 6%.

Negative controls (the metric must rank, not always pass):

| Arm | R@1 | R@3 |
| --- | ---: | ---: |
| prod (shipped) | 49% | 50% |
| naive (previous) | 50% | 60% |
| constant (control, must be lower) | 3% | 7% |
| anti-naive (control, must be lower) | 12% | 20% |

## Store size 200

| Query class | n | naive R@3 | prod R@1 | prod R@3 | BM25 R@1 | BM25 R@3 | prod recovers | BM25 recovers | all miss | prod abstains |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 48 | 94% | 98% | 98% | 98% | 98% | 2 | 0 | 1 | 0 |
| near | 18 | 72% | 28% | 28% | 56% | 78% | 1 | 9 | 4 | 12 |
| strict | 39 | 5% | 0% | 0% | 3% | 3% | 0 | 1 | 38 | 35 |
| **all** | 105 | 57% | 50% | 50% | 55% | 59% | 3 | 10 | 43 | 47 |

Wrong-memory-first (top-1 noise): naive 49% -> prod 6%.

Negative controls (the metric must rank, not always pass):

| Arm | R@1 | R@3 |
| --- | ---: | ---: |
| prod (shipped) | 50% | 50% |
| naive (previous) | 50% | 57% |
| constant (control, must be lower) | 3% | 7% |
| anti-naive (control, must be lower) | 0% | 0% |

## Store size 500

| Query class | n | naive R@3 | prod R@1 | prod R@3 | BM25 R@1 | BM25 R@3 | prod recovers | BM25 recovers | all miss | prod abstains |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 48 | 94% | 98% | 98% | 98% | 98% | 2 | 0 | 1 | 0 |
| near | 18 | 72% | 28% | 28% | 72% | 78% | 1 | 9 | 4 | 12 |
| strict | 39 | 5% | 0% | 0% | 3% | 3% | 0 | 1 | 38 | 35 |
| **all** | 105 | 57% | 50% | 50% | 58% | 59% | 3 | 10 | 43 | 47 |

Wrong-memory-first (top-1 noise): naive 49% -> prod 6%.

Negative controls (the metric must rank, not always pass):

| Arm | R@1 | R@3 |
| --- | ---: | ---: |
| prod (shipped) | 50% | 50% |
| naive (previous) | 50% | 57% |
| constant (control, must be lower) | 3% | 7% |
| anti-naive (control, must be lower) | 0% | 0% |


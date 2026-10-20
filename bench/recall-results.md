# Recall quality: shipped matcher vs alternatives (zero dependencies, zero models)

Dataset: 52 gold memories, 105 queries; classes assigned by MEASURED token overlap with the gold (>=2 shared content tokens = lexical, 1 = near, 0 = strict paraphrase). k=3 mirrors the production injection limit. BM25 k1=1.2 b=0.75 fixed before the eval. naive = pre-2026-10-20 shipped matcher; prod = current shipped matcher (query-side stopword abstention).

## Store size 50

| Query class | n | naive R@3 | prod R@1 | prod R@3 | BM25 R@1 | BM25 R@3 | prod recovers | BM25 recovers | all miss | prod abstains |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 45 | 100% | 100% | 100% | 98% | 100% | 0 | 0 | 0 | 0 |
| near | 18 | 72% | 44% | 89% | 61% | 89% | 4 | 2 | 0 | 0 |
| strict | 38 | 8% | 0% | 0% | 3% | 5% | 0 | 2 | 36 | 13 |
| **all** | 101 | 60% | 52% | 60% | 55% | 62% | 4 | 4 | 36 | 13 |

Wrong-memory-first (top-1 noise): naive 46% -> prod 33%.

## Store size 200

| Query class | n | naive R@3 | prod R@1 | prod R@3 | BM25 R@1 | BM25 R@3 | prod recovers | BM25 recovers | all miss | prod abstains |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 48 | 94% | 100% | 100% | 98% | 98% | 3 | 0 | 0 | 0 |
| near | 18 | 72% | 44% | 83% | 56% | 78% | 4 | 3 | 0 | 0 |
| strict | 39 | 5% | 0% | 0% | 3% | 3% | 0 | 1 | 38 | 13 |
| **all** | 105 | 57% | 53% | 60% | 55% | 59% | 7 | 4 | 38 | 13 |

Wrong-memory-first (top-1 noise): naive 49% -> prod 34%.

## Store size 500

| Query class | n | naive R@3 | prod R@1 | prod R@3 | BM25 R@1 | BM25 R@3 | prod recovers | BM25 recovers | all miss | prod abstains |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 48 | 94% | 100% | 100% | 98% | 98% | 3 | 0 | 0 | 0 |
| near | 18 | 72% | 44% | 83% | 72% | 78% | 4 | 3 | 0 | 0 |
| strict | 39 | 5% | 0% | 0% | 3% | 3% | 0 | 1 | 38 | 13 |
| **all** | 105 | 57% | 53% | 60% | 58% | 59% | 7 | 4 | 38 | 13 |

Wrong-memory-first (top-1 noise): naive 49% -> prod 34%.


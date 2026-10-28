# Injection cost — measured

Reproduce with `bun bench/inject-cost.ts` (deterministic: fixed-seed LCG,
synthetic timestamps, no wall clock in the output — reruns are byte-identical).
The numbers come from the plugin's real injection code (`src/inject.ts`):
a seeded store of 50 memories, a simulated session of
20 user prompts with 3 mid-session store writes, and the default
1200-character budget. Every column is measured on the FULL memory section
(digest + frontier + relevance block) — the bytes a request actually sends,
because prompt caching is a property of those bytes and not of the block alone.

| Policy | Recomputes | Cache busts | Injected chars (20 turns) | Avg/turn | Worst section |
| --- | ---: | ---: | ---: | ---: | ---: |
| A — recompute per prompt, uncapped (naive) | 20 | 19 | 60996 | 3049.8 | 3404 |
| B — block frozen on store fingerprint, digest rebuilt per turn (pre-#162) | 4 | 3 | 55478 | 2773.9 | 2867 |
| C — section frozen on rendered bytes (shipped) | 4 | 3 | 55258 | 2762.9 | 2856 |

A "cache bust" is a turn whose memory-section bytes differ from the turn
before: each one re-bills the whole conversation as fresh input. On this
workload all three mid-session writes turn out to be visible — a new row shifts
the document frequencies and reorders the top-5 — so B and C agree here. The
difference is what a write the session CANNOT see costs: under B the digest
carried the row count and the latest timestamp, so it busted anyway; under C it
costs nothing. That case is pinned by `test/epoch.test.ts` ("a write that
changes nothing rendered costs ZERO cache busts"), which fails against the
pre-#162 policy. C also injects 9.4% fewer characters than the naive
policy.

Compaction anchor (capped at 2500 chars): 2304 chars,
pushed once per compaction rather than per turn.

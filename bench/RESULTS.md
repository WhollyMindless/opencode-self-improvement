# Injection cost — measured

Reproduce with `bun bench/inject-cost.ts` (deterministic: fixed-seed LCG,
synthetic timestamps, no wall clock in the output — reruns are byte-identical).
The numbers come from the plugin's real injection code (`src/inject.ts`):
a seeded store of 50 memories, a simulated session of
20 user prompts with 3 mid-session store writes, and the default
1200-character budget.

| Policy | Recomputes | Injected chars (20 turns) | Avg/turn | Worst block |
| --- | ---: | ---: | ---: | ---: |
| A — recompute per prompt, uncapped (pre-0.2) | 20 | 27748 | 1387.4 | 1575 |
| B — epoch freeze + 1200-char cap (0.2) | 4 | 20654 | 1032.7 | 1157 |

Policy B injects 25.6% fewer characters on this workload. The bigger
saving is invisible in this table: B's block is byte-identical between store
changes, so the system prefix — and with it the provider prompt cache —
survives ordinary turns instead of being invalidated on every prompt.

Compaction anchor (Phase 3 block, capped at 2500 chars): 2249 chars,
pushed once per compaction rather than per turn.

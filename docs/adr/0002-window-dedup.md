# ADR 0002 — Near-duplicate suppression inside the recall window

Status: accepted (2026-11). Code: `src/recall/dedupe.ts`. Flag: `OPENCODE_MEMORY_DEDUP`.

## Decision

One deterministic pass after ranking: skip a candidate whose content-token Jaccard against an already-kept row of the same scope reaches the threshold (default 0.8, ON). The newest copy of a clash takes the slot.

## Why

The live store carries repeated rows — superseded snapshots, cursor rows differing only by a timestamp, the same decision restated after a compaction — and the matcher scores them alike. With a fixed window they crowd out distinct facts, which breaks composition: two memories a later task needs together rarely fit side by side because the first one's copies take the slots. Recency decides because the duplicates are stale by construction.

## History

- Threshold guidance from the live replay: 0.5–0.7 suppresses rows that are merely related (92% of them at 0.5) and forces the window deep into the ranking; 0.8 suppresses only near-identical copies. Values below 0.5 are a misconfiguration, not an aggressive setting — at Jaccard 1e-9 a single shared fragment suppressed rows.
- The first version made four mistakes, each now pinned by a test:
  1. It scored `type` and `scope` as tokens, so same-scope rows shared two free tokens and short rows looked like copies of each other.
  2. It compared whole token sets, so a prohibition read as a copy of the permission it denies: "force push main" inside "never force push main" reaches Jaccard 0.833 and the wrong copy survived.
  3. It had no floor. Non-Latin prose tokenises to nothing under `words()`, so two unrelated Chinese rows in one scope both reduced to the empty set; the pre-floor version scored them on type and scope alone at 1.0 and deleted the second row.
  4. It treated differing numeric facts as duplicates: short tokens are dropped, so "DB 3" and "DB 4" share identical token sets and the older row was suppressed even at threshold 1.
- Default-ON followed the same rule as ADR 0001: a quality fix behind an opt-in flag is not a fix.
- Evidence: live-store replay published in the #409 record (§17) and PR #426. The replay's off-arm must set `OPENCODE_MEMORY_DEDUP=0` explicitly — with default-ON, an unset arm measures nothing.
- Re-measured 2026-11-19 over the window a repository actually reads — its own rows plus rows carrying no repository stamp (`bun bench/runners/dedup-live-replay.ts`; written up in the [live dedup replay](https://github.com/abogartz/opencode-self-improvement/blob/main/bench/dedup-live-results.md), whose counts are a dated snapshot because the store drifts). The scan neither confirms nor refutes 0.8: among the repository's own active rows no pair reaches the threshold, and once superseded history is included every candidate has a superseded side. It found two other things, and they are the useful part. Near-identical rows can stay active together: the write gate's duplicate check is exact and keyed by type, while this pass compares across types, so identical prose filed as two types lands twice and stays active. This pass is therefore not redundant with the gate. And the pass is inert on the repository's own rows because of its guards, not because the store is clean: of the pairs the pre-`fc59b84` rule would have suppressed, the dropped-chunk guard stops nearly all and the content floor the rest.
- Known limitation, from that same replay: 0.8 suppresses a pair that is not a copy. Two active rows naming two different build commands in one scope score 0.824 and pass every guard, so one of them loses its slot and the command disappears from the reader's view. The threshold trades that against crowding; where a scope holds parallel short facts, it costs real information.

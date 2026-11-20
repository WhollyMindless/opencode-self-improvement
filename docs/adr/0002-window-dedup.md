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
- Known limitation, from that same replay: 0.8 suppresses a pair that is not a copy. Two active rows naming two different build commands in one scope score 0.824 and pass every guard. Ranking favors recency and the pass keeps the first-ranked row of a clash, so the survivor is the newer, narrower command and the plain build command is what disappears from the reader's view. The threshold trades that against crowding; where a scope holds parallel short facts, it costs real information.
- Raising the default was evaluated on 2026-11-19 and rejected. The pair worth releasing scores 0.8235; the changed-fact pair pinned in `test/recall/dedupe-tool.test.ts` — the same runbook sentence with `friday` replaced by `monday` — scores 0.8333. Any threshold separating them must sit in a window one hundredth wide, which is a constant fitted to two observations, and 0.9 releases both and removes the recency rule above. The two rows have the same shape: one sentence, one long token swapped out. Whether that swap replaced a fact or added one is not visible in a token overlap, so this is not a threshold problem.
- The dropped-chunk guard, not the threshold, decides what this pass ever sees. Two rows differing by a timestamp have different dropped fragments and are never compared, so the cursor rows this record names as the motivation are exempt, while prose carrying no short fragments at all is compared and can be suppressed on shape alone.


## Addition groups

A clash is not always a copy. `classifyPair` reads the leftover token sets and splits three cases:
`identical` (nothing left over — one row typed twice), `addition` (one side wholly contained — the
rows name different things, so both hold), `substitution` (a leftover on each side). Only `addition`
is decidable from containment, and only `addition` keeps both rows; it takes an extra slot and the
handler marks the pair with `AMBIGUOUS` rather than deciding silently. Flag:
`OPENCODE_MEMORY_AMBIGUOUS`, on by default.

`substitution` is an interpretation, not a decision, and its absence of containment is not evidence
of a correction. Two instructions naming two scripts that both exist — `bun run bench:recall` and
`bun run bench:write` — leave a leftover on each side, score 0.882, and the older is dropped. That
predates the split and the split does not fix it: the pass has no way to learn from a row's text that
both scripts are real. It is the remaining limitation of the rule, and the reason the group marker
exists at all — where the classifier can see both readings are possible, it says so instead of
choosing.

# The use ledger

A due-date card for every row: who looked at it, when, and how it reached them.
It answers one question you cannot answer any other way — is this memory
earning its place, or has nothing touched it in six months?

The ledger is `<memory-root>/hits.logfmt`: append-only, rotated at 2 MB, never
ingested as a memory, and reported in `memory_status` and the `/memory` panel.

## What it looks like

Illustrative output — shape, not a measurement:

```
STORE
  41 active · 12 superseded · 4 open · 6 scopes
  retrieved 33 rows in the last 30d; never retrieved 8 (20%) — reported, not acted on
  outcome-linked 7 rides over 3 rows: 3 clean row/turns, 2 failed row/turns (store-wide)
  1 candidate at ≥5 rides with no clean turn — best-effort counts are floors since 2026-11-01T10:00:00.000Z; correlation on the ride's own turn, reported, never acted on
  outcome writes dropped for this store by this process: 0
    2026-10-31T14:05:00.000Z used=5 clean=0 fail_after=2 unknown=2 (eviction candidate)
  24.1 KB total · 604 B per row · 1.3 rows/day (30d)
```

## What counts as use

Credit comes from three distinct sources, because "the model asked" and "the
harness offered" are different facts:

1. the row rode the injected block;
2. `memory_recall` returned it;
3. a pull appended it to a grep/glob/read result — searched against that call's
   arguments plus the first 512 characters of what the tool printed, so a row can
   be credited here for something the model had not asked about yet
   (`pullOutputChars` in [docs/reference/options.md](../reference/options.md) dials it back).

Credit is recorded only when the bytes were actually placed on the result. When a
pull computed rows and found nowhere to write them, the evidence log gets a
`pull_undelivered` line instead — a host that changes its result shape should show
up as a failure, not as a quieter ledger.

The writer throttles identical sets of retrieved rows to one successful line
per session and source per hour. A row can appear in multiple sets.

**No prompt content is stored.** The ledger keeps a scan-truncated string from
the *memory* side, never your message.

## What happens after retrieval

Each `memory_used` line records the turn number and turn key when available.
Each classified gate check appends a separate `ev=gate_outcome` line with
the session, turn, key, timestamp, command family and `outcome=clean|fail`.
The chat report aggregates those observations on read. On each row, `used`
counts recorded rides. `clean` and `fail_after` count distinct turns with
a classified gate after a ride. A later failure takes precedence over passes.
`unknown` counts rides without a usable later gate on that turn, including
legacy rides without a turn key when no compatible outcome exists.
Multiple rides on one turn can therefore contribute one measured turn.

The ledger drops old lines at rotation and can miss writes under contention.
The counts describe the retained observations. The dropped-outcome counter
covers failed writes in the reporting process for this store. It resets on
restart and excludes failures in other processes. A zero cannot establish
complete history.

A row becomes an eviction candidate after five recorded rides if at least
one ride has a measured outcome and none has a clean turn. A subsequent
failure can be unrelated to the row. Inspect the row and its use before
deciding whether to retire it. The report makes no store changes.

## What use is allowed to do

Reinforcement is a tie-break only (`useBoost ≤ 1.0`): a recently used row wins a
tie and can never outrank a real score gap. In consolidation, the most recently
used member of a cluster is never the merge loser.

`never retrieved` is stated, not acted on. Pruning is your decision, and retired
rows cannot inherit reinforcement: ledger rows are verified against the store on
read.

## Whose numbers these are

Aggregate STORE counts are machine-wide by decision (#213 B): they count every
repository's rows in the shared store on this machine, never just the reading
session's repository. The numbers describe the store, not your slice of it.

Outcome totals and candidate counts also cover every repository. The chat report
shows up to 20 reader-visible row IDs, prioritizing candidates. The omitted
count covers additional visible rows.

Privacy applies to the content surfaces instead. `memory_evidence` and the
recent-blocked-writes list in `memory_status` and `/memory` follow each reader's
repository visibility (#306).

## Capture lag

Capture lag is how stale the newest message was when auto-capture fired. The
line prints only when at least one `capture_lag` sample exists, which needs
auto-capture to have fired.

# The mutation sweep: what the suite actually pins (issue #70)

One question, answered mechanically: when an invariant dies, does anything die with it? Each mutant breaks
exactly ONE claimed invariant in a detached scratch worktree of HEAD and runs the full suite against that tree.
A mutant nothing kills is an invariant the suite does not actually depend on, whatever the test titles claim.

**Run:** main @ `7c4a22d` (0.13.0), Windows, Bun 1.3.10, 43 mutants, one run each with 3-run confirmation for
timing-only evidence. Baseline (clean tree) first: **457 pass / 4 fail / 5 skip** — the 4 known-red races are
measured once and excluded from every kill verdict, so only DELTA failures count as kills. A kill resting only
on timing-sensitive tests is confirmed to 3 runs; unstable = timing luck, reported, not credited. Every mutant
flagged unstable/timing, plus every survivor, was then re-run on a quiet machine (`--mutant=` ×5); two verdicts
flipped in that pass and the table reflects the quiet verdicts (see Method notes). Equivalents
are excluded from the denominator, and the tool warns when an equivalent-marked mutant dies — that warning
already disproved one entry of #70 itself: the `undo.ts` containment branch finding 3 called a "dead branch"
is reached and killed (`undo.test.ts`), and the catalog no longer marks it equivalent.

## Score

**38/42 = 90.5%** canonical (43 mutants, 1 excluded equivalent, 0 load-errors). Full status table:

| status | runs | mutant | class | invariant | killed by |
| --- | --- | --- | --- | --- | --- |
| killed | 1/1 | `lock-noexcl-mutex` | D2 | lock file is created with O_EXCL: the mutex is cross-process | concurrency.test.ts, lock.test.ts, scenarios-consistency.test.ts |
| killed | 1/1 | `lock-no-stale-steal` | guard | a lock abandoned by a dead process is taken over after age | concurrency.test.ts, lock.test.ts, scenarios-consistency.test.ts |
| killed | 3/3 | `lock-restore-failopen` | D2 | restore fails CLOSED on a busy store, because force drops rows | concurrency.test.ts, scenarios-consistency.test.ts |
| survived | 0/1 | `publish-rename-to-truncate` | D2 | whole-file publishes hand over by rename: readers (no lock) | ΓÇö |
| killed | 1/1 | `append-truncate-regression` | D2 | appends are one O_APPEND write, never a replacing write | boundaries.test.ts, capture.test.ts, compaction.test.ts, concurrency.test.ts, consolidate-tool.te... |
| killed | 3/3 | `append-nolock` | D2 | appends hold the store lock: none lands inside an RMW window | concurrency.test.ts, scenarios-consistency.test.ts |
| killed | 1/1 | `supersede-rmw-nolock` | D2 | supersede is a locked read-modify-write (stampRow) | concurrency.test.ts, consolidate-tool.test.ts, scenarios-consistency.test.ts |
| killed | 3/3 | `prune-nolock` | D2 | prune filters and republishes under the store lock | concurrency.test.ts, scenarios-consistency.test.ts |
| killed | 1/1 | `prune-repofloor-off` | guard | forget never deletes another repo's row for the same scope | concurrency.test.ts, repo-scope.test.ts |
| killed | 1/1 | `blocklist-poison-filter-off` | guard | blocked (poisoned) rows are filtered from every read path | epoch.test.ts, negative-eval.test.ts, scenarios-consistency.test.ts, undo.test.ts, viewer.test.ts |
| killed | 1/1 | `malformed-ts-guard-and` | guard | a non-ISO ts is malformed: skipped, never an addressable row | boundaries.test.ts, concurrency.test.ts |
| killed | 1/1 | `redact-chokepoint-off` | guard | secrets are redacted at the single write choke point | concurrency.test.ts, viewer.test.ts, write-caps.test.ts |
| killed | 1/1 | `metadata-secret-guard-off` | guard | credential-shaped metadata is refused, not stored | keywords.test.ts, scenarios-consistency.test.ts, write-caps.test.ts |
| survived | 2/3 | `snapshot-overwrite` | D4 | claimSnapshot bumps names with O_EXCL: a snapshot is never | ΓÇö |
| killed | 1/1 | `visible-global-off` | guard | repo visibility: explicitly-global rows stay visible everyw... | repo-scope.test.ts |
| killed | 1/1 | `undo-force-safety-removed` | D4 | force-restore snapshots what it drops, inside the lock: | concurrency.test.ts, scenarios-consistency.test.ts, scenarios-scripted.test.ts, undo.test.ts |
| killed | 1/1 | `undo-force-safety-after-publish` | D4 | the safety copy is taken BEFORE the publish that drops rows | concurrency.test.ts, scenarios-consistency.test.ts, scenarios-scripted.test.ts, undo.test.ts |
| killed | 1/1 | `undo-check-mutates` | D1 | check mode never writes: a diverged store is refused, untou... | scenarios-consistency.test.ts, undo.test.ts |
| killed | 1/1 | `undo-escapes-root-branch` | D3 | containment: the requested snapshot path stays in snapshots/ | scenarios-consistency.test.ts, undo.test.ts |
| killed | 1/1 | `budget-overlong-breaks-scan` | pure | capToBudget skips over-long lines and keeps scanning the rest | concurrency.test.ts, epoch.test.ts |
| killed | 1/1 | `budget-dangling-header` | pure | a block trimmed down to headers is dropped, never injected | epoch.test.ts, scenarios-consistency.test.ts |
| equivalent | - | `budget-header-fit-boundary` | pure | a header exactly the size of the budget still counts as fit... | ΓÇö |
| killed | 1/1 | `repokey-colon-form` | pure | every transport form of one remote hashes to one repo key | repo-scope.test.ts, scenarios-consistency.test.ts |
| killed | 3/3 | `viewer-snapshot-grammar-off` | D3 | restore names are pinned to the snapshot grammar at the wire | concurrency.test.ts, scenarios-consistency.test.ts |
| killed | 1/1 | `viewer-host-guard-off` | guard | the loopback viewer rejects foreign Host headers (DNS rebin... | concurrency.test.ts, scenarios-consistency.test.ts, viewer.test.ts |
| killed | 1/1 | `viewer-content-type-off` | guard | writes must be application/json (cross-site form refusal) | viewer.test.ts |
| killed | 1/1 | `lock-noop` | D2 | whole-file rewrites are serialized per store file | concurrency.test.ts, lock.test.ts, scenarios-consistency.test.ts |
| killed | 1/1 | `lock-release-blind` | D2 | a holder never deletes a lock another process took over | lock.test.ts, scenarios-consistency.test.ts |
| survived | 0/1 | `lock-default-fail` | D1 | an ordinary write proceeds rather than losing the write | ΓÇö |
| killed | 1/1 | `lock-default-fail-queued` | D1 | a queued ordinary write proceeds rather than losing the write | lock.test.ts, scenarios-consistency.test.ts |
| killed | 1/1 | `restore-merge-drops` | D4 | merge restores the snapshot AND keeps concurrently written ... | concurrency.test.ts, scenarios-consistency.test.ts, undo.test.ts |
| survived | 1/3 | `restore-escapes-root` | D3 | a restore cannot write outside the memory root | ΓÇö |
| killed | 1/1 | `row-ts-any` | guard | a row whose ts is not an ISO instant is not addressable | boundaries.test.ts, concurrency.test.ts, scenarios-consistency.test.ts |
| killed | 1/1 | `repo-floor-off` | guard | another repo's rows never surface or get deleted here | negative-eval.test.ts, repo-scope-session.test.ts, repo-scope.test.ts, scenarios-consistency.test.ts |
| killed | 1/1 | `content-cap-off` | guard | nothing oversized is persisted (append floor) | write-caps.test.ts |
| killed | 1/1 | `gate-blocks-ignored` | D1 | a write rejected by a gate never reaches the store | concurrency.test.ts, frontier.test.ts, gated-injection.test.ts, negative-eval.test.ts, path-refs.... |
| killed | 1/1 | `gate-dupes-promoted` | D1 | a near-duplicate is collapsed, not stored twice | capture.test.ts, concurrency.test.ts, gated-injection.test.ts, init.test.ts, keywords.test.ts, po... |
| killed | 1/1 | `gate-content-cap-off` | guard | oversized content is blocked with a reason, not stored | concurrency.test.ts, write-caps.test.ts |
| killed | 1/1 | `inject-one-token-shared` | pure | free-text prompts need two shared concepts to inject | concurrency.test.ts, consolidate-bench.test.ts, inject.test.ts, keywords.test.ts, negative-eval.t... |
| killed | 1/1 | `inject-frontier-uncapped` | pure | only the newest open threads are surfaced | frontier.test.ts, scenarios-consistency.test.ts |
| killed | 1/1 | `viewer-origin-guard-off` | guard | cross-origin writes to the viewer are refused | viewer.test.ts |
| killed | 1/1 | `import-frontier-any-version` | guard | a newer export header does not grant the frontier exemption | portable.test.ts |
| killed | 1/1 | `import-open-status-unconditional` | guard | status:open is honored only under its guards (export header... | injection-framing.test.ts, portable.test.ts |

Score: **38/42 = 90.5%** (43 mutants, 1 excluded equivalent).

## Unpinned invariants (the audit's output)

Four invariants the suite does not currently defend. None is a live bug found; each is a promise the tests
would not notice being broken — the cheap pins are named per mutant:

1. **`publish-rename-to-truncate` [D2]** — replacing the rename handover with a direct `Bun.write(file, ...)`
   dies only in the torn-read races, 1 run in 3: timing luck, not a pin (per #68's D2 rule). The deterministic
   shape exists: stall a publisher between the temp write and the rename, run an unlocked reader mid-publish,
   assert every parse is a complete record. (`test/concurrency.test.ts` already has the machinery.)
2. **`snapshot-overwrite` [D4]** — `open(snap, "w")` instead of `"wx"` is killed only 2 runs in 3 (timing
   luck) here, while it died confirmed 3/3 on the 0.11.x-era tree: the only test that caught it did so by
   timing, and the timing moved. Treat this one as a quiet regression: the pin was never deterministic, so
   0.13.0's reshuffling silently un-pinned it. A deterministic pin is two colliding `claimSnapshot` calls
   asserting both files exist with distinct content.
3. **`lock-default-fail` [D1]** — flipping the default (non-queued) write's lock-loss policy so the write is
   dropped instead of deferred goes unnoticed: nothing deterministic exercises WHAT THE DEFAULT PATH DOES
   WHEN THE LOCK IS BUSY. The queue-path sibling (`lock-default-fail-queued`, split from this same anchor
   when the policy was duplicated) IS killed 1/1 by `lock.test.ts` — the deterministic shape exists and just
   needs the same two lines aimed at the unqueued path. Fair warning on this row's history: run 3 "confirmed"
   it 3/3 killed, but that confirmation ran under background load — load-manufactured reds can pass ×3. The
   quiet re-run says 0/1 and the quiet machine is the only one that gets a vote.
4. **`restore-escapes-root` [D3]** (ported from the original catalog) — the `realpath`-based root-containment
   throw in `restoreTarget` has no test reaching it; the 1/3 kill is timing luck. Reachable shape: a snapshot
   whose `original` resolves outside the memory root (symlink) → refuse. Note the sibling containment branch
   IS killed (`undo-escapes-root-branch`, 1/1) — see the corrected finding 3.

## What changed since the 0.11.x-era run

Two mutants that survived then — `prune-nolock` and `lock-restore-failopen` — are killed now, confirmed 3/3,
by tests that landed since (their killers include `consolidate-tool.test.ts` / `keywords.test.ts` territory).
The scenario suite is tightening faster than the sweep's score moves; that's the loop working.

## Method notes (the honesty rules this run exercised)

- **Baseline subtraction is what makes the sweep runnable on Windows.** The shipped sweep refuses to start
  unless the clean tree is fully green; 4 races are known-red on this platform, so "green-only" means the
  auditor cannot audit exactly where the storage invariants are weakest. Measured knowns subtract; a
  known-red that dies under a mutant is still reported (it's news), it just isn't a kill.
- **Load contaminates in one direction — and confirmation runs are only valid on a quiet machine.** Extra
  machine load manufactures reds (false KILLS); it cannot un-red a real kill. Survivors under load are sound;
  timing-only kills under load are not — and this run proved the corollary the tool didn't assume: a
  load-manufactured kill can PASS a 3-run confirmation if the load persists through it (`lock-default-fail`
  confirmed 3/3 under a stray background process, then died 0/1 quiet). Every timing-flagged row and every
  survivor in this table therefore carries a quiet-machine re-run verdict, not the original one. The
  quiet pass flipped two verdicts: `lock-default-fail` kill→survive, and `viewer-snapshot-grammar-off`
  survive→confirmed-kill — its run-3 green was recorded while the stray process was live, and no run-3-style
  green for it has been seen since. A survivor can be a load artifact too, which is why survivors deserve the
  quiet re-run as much as kills do.
- **Calibration:** `--selftest` plants a mutant in a deliberately under-pinned pure helper and demands a
  kill — a harness that cannot go red is itself a defect.
- **Catalog lineage (corrected 2026-10-26; an earlier claim here said 24+26−5=42 — the measured accounting
  is different, per #110's review):** of the 24 mutants in the tool shipped in `6d1858b`, 19 ids survive into
  the merged catalog; 5 (`lock-never-steal`, `publish-truncate`, `blocklist-visible`, `restore-check-blind`,
  `restore-safety-stale`) were exact-duplicate breaks deduped to their rebuilt sites. With 24 entries built
  for #70 that is **43 patterns + 1 calibration plant**, all anchored exactly once (`--validate` 44/44).
  Two anchors went stale when #89 rewrote the publish path and were re-anchored at the merge
  (`publish-rename-to-truncate` onto `handoverRename`, `undo-force-safety-after-publish` onto the
  `since`-threaded call).

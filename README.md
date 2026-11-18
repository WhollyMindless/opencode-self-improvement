# Opencode-Self-Improvement

Durable memory for [opencode](https://opencode.ai): the decisions, commands and facts an agent should keep across sessions, plus a one-command per-repo setup.

Every memory passes four write gates, injection is budgeted and cache-stable, and nothing is ever deleted — updates supersede and `memory_undo` rolls back.

Every figure in this README carries a provenance marker: **measured** (read off a live store), **bench** (a deterministic synthetic workload, reproducible with the command printed under the table), or **illustrative** (sample output showing shape, not a measurement). A number without a marker is a claim that has not been checked.

## Quick start

**1. Add the plugin** to `~/.config/opencode/opencode.jsonc` (global) or a project `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-self-improvement"]
}
```

**2. Restart opencode.** It installs the package and its dependencies at startup, and the plugin installs its own slash commands. On desktop, a later config edit needs `opencode service restart`: relaunching the app leaves the background service — and the plugin options it already parsed — alive.

**3. Run `/repo-init`** in each repo you work in. It stores the test / build / lint / typecheck commands as memories and records an init stamp tied to the current git head. The stamp is plugin bookkeeping under `<memory-root>/init-stamps/`, not a memory row, so no session can forge it (#374). A store left by an older release migrates once: its `init-stamp` row is honoured only when an `init_complete` audit line names it (and at the head that line names), is then retired, and is withheld from recall and injection either way (#376). Rerun `/repo-init force` after a refactor.

Needs Bun 1.3.0 or newer in the opencode build (the tested floor); older Bun reports a startup warning.

On opencode v2 the CLI works too:

```sh
opencode plugin add opencode-self-improvement
opencode plugin update opencode-self-improvement
```

After that, memory is just conversation: ask the agent to remember something and it sticks.

## What you get

- **`memory_*` tools** — `memory_init`, `memory_remember`, `memory_recall`, `memory_update`, `memory_forget`, `memory_list`, `memory_undo`, `memory_status`, `memory_evidence`, `memory_export`, `memory_import`, `memory_decay`, `memory_consolidate`, `memory_merge_review`.
- **`/repo-init`** — per-repo setup: build/test commands as memories, keyed to the git head.
- **Write gates** — code references are verified against your actual repo, near-duplicates are collapsed, contradictions with superseded memories are rejected. Blocked writes are logged with a reason in `memory_evidence`, which reads one real calendar day inside `evidence/` at a time — its `date` is a date, never a path.
- **Memory-aware compaction** — durable memories are handed to the compaction summarizer, so a long session keeps its facts.
- **Auto-capture (experimental, opt-in)** — in progress and **not working yet**. The design: on the turn-end and compaction triggers, one cheap model pass per trigger proposes candidates, which face the same write gates, with a 5-minute cooldown per session and trigger bounding the spend. What is not true today: it has never been observed firing on a live opencode 2.x store, so enabling it may cost model calls and store nothing. See [Auto-capture is experimental](#auto-capture-is-experimental).
- **Repo scoping** — rows belong to the repo that wrote them; project A's facts never surface in project B.
- **Safe across concurrent sessions** — a whole-file rewrite holds a lock honoured across processes and hands the new file over with an atomic rename. The lock is a SQLite database beside each store file, claimed with `BEGIN IMMEDIATE`, so a process that is killed releases it at once and a normal write creates and deletes nothing ([#407](https://github.com/abogartz/opencode-self-improvement/issues/407)).
- **Decay** — `memory_decay` retires stale open threads. Dry run by default, snapshot-first, undoable.
- **Consolidation** — `memory_consolidate` proposes near-duplicate merges, and only when replaying the store's own use ledger shows the merged row catches at least as many reads as the best single member. It writes nothing.
- **Export / import (JSONL)** — back the store up or move it between machines; every imported row re-enters through the write gates.
- **Surfaces** — a terminal footer badge and `/memory` panel, `/memory-report` for chat clients, a `memory_status` tool, and a browser admin editor. See [Surfaces](#surfaces).
- **Secret redaction** — credential-shaped values in content become `[redacted]`. See [Secret redaction](#secret-redaction).

Memory is stored outside every repository, under `~/.config/opencode/memory` by default (override with `OPENCODE_MEMORY_DIR`). To start over, delete that directory.

A write publishes a **complete replacement file** under a per-file lock, so a concurrent reader sees the previous file or the new one, never a partial record. New store directories are `0700` and new files `0600` on POSIX, subject to a more restrictive umask. A memory root on SMB, NFS or a OneDrive-mounted folder is **not supported** — the lock's write-ahead log needs shared memory that SQLite cannot mmap there. Lock scope and why it is one file rather than the store, the Windows reader handle that can refuse a replacement, permission migration and what it does not revoke: [docs/store-concurrency.md](docs/store-concurrency.md).

## Options

Zero configuration is the default. To tune, use the object form of the plugin entry in `opencode.json(c)`:

```json
{
  "plugins": [{ "package": "opencode-self-improvement", "options": { "injectBudget": 1200, "frontierBudget": 3600 } }]
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `injectBudget` | `1200` | Character cap on the injected relevance block and each contextual pull; trimmed at whole-memory boundaries. Env fallback: `OPENCODE_MEMORY_INJECT_BUDGET`. |
| `frontierBudget` | `3 × injectBudget` | Character cap on the session-start open-threads block. A thread longer than the budget is not injected and is reported as omitted. Env fallback: `OPENCODE_MEMORY_FRONTIER_BUDGET`. |
| `contradictionSurface` | `true` | Experimental: compare guided constant claims with bounded source reads and render a class-specific CONFLICT verdict. Set `false` to skip code checks and retain plain guidance. See [Contradiction authority policy](#contradiction-authority-policy-experimental-349--351). |
| `autoCapture` | `false` | Master switch for auto-capture, which is **experimental and has never fired on a verified live store** — see [Auto-capture is experimental](#auto-capture-is-experimental). Off by default, so the install stays zero-token. |
| `captureModel` | — | `"provider/id"` model used for auto-capture. Required when `autoCapture` is on; missing or invalid disables capture with a startup warning. |
| `captureMax` | `3` | Maximum candidates proposed per capture pass. |
| `captureOnCompact` | `true` | When `autoCapture` is on, also mine the transcript at compaction, before the summarizer replaces it. Its 5-minute cooldown is separate from the turn-end one, so the two triggers' hit-rates stay measurable. Setting it while `autoCapture` is off does nothing and reports a startup warning. |
| `captureGuidedRules` | `false` | POC: deterministic guided-candidate pre-pass. The user's own lines decide which stated values or rules are guided (numbers, rates, currency, explicit rule assertions) and attach the verbatim quote; the capture model may phrase such a row but cannot clear the flag or the quote, and a guided quote the user never wrote is refused at the write boundary instead of silently stripped. Fires alongside the model pass only — no extra model calls. |
| `notifyBlocked` | `true` | Terminal (TUI) only: toast when a write gate blocks a write. Blocks are always in `memory_evidence` either way. |

### Environment variables

| Variable | Purpose |
| --- | --- |
| `OPENCODE_MEMORY_DIR` | Store location (default `~/.config/opencode/memory`). |
| `OPENCODE_MEMORY_ALLOW_OUTSIDE_PATHS` | Operator-only. When truthy, `memory_export`/`memory_import` accept paths anywhere on disk instead of confining themselves to the store. Off by default. See [Export and move between machines](#export-and-move-between-machines). |
| `OPENCODE_MEMORY_INJECT_BUDGET` | Fallback for `injectBudget`. |
| `OPENCODE_MEMORY_FRONTIER_BUDGET` | Fallback for `frontierBudget`. |
| `OPENCODE_MEMORY_DEDUP` | Near-duplicate suppression inside a `memory_recall` window. **ON by default at `0.8`** (content-token Jaccard, same scope): the newest copy of a near-clone is kept and the rest skipped, so the window fills with distinct facts. Rows that disagree on a negation word are never suppressed. `0` restores the plain top-`limit` slice. |
| `OPENCODE_MEMORY_SYMPTOM` | **ON by default**: `learning` and `blocker` rows must open their content with the observable trigger a future session will hit — `"When <symptom>: <fact>"`. Set `off` (or `0`/`false`) for automation holding a pre-convention backlog. `scripts/symptom-fixer.ts` repairs old rows offline. |
| `OPENCODE_MEMORY_QUERY_GATE` | **ON by default**: a `memory_recall` match must share **two** whole words once the query has three content words — the rule the injected relevance block already applies. Set `off` for the matcher's permissive one-word admission. |
| `OPENCODE_COMMANDS_DIR` | Where the plugin mirrors its slash commands (default `~/.config/opencode/commands`). |
| `OPENCODE_VIEWER_HOST` | Interface the editor binds to (default `127.0.0.1`). A non-loopback bind serves the store over plain HTTP with no authentication — only do it on a network you control. See [Surfaces](#surfaces). |
| `OPENCODE_VIEWER_PORT` | Admin editor port (default `8787`). |
| `OPENCODE_VIEWER_ALLOWED_HOSTS` | Comma-separated hosts beyond loopback. See [Surfaces](#surfaces). |

## Auto-capture is experimental

**Status: in progress, and not working yet.** Auto-capture has never been observed firing on a live opencode 2.x store. It is shipped behind `autoCapture` because the plumbing is finished — the trigger, the model pass, the gates, the cooldown — not because the outcome has been verified. Treat it as a switch that may cost model calls and store nothing.

What has been established, and by which kind of evidence, is itemised in [docs/auto-capture-evidence.md](docs/auto-capture-evidence.md): trigger events checked against a host recording rather than a declared type, the path run under simulated host traffic, teardown bounds, a real-host `opencode run` scenario, and the availability bench measured across budgets and store sizes. Read that file before quoting any figure in it — two of the entries are defects found in the measuring bench itself, and the corrected numbers are the ones recorded there.

What is **not** established: that a live host with a live model completes a capture end to end (no `auto_capture_*` line exists anywhere in the maintainer's evidence history), and anything about quality — what auto-capture would write, how often it duplicates a memory you would have written yourself, and what it costs. `bench/capture-trigger-results.md` is a **bench** simulation of trigger *timing* with a scripted extractor; it answers "which moment is worth mining", not "does the shipped feature work".

**Am I armed?** `memory_evidence` answers on the `plugin_load` line: `capture=off` (the option is not on), `invalid_model` (`captureModel` is not `provider/id`), `no_capabilities` (the host did not expose what capture needs) or `capture=on`, next to `subscribed=[…]` listing the event types that subscription really reacts to. On desktop this needs `opencode service restart` after an edit — relaunching the app keeps the old service and its already-parsed options alive, so `capture=` can report a value your config no longer contains. `capture=on` plus no `auto_capture_*` line after a session means the pass did not complete, not that your configuration is wrong; #404 is the known cause and its fix is on this branch.

## How memory is written

Promotion evidence keeps a bounded sample of the session's code-engagement call IDs — audit pointers, not a complete history — while grounding and attribution use the full in-memory ledger. Existing evidence day-files are left unchanged: no backfill, no compaction, no deletion. What is sampled and why: [docs/write-gates.md](docs/write-gates.md).

Four gates run before anything is stored, and each emits an ordered evidence line:

1. **GATE-1 — code references resolve.** Call signatures and paths embedded in the memory are checked against your live source tree.
2. **GATE-2 — no stale memory applies here.** References that drifted out of date are superseded or the write is blocked.
3. **GATE-3 — no duplicates.** Near-duplicates collapse into the existing row; a contradiction with a superseded memory is rejected.
4. **GATE-4 — promotion or block.** The row lands, or the call returns the reason.

Nothing is deleted: `memory_update` supersedes the previous row, `memory_forget` records a retirement, and `memory_undo` restores a snapshot. `memory_update` takes a `query` that picks the row — its id, a clock fragment such as `00:11:22.123`, or a unique substring of its text. Omit it to update the newest entry of that scope and type. A `query` that matches nothing, or several rows, writes nothing and says so. A prose edit carries over ordinary tags, issue link, retrieval keywords, open/settled standing, and repository to the new row, while capture-only guidance provenance is removed — updating a `global` row from one machine keeps it global for every other. Naming a row an earlier update already superseded reports the duplicate when the live successor already holds that exact content; when only the metadata you name differs, the update runs against the successor instead of dead-ending. And a failure after the new row is durable is reported as `PARTIAL` — the message names what failed, the replacement stands on disk, and `memory_undo` (merge or force) brings the old row back.

### Contradiction authority policy (experimental, #349 / #351)

`contradictionSurface` defaults to `true`; set it to `false` to keep plain guidance without code checks. Guided capture can attach a declared constant's `ref`, the user's value as `claim`, and an authority `klass`:

| Captured statement | Class | Verdict on a detected conflict |
| --- | --- | --- |
| User states the required value for a declared constant | `spec` | The user is the authority; change the constant to the stated requirement. |
| User describes how working code behaves | `behavior` | Code is the authority; keep the constant and raise the mismatch with the user. |
| Authority is unclear | Omit `klass` | Keep plain guidance and its staleness caveat; emit no CONFLICT verdict. |

The code check accepts only a unique top-level `const` with a literal value, runs inside fixed source budgets, and refuses to decide anything it cannot read. Its limits, and the accepted residual — a user-stated **wrong spec** still classifies as `spec` and its verdict follows that requirement — are in [docs/contradiction-authority.md](docs/contradiction-authority.md).

## Repo scoping

Rows are stamped with your git origin (an id that survives re-clones and moves between machines) or, without an origin, a hash of the normalized directory path. `repoPath` keeps the human-readable path, so rows written before hashing keep matching.

Injection, recall, the frontier block, compaction, `memory_forget` and decay see the current repo plus global rows, resolved from the calling session's identity at flow entry. Writes follow the stricter direction: a named session whose repository cannot be resolved has **no write target**, so `memory_remember`, `memory_update`, `memory_import` and auto-capture refuse it (evidence `write_refused`) rather than stamp your content into another workspace or publish it as an unstamped row. Preferences that should follow you everywhere go in with `memory_remember global: true`.

Identity derivation and legacy hashes, evidence attribution when a session moves repositories mid-operation, and the viewer's separate admin seat: [docs/repo-scoping.md](docs/repo-scoping.md).

## What memory is worth, measured

Two results. Only two are quoted, each with its `n` and the seat it ran on, because the direction of an early finding flipped when the metric was corrected — see [#385](https://github.com/abogartz/opencode-self-improvement/issues/385) and [#392](https://github.com/abogartz/opencode-self-improvement/issues/392).

**The metric.** `work = session generation + capture generation`, with cache read and cache write reported separately and never folded into a total. Capture is a separate model call made after the turn, so it appears in no session's usage: a meter that reads session numbers alone reports this plugin's own cost as exactly zero. On the seat below `input` is only the **uncached remainder** — one run reported 13,393 of 187,856 tokens that actually moved, 7%.

| Result | n | Seat | What was measured |
| --- | --- | --- | --- |
| **Transport.** A fact learned in one session reaches a later session that provably cannot obtain it any other way | 5 per arm, with the empty-store floor verified first | `evo/Qwen3.8-Flash-Next-UD-Q4_K_XL`, local seat behind a recording proxy | empty store **0/5** (every failure: the artifact was never written), the same store seeded **5/5**. The fixture is leak-checked: no form of the answer is in any file the agent sees, including its own documentation |
| **Reuse.** A memory reduces the work on a task the agent already passes | 6 pairs | same seat | median of the six per-pair L2/L0 work ratios — sorted 0.54, 0.79, 0.84, 0.98, 1.06, 1.23, middle two averaged — **0.91×**, higher in 2 of 6, inside the pre-registered 0.80–1.25 band: **no measurable effect at 20% resolution**. A memory about an unrelated task: **0.99×**, same estimator, higher in 3 of 6 |

**What is not claimed here.** No token saving. No dollar figure. The seat above is a local box with no cache price; on a hosted provider a cache miss costs roughly 0.1× read and 1.25× write, which is a different claim and cannot be quoted from these numbers.

**Rules for any cost claim in this repository** — the published numbers live in `bench/claims.json`, and `test/claims.test.ts` enforces that file and this one in CI:

- No cost claim below **n=6 pairs per arm**. A ratio at `6 ≤ n < 21` is labelled **"20% resolution"**.
- A **seat** and a **metric** are named on the same line as the number.
- The word "cheaper" does not appear without those.
- An issue or PR body making a cost claim owes the same n, seat and metric. CI reads only this file, so that half is enforced by review.
- Nothing reproduces at n=1: the same arm on the same fixture, both runs passing, differed by more than 2× in tokens.
- Cache state is reported, never assumed. Two runs that start from different cache states are not a saving.

## Token cost and caching

- **Section-frozen injection.** The whole memory section — standing digest, open-thread frontier, relevance block — is computed once per epoch and delivered byte-identically until something the model actually needs changes. The epoch's authority is the **rendered bytes**, not the store fingerprint: a promoted row that changes nothing visible costs no cache bust.
- **A session never pays for bytes it is not riding.** A memory *you* saved in this session is a fact you already produced — it is in your own transcript. A correction, blocklisting, redaction or supersession of a row you are riding, and anything another session, the viewer or an import wrote, still land on your next request.
- **Two-concept threshold.** A free-text prompt must share at least two distinct concepts with a memory for it to be injected; keyword-length queries (one or two words) need only one. Silence on single-word coincidences is deliberate; `memory_recall` still reaches them on the pull path.
- **Identifiers split.** `getUserAccount`, `get_user_account`, `get-user-account` and `get.user.account` are one concept to the matcher rather than four, and a memory citing `src/recall/score.ts` answers a session that typed the path ([#409](https://github.com/abogartz/opencode-self-improvement/issues/409)).
- **User-stated guidance rides ahead of relevance.** A row auto-capture tagged `user-guided` — something you said outright, like "the correct sales tax rate is 8.25%" — rides the block ahead of the lexical picks: newest-first, at most three, inside `injectBudget`. The tag is minted by auto-capture alone; `memory_remember`, `memory_update` replacements and JSONL imports strip it, because always-riding priority is a poisoning amplifier.
- **Hard budgets.** Relevance block and each pull are capped at `injectBudget` characters, the frontier at `frontierBudget`, trimmed at whole-memory boundaries. Nothing volatile rides the cached prefix: no row count, no latest timestamp.
- **Receipts, not claims.** The plugin reads each turn's `tokens.cache` accounting and shows the actual hit rate next to the badge, with the session's `output` and `reasoning` split. A host that reports neither shows nothing, never a zero.
- **Auto-capture bills separately, and it is an estimate.** Capture is its own model call made after the turn, so it appears in no session's usage, and the host exposes no receipt for it. `memory_status` reports chars/4 with `receipt=none` and the words "estimate, no provider receipt". Quote that number as an estimate or not at all.

**Bench** — on a deterministic workload the shipped policy injects **12.3% fewer characters** than the naive policy, measured over the whole memory section: bytes on a synthetic run, not tokens and not a provider bill. The four-policy comparison table, what the invalidation counter does and does not count, what the workload cannot show, and a provider audit reported by its author (input tokens only, not a total and not a saving) are all in [docs/injection-cost.md](docs/injection-cost.md). Reproduce the byte workload with `bun run bench`.

## Recall quality

No vector database, no embedding model, no API key. **Bench** — what the keyword matcher gives up, measured against classic BM25 on a deterministic eval (store of 200, k=3 — the production injection limit):

| Query, vs. the stored memory | share | R@1 | R@3 | with `kw` R@1 | with `kw` R@3 |
| --- | ---: | ---: | ---: | ---: | ---: |
| lexical — reuses your project's words | 46% | 98% | 98% | 98% | 98% |
| near — reworded, one overlap | 17% | 28% | 28% | 67% | 72% |
| strict — zero shared words | 37% | 0% | 0% | 26% | 26% |

"with `kw`" is the same matcher over the same store with each row's write-time keywords indexed; the only changed variable is the index.

- **In-project prompts are overwhelmingly lexical** (`bun test`, "the rate limiter", "staging deploys"): 98–100% R@3, flat from store size 50 to 500.
- **Single-overlap guessing was traded away.** Free-text prompts that share one concept abstain rather than force a guess; wrong top-memory fell to 6%. `memory_recall` still covers them.
- **Zero-overlap paraphrase is the real limit, and write time is where it is answered.** `memory_remember` asks each row for 3–5 `kw` aliases (other names, other verb forms, the literal command); auto-capture asks for the same list, so these numbers are measured through the tool path rather than through capture. Keywords are indexed and never rendered. Strict R@1 0% → 26%, near R@1 28% → 67%. A permutation control (every row given someone else's aliases) scores 29%/35%, so the gain is meaning rather than extra tokens. The limit is narrowed, not removed.
- **`memory_recall` returns 5 rows by default, not 20.** A live audit joined 1,090 recall events to their session transcripts: a returned row at rank 1 shows up in a later tool call at 3.4x the rate of a random store row, ranks 2–3 at 2.4x, and ranks 11–20 at 1.16x — noise against a 0.129 null. The old default returned 17.7 rows per call, so most of the window was context nobody read. At limit 5, recall@1 and recall@3 are unchanged, precision rises 4.1% → 13.1%, and 74% of the returned characters disappear; every gold row the cut dropped sat at ranks 6–20. Pass `limit` for a wider sweep ([#409](https://github.com/abogartz/opencode-self-improvement/issues/409)).
- **Caveats.** The dataset is synthetic (52 memories / 105 queries, a fictional project), its class mix is deliberately adversarial, and scoring is single-gold.

Full methodology and all store sizes: `bench/recall-results.md`.

```sh
bun run bench:recall
```

## Write latency

A write that cites code references builds one tree index — a single recursive walk that prunes `node_modules` and VCS directories — shared by GATE-1 and GATE-2, and reads each source file at most once. **Bench** — measured on a 5,300-file fixture (300 sources + 5,000 `node_modules` decoys), scope seeded with 5 embedded call forms:

| Call forms in the write | Shipped | One scan per form |
| --- | ---: | ---: |
| 1 | 17ms | 105ms |
| 3 | 15ms | 136ms |
| 5 | 20ms | 169ms |

The shipped column is flat: the tree is walked once no matter how many references the write cites.

```sh
bun run bench:write
```

## The store keeps score

The plugin keeps a **use ledger** (`<memory-root>/hits.logfmt`, append-only, rotated at 2 MB, never ingested as a memory) and reports it in `memory_status` and the `/memory` panel. Illustrative output — shape, not a measurement:

```
STORE
  41 active · 12 superseded · 4 open · 6 scopes
  retrieved 33 rows in the last 30d; never retrieved 8 (20%) — reported, not acted on
  24.1 KB total · 604 B per row · 1.3 rows/day (30d)
```

- **Credit comes from three distinct sources** — the row rode the injected block, `memory_recall` returned it, or a grep/read pull appended it — because "the model asked" and "the harness offered" are different facts. Credit requires ≥2 shared terms with the query and is throttled to one line per memory per session per source per hour.
- **No prompt content is stored.** The ledger keeps a scan-truncated string from the *memory* side, never your message.
- **Reinforcement is a tie-break only** (`useBoost ≤ 1.0`): a recently used row wins a tie and can never outrank a real score gap. In consolidation the most recently used member of a cluster is never the merge loser.
- **`never retrieved` is stated, not acted on.** Pruning is your decision. Retired rows cannot inherit reinforcement: ledger rows are verified against the store on read.
- **Aggregate STORE counts are machine-wide by decision (#213 B).** They count every repository's rows in the shared store on this machine, never just the reading session's repository — the numbers describe the store, not your slice of it. Privacy applies to the content surfaces instead: `memory_evidence` and the recent-blocked-writes list in `memory_status` and `/memory` follow each reader's repository visibility (#306).
- **Capture lag** is how stale the newest message was when auto-capture fired. The line prints only when at least one `capture_lag` sample exists, which needs auto-capture to have fired — see [Auto-capture is experimental](#auto-capture-is-experimental).

## Consolidation

`memory_consolidate` finds near-duplicates and proposes merges. It writes nothing; each proposal prints the exact `memory_merge_review` call that resolves it, and resolving is supersede-not-delete.

- **Deterministic.** The canonical row is the survivor's prose verbatim plus the absorbed rows' aliases as keywords. No model rewrites anything.
- **Proven by recorded reads.** Every read the ledger recorded for a cluster is replayed against the merged store, and a merge is proposed only when the canonical row catches at least as many of the cluster's own reads as the best single member did alone. A cluster with no recorded reads is reported as *unmeasured* and never merged on resemblance.

**Bench** — on the eval dataset the pass takes 200 rows to 52 with **R@3 52 → 53 and R@1 52 → 50**, and store-wide injected characters 25 945c → 6 933c. Both the regression and the budget swap are bounded in CI (`test/consolidate-bench.test.ts`).

## Secret redaction

One best-effort credential rule set (`src/secrets.ts`) replaces recognized values with `[redacted]`. It runs at every boundary a credential could persist, not one:

- over the auto-capture prompt before it leaves the plugin — the complete transcript is redacted *before* the character budget crops it, so a credential cut in half still matches its pattern;
- at the write gate, before content is hashed or analysed;
- again in the final write choke point used by gated writes and by the viewer's edit and restore paths;
- at the durable audit boundaries — every evidence line, every supersede field written into a retired row, and every deletion-audit reason.

So a recognized credential cannot persist in `evidence/`, in `deletions.logfmt`, or in a tombstoned row, whichever path carried it.

Covered: OpenAI `sk-`, GitHub `ghp_` / `gho_` / `github_pat_`, Slack `xoxb-` / `xoxp-`, AWS `AKIA`, Google `AIza`, bearer tokens containing digits, PEM private-key blocks, and high-entropy values assigned to names ending in `_KEY`, `_TOKEN`, `_SECRET` or `_PASSWORD` (plus `password`).

Limits worth knowing:

- It can miss hex-only secrets, low-diversity passwords, and credentials written in prose without an assignment.
- Credential-shaped `scope`, `tags` or `issue` metadata is rejected rather than silently rewritten.
- `memory_remember` still replies `Remembered` when content was redacted, so the stored text can differ from what was sent.
- Redaction is forward-only: existing stores are not scrubbed. `memory_export` scrubs credentials out of `content`, `issue`, `scope`, `tags` and `kw` as it serialises, so the file that leaves the machine carries `[redacted]` where a stored row still holds a token; the store itself is untouched, and origin stamps (`repo`, `repoPath`) are written as stored. The scrubber is a best-effort sweep over known token families and high-entropy credential-shaped values — an exotic credential can survive it, so an export is still a file you hand out deliberately.

## Export and move between machines

`memory_export` writes the live store **as its caller can read it** as JSONL: from a plugin session that means its own repository plus global rows; full-store breadth belongs to a session-less caller outside the plugin (the library route — the viewer has no export route). The format is a machine-readable header line (`{_export, version, exportedAt, count}`) followed by one JSON object per line (`{ts,type,scope,content,status,tags,issue}`), active rows only. `memory_import` reads such a file back. Default path is `<memory-root>/exports/<timestamp>-<unique>.jsonl` — a unique name created exclusively, so two exports in the same second never replace each other's artifact; `file` must name a path **inside the store** - exports under `<memory-root>/exports` (a relative path resolves against it), imports anywhere under `<memory-root>` - and `scope` exports a single scope.

Both tools are model-facing, so a path is not a privilege: an export cannot write to `~/.gitconfig` or anywhere else outside the store, and an import cannot read outside it. Symbolic links are resolved before the check — including an `exports/` directory that is itself a link — so a link cannot carry a request out of the store. Exports are written `0600` and opened `O_NOFOLLOW` (both POSIX; on Windows the check before the write is the only guard). (Hardlinks are beyond any path check: a link planted inside `exports/` shares an inode with its target. That, and a narrow window on intermediate path components, are the boundary's known limits.) To move a store between machines, copy the file in:

```
Export my memories                              # -> <memory-root>/exports/<timestamp>-<unique>.jsonl
# …copy that file to the other machine's <memory-root>/…
Import <memory-root>/memories.jsonl             # memory_import
```

An operator running a one-off migration can restore the old anywhere-on-disk behavior with `OPENCODE_MEMORY_ALLOW_OUTSIDE_PATHS=1`. It is read from the plugin process's own environment, so a model cannot grant it to itself through a tool argument.

Every imported row re-enters through the same four gates as `memory_remember` (tagged `import`, original tags preserved), and the tool reports a tally:

| Outcome | Meaning |
| --- | --- |
| `promoted` | passed the gates and was stored |
| `collapsed` | near-duplicate of an existing memory; nothing written |
| `blocked` | rejected by a gate; reason in `memory_evidence` |
| `skipped` | malformed line; never reached the gates |
| `downgraded` | imported as settled because its `status:"open"` could not be vouched for |

Import and auto-capture also scan incoming prose for instruction-override, role-header and download/execute patterns. A promoted match is tagged `quarantine` and withheld from recall, prompt and frontier injection, compaction anchors, contextual pull, consolidation and decay; review it in the viewer's **quarantined** filter.

This is a heuristic review queue, not a prompt-injection detector: legitimate documentation can match, and several forms evade it. What the screen covers, what it misses, how an existing store is re-tagged, what releasing quarantine does and what it leaves alone, and why direct `memory_remember` and viewer edits are not scanned: [docs/import-quarantine.md](docs/import-quarantine.md).

## Surfaces

Same data behind each one (`memory_status`; no model call).

**Terminal (opencode CLI)** — the plugin ships a TUI half (`@opencode/plugin/tui`) that loads automatically:

- **Footer badge** — illustrative `● mem 1157/1200c · cache 96%`: the injected block against its budget, plus the measured session prompt-cache hit rate. The dot is green (stable and warm), yellow (recent recompute, or 50–90% reads) or red (last turn served almost nothing from cache); `—` until the first assistant turn, and `—` throughout on a provider that reports no cache usage.
- **`/memory`** — session panel: **CONTEXT** (chars and estimated tokens riding now, % of budget, the full memory section riding the prompt — digest + frontier + block — requests this epoch has ridden, session totals, abstentions), **CACHE** (busts this session and the measured cache-served share of prompt tokens), **INJECTED BLOCK** (the verbatim block, or an explicit abstention), **RECENT BLOCKED WRITES** (with gate reasons), **STORE** (active / superseded / open / scopes, plus `malformed` when a row's `ts` is not a valid ISO instant — those rows are skipped by every reader). Keys: `r` refresh, `f` fullscreen.
- **Block toast** when a write is refused (`"notifyBlocked": false` to silence).

**Desktop / web / IDE** — the terminal slots do not exist there, so use the self-installed **`/memory-report`** chat command: the same sections rendered in the conversation.

**Browser editor** — `bun memory-view`, then http://127.0.0.1:8787. Bound to loopback; requests are checked against `Host` and `Origin`, so other hosts must be listed explicitly in `OPENCODE_VIEWER_ALLOWED_HOSTS`. Listing a non-loopback host serves the store over plain HTTP with no authentication — only do it on a network you control.

## Installing a specific version

An unpinned entry resolves `@latest` exactly once and is never re-resolved afterwards, so updates are deliberate: `opencode plugin update opencode-self-improvement`. To pin, append `@<version>` — see [npm](https://www.npmjs.com/package/opencode-self-improvement) for what is current.

<details>
<summary>Install from a clone (development)</summary>

```sh
git clone https://github.com/abogartz/opencode-self-improvement.git
cd opencode-self-improvement
bun install
```

Then point the `plugins` entry at the local file instead:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/full/path/to/opencode-self-improvement/index.ts"]
}
```

After changes, `git pull` and restart opencode.

</details>

## Development

Nothing merges without the full gate; CI runs it as required checks (`lint`, `test`, `smoke`), and the same sequence is one command locally:

```sh
bun run gate          # typecheck + lint + unit tests + terminal smoke & BDD
bun run gate:hooks    # once per clone: run the gate on `git push`
bun run format        # apply the shared two-space TypeScript/TSX style
bun run format:check  # check formatting without changing files
```

`bun run typecheck` runs `tsc --noEmit` on its own. In CI it runs inside the job named `lint`, so a green `lint` check silently implies tsc. The rest of the mapping: `bun run test` is the `test` job (re-run in `test-windows`, which reports but cannot gate merges), and `bun run test:e2e` is the `smoke` job.

`bun run lint` checks lint rules and TypeScript/TSX formatting; CI calls the same command. Lint warnings remain advisory, while formatting differences fail the check. Markdown commands, prose, JSON data and historical benchmark records are outside the formatter's scope.

Use Bun **1.4.4** for development checks, matching CI. `bun run test` and `bun run test:e2e` run files across at most four worker processes with Bun's file isolation; cases inside each file stay sequential because fixtures share environment variables and module state. The local gate uses those same scripts. To diagnose order-dependent failures in the original shared-process mode, run `bun test ./test/` or `bun test ./e2e/ --timeout 240000` directly.

**Feature order is BDD-first.** A new feature starts by adding or fixing a scenario in `e2e/` that describes the behavior as a user would observe it — before implementation code and before unit tests. Then the unit tests for the pieces, then the code until everything is green. If no scenario turns red first, the feature has no observable contract.

`e2e/` boots the **real opencode CLI** in a fully isolated instance against a scripted fake model — no API keys, no shared store. It needs `opencode` on `PATH` locally, or `OPENCODE_BIN`. A `test-windows` leg also runs the suite on Windows; it reports without gating merges.

**The published surface is `package.json`.** `exports` is the only import surface other code can reach; `files` is the packaging list. A new top-level file, or anything the plugin reads at runtime outside those paths, must be added to `files` or it works from the checkout and vanishes from the npm artifact. What the smoke suite boots and how that miss turns red: [docs/development.md](docs/development.md).

### Before a release

```sh
bun scripts/test-sweep.ts --validate             # every pattern still lands on one site
bun scripts/test-sweep.ts --selftest             # the instrument can still go red
bun scripts/test-sweep.ts --fail-on-survivors    # exits 4 when anything survives
```

`scripts/test-sweep.ts` audits the test suite rather than the plugin: each mutant breaks exactly one claimed invariant in a detached worktree, and the suite has to notice. A mutant no test kills is an unpinned invariant — the audit's output, not a red check. The ritual and its cadence, why the sweep never belongs in CI, and which benchmark artifacts stay out of git: [docs/pre-release-ritual.md](docs/pre-release-ritual.md).

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `memory_*` tools not available | The plugin didn't load. Restart opencode and check the `plugins` entry in your config. |
| `memory_remember` says blocked | A gate rejected the write: a stale code reference, a cited path that doesn't exist in the repo, overlap with a superseded memory, or an ambiguous claim. The reason is in `memory_evidence`; rephrase against current code and retry. |
| `invalid arguments to memory_*` | The call didn't match the tool's input schema; nothing was done and the message names the offending fields. Gate blocks look different (`blocked at GATE (…)`). |
| STORE shows `N malformed` | A daily file has a `ts=` that is not a valid ISO instant (typically a hand-edit). Every reader skips those rows; fix the `ts=` or restore the file with `memory_undo`. |
| `memory store is busy` | A store write exhausted its 5s lock-wait budget. Appends, rewrites, and restores refuse that mutation rather than proceed unlocked and risk losing another writer's rows. Retry after contention clears. An operation spanning several files or steps may have completed earlier steps; refusal is not a rollback of those steps. If the reply reports `PARTIAL`, inspect the named rows and `memory_evidence` / `memory_undo` before retrying. A process that is killed releases the lock when it dies — there is no stale window to wait out. |
| Stray `*.logfmt.lock` or `*.tmp` in the store | Write bookkeeping left by an older release; safe to delete while nothing is writing. Current releases leave `.store-lock.<file>.sqlite` beside each store file and `.store-batch.<name>.sqlite`: coordination state, holding no rows, one file per lock, safe to delete while nothing is writing. |
| Writes report a disk I/O error and the store is on a share | The lock's write-ahead log needs mmap'd shared memory, which SQLite does not support on network filesystems. SMB, NFS and OneDrive-mounted roots are unsupported — move `OPENCODE_MEMORY_DIR` to local disk. |
| `/repo-init` missing from the command list | The self-install couldn't write to `~/.config/opencode/commands/`. Create it and restart, or ask the model to "init memory for this repo" — the same tool. |
| `memory_init` rejects a call naming `mode` | The code-graph integration was removed (#231) and the tool schema refuses unknown arguments — drop `mode` from the call. Stamps written by older versions (their text carries `graph=`/`mode=`) still read fine; no re-init is forced. |
| Stale plugin after an update | `opencode plugin update opencode-self-improvement` (or bump the pinned `@version` in the `plugins` entry) and restart opencode. On desktop use `opencode service restart`: relaunching the app leaves the background service — and the plugin version and options it already parsed — alive. |
| `Error: Plugin is not configured` right after `plugin add` | An opencode bug ([#54654](https://github.com/anomalyco/opencode/issues/54654)), not a config problem: the first `plugin list/check/update` against a cold background service reads the plugin inventory before activation finishes. The plugin is installed and loading — just run the command again. |
| Auto-capture does nothing | Auto-capture is **experimental and has never fired on a verified live store** — see [Auto-capture is experimental](#auto-capture-is-experimental). `memory_evidence` says which case you are in from the `plugin_load` line: `capture=off` (option not on), `invalid_model` (`captureModel` must be `provider/id`; a bad one disables capture with a startup warning), `no_capabilities` (host did not expose what capture needs), or `capture=on`. `captureOnCompact` alone does nothing. `capture=on` with no `auto_capture_*` line after a session is the open bug, not your config. Rejected candidates log as evidence, not errors. On desktop, changing any of these options needs `opencode service restart`. |
| Reset all memories | Stop any running opencode session first, then delete `~/.config/opencode/memory/`. On Windows the delete fails with `EBUSY` while a session is live: the store lock is an open SQLite connection, and Windows will not delete a directory that contains one. |

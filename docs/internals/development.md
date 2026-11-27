# Development internals

What the local commands really run, what the smoke suite boots, and how the
published npm surface is decided. The commands themselves and the BDD-first
rule stay in the README.

## Local command to CI job

| Local command | Where it runs in CI | Gates a merge |
| --- | --- | --- |
| `bun run typecheck` | inside the job named `lint` | yes, under that name |
| `bun run lint` | `lint` | yes |
| `bun run test` | `test`, re-run in `test-windows` | `test` yes; `test-windows` reports only |
| `bun run test:e2e` | `smoke`, `smoke-stable` | `smoke` only |
| `bun run test:oh-my-pi` | `oh-my-pi` | separate adapter job |

`tsc --noEmit` has no check of its own in CI — it runs inside `lint`, so a green `lint` silently implies a green typecheck.

`bun run lint` checks lint rules and TypeScript/TSX formatting, and CI calls the same command. Lint warnings stay advisory; formatting differences fail the check. Markdown commands, prose, JSON data and historical benchmark records are outside the formatter's scope.

The test scripts run files across at most four worker processes with Bun's file isolation. To reproduce an order-dependent failure the way it would appear in one shared process, run `bun test ./test/` or `bun test ./e2e/ --timeout 240000` directly.

## What the smoke suite boots

Both smoke jobs run the same suite and print the exact OpenCode CLI version.
`smoke` checks the compatibility baseline, OpenCode 2.0.26. `smoke-stable` is
informational and pins a stable OpenCode v2 release in the CI workflow. Update
that pin by PR. Before retiring the baseline, document the new minimum
supported host and announce how long the existing coverage will remain.

`e2e/` boots the **real opencode CLI** against each candidate in a fully isolated instance (fresh config, fresh db, fresh memory store, empty `HOME`) driven by a scripted OpenAI-compatible fake model — no API keys. It covers loading from the source tree and from the packed npm artifact installed runtime-deps-only, plus BDD flows for remember, recall, exact and near duplicates, ungrounded claims, and forget. Needs `opencode` on `PATH` locally, or set `OPENCODE_BIN`. A `test-windows` leg also runs the suite on Windows; it reports without gating merges.

`e2e/shared-store.test.ts` runs independent OpenCode instances against one memory root. It checks project isolation, global visibility, prompt-based selection, and corrections/deletions observed in subsequent sessions. Rows enter through the public tools and assertions inspect both recall results and the initial model request. These are contracts for future harness adapters to preserve; the suite currently exercises OpenCode only, with the same local project directory for same-project readers. It does not promise that a running session's frozen injection block changes after another process edits the store.

## Adapter extraction baseline

Before the adapter extraction, Windows with Bun 1.4.4 reproduced the real-host capture persistence failure on OpenCode 2.0.26 and 2.4.2. The retained 2.4.2 trace reached `auto_capture_seen`, `auto_capture_start`, and `capture_cost` (including returned text), then ended without `capture_lag`, a stored row, or `auto_capture_dispose`. This local observation narrows the gap to after the model answer; it does not establish whether the host awaited cleanup. The deterministic capture disposal and hook suites passed all 27 tests. Keep those contracts and the failing real-host assertion intact when extracting lifecycle handling.

The full local gate also reproduced two Windows `EBUSY` failures in the viewer E2E cleanup, with the new shared-store suite excluded. Neither failure is an adapter regression. The shared-store scenarios pass on both host versions; they cover fresh sessions, not live replacement of a frozen injection block.

### Shutdown investigation

The viewer cleanup now waits for its child process to exit before removing the
temporary store. Both previously failing Windows scenarios pass with their HTTP
and persistence assertions unchanged.

On Windows with OpenCode 2.4.2, the independent plugin in
`e2e/support/teardown-probe-plugin/` received the turn-end event in three of three
standalone runs, but recorded neither cleanup entry/completion nor process
`beforeExit`/`exit` handlers. OpenCode's tagged
[standalone server owner](https://github.com/anomalyco/opencode/blob/v2.4.2/packages/cli/src/services/standalone.ts)
uses the
[process spawner](https://github.com/anomalyco/opencode/blob/v2.4.2/packages/util/src/cross-spawn-spawner.ts),
whose Windows termination path runs `taskkill /T /F` even when asked for SIGTERM.
That matches the observed loss of asynchronous plugin work at standalone exit.
This diagnosis is specific to that version and platform.

`e2e/support/server.ts` supplies a cooperative control: start an isolated real
server, connect the CLI with `--server`, and close the server's stdin ownership
lease after the turn. Its watchdog fails the test if forced termination is
needed. With this path, the probe records async cleanup completion and the
capture test persists the exact candidate through the normal write gate. The
real-host capture control does not pin whether the write completes before or
during cleanup; the deterministic capture disposal tests cover that ordering.

The original standalone capture assertion remains unconditional and still fails
on this Windows host. The cooperative control does not replace it, enable capture
for oh-my-pi by default, or guarantee persistence after a forced process kill.

## Host adapter boundary

`src/host/contracts.ts` defines the current tool/identity boundary: schema-bearing memory tools, normalized per-call identity, and optional session-directory sources. `src/adapters/opencode/` translates OpenCode tool contexts and directory responses and supplies the OpenCode `codemode: false` registration option. Shared tools validate raw arguments themselves. Shared session policy still owns provisional/firm binding, lookup ordering, pending-lookup joins, and repository isolation. Missing directory sources do not invent a repository; OpenCode API errors retain the existing binding fallback behavior.

`test/host/tool-contract.ts` is a reusable behavioral contract. It runs the real shared tools against both the OpenCode adapter and a minimal normalized in-memory host, checking validation, write gates, project/global visibility, updates, and deletion. The in-memory fixture is not a dsh or Pi implementation. The separate real-host suite still verifies actual OpenCode loading, delivery, and lifecycle behavior.

`src/host/lifecycle.ts` defines normalized prompts, tool results, outgoing request observations, compaction, identity, and usage events. The shared handlers in `src/events.ts` select memory and account for delivery. The OpenCode lifecycle adapter registers hooks, decodes envelopes, and supplies callbacks that insert text into the host's system context and tool results. Receipt matching consumes independent normalized tool-result copies, so repeated or clipped copies cannot combine to prove a row. Receipt settlement remains synchronous and precedes system injection. Observations describe the request visible at the hook; later request transformations remain opaque.

Compaction accepts an optional `phase`. A host with separate notifications sends
`prepare` to supply the anchor and any enabled pre-compaction capture, then
`complete` after success to finalize session bookkeeping and invalidate the
injection epoch. Completion never appends context or starts another capture.
Omitting the phase retains the combined contract used by OpenCode. An abandoned
preparation does not finalize or invalidate the session; preparation-time capture,
when enabled by a host, remains an independent pre-compaction operation.

A missing system-context callback skips injection and request accounting. Cleanup stops new callbacks synchronously, aborts the observation subscription, and attempts every registered hook disposer once; setup failure also releases hooks already registered. Already-started handlers finish against their captured delivery surfaces rather than silently dropping text while recording it as delivered. Capture keeps its separate bounded teardown policy. Tests cover normalized handlers without OpenCode envelopes, plus adapter ordering, concurrent receipt settlement, missing capabilities, registration rollback, and late callbacks after disposal.

`src/host/capture.ts` defines optional transcript access, model generation, default-model lookup, and a stream of normalized turn-end events. `src/adapters/opencode/capture.ts` owns OpenCode event names and API calls; `transcript.ts` in the same adapter decodes both recorded and legacy message shapes. Compaction uses that decoder too, taking a snapshot before asynchronous shared handlers run. Missing required capabilities disable capture with a warning. Configuration, model precedence, cooldowns, signal/delta policy, prompt redaction, write gates, and bounded teardown remain in the shared capture runtime.

A normalized transcript preserves one slot per source message, even when the slot has no public conversation text. This preserves cursor positions and lag measurements. The adapter removes reasoning/thinking text and supplies structured user/assistant roles; an assistant quoting a user label cannot create user provenance. The shared renderer applies its turn cap after window selection, so a delta beyond the first forty user turns can still be captured. Adapter tests retain the recorded-message regression matrix; normalized-host tests exercise real capture gates, project visibility, and abandonment without OpenCode envelopes. These contracts do not resolve the real-host persistence failure described above.

`src/runtime/setup.ts` now assembles the shared engine through `setupMemory(host, { directory, options })`. The host supplies the tool/identity, lifecycle, and capture ports in `src/host/runtime.ts`, plus an optional command installer. That installer is awaited before registrations begin; a host that omits it writes no OpenCode command files. `src/adapters/opencode/plugin.ts` is the OpenCode composition root, and `commands.ts` beside it owns command-directory discovery and the shipped Markdown format. Both existing package entry points retain their OpenCode exports.

Startup diagnostics derive capture availability from the supplied methods. Adapters may label those methods for diagnostics; labels do not grant capabilities. The OpenCode labels, package version and loaded-directory heartbeat remain compatible. OpenCode capture availability is inspected after hook registration, when the host may have attached additional APIs. Cleanup is idempotent, starts lifecycle shutdown and capture abandonment synchronously, and waits for both before reporting an error. Capture retains its bounded drain policy; a setup failure after lifecycle registration also disposes that registration. Hosts remain responsible for rollback of a failed registration and for releasing their own tool registrations.

`test/runtime/setup.test.ts` exercises complete setup with normalized hosts: tool-mediated writes and later-instance recall, project/global visibility, relevance-selected injection, an unresolved workspace, optional command installation, partial-setup cleanup, and capture draining despite a failing lifecycle disposer. These fixtures are not dsh or Pi adapters. The initialization interfaces are internal to the package rather than a newly published adapter SDK.

Store ownership remains project/global, independent of the adapter. Existing store paths and `OPENCODE_MEMORY_DIR` remain unchanged for compatibility, so hosts configured to use the same root share the same rows. Store configuration is still process-wide; independently configured roots require separate processes. OpenCode session IDs retain their existing values; other adapters sharing one process must make transient session IDs distinct without adding harness ownership to durable rows. The shared engine still requires Bun, so a host using a different runtime needs an explicit in-process or worker strategy.

### Harness attribution and statistics

`MemoryHost.harness` supplies a stable telemetry identifier (`opencode`,
`oh-my-pi`, or another lowercase adapter name). `src/runtime/harness.ts` binds
setup, tool execution, lifecycle callbacks, and disposal through async-local
context. Delayed work retains its originating harness; explicit evidence contexts
capture it alongside session/project identity. It is never read from user tool
arguments or inferred from a session prefix. Omitted or invalid identifiers produce
new records marked `unknown`.

Evidence and retrieval ledgers now carry `harness`. Readers attribute historical
records with no field to OpenCode without rewriting them. Status payloads also
carry the identifier. Memory rows, project/global visibility, and store paths
are unchanged. Usage folding and retrieval throttles distinguish harness/session
pairs; this does not remove the existing requirement for distinct transient
session IDs elsewhere in the engine.

Normalized usage events persist folded `session_usage` snapshots with an
observation timestamp. The report chooses the latest observation per
harness/session, so duplicate or reordered appends do not add the same totals
again. These are reported totals, not billing or memory-only cost: a cumulative
snapshot can include earlier work, while a per-message source only covers the
runtime's observed messages. Retained snapshots survive disposal; reopening a
session without replaying its history can replace the snapshot with partial usage.
Unreported sessions are excluded. Capture estimates stay separate.
`SessionUsage.accountingID` optionally identifies a persisted host session when
the runtime's grounding identity changes after reload; it only affects usage
snapshot grouping. Omission preserves the existing session-ID behavior. A missing
`reasoning` means output is combined completion usage; the shared fold and report
retain that unknown split without losing already reported reasoning tokens.

`src/status/harness-stats.ts` supplies the combined and per-harness thirty-day
breakdown in `memory_status` / `/memory-report`; the terminal panel is unchanged.
Capture configuration is selected within each harness. Aggregates expose counts
without session IDs, repository names, prompts, or memory text. Retrieval counts
are throttled credits, and retained data is a floor rather than a complete history.
Unit and simulator scenarios cover legacy records, duplicate receipts, missing
usage, raw session-ID collisions, delayed captures, and shared memory ownership.
The real SDK shared-store scenario checks reports from both adapters after
separate process runs.

## Exploratory oh-my-pi adapter

`src/adapters/oh-my-pi/extension.ts` is an experimental extension for
`@oh-my-pi/pi-coding-agent` **19.2.1**, which requires Bun **1.4.4** or newer.
The package's `omp.extensions` manifest points to it for plugin discovery, and
`./oh-my-pi` exports it for explicit imports. Source-path loading via `--extension`
or the SDK's `additionalExtensionPaths` remains available. Follow the
[installation guide](../reference/oh-my-pi.md) for checkout and packed-copy trials.
This is not a support claim for Pi or other derivatives. Host types remain inside the
adapter; OpenCode installs do not acquire an oh-my-pi SDK dependency.

The adapter registers the fourteen shared tools with their JSON schemas, binds
each call to the host's absolute workspace and session identity, and places
selected memory into `before_agent_start` system context. Each extension instance
namespaces its transient session IDs. Clear, switch/resume, branch, and tree
navigation advance a transcript generation even when the host retains the same
session ID. Grounding and frozen context from the old transcript cannot authorize
new writes; resumed transcripts require fresh tool observations. Durable rows keep
project/global ownership.
Configure both hosts with the same `OPENCODE_MEMORY_DIR` and use the same local
project directory to share project memories. Global rows remain eligible across
projects, subject to the ordinary selection rules.

Successful text tool results supply grounding observations; failed reads do not.
The shared pull policy runs on successful tool results, with `read`, `grep`, and
`glob` enabled by default. The adapter returns replacement content, preserving
images and existing blocks, and appends only the shared engine's suffix. It does
not feed that added memory back into the same tool's grounding observation.
The `context` hook decodes actual `toolResult` messages and settles held receipts;
user/assistant quotations, another call, another session, or a retired transcript
generation cannot credit a placement. Complete rows must survive earlier result
transformations. Later context/provider transformations are opaque, as with the
OpenCode context-stage observation; receipts do not establish provider acceptance.
`createOhMyPiMemory({ options })` passes shared budgets and pull settings through;
the [configuration example](../reference/oh-my-pi.md#configure-the-adapter) uses a
single configured extension entry point. Native plugin-settings UI integration is
still pending because the public extension API does not expose its reader.
Missing identity, calls after shutdown, and already-aborted calls fail closed.
Shutdown stops admission immediately, waits for initialization to settle, and
drains admitted work. The host owns
registration removal; a failed factory leaves any partially registered callbacks
inert. Cancellation after a write begins does not roll back a durable write.

The default entry point enables automatic turn-end capture. `completion.ts` binds
the terminal event's active transcript, a deep copy of the selected model, and the
host credential resolver with its original session identity before awaiting other
work. An explicit `captureModel` resolves through the host registry without silent
fallback. The extension loader supplies the running host's `completeSimple` SDK;
the model packages are development dependencies only. The factory still accepts
an explicit `capture` binding for embeddings and controlled tests.
Only terminal `agent_end` events qualify; loops that will continue or await async
work do not. Snapshot text and model identity are retained across session changes.
The queue coalesces pending notifications for the same session and admits up to
64 queued sessions. Excess notifications are dropped. Invalid or disabled capture
configuration cannot leave a host callback waiting for a nonexistent subscription.

The decoder preserves message slots while excluding thinking, tool results, custom
messages, and agent-attributed user messages. The model receives only the shared
engine's sanitized capture prompt, with empty conversation history and tools.
Do not replace this with `runEphemeralTurn`: that API inherits live conversation
state and would bypass the capture boundary. Model errors, aborts, truncated
answers, and tool-call responses cannot write. Built-in generation uses a
20-second abort deadline, below the host's generic handler timeout. Shutdown
closes callback admission and gives built-in captures up to 500 ms to settle,
then cancels unanswered generation and invokes the shared bounded write drain.
This leaves room within the host's two-second shutdown handler budget. Explicit
custom capture bindings retain immediate cancellation at disposal. Slow storage
or a forced process kill can still exceed those guarantees. Runtime-registered
provider implementations, host cost budgets, and capture spend accounting remain
outside the integration proof. OpenCode's generation envelope is unchanged.

The adapter maps `session.compacting` to the shared preparation phase and returns
the anchor as `{ context }`, leaving messages and the default summary prompt
untouched. A mismatched event/context session ID cannot supply an anchor. The
`session_compact` notification completes bookkeeping and invalidates the epoch,
including paths where another extension provided the entire summary. The native
19.2.1 runner keeps the last returned compaction-hook result; it does not merge
context, prompt, or preserved data across extensions. Compaction capture remains
unwired.
Context accounting observes placement at
`before_agent_start`; later host retries, aborts, or transformations can discard
that prepared request. The SDK's bounded shutdown behavior does not guarantee
completion of arbitrarily slow storage operations. These limits need real-host
tests before expanding the supported surface.

The adapter's `usage.ts` reads the public readonly `sessionManager.getEntries()`
at `session_start`, `agent_end`, completed session transitions, and shutdown.
Only finalized assistant-message usage is counted. There is no streaming-delta
listener and no transcript text in telemetry. Valid usage on error/aborted
messages is retained; malformed counts and missing history do not fabricate use.
The sum is a cumulative normalized receipt with the native session ID as its
stable accounting identity. The random/generation-qualified runtime ID still
isolates grounding. Shutdown starts usage recording without awaiting its I/O;
admitted telemetry joins the existing pending-work drain.

The native output bucket includes reasoning. `reasoningTokens`, when available
on every retained receipt, is subtracted into the separate normalized field;
otherwise output stays combined and the split is unknown. Full retained history
includes off-branch messages, and different fork sessions can contain inherited
receipts. History replacement can lower totals. These snapshots are not a spend
ledger. Auxiliary model calls, `task` tool totals, and separate capture calls are
excluded. Reopening in a fresh process reconstructs the same session total rather
than counting a new session. The SDK test proves normal streaming, cancelled
preparation, and process restart; it does not prove forced-exit durability.

The ordinary unit suite runs `test/host/oh-my-pi*.test.ts` without an installed
harness. The separate optional integration package pins the real SDK and its
dependency lockfile:

```sh
bun install --cwd integration/oh-my-pi --frozen-lockfile
bun run test:oh-my-pi
```

This command typechecks the structural adapter against the published SDK, then
runs actual SDK sessions and OpenCode CLI processes against the local scripted
model server. It needs `opencode` on `PATH` (or `OPENCODE_BIN`), but no model account
or real API key. Homes, host settings, project directories, and stores are temporary.
The shared-store scenarios verify writes in both directions, real read grounding, project/global
visibility, relevance-selected system context, corrections, deletion, and rejected
foreign-project mutations. They cover fresh sessions with matching local project
identity; interactive UI behavior, concurrent host writes,
relocated checkouts, and live replacement of a frozen injection block remain outside
this proof. The SDK suite is separate from the OpenCode gate and ordinary tests;
the `oh-my-pi` CI job installs its pinned dependencies and runs it on pull requests.

`lifecycle.test.ts` drives actual SDK new-session, resume, clear, compaction, abort,
and dispose operations in isolated children. A probe wraps the adapter's public
registrations to pause prepared context or observe tool admission; a real store
lock holds an admitted write. Handshakes establish ordering, with a watchdog only
to fail stalls. Tests verify that clear retains the host ID but retires grounding,
an aborted preparation sends no model request and does not contaminate the next
unrelated turn, compaction reselects durable memory, and cancellation plus disposal
drains a held write before cleanup finishes. SDK shutdown is idempotent. Branch
and tree notifications are covered by adapter unit contracts; their actual SDK
navigation paths still need coverage. These checks do not establish forced-exit
durability beyond the host's shutdown deadline or confirm delivery after a later
provider failure.

`installation.test.ts` packs the repository, installs the archive and its
dependencies into a fresh directory, and registers that installed copy using the
published oh-my-pi CLI's `plugin install` command. CLI processes discover the
manifest without a source-path override. A successful write survives process exit,
is recalled and injected on restart, stays hidden from another project, and remains
readable through OpenCode after uninstalling the oh-my-pi registration. The test
also checks that all fourteen tools appear exactly once, the packaged default
captures a grounded memory that survives immediate CLI exit, and a fresh process
recalls it. A configured entry point imported from the installed package disables
capture, changes context budgets, and disables pulls while leaving
explicit recall available. All host configuration and stores are
temporary; no investigation wrapper is required or packaged.

`delivery.test.ts` drives real SDK reads against a project memory and inspects
the next request at the scripted provider. Its scenarios keep or clip the pulled
row in a later tool-result handler, disable pulls, or search arguments only. The
receipt ledger agrees with those outgoing requests. Adapter contracts separately
cover mixed text/images, session and call identity, transcript replacement, and
duplicate observations without requiring a host installation.

`compaction.test.ts` inspects the real summarizer requests for project/global
anchors, excluded foreign-project rows, and preserved caller instructions. The
same fixture uses three native summary requests with or without an anchor. Further
scenarios supply a full replacement summary, let a later hook replace our result,
and cancel after preparation before retrying successfully. The cancellation probe
wraps public registration and uses the host's `abortCompaction`; it observes no
provider request, no completed-compaction bookkeeping, and an unchanged transcript
for the cancelled attempt. These tests verify summarizer input, not a real model's
ability to retain every fact in its generated summary. Snapcompact, handoff, and
provider-native compaction paths remain outside the proof; delivering a hook result
alone does not establish that those paths consume its context.

The capture scenarios initialize extensions with the SDK's print/RPC runtime
initializer, use its actual terminal events and active transcript,
and verify the outgoing completion request. A captured project row is recalled
through OpenCode and hidden from another project. A tool-call capture answer is
rejected. The SDK does not join terminal extension notifications before
`prompt()`/`waitForIdle()` returns. The capture fixture therefore wraps public
handler registration with an explicit completion handshake to keep the session
open. The separate packed CLI scenario covers immediate exit without that
handshake. `capture-shutdown.test.ts` holds a real provider response while SDK
disposal begins: a quick answer persists, while an unanswered request is cancelled
within the shutdown budget and cannot write after disposal. Capture during actual
branch/tree navigation and compaction still needs broader real-host coverage.

## Programmable test host

Run `bun run test:simulator` for the scripted-host scenarios and shared-initialization contracts. It needs Bun and this repository's dependencies, with no installed OpenCode, dsh, Pi, oh-my-pi, or model service. These tests also run in the ordinary unit suite. Narrow a reproduction with `bun run test:simulator -t "dispose during a paused transcript"`.

`test/simulator/host.ts` implements the normalized host ports and calls the real `setupMemory`. Tools, selection, write gates, storage, and telemetry are production code. `test/helpers/temp-store.ts` supplies isolated stores without importing the OpenCode plugin; the existing OpenCode test harness re-exports that fixture for compatibility. `test/runtime/setup.test.ts` uses the programmable host instead of its former private driver.

Use `runScenario` to own hosts, collect a single ordered trace, and clean up even after an assertion or checkpoint failure. Its trace records host inputs, model prompts and replies, requested versus delivered system text, tool-result transformations, and shutdown. Failures include the last 100 entries with their original sequence numbers. Trace snapshots retain session identity and replace callback functions with a marker. Use synthetic fixture content: traces intentionally include the supplied text.

The main controls are:

- `generation`, `transcriptReads`, `registration`, and `disposal` each accept `pause(label)`, `reply(value)`, or `fail(error)`. Pause the next call, await its `entered` checkpoint, then `resolve(value)` or `reject(error)`. Separate calls can be released in either order.
- `turnEnd(sessionID)` queues a capture event. Its promise settles when the capture consumer resumes after processing that event, or when shutdown drops the queued event. Queue repeated events or call lifecycle methods in the desired order to reproduce a specific interleaving.
- `emit`, `move`, `request`, `context`, and `toolResult` drive normalized lifecycle inputs. Context and tool-result controls can omit delivery surfaces or clip text after placement. Feed returned tool results into a later context's `observedResults` to test real receipt accounting.
- `emit("compact", { sessionID, phase, transcript, appendSystem })` drives the same
  compaction operation as the adapters. Omit `phase` for the combined OpenCode
  contract, or send `prepare` and `complete` separately. The callback can collect,
  clip, or reject the anchor; omit completion to model an abandoned preparation.
  Simulator scenarios cover scope, callback failure, frozen-context refresh, and
  one bookkeeping rollup per completed pair without installing a real harness.
- `capabilities` can omit events, transcript access, or generation. Capture is opt-in in this test host (`options: { autoCapture: true }`); its default model response is an empty candidate list. No model request leaves the process.
- `dispose()` models shutdown. Scenario cleanup also cancels held calls and drains tracked work, including setup parked at registration, before the temporary store is removed.

For example, in a test under `test/simulator/`:

```ts
import { expect, test } from "bun:test";
import { withTempStore } from "../helpers/temp-store.ts";
import { runScenario } from "./scenario.ts";

const store = withTempStore({ prefix: "osi-reproduction-" });

test("dispose while the transcript read is pending", async () => {
  await runScenario("pending transcript", async s => {
    const host = s.host("writer", {
      directory: store.root,
      options: { autoCapture: true },
    });
    await host.start();
    const read = host.transcriptReads.pause("transcript");
    const turn = host.turnEnd("session-a");
    await read.entered;
    const cleanup = host.dispose();
    read.resolve([]);
    await Promise.all([turn, cleanup]);
    expect(host.generation.calls).toHaveLength(0);
  });
});
```

Checkpoints control progress; there are no sleep-based success assertions. Ten-second watchdogs report stalls rather than advancing simulated time. The engine still uses its real clock, filesystem and bounded capture drain. Run scenarios sequentially within a process because engine configuration and session ledgers are process-wide. Use distinct session IDs across hosts unless testing an intentional collision. Each scenario resets capture cooldowns and cursors before starting; the store fixture handles shared state and filesystem isolation.

This is the first testing layer, followed by recorded-payload adapter contracts and pinned real-host smoke tests. It models host admission and shutdown, including rejection of late hooks; it does not prove a released host's actual scheduling, payload shape, installation, or process-exit behavior. Keep the real-host suites and their current failure assertions intact. New adapters should reuse the shared behavioral scenarios while adding their own payload and real-host checks.

## The published surface is `package.json`

`exports` defines package imports (`.` → `index.ts`, `./tui` → `src/tui/panel.tsx`, `./oh-my-pi` → `src/adapters/oh-my-pi/extension.ts`); the `omp` manifest also names the oh-my-pi discovery entry. `files` is the packaging list. `files` covers `src/`, so anything reachable from an `exports` target ships, but a new top-level file or directory — or anything the plugin reads at runtime outside those paths — must be added to `files` or it works from the checkout and vanishes from the npm artifact. The packed-artifact loads in `e2e/` and the optional oh-my-pi installation suite turn those misses red.

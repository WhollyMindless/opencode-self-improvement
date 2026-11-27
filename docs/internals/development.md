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

## Host adapter boundary

The [host contract and conformance audit](host-contract.md) defines required
semantics, capability declarations, remaining tool/capture assumptions, and the
limits of the programmable harness. OpenCode is the implementation in this change.

`src/host/contracts.ts` defines the current tool/identity boundary: schema-bearing memory tools, normalized per-call identity, and optional session-directory sources. `src/adapters/opencode/` translates OpenCode tool contexts and directory responses and supplies the OpenCode `codemode: false` registration option. Shared tools validate raw arguments themselves. Shared session policy still owns provisional/firm binding, lookup ordering, pending-lookup joins, and repository isolation. Missing directory sources do not invent a repository; OpenCode API errors retain the existing binding fallback behavior.

`test/host/tool-contract.ts` is a reusable behavioral contract. It runs the real shared tools against both the OpenCode adapter and a minimal normalized in-memory host, checking validation, write gates, project/global visibility, updates, and deletion. The in-memory fixture is not a dsh or Pi implementation. The separate real-host suite still verifies actual OpenCode loading, delivery, and lifecycle behavior.

`src/host/lifecycle.ts` defines normalized prompts, tool results, outgoing request observations, compaction, identity, and usage events. The shared handlers in `src/events.ts` select memory and account for delivery. The OpenCode lifecycle adapter registers hooks, decodes envelopes, and supplies callbacks that insert text into the host's system context and tool results. Receipt matching consumes independent normalized tool-result copies, so repeated or clipped copies cannot combine to prove a row. Receipt settlement remains synchronous and precedes system injection. Observations describe the request visible at the hook; later request transformations remain opaque.

A missing system-context callback skips injection and request accounting. Cleanup stops new callbacks synchronously, aborts the observation subscription, and attempts every registered hook disposer once; setup failure also releases hooks already registered. Already-started handlers finish against their captured delivery surfaces rather than silently dropping text while recording it as delivered. Capture keeps its separate bounded teardown policy. Tests cover normalized handlers without OpenCode envelopes, plus adapter ordering, concurrent receipt settlement, missing capabilities, registration rollback, and late callbacks after disposal.

`src/host/capture.ts` defines optional transcript access, model generation, default-model lookup, and a stream of normalized turn-end events. `src/adapters/opencode/capture.ts` owns OpenCode event names and API calls; `transcript.ts` in the same adapter decodes both recorded and legacy message shapes. Compaction uses that decoder too, taking a snapshot before asynchronous shared handlers run. Missing required capabilities disable capture with a warning. Configuration, model precedence, cooldowns, signal/delta policy, prompt redaction, write gates, and bounded teardown remain in the shared capture runtime.

A normalized transcript preserves one slot per source message, even when the slot has no public conversation text. This preserves cursor positions and lag measurements. The adapter removes reasoning/thinking text and supplies structured user/assistant roles; an assistant quoting a user label cannot create user provenance. The shared renderer applies its turn cap after window selection, so a delta beyond the first forty user turns can still be captured. Adapter tests retain the recorded-message regression matrix; normalized-host tests exercise real capture gates, project visibility, and abandonment without OpenCode envelopes. These contracts do not resolve the known Windows standalone cleanup failure documented in the contract audit.

`src/runtime/setup.ts` now assembles the shared engine through `setupMemory(host, { directory, options })`. The host supplies the tool/identity, lifecycle, and capture ports in `src/host/runtime.ts`, plus an optional command installer. That installer is awaited before registrations begin; a host that omits it writes no OpenCode command files. `src/adapters/opencode/plugin.ts` is the OpenCode composition root, and `commands.ts` beside it owns command-directory discovery and the shipped Markdown format. Both existing package entry points retain their OpenCode exports.

Startup diagnostics derive capture availability from the supplied methods. Adapters may label those methods for diagnostics; labels do not grant capabilities. The OpenCode labels, package version and loaded-directory heartbeat remain compatible. OpenCode capture availability is inspected after hook registration, when the host may have attached additional APIs. Cleanup is idempotent, starts lifecycle shutdown and capture abandonment synchronously, and waits for both before reporting an error. Capture retains its bounded drain policy; a setup failure after lifecycle registration also disposes that registration. Hosts remain responsible for rollback of a failed registration and for releasing their own tool registrations.

`test/runtime/setup.test.ts` exercises complete setup with normalized hosts: tool-mediated writes and later-instance recall, project/global visibility, relevance-selected injection, an unresolved workspace, optional command installation, partial-setup cleanup, and capture draining despite a failing lifecycle disposer. These fixtures are not dsh or Pi adapters. The initialization interfaces are internal to the package rather than a newly published adapter SDK.

Store ownership remains project/global, independent of the adapter. Existing store paths and `OPENCODE_MEMORY_DIR` remain unchanged for compatibility, so hosts configured to use the same root share the same rows. Store configuration is still process-wide; independently configured roots require separate processes. OpenCode session IDs retain their existing values; future adapters sharing one process must make transient session IDs distinct without adding harness ownership to durable rows. A real candidate adapter is the next integration step. The shared engine still requires Bun, so a host using a different runtime needs an explicit in-process or worker strategy.

## Programmable test host

Run `bun run test:simulator` for the scripted-host scenarios and shared-initialization contracts. It needs Bun and this repository's dependencies, with no installed OpenCode, dsh, Pi, oh-my-pi, or model service. These tests also run in the ordinary unit suite. Narrow a reproduction with `bun run test:simulator -t "dispose during a paused transcript"`.

`test/simulator/host.ts` implements the normalized host ports and calls the real `setupMemory`. Tools, selection, write gates, storage, and telemetry are production code. `test/helpers/temp-store.ts` supplies isolated stores without importing the OpenCode plugin; the existing OpenCode test harness re-exports that fixture for compatibility. `test/runtime/setup.test.ts` uses the programmable host instead of its former private driver.

Use `runScenario` to own hosts, collect a single ordered trace, and clean up even after an assertion or checkpoint failure. Its trace records host inputs, model prompts and replies, requested versus delivered system text, tool-result transformations, and shutdown. Failures include the last 100 entries with their original sequence numbers. Trace snapshots retain session identity and replace callback functions with a marker. Use synthetic fixture content: traces intentionally include the supplied text.

The main controls are:

- `generation`, `transcriptReads`, `registration`, and `disposal` each accept `pause(label)`, `reply(value)`, or `fail(error)`. Pause the next call, await its `entered` checkpoint, then `resolve(value)` or `reject(error)`. Separate calls can be released in either order.
- `turnEnd(sessionID)` queues a capture event. Its promise settles when the capture consumer resumes after processing that event, or when shutdown drops the queued event. Queue repeated events or call lifecycle methods in the desired order to reproduce a specific interleaving.
- `emit`, `move`, `request`, `context`, and `toolResult` drive normalized lifecycle inputs. Context and tool-result controls can omit delivery surfaces or clip text after placement. Feed returned tool results into a later context's `observedResults` to test real receipt accounting.
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

`exports` is the only import surface other code can reach (`.` → `index.ts`, `./tui` → `src/tui/panel.tsx`); `files` is the packaging list. `files` covers `src/`, so anything reachable from an `exports` target ships, but a new top-level file or directory — or anything the plugin reads at runtime outside those paths — must be added to `files` or it works from the checkout and vanishes from the npm artifact. The packed-artifact load in `e2e/` turns that miss red.

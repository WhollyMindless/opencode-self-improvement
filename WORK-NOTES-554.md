# Temporary harness support work notes

Updated 2026-11-27. This is a handoff for the current branch, not permanent
project documentation. Update it while the work is active, then remove it
before an upstream merge. Keep lasting architectural guidance in
`docs/internals/development.md` and the eventual PR description.

## What we are trying to do

Make the memory engine usable from other harnesses while keeping their API
shapes, registration, and lifecycle behavior in adapters. The candidates are
dsh and the Pi family, including oh-my-pi. T3 is the user's main daily driver;
this work does not depend on adopting one of the candidates as a daily driver.

Memory belongs to its project or global scope, not to the harness that wrote
it. A memory submitted through OpenCode should be available through another
harness using the same store and project identity. Global memories can be
eligible across projects. Normal relevance, selection, and write rules still
apply; sharing a store does not mean injecting every memory into every request.

## Where the work lives

- Branch: `test/554-harness-contracts`.
- Remote backup: https://github.com/WhollyMindless/opencode-self-improvement/tree/test/554-harness-contracts
- The local branch tracks `fork/test/554-harness-contracts`.
- Previous code checkpoint: `c68afe21471d522ffe4980d331515a53c3010ce5`
  (compaction anchors and shared compaction phases), published and verified.
  The current slice adds combined and per-harness activity statistics; its final
  commit is the branch tip accompanying these notes.
- Last incorporated upstream main: `7b7d88e0` (README improvements, #556), merged
  in `fe00b8cf`. The README conflict was resolved by keeping the new upstream
  introduction/quick start and the experimental adapter notice.
- No implementation PR has been opened.

The contribution offer is https://github.com/abogartz/opencode-self-improvement/issues/554.
At the last check it was open, with our explicitly authorized
[investigation update](https://github.com/abogartz/opencode-self-improvement/issues/554#issuecomment-7208768413),
no maintainer response, assignee, or linked PR. There is no maintainer-agreed
implementation scope yet. The separate scheduled watch reports changes; it does
not post replies or claim work. Its old zero-comment baseline is stale; do not
report our existing update again as a new development.

## What is done

Seven commits establish the baseline and extract the adapter boundary:

- `53f92aa`: shared-store contracts across independent OpenCode instances.
- `38164d6`: retained evidence for the existing real-host capture failure.
- `c9cd073`: isolated OpenCode tool registration and session identity decoding.
- `3df60f3`: isolated lifecycle hooks and context delivery.
- `b2359f0`: isolated capture transcripts and model generation.
- `5af8738`: extracted shared runtime initialization.
- `7c0036d`: added the programmable test harness and fault scenarios.

`src/host/` defines the normalized interfaces. `src/runtime/setup.ts` assembles
the shared engine through `setupMemory`. `src/adapters/opencode/` owns OpenCode
payload decoding, registrations, model calls, and command installation. Existing
OpenCode package entry points and store paths remain compatible. These interfaces
are internal; we have not published an adapter SDK or implemented dsh/Pi support.
The following slices add the narrow oh-my-pi proof and lifecycle hardening below.

The new host in `test/simulator/` runs the real tools, selection, capture, storage,
and telemetry against temporary stores. It can pause or fail calls, release model
answers in a different order, move sessions between repositories, omit capabilities,
clip delivered text, and control shutdown. Scenario failures include an ordered
trace, and cleanup cancels held calls. It needs no installed harness or model service.

Tests now cover repository ownership during interleaved captures, shutdown with
work pending, failure recovery, partial delivery and duplicate receipts, setup
failure, and missing capabilities. Shared initialization tests also use this host.
The intended testing sequence is simulator scenarios, adapter payload contracts,
then pinned real-host smoke tests.

## First real candidate: oh-my-pi

Fetched `origin/main` before this slice; it was already incorporated at `966bb7e`.
The candidate inspection found:

- [oh-my-pi](https://github.com/can1357/oh-my-pi): published
  `@oh-my-pi/pi-coding-agent` 19.2.1 requires Bun >=1.4.4. Its extension factory,
  tools, session context, tool-result events, and `before_agent_start` cover the
  first slice directly. Shutdown is bounded by the host; transcript/model
  generation and compaction injection still need separate work.
- [Pi](https://github.com/earendil-works/pi): the repository now resolves here
  from badlogic/pi-mono. The current package is `@earendil-works/pi-coding-agent`
  1.6.1, Node >=22.19.0. The old `@mariozechner/pi-coding-agent` package is 0.73.1.
  Similar-looking extension APIs differ, including context hooks and factory
  lifetime. Do not reuse the oh-my-pi adapter without an independent contract.
- [dsh](https://github.com/deepseek-ai/deepseek-harness):
  `@deepseek-ai/dsh` 0.2.2-rc.5, Node >=24.9.0. Its Cordis plugin services expose
  tools, system prompt assembly, sessions, agent lifecycle, and tool execution
  middleware. The default branch is `master`. It needs its own adapter and an
  explicit runtime strategy for the Bun engine.

These versions were checked on 2026-11-27. Only oh-my-pi has been installed and
exercised in this slice. It was chosen because its native Bun runtime removes a
worker bridge from the first feasibility proof, not because Pi/dsh are ruled out.
The integration lockfile pins the exact published oh-my-pi dependency graph.

`src/adapters/oh-my-pi/` now translates tools, identity, successful tool results,
selected system context, and shutdown through `setupMemory`. A unique transient
session namespace prevents colliding host IDs from sharing grounding/identity.
There is no durable harness partition and no store migration. Adapter unit tests
cover schemas, gates, project/global scope, relevance, colliding IDs, failed reads,
malformed arguments, aborts, late calls, registration failure, and the lifecycle
contracts below.

`integration/oh-my-pi/` is an optional, pinned real SDK test package. Its typecheck
also checks the adapter's structural subset against the actual SDK declarations.
Two real-host scenarios passed with 110 assertions using OpenCode 2.4.2 and
oh-my-pi 19.2.1: writes/read grounding in both directions, project/global scope,
selection in the outgoing system request, foreign-project mutation rejection,
corrections and deletion across subsequent host sessions. The model is scripted
locally; no paid model or user credentials are involved.

That first proof used a source-path extension, not an advertised npm adapter release.
The following sections describe later capture, delivery, packaging, and compaction
work. Interactive UI, concurrent cross-host writes, and relocated checkouts remain
outside the proof. Read the precise limits and reproduction commands in
`docs/internals/development.md`.

## Lifecycle hardening

Fetched upstream again before this slice; `origin/main` remains at `966bb7e`.
Five failing contracts exposed two adapter bugs: old read grounding survived
transcript replacement when the host reused its session ID, and shutdown could
return while initialization was still creating registrations. Clear, switch,
branch, and tree events now rotate a transient transcript generation; shutdown
waits for initialization and drains admitted work. Durable ownership is unchanged.

The ordinary harness-free adapter suite now has eleven tests (62 assertions),
including compaction epoch refresh and shutdown with a held, subsequently aborted
write. The real SDK suite adds three scenarios: new/resume/clear plus compaction,
aborted preparation followed by recovery, and cancellation/dispose with a held
write. The SDK emits its actual payloads; the probe wraps our public registrations
and a real store lock supplies the pause. There are no timing-based success sleeps.

The actual SDK tests show that clear keeps the session ID, durable rows remain
available, old grounding cannot authorize a new settled write, compaction reselects
memory, and aborting preparation sends no model request or stale memory in the
next unrelated turn. An admitted write survives cancellation, and adapter shutdown
finishes after the write. This does not establish forced-exit durability beyond
the SDK's two-second shutdown handler budget. Branch/tree API navigation is still
covered only at the adapter notification boundary. Capture was disabled at that
checkpoint; the default entry point still leaves it disabled.

## Opt-in capture investigation

The adapter now exposes `createOhMyPiMemory({ capture, options })`. Its synchronous
binding takes a snapshot of the current transcript, model reference, and completion
function before any asynchronous capture work. The adapter queues terminal turns,
skips continuing/async-work loops, and preserves the original project's identity
through session switches. Shutdown closes admission, releases waiting callbacks,
and forwards cancellation to generation. Invalid capture-model configuration was
found to leave callbacks waiting without a consumer; the new subscription check
and regression test prevent that hang. Coalescing retains the first pending
snapshot for each session; the queue is capped at 64 and drops excess notifications.

The optional SDK package contains `capture-extension.ts`, an executable wrapper
using `buildSessionContext` and `completeSimple` with the selected model and host
credential resolver. It sends only the core's redacted capture prompt, no live
conversation history or tools. We deliberately avoided `runEphemeralTurn`, which
inherits the raw session. The decoder filters reasoning, tools, custom messages,
and agent-attributed user messages while preserving cursor slots. The normalized
capture interface now carries session identity and an abort signal; OpenCode's
adapter still forwards only its original model/prompt envelope.

Two real SDK scenarios demonstrate a captured row being recalled through OpenCode
in the same project (and hidden elsewhere), and refusal of a tool-call model
response. Outgoing request assertions check redaction, absence of tool output and
history, model selection, and empty tool definitions. Eight new SDK-free contracts
exercise filtering, interleaved snapshots, cooldowns, project switches, failure
recovery, missing grounding/bindings, thin transcripts, invalid settings, and late
responses during shutdown.

Two SDK discoveries matter for interpreting this proof. `createAgentSession`
alone leaves extension context actions uninitialized; the fixture now calls the
public `initializeExtensions` helper used by print/RPC modes. Also, terminal
extension notification is fire-and-forget from the SDK's run-end path: neither
`prompt()` nor `waitForIdle()` joins it. Immediate disposal can cancel capture
before generation. The capture fixture uses a public-registration handshake to
represent a continuing session, not evidence of reliable capture at CLI exit.
Successful capture is verified through the imported source factory; default
tools/context tests still exercise source-path loading. This does not resolve the
separate existing OpenCode capture-teardown failure.

Capture remains opt-in through the wrapper/factory. Compaction capture is forced
off, and a different explicit `captureModel` is refused rather than silently using
another model. Production packaging, shared SDK instance/provider registration,
host usage/cost accounting, cancellation outside shutdown, actual branch/tree
capture transitions, and headless teardown remain investigation work.

## Packaged tools/context installation

The root package now exports `./oh-my-pi` and declares `omp.extensions` pointing
to the existing tools/context adapter. The OpenCode default and TUI entry points
are unchanged, and no SDK dependency was added to the root. The normal package
keeps capture disabled; the SDK capture wrapper stays outside the tarball.

The new optional `installation.test.ts` packs the project, installs the archive
and dependencies in a fresh directory outside the checkout, then uses the actual
oh-my-pi 19.2.1 CLI to install that copy. The host discovers it from the manifest,
without `--extension`, and all fourteen tools register exactly once. One CLI
process reads a project file and remembers a verified fact; a second recalls
and injects it. A third process in another project cannot see it. Uninstalling the
oh-my-pi registration leaves the row readable through OpenCode. The fixture uses
temporary homes, configuration, projects, and stores with a local scripted model.

This establishes a usable experimental tools/context installation. It is not a
published npm release or a test of interactive UI or real hosted providers.
Local-directory `omp plugin install` creates a link, so the installed directory
must remain. `docs/reference/oh-my-pi.md` documents checkout and packed-copy
installation, store sharing, removal, and limitations. The README links that guide
and distinguishes the adapter's features from the OpenCode feature list.

## Contextual delivery and configuration

The adapter now runs the shared contextual-pull policy on successful tool results.
It returns replacement content to oh-my-pi, preserving existing text/image blocks
and appending only the shared engine's memory suffix. Grounding observes the tool's
original text. The default scope is `read`, `grep`, and `glob`; shell results remain
outside that default, and failed results are skipped.

The public `context` event supplies actual `toolResult` messages to the shared
receipt book. Placement alone earns no pull credit. The matching session, transcript
generation, call, tool, unique header, and complete row must reach that observation.
Clipping a row after placement gives it no credit; duplicate requests cannot credit
it twice. Later context/provider hooks and provider acceptance remain outside this
boundary. No provider-specific payload parser or shared-engine change was needed.

`createOhMyPiMemory({ options })` now honors `pullTools` instead of forcibly disabling
it. It also passes shared budgets and other engine settings through as before. The
installation guide documents a single configured extension entry point. The packed
CLI test disables the default registration, loads a wrapper importing the installed
package, and proves smaller context budgets and disabled pulls while recall still
works. Native `omp plugin config` integration remains pending: the 19.2.1 public
extension API does not expose its plugin-settings reader. We did not duplicate host
configuration-path discovery or add an SDK dependency to the root package.

Eleven adapter delivery scenarios were added; the missing delivery cases failed
before implementation. Four real-SDK scenarios cover kept/clipped pulls, explicit
disable, and arguments-only retrieval. The kept SDK scenario also failed before
implementation. The fake provider's outgoing request and the receipt ledger agree
after a later tool-result formatter. Settings and receipts are still startup/context
observations, not live configuration or proof of model consumption.

Upstream main was fetched again before that slice and was already incorporated (`966bb7e`).

## Compaction anchors through the shared test interface

The programmable `TestHost.emit("compact", ...)` already used the same normalized
operation as the adapters, including `transcript` and `appendSystem`. It needed no
new SDK-specific operation. The shared event now accepts an optional `phase`:
`prepare` supplies the memory anchor and any enabled capture; `complete` finalizes
bookkeeping and invalidates the injection epoch. Omitting the phase retains the
combined OpenCode behavior. This avoids a double rollup and avoids invalidating
frozen context for an abandoned preparation.

The oh-my-pi adapter maps its public `session.compacting` hook to preparation and
returns `{ context }`. It leaves the messages and summary prompt alone. The public
`session_compact` event completes bookkeeping, including when another extension
supplies the whole summary. Compaction capture remains forced off. All selection,
project/global scope, whole-line limits, and the 2,500-character cap remain shared
policy. The adapter neither replaces the summarizer nor adds a memory model call.

Four simulator scenarios cover scoped anchors, an abandoned preparation, a rejected
delivery callback, and the legacy combined operation. Three adapter contracts cover
context-only output, no delivery for empty/mismatched/closed sessions, and completion
without preparation. The new scenarios failed before implementation. Five real-SDK
scenarios inspect the summarizer request: project/global anchors with foreign rows
excluded, an empty store, a full replacement summary, a later hook replacing ours,
and cancellation after preparation followed by a successful retry. Cancelled
preparation sends no request, leaves the transcript intact, and performs no
completion bookkeeping. The normal fixture uses three native summary requests
with or without an anchor.

Limits are explicit: 19.2.1 keeps the last returned compaction-hook result rather
than merging results, so extensions can replace one another's context, prompt,
and preserved data. A full summary replacement bypasses preparation. Tests prove
ordinary LLM summarization input; they do not prove real-model retention or delivery
through snapcompact, handoff, or provider-native compaction paths. Some host paths
bypass hook context. These are host-specific gaps, not reasons to put host APIs in
the shared engine.

## Combined and per-harness statistics

The user requested global and per-harness statistics, explicitly agreeing that
old records with no harness field count as OpenCode. New adapters supply a stable
`MemoryHost.harness`; evidence, retrieval/outcome ledgers, and status payloads
carry it. New operations with no valid source are explicitly `unknown`. An
async-local binding at shared runtime entry points keeps overlapping work and
delayed capture completion attributed to the originating harness. Deferred pull
receipts retain their captured source. Memory ownership remains project/global;
no migration or per-harness store partition was introduced.

`memory_status` / OpenCode's `/memory-report` now show shared inventory plus
combined and per-harness activity: credited inject/pull/recall events, blocked
writes, reported session tokens, capture calls/estimates/rows, and capture lag
percentiles. Capture configuration is read within each harness, so an oh-my-pi
`off` heartbeat does not override OpenCode's state. The terminal panel retains its
existing session view.

Usage snapshots are persisted and reconstructed from retained evidence. The latest
observation wins per harness/session; duplicate or reordered writes are not summed.
Usage folding, retrieval throttles, and capture session counts distinguish harnesses
even when raw session IDs collide. This does not solve all process-global session
state: adapters still namespace transient IDs. Statistics cover retained data in
a trailing thirty-day window, with throttled retrieval credits and no lifetime
claim. A session total can include earlier work; per-message sources cover only
runtime-observed messages and can become partial after a restart without history
replay. Unreported usage is not zero. Capture estimates remain separate from
reported tokens; no currency cost is claimed. Oh-my-pi model-usage mapping is
still the next parity slice.

Six new test scenarios cover shared memory with separate/combined statistics,
source identity during delayed captures, legacy OpenCode attribution, same-ID
sessions, duplicate/reordered snapshots, malformed/expired receipts, and missing
usage. Existing telemetry privacy checks now allow the source label while still
rejecting memory/tool-output content. Real SDK tests read the shared breakdown
from both OpenCode and oh-my-pi across separate processes.

## Current validation

The last code validation used Windows, Bun 1.4.4, and OpenCode 2.4.2:

- oh-my-pi adapter contracts: thirty-three passed (eleven lifecycle/tools, eleven
  delivery/configuration, eight capture, and three compaction scenarios), included
  in the full unit run. Six new statistics scenarios passed (40 assertions).
- Pinned SDK compatibility typecheck passed; the full optional integration suite:
  seventeen passed, 236 parent-test assertions plus assertions inside the SDK children.
  This includes shared statistics, compaction, delivery, and installed CLI configuration.
- Full unit suite, including simulator/shared initialization: 1,938 passed,
  34 skipped, no failures.
- Comment policy, typecheck, lint, and formatting passed.
- Real-host E2E: 57 passed, three failed. The full gate is therefore still red.

The three failures were reproduced before the adapter extraction: capture returns
a model answer but fails to persist the candidate during real-host teardown; two
viewer tests fail during Windows cleanup with `EBUSY`. Preserve their assertions.
The capture trace does not establish whether OpenCode awaited plugin cleanup.

The earlier targeted OpenCode 2.0.26 checks passed for loading, shared stores, and
compaction (seven checks). That version was not rerun for the oh-my-pi checkpoints.
Local logs, which are temporary and are not part of the remote backup, are
`%TEMP%\osi-554-harness-stats-gate.log` and
`%TEMP%\osi-554-harness-stats-integration.log` for this slice. The compaction logs are
`%TEMP%\osi-554-omp-compaction-gate.log` and
`%TEMP%\osi-554-omp-compaction-integration.log`. The delivery logs are
`%TEMP%\osi-554-omp-delivery-gate.log` and
`%TEMP%\osi-554-omp-delivery-integration.log`. The installation logs are
`%TEMP%\osi-554-omp-install-gate.log` and
`%TEMP%\osi-554-omp-install-integration.log`. The preceding capture
logs are `%TEMP%\osi-554-omp-capture-gate.log` and
`%TEMP%\osi-554-omp-capture-integration.log`. The previous lifecycle
logs are `%TEMP%\osi-554-omp-lifecycle-gate.log` and
`%TEMP%\osi-554-omp-lifecycle-integration.log`. The earlier
adapter logs remain `%TEMP%\osi-554-omp-gate.log` and
`%TEMP%\osi-554-omp-integration.log`; the simulator checkpoint logs remain
`%TEMP%\osi-554-simulator-gate.log` and `%TEMP%\osi-554-simulator-final.log`.

Useful commands:

```sh
bun run test:simulator
bun run test:simulator -t "dispose during a paused transcript"
bun install --cwd integration/oh-my-pi --frozen-lockfile
bun run test:oh-my-pi
bun run typecheck
bun run test
bun run gate
```

The simulator uses the real clock, filesystem, and capture drain timeout; its
checkpoints control ordering rather than providing a virtual clock. Run scenarios
sequentially within one process. It cannot prove a released harness's payloads,
installation, scheduling, or actual process-exit behavior.

## What we think comes next

1. Fetch upstream main and merge any new changes into this branch before the next
   implementation slice. Keep the work incremental and publish each useful checkpoint.
   The next parity slice should map ordinary model-usage events into the shared
   usage/evidence interface and verify its contribution to both the combined and
   per-harness totals. The generic interface and reporting are now in place.
   Native configuration UI and command/UI equivalents
   also remain; compaction method coverage needs expansion beyond LLM summaries.
   Keep capture opt-in while settling its shutdown and provider-accounting limits.
2. Add actual SDK branch/tree navigation and shutdown-deadline fault scenarios
   when expanding the supported lifecycle surface. Current checks cover their
   notifications and cooperative shutdown, not every host transition or process kill.
3. Resolve the remaining capture lifecycle limits: prove behavior during actual
   branch/tree navigation and immediate teardown, and decide how host cancellation,
   usage/cost accounting, and pre-compaction capture should map. The isolated
   continuing-session capture proof exists; keep it opt-in until these limits and
   packaging are addressed.
4. Try the documented tools/context installation interactively and collect real
   provider feedback. Packaging and CLI restart/recall are verified; decide release
   naming/versioning with the maintainer before any registry publication. Capture
   SDK sharing remains separate packaging work. Preserve the OpenCode surface.
5. Design and test a Bun worker boundary for Node-based Pi/dsh, or prove a supported
   in-process arrangement. The existing adapter interfaces do not solve runtime
   compatibility. Implement each host's own payload/lifecycle mapping and reuse
   the shared-store scenarios rather than assuming Pi derivatives are identical.

Investigate the existing teardown failure as a separate, evidence-backed fix. The
simulator can reproduce a suspected ordering problem, but a fix still needs the
real-host test. Keep the Windows viewer cleanup failures visible as well.

## Constraints to preserve

- Keep durable ownership project/global. Distinguish transient session IDs when
  different adapters share a process; do not partition stored memories by harness.
- Store configuration and some engine state are process-wide. Independently
  configured store roots currently require separate processes.
- Same-store tests use matching project identities. Portability across relocated
  checkouts or machines is not established by these tests.
- Cross-session visibility is covered; updating an already frozen injection block
  in a running session is not promised.
- Keep host-specific types and payloads inside adapters. Missing optional capabilities
  should degrade predictably. Release registrations where the host exposes disposal;
  otherwise close admission, drain work, and let the host unload its registrations.

For the detailed contracts and simulator usage, start at
`docs/internals/development.md`, `src/host/runtime.ts`,
`test/host/tool-contract.ts`, and `test/simulator/scenarios.test.ts`.

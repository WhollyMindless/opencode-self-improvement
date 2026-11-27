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
- Previous code checkpoint: `6a00403b5d19be50d2f557749a47b41abfbc4da8`, published
  in draft PR #560 with all five CI checks passing. The current slice enables
  built-in oh-my-pi turn-end capture and adds `README.oh-my-pi.md` with installation
  instructions and an explicit agent-install prompt.
- Last incorporated upstream main: `7b7d88e0` (README improvements, #556), merged
  in `fe00b8cf`. The README conflict was resolved by keeping the new upstream
  introduction/quick start and the experimental adapter notice.
- Upstream draft PR: https://github.com/abogartz/opencode-self-improvement/pull/560.
  It targets upstream main from the fork's feature branch; the fork remains the
  source and backup. The draft includes validation, the remaining host failure,
  and a suggested review order. This is still exploratory work without
  maintainer-agreed scope. CI was pending when the draft was opened.

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
reported tokens; no currency cost is claimed. The following slice adds oh-my-pi
assistant-usage mapping.

Six new test scenarios cover shared memory with separate/combined statistics,
source identity during delayed captures, legacy OpenCode attribution, same-ID
sessions, duplicate/reordered snapshots, malformed/expired receipts, and missing
usage. Existing telemetry privacy checks now allow the source label while still
rejecting memory/tool-output content. Real SDK tests read the shared breakdown
from both OpenCode and oh-my-pi across separate processes.

## Oh-my-pi assistant usage

The adapter now snapshots finalized assistant usage through the public readonly
`sessionManager.getEntries()` at load, agent completion, session transitions, and
cooperative shutdown. Repeated completion notifications replace cumulative
receipts; streaming deltas are not independently counted. Valid usage survives
error/cancellation status. Missing or malformed receipts are excluded.

`SessionUsage.accountingID` separates stable usage identity from the transient
session ID that isolates grounding after reload/tree changes. Restarting a native
session in another process reconstructs its retained total under the same key.
Adapters without this field keep the previous behavior. Native output includes
reasoning; when every receipt provides `reasoningTokens`, it is separated. Without
a complete split, output stays combined and reasoning stays unknown. Generic
per-message folding also preserves known reasoning tokens when another message
has no split. Mixed-harness reports do not invent a missing reasoning total.

The real-SDK BDD failed before implementation, then passed two streamed turns,
cancelled preparation, disposal, and a second process reopening the saved session.
Four adapter scenarios and two additional simulator scenarios cover duplicate
events, reload/transcript generations, invalid and missing usage, aborted/failed
messages, late notifications, mixed harness totals, and partial reasoning splits.
The capture disposal regression suite caught and prevented delaying cancellation
behind the final usage write. Its existing immediate-abort assertion is unchanged.

These are retained assistant-history snapshots, not billing totals: off-branch
messages count, separate forks can inherit overlapping history, and pruning can
lower a snapshot. Auxiliary model records, subagent tool totals, and separate
capture model calls are excluded. Forced-exit durability and hosted-provider
coverage remain unproved. The adapter adds no model call or SDK dependency.
Upstream main was fetched and remains incorporated at `7b7d88e0`.

## Built-in automatic capture (current)

The packaged entry point now enables turn-end capture without a custom wrapper.
`completion.ts` snapshots the terminal event's active transcript, model routing,
and credential resolver bound to the original session. `captureModel` selects an
available model through the host registry; no override inherits the session model.
The running host's loader resolves its model SDK, so normal package installations
do not install another model SDK. Root development dependencies pin pi-ai and
pi-catalog 19.2.1 for types and contract tests.

Only the sanitized capture prompt reaches the isolated completion: no tools,
reasoning blocks, raw tool results, or live host conversation history. Invalid,
truncated, aborted, and tool-call responses cannot create memories. The normal
shared gates, cooldowns, project ownership, and capture telemetry still apply.

Built-in requests have a 20-second abort deadline. Cooperative shutdown closes
admission, gives pending capture up to 500 ms to settle, then cancels unanswered
generation and drains admitted writes. The earlier two-second grace exceeded the
host's two-second total shutdown budget; the new real-SDK stalled-provider test
reproduced that failure before the grace was shortened. Slow immediate-exit
captures can be lost; forced termination is still outside the guarantee. Explicit
custom capture bindings retain the existing immediate-cancellation behavior.

The packed CLI test now proves automatic capture and recall in a new process,
with no completion handshake or custom wrapper. It also proves explicit
`autoCapture: false` prevents calls. SDK capture tests now use the built-in binding;
they verify redaction, project visibility, rejection of tool-call responses,
quick-answer persistence during shutdown, and cancellation of a held response
without late writes. Model/credential/transcript snapshots and explicit model
selection have unit contracts. Actual branch/tree navigation during capture and
hosted-provider coverage remain follow-ups; compaction capture remains disabled.

`README.oh-my-pi.md` is linked from the main README and included in the tarball.
It documents checkout/PR installation, store sharing, verification, configuration,
removal, and a copyable task for an agent to perform an authorized installation.
The agent must report the required host restart; installing does not load the
extension into an already running session. Older investigation sections above
describe earlier checkpoints, including their then-disabled capture default.
The new `oh-my-pi` CI job installs the pinned SDK dependencies and runs this suite
with OpenCode 2.0.26 for cross-harness checks on every PR update.

## Current validation

The last code validation used Windows, Bun 1.4.4, and OpenCode 2.4.2:

- oh-my-pi adapter contracts: forty passed (eleven lifecycle/tools, eleven
  delivery/configuration, eight capture, three completion binding, three compaction,
  and four usage scenarios),
  included in the full unit run. Two additional simulator scenarios cover stable
  accounting and incomplete reasoning splits.
- Pinned SDK compatibility typecheck passed; the full optional integration suite:
  twenty passed, 256 parent-test assertions plus assertions inside the SDK children.
  The packed installation scenario was rechecked after the README/package additions:
  one passed with 63 assertions, including presence of the README in the tarball
  and absence of an installed pi-ai dependency in the consumer.
  This includes usage across process restart, shared statistics, compaction,
  delivery, and installed CLI configuration.
- Full unit suite, including simulator/shared initialization: 1,947 passed,
  34 skipped, no failures.
- Comment policy, typecheck, lint, and formatting passed.
- Real-host E2E: 61 passed, one failed. The full gate is therefore still red.
- The two new cooperative-shutdown controls also passed separately against the
  supported OpenCode 2.0.26 baseline.

All three earlier failures were reproduced before the adapter extraction. The two
viewer cleanup failures are fixed by awaiting child exit before deleting its
temporary store; their HTTP and persistence assertions are unchanged.

The remaining standalone capture test still returns a model answer but fails to
persist its candidate. The independent teardown probe now records cleanup entry,
async completion, and process exit hooks. On OpenCode 2.4.2/Windows none ran in any
of three standalone trials, although all three received turn-end. The tagged host
source uses `taskkill /T /F` in its Windows process-spawner termination path, even
for SIGTERM. This is evidence of a host shutdown boundary, not an adapter-specific
write-gate failure. See the source links in `docs/internals/development.md`.

The cooperative control runs the real server with a stdin ownership lease and
connects the CLI using `--server`. Closing that lease invokes and awaits async
plugin cleanup, and the real capture control persists the byte-exact candidate.
The control cannot pin whether persistence finished before or during shutdown;
existing deterministic disposal tests cover the in-flight write ordering. No
production write gates, capture cancellation policy, or opt-in defaults changed.
The original failing standalone assertion remains intact. Fixing forced host
termination requires host-side work; a delay or optimistic gate bypass is not a
plugin fix.

The earlier targeted OpenCode 2.0.26 checks passed for loading, shared stores, and
compaction (seven checks). That version was not rerun for the oh-my-pi checkpoints.
Current logs are `%TEMP%\osi-554-autocapture-gate.log`,
`%TEMP%\osi-554-autocapture-integration.log`, and
`%TEMP%\osi-554-autocapture-readme-install.log`. The gate still has the one known
OpenCode Windows standalone failure; oh-my-pi shutdown checks pass.
Earlier logs, which are temporary and are not part of the remote backup, are
`%TEMP%\osi-554-shutdown-gate.log` and
`%TEMP%\osi-554-cooperative-baseline.log` cover the current slice. The preceding
`%TEMP%\osi-554-omp-usage-gate.log` and
`%TEMP%\osi-554-omp-usage-integration.log` for this slice. The preceding statistics logs are
`%TEMP%\osi-554-harness-stats-gate.log` and
`%TEMP%\osi-554-harness-stats-integration.log`. The compaction logs are
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
   Assistant usage now reaches both combined and per-harness totals. Present the
   exploratory branch upstream for feedback on the adapter boundary, shared stores,
   and experimental oh-my-pi packaging. The shutdown diagnosis and cooperative
   controls are ready for that discussion; the Windows standalone failure remains
   explicit. Agree on the landing scope before marking a draft ready to merge.
   Native configuration UI and command/UI equivalents
   also remain; compaction method coverage needs expansion beyond LLM summaries.
   Built-in turn-end capture is now enabled; keep compaction capture off while
   settling additional lifecycle and provider-accounting limits.
2. Add actual SDK branch/tree navigation and shutdown-deadline fault scenarios
   when expanding the supported lifecycle surface. Current checks cover their
   notifications and cooperative shutdown, not every host transition or process kill.
3. Resolve the remaining capture lifecycle limits: prove behavior during actual
   branch/tree navigation and immediate teardown, and decide how host cancellation,
   usage/cost accounting, and pre-compaction capture should map. The isolated
   continuing-session, packaged CLI, and bounded shutdown proofs now exist.
   Preserve their limits when extending lifecycle coverage.
4. Try the documented tools/context installation interactively and collect real
   provider feedback. Packaging and CLI restart/recall are verified; decide release
   naming/versioning with the maintainer before any registry publication. Capture
   SDK sharing remains separate packaging work. Preserve the OpenCode surface.
5. Design and test a Bun worker boundary for Node-based Pi/dsh, or prove a supported
   in-process arrangement. The existing adapter interfaces do not solve runtime
   compatibility. Implement each host's own payload/lifecycle mapping and reuse
   the shared-store scenarios rather than assuming Pi derivatives are identical.

Carry the standalone teardown reproduction into a separate host-side fix if that
work is taken on. A fix still needs the original real-host assertion to pass.
The Windows viewer cleanup failures are resolved in this checkpoint.

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

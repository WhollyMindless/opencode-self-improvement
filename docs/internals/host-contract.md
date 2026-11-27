# Internal host contract and conformance

The host boundary is an internal protocol consumed by the shared memory engine.
OpenCode implements it in `src/adapters/opencode/`; the programmable host in
`test/simulator/` implements the same interfaces without a vendor SDK. This is
not a published adapter SDK or a claim of support for another harness.

## Required semantics

- **Tools:** register the fourteen definitions once, preserve their JSON schemas,
  pass raw arguments to the shared validator, and return the shared text result.
  Registration options and native command installation belong to the adapter.
- **Identity:** capture session/call IDs and the absolute project directory before
  awaiting work. Session IDs must be distinct between concurrent host instances
  unless they refer to the same transcript. Bind directory changes explicitly.
  Unknown ownership must not fall back to another session's project. A transcript
  replacement must retire its old grounding and frozen context, even if the host
  keeps its session ID; an adapter can use a fresh generation in its internal ID.
- **Storage:** ownership is project/global, never adapter-specific. Sharing a
  memory directory and project identity shares eligible rows; relevance selection
  still applies. Root configuration and some engine state are process-wide, so
  independent roots require separate processes. The engine requires Bun and local
  filesystem/git access. A Node host needs an explicit runtime bridge.
- **Lifecycle:** report prompts, tool calls/results, context observations, identity,
  usage and compaction through `LifecycleHandlers`. Callbacks may overlap; retain
  the original event's identity and delivery sink across awaits. Await preparation
  before sending the request. The combined compaction operation is the existing
  OpenCode contract; a host with separate preparation/commit hooks needs an
  explicit mapping before its adapter can claim compaction support.
- **Injection:** append the exact returned text to the declared surface. A missing
  sink means no delivery. Observe tool results independently by session and call
  ID; clipped, duplicated or quoted fragments must not create delivery credit.
  Hook observation proves what was visible there, not provider acceptance after
  later transformations. Declare placement relative to the conversation's cached
  prefix; do not infer cache preservation from a successful append.
- **Capture:** expose turn-end events, a normalized transcript, and isolated text
  generation, or omit unavailable methods. Preserve transcript slots and genuine
  user/assistant provenance; strip thinking and synthetic/tool content. Bind model
  and credential routing to the original session before awaits. Generate only from
  the supplied scrubbed prompt, with no inherited tools or ambient conversation.
  Honor cancellation and reject unsuccessful completions. Shared policy retains
  model selection, cooldowns, redaction, write gates, and bounded abandonment.
- **Usage:** normalize message/session identity and cumulative versus incremental
  receipts. Streaming updates replace the same message receipt, not another one.
  Cache counts and generated counts are tokens, not currency or proof of delivery.
- **Shutdown:** stop admission synchronously, release subscriptions/registrations,
  and join the returned cleanup promise when the host allows it. Shared capture
  drains already-answered work for a bounded interval and abandons unanswered work.
  Forced termination can bypass all callbacks; no adapter promises persistence then.

## Capability declarations

`src/host/capabilities.ts` defines the report exposed as
`MemoryRuntime.capabilities`. An adapter must declare tool/event/usage/injection
surfaces, compaction shape, prompt-dependent cache placement, and shutdown
semantics. Capture availability is derived from the actual optional methods,
not diagnostic labels. A model lookup method does not guarantee a selected model
or valid credentials. Reports describe offered surfaces; individual callbacks
still check whether their actual delivery sink exists.

OpenCode declares system context ahead of conversation text: changing that text
changes the conversation prefix. This does not claim every turn changes it; the
existing stable-core injection policy remains intact. Its cleanup is best-effort:
a cooperative server can await it, but Windows standalone termination can bypass
it. The simulator declares cache placement unknown because it has no provider;
its cooperative disposal is awaited and forced exit offers no cleanup guarantee.

This extraction adds inspection of these declarations, not a new status-panel
format or a new capability-based policy. Existing OpenCode payloads, defaults,
store files, command installation and evidence semantics are retained.

## Audit of the fourteen tools

None of these shared tool handlers imports the OpenCode SDK. All use the same
registry and validator through `MemoryToolHost`. Their remaining dependencies are
engine policy and filesystem/session contracts, some inherited from OpenCode.

| Tool | Adapter obligation or remaining dependency |
| --- | --- |
| `memory_remember` | Bind writer ownership; settled behavioral facts depend on normalized engagement evidence. |
| `memory_update` | Bind the same reader/writer identity throughout replacement and gate checks. |
| `memory_forget` | Preserve selector, reason and project/global authorization semantics. |
| `memory_recall` | Bind reader identity and call ID for visibility and use accounting. |
| `memory_list` | Preserve shared inventory/filter semantics; listing is not relevance injection. |
| `memory_undo` | Preserve snapshot and write ownership checks; local shared-store access is required. |
| `memory_evidence` | Preserve reader-scoped evidence and original operation IDs. |
| `memory_merge_review` | Preserve candidate ownership, reason and gate checks. |
| `memory_export` | Write to the configured local store export directory under existing containment rules. |
| `memory_import` | Read a local artifact and preserve importer ownership and replay gates. |
| `memory_decay` | Preserve dry-run/default behavior and scoped mutation semantics. |
| `memory_consolidate` | Preserve shared store analysis; this is not a host model call. |
| `memory_init` | Supply the actual local project tree; script discovery and git HEAD stamps require filesystem/git access. |
| `memory_status` | Supply normalized usage/context evidence; shared text currently names OpenCode UI surfaces and aggregate store counts are machine-wide. |

The important remaining assumptions are **below** the tool handlers:

1. `capture/triggers.ts` recognizes `read`, `grep`, `glob`, `edit`, `write`,
   `bash`, and `shell` as engagement. It extracts arguments from
   `command/cmd/pattern/query/path/filePath` and command exit status from
   `metadata.exitCode/exit/code`, with legacy text fallbacks. `capture/policy.ts`
   uses the same edit/command vocabulary for signal selection. Unknown names may
   miss grounding or capture. A differently named host must translate genuine
   semantics; it must not relabel failed operations as successful engagement.
2. Pull defaults select `read/grep/glob`. An adapter must map those meanings or
   supply explicit `pullTools`. A mutable system/result sink and hook observation
   do not establish exact provider bytes or cache acceptance.
3. Transcript cursor positions count source slots. Filtering records out rather
   than leaving empty slots changes delta/lag semantics. Session replacement
   needs distinct internal identity to prevent old grounding authorizing new writes.
4. The current usage structure requires numeric reasoning/output fields. The
   existing OpenCode mapping is retained; a host that cannot report the same
   distinctions needs an explicit unknown-value representation before claiming
   equivalent measurements. Missing optional hooks must be declared absent.
5. Default paths retain the OpenCode name for compatibility; process-global
   configuration is not a multi-tenant store API. Package entry points and TUI
   remain OpenCode-specific. Only registration and payload translation moved.

Therefore this is a real protocol extraction with tested OpenCode conformance,
but not a universal adapter promise based on interface shape alone. A second host
must test these semantic obligations against its own released SDK and runtime.

## Proof and boundaries of the proof

Run `bun run test:simulator` for the real engine with controlled event order,
missing capabilities, failed/held generation, clipped delivery, concurrent
sessions, and teardown. It records attempted versus delivered text at its sinks.
It cannot observe a real provider or prove caching or forced-exit durability.

`test/host/tool-contract.ts` runs shared write/visibility/correction/deletion
scenarios through both the OpenCode tool adapter and a normalized host. Adapter
tests pin recorded payload decoding, capture, usage and lifecycle behavior.
`e2e/coverage.test.ts` and `e2e/characterization.test.ts` retain real OpenCode
coverage of the fourteen tools. Existing E2E assertions are unchanged; the added
shared-store scenarios run independent OpenCode processes.

Run `bun run gate` for the existing OpenCode CI sequence. The known Windows
standalone cleanup failure remains an unconditional assertion, reported with a
minimal independent reproduction in
[OpenCode #66868](https://github.com/anomalyco/opencode/issues/66868). Green Linux
checks must not be described as fixing that Windows behavior.

## Separate behavior changes

Adapters for upstream Pi, oh-my-pi, and dsh, per-harness statistics, and capture
loss accounting do not belong in this behavior-preserving foundation. The
experimental oh-my-pi implementation remains in
[draft #560](https://github.com/abogartz/opencode-self-improvement/pull/560).

Loss accounting needs durable admission/completion records and explicit observed
abandonment reasons. After forced termination, an unfinished record means outcome
unknown, not necessarily a lost memory: storage may have succeeded before its
receipt was written. The killed process cannot reliably emit a final loss event.
That distinction needs a separate tested change; existing evidence gaps are not
presented here as an accurate lost-capture counter. Historical harness attribution
is likewise unchanged by this extraction.

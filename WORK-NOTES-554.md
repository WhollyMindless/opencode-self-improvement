# Temporary harness support work notes

Updated 2026-11-26. This is a handoff for the current branch, not permanent
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
- Code checkpoint: `7c0036d8de2751aba090ed70a2e3f7dd4da2b589`, published and verified.
- Last incorporated upstream main: `966bb7e` (merge of the host teardown probe, #551).
- No implementation PR has been opened.

The contribution offer is https://github.com/abogartz/opencode-self-improvement/issues/554.
At the last check it was open with no comments, assignee, or linked PR. There
is no maintainer-agreed implementation scope yet. The separate scheduled watch
reports changes; it does not post replies or claim work.

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

## Current validation

The last code validation used Windows, Bun 1.4.4, and OpenCode 2.4.2:

- Simulator and shared initialization: 18 passed.
- Full unit suite: 1,895 passed, 34 skipped, no failures.
- Comment policy, typecheck, lint, and formatting passed.
- Real-host E2E: 57 passed, three failed. The full gate is therefore still red.

The three failures were reproduced before the adapter extraction: capture returns
a model answer but fails to persist the candidate during real-host teardown; two
viewer tests fail during Windows cleanup with `EBUSY`. Preserve their assertions.
The capture trace does not establish whether OpenCode awaited plugin cleanup.

The earlier targeted OpenCode 2.0.26 checks passed for loading, shared stores, and
compaction (seven checks). That version was not rerun for the latest test-only commit.
Local logs, which are temporary and are not part of the remote backup, are
`%TEMP%\osi-554-simulator-gate.log` and `%TEMP%\osi-554-simulator-final.log`.

Useful commands:

```sh
bun run test:simulator
bun run test:simulator -t "dispose during a paused transcript"
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
2. Inspect and pin the actual extension APIs for dsh, Pi, and oh-my-pi. Record which
   tool, identity, context, transcript, generation, and shutdown capabilities each
   supplies. Do not assume Pi derivatives have interchangeable extension APIs.
3. Choose the first adapter and its runtime arrangement from that evidence. The
   engine still requires Bun. A host using another runtime needs a tested in-process
   arrangement or a Bun worker bridge; extracting interfaces alone has not solved it.
4. Build one narrow adapter through the shared interfaces. Start with tools, project
   identity, and selected context delivery; add capture as the host capabilities allow.
   Reuse shared behavioral tests and add recorded payload tests for the actual API.
5. Prove sharing in both directions with a real second harness: write through one,
   read or select through the other; also check project isolation, global eligibility,
   corrections, and deletion. Then run installation and lifecycle smoke tests against
   pinned releases before claiming support.

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
  should degrade predictably, and adapters must release their own registrations.

For the detailed contracts and simulator usage, start at
`docs/internals/development.md`, `src/host/runtime.ts`,
`test/host/tool-contract.ts`, and `test/simulator/scenarios.test.ts`.

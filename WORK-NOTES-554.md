# Temporary harness support work notes

Updated 2026-11-27. This is a short handoff for the active branch. Remove it before
upstream merge; lasting guidance belongs in docs/internals/development.md and
README.oh-my-pi.md.

## Intent and location

Memory belongs to a project or global scope, not to a harness. OpenCode and
another harness should share eligible memories when configured with the same
store and project identity. Relevance selection and write gates still apply.

- Branch: test/554-harness-contracts, tracking fork/test/554-harness-contracts.
- Backup: https://github.com/WhollyMindless/opencode-self-improvement/tree/test/554-harness-contracts
- Upstream draft: https://github.com/abogartz/opencode-self-improvement/pull/560
- Contribution offer: https://github.com/abogartz/opencode-self-improvement/issues/554
- Main incorporated through 48bdf6f7 (0.37.2), merge commit 286abb4a.
- Foundation PR #561 is now integrated through 8f7da817. Its OpenCode host factory,
  capability contract, simulator, and cross-host runtime tests are shared by this
  branch. Both PRs still target main; the displayed diff will include foundation
  work until that first landing unit is accepted.
- There is no maintainer-agreed landing scope. No review threads or comments were
  present on PR #560 at this check. Keep the draft status while seeking feedback.

## Implemented

- Shared host interfaces separate tools, lifecycle, capture, identity, and usage
  from OpenCode payloads. The OpenCode entry point and storage format are retained.
- OpenCode, oh-my-pi and the simulator all use MemoryHost/setupMemory. OpenCode's
  plugin is only a host-construction/setup/disposal entry point. Attribution
  forwards live capability reports; oh-my-pi declares split compaction and
  best-effort shutdown under the host's two-second limit.
- Programmable test host drives the real engine through controlled event ordering,
  missing capabilities, errors, transcript changes, and bounded shutdown.
- oh-my-pi 19.2.1 exposes fourteen tools, prompt context, tool-result pulls,
  compaction anchors, and automatic capture using the host model and credentials.
- Compaction capture now snapshots the original transcript and starts only after
  successful host compaction, including summaries supplied by other extensions.
  Cancellation starts no capture. Async-local bindings isolate concurrent snapshots.
- Native /repo-init, /memory-report, and /memory commands invoke shared tools
  without a model turn. Persistent JSON configuration works through the normal
  entry point: <memory-root>/oh-my-pi.json or OMP_MEMORY_CONFIG. Programmatic
  options override JSON settings; restart after edits.
- Combined and per-harness statistics share the same store. Historical records
  without attribution count as OpenCode. Assistant usage is retained-history
  accounting, not a billing ledger; capture spend remains estimated.
- Real SDK tests cover branch/tree/switch capture boundaries, compaction,
  cancellation, runtime-registered providers, direct commands, and shutdown.
- Packed CLI tests cover installation, discovery, restart, explicit and automatic
  capture, settings, commands, project isolation, uninstall, and OpenCode sharing.
- CI now runs the oh-my-pi suite on Linux and Windows, pinned to Bun 1.4.4 and
  oh-my-pi 19.2.1, with OpenCode 2.0.26 for cross-harness checks.

## OpenCode Windows shutdown report

Filed with the small self-contained reproduction:
https://github.com/anomalyco/opencode/issues/66868

Related project report/backlink:
https://github.com/abogartz/opencode-self-improvement/issues/481#issuecomment-7225894652

The source is e2e/repros/standalone-cleanup/. The plugin is sixteen lines, imports
no project code, and records setup plus async cleanup. Verified after extracting
outside this checkout with OpenCode 2.4.2 and 2.0.26: standalone exits with no
cleanup; closing a cooperative server's stdin lease completes cleanup. The
original failing standalone E2E assertion remains enabled. This failure is
independent of the passing oh-my-pi shutdown tests.

## Validation and remaining work

Windows CI follow-up: eb955078 repeated the packed-install recall failure and
hit the provider fixture's 30-second process watchdog. A local run under an
actual 8.3 temporary-directory alias reproduced the identical recall failure.
Bun realpathSync retained the short name; realpathSync.native expanded it, so
the two harnesses could hash different names for one directory. Normalization
now uses the native Windows resolver, and visibility preserves old path keys
when the stored path identifies the same canonical directory. The regression
also checks that a different project cannot read those rows. Packed installation
now passes under the short alias with pinned OpenCode 2.0.26.

The provider process watchdog is now 90 seconds, consistent with other SDK
fixtures, and logs its phase on failure. This does not change the production
20-second generation timeout or shutdown limits. Hosted CI must confirm both
changes; the known OpenCode standalone shutdown issue is separate.

Foundation integration validation: 1,958 unit tests pass with 34 skips; 57 focused
adapter/runtime/simulator tests pass. All 32 real oh-my-pi integration tests pass.
OpenCode 2.4.2 E2E has 61 passes and the known
standalone shutdown failure. Packed installation passes locally with both
OpenCode 2.4.2 and CI's pinned 2.0.26. The previous Windows CI recall failure is
not yet considered resolved: wait for the new hosted run before claiming that.
Foundation PR #561 separately has 1,902 passing unit tests and the same three
Windows E2E baseline failures recorded against upstream main (shutdown plus two
viewer cleanup failures). Its head is 8f7da817.

Completion validation on Windows with Bun 1.4.4:

- Comment policy, root/SDK typechecks, lint, formatting, and workflow YAML parse pass.
- Unit suite: 1,955 passed, 34 skipped, zero failures.
- oh-my-pi integration: 32 passed, zero failures, 299 assertions, using pinned
  oh-my-pi 19.2.1 and OpenCode 2.0.26. Includes packed installation and commands.
- OpenCode 2.4.2 E2E: 61 passed, one failure, the unchanged standalone shutdown
  assertion reported in OpenCode #66868. The local full gate therefore stays red.
- Quick and unanswered compaction capture shutdown scenarios pass. The original
  quick-answer scenario failed before adding bounded grace for compaction tasks.

Logs:

- %TEMP%\osi-omp-completion-gate-final.log
- %TEMP%\osi-omp-completion-unit-final.log
- %TEMP%\osi-omp-completion-integration-final.log
- %TEMP%\osi-omp-completion-packed.log

Useful commands: bun run gate; bun run test:oh-my-pi; bun run test:simulator.
Install the optional SDK dependencies with:
bun install --cwd integration/oh-my-pi --frozen-lockfile

Publish this checkpoint to the existing branch, update PR #560's scope and
evidence, and watch CI. Next is CI and maintainer review; do not claim a release
or upstream acceptance. Live hosted-provider
and interactive trials remain valuable release feedback; deterministic tests use
local scripted/custom providers and no paid service. OpenCode's interactive panel
is host-specific, and oh-my-pi's public plugin-settings UI reader is unavailable.
Snapcompact, handoff, and provider-native compaction anchor delivery remain outside
the tested LLM summary paths. A pre-compaction hook changes some host background
optimization choices; captureOnCompact=false omits that hook.

Upstream Pi and dsh are separate follow-ups: their Node runtime needs a deliberate
Bun boundary, not reuse of oh-my-pi's contract. Do not expand this adapter's support
claim to those harnesses.

## Constraints to preserve

- Never partition durable memories by harness. Retain project/global ownership.
- Separate processes are required for independently configured store roots.
- Shared-store tests use matching local project identities. Relocated checkouts
  or machines and live replacement of frozen context are not established.
- Snapshot identity, transcript, model, and credential routing before awaits.
- Thinking/raw tool results are excluded from capture; use only the sanitized
  prompt and no tools. Keep the 20-second generation deadline and bounded drain.
- Forced process termination cannot guarantee capture persistence.

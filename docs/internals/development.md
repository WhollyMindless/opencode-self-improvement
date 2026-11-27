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

## Adapter extraction baseline

Before the adapter extraction, Windows with Bun 1.4.4 reproduced the real-host capture persistence failure on OpenCode 2.0.26 and 2.4.2. The retained 2.4.2 trace reached `auto_capture_seen`, `auto_capture_start`, and `capture_cost` (including returned text), then ended without `capture_lag`, a stored row, or `auto_capture_dispose`. This local observation narrows the gap to after the model answer; it does not establish whether the host awaited cleanup. The deterministic capture disposal and hook suites passed all 27 tests. Keep those contracts and the failing real-host assertion intact when extracting lifecycle handling.

The full local gate also reproduced two Windows `EBUSY` failures in the viewer E2E cleanup, with the new shared-store suite excluded. Neither failure is an adapter regression. The shared-store scenarios pass on both host versions; they cover fresh sessions, not live replacement of a frozen injection block.

## The published surface is `package.json`

`exports` is the only import surface other code can reach (`.` → `index.ts`, `./tui` → `src/tui/panel.tsx`); `files` is the packaging list. `files` covers `src/`, so anything reachable from an `exports` target ships, but a new top-level file or directory — or anything the plugin reads at runtime outside those paths — must be added to `files` or it works from the checkout and vanishes from the npm artifact. The packed-artifact load in `e2e/` turns that miss red.

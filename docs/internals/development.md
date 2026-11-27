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

`src/host/contracts.ts` defines the current tool/identity boundary: schema-bearing memory tools, normalized per-call identity, and optional session-directory sources. `src/adapters/opencode/` translates OpenCode tool contexts and directory responses and supplies the OpenCode `codemode: false` registration option. Shared tools validate raw arguments themselves. Shared session policy still owns provisional/firm binding, lookup ordering, pending-lookup joins, and repository isolation. Missing directory sources do not invent a repository; OpenCode API errors retain the existing binding fallback behavior.

`test/host/tool-contract.ts` is a reusable behavioral contract. It runs the real shared tools against both the OpenCode adapter and a minimal normalized in-memory host, checking validation, write gates, project/global visibility, updates, and deletion. The in-memory fixture is not a dsh or Pi implementation. The separate real-host suite still verifies actual OpenCode loading, delivery, and lifecycle behavior.

This extraction does not yet generalize hook delivery, transcript decoding, model generation, command installation, or capture teardown. Those require their own ports and capability checks before a second harness can initialize the complete plugin. Store ownership remains project/global, independent of the adapter. OpenCode session IDs retain their existing values; any future adapters sharing one process must make transient session IDs distinct without adding harness ownership to durable rows. The shared runtime still requires Bun, so an adapter for a different runtime must explicitly choose an in-process runtime or a worker boundary.

## The published surface is `package.json`

`exports` is the only import surface other code can reach (`.` → `index.ts`, `./tui` → `src/tui/panel.tsx`); `files` is the packaging list. `files` covers `src/`, so anything reachable from an `exports` target ships, but a new top-level file or directory — or anything the plugin reads at runtime outside those paths — must be added to `files` or it works from the checkout and vanishes from the npm artifact. The packed-artifact load in `e2e/` turns that miss red.

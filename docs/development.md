# Development internals

What the smoke suite really boots, and how the published npm surface is
decided. The commands and the BDD-first rule stay in the README.

`e2e/` boots the **real opencode CLI** against each candidate in a fully isolated instance (fresh config, fresh db, fresh memory store, empty `HOME`) driven by a scripted OpenAI-compatible fake model — no API keys. It covers loading from the source tree and from the packed npm artifact installed runtime-deps-only, plus BDD flows for remember, recall, exact and near duplicates, ungrounded claims, and forget. Needs `opencode` on `PATH` locally, or set `OPENCODE_BIN`. A `test-windows` leg also runs the suite on Windows; it reports without gating merges.

**The published surface is defined in `package.json`.** `exports` is the only import surface other code can reach (`.` → `index.ts`, `./tui` → `src/tui/panel.tsx`); `files` is the packaging list. `files` covers `src/`, so anything reachable from an `exports` target ships, but a new top-level file or directory — or anything the plugin reads at runtime outside those paths — must be added to `files` or it works from the checkout and vanishes from the npm artifact. The packed-artifact load in `e2e/` turns that miss red.

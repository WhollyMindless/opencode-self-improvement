# Options and environment variables

Every knob, in one place. The README keeps the ones you are likely to set; this
file is the complete reference, including what an invalid value does.

## Plugin options

Set them in the object form of the plugin entry in `opencode.json(c)`:

```json
{
  "plugins": [{ "package": "opencode-self-improvement", "options": { "injectBudget": 1200, "frontierBudget": 3600 } }]
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `injectBudget` | `1200` | Character cap on the injected relevance block and each contextual pull; trimmed at whole-memory boundaries. Env fallback: `OPENCODE_MEMORY_INJECT_BUDGET`. |
| `frontierBudget` | `3 × injectBudget` | Character cap on the session-start open-threads block. A thread longer than the budget is not injected and is reported as omitted. Env fallback: `OPENCODE_MEMORY_FRONTIER_BUDGET`. |
| `contradictionSurface` | `true` | Experimental: compare guided constant claims with bounded source reads and render a class-specific CONFLICT verdict. Set `false` to skip code checks and retain plain guidance. See [docs/contradiction-authority.md](contradiction-authority.md). |
| `notifyBlocked` | `true` | Terminal (TUI) only: toast when a write gate blocks a write. Blocks are always in `memory_evidence` either way. |
| `autoCapture` | `true` | Master switch for auto-capture. On, so a plain install mines turn ends and compactions. Set `false` for no capture model call at all. |
| `captureModel` | inherits | `"provider/id"` model used for auto-capture. Unset means the model the session is using, else the host default. An explicit value that is not `provider/id` disables capture with a startup warning rather than substituting a model. |
| `captureMax` | `3` | Maximum candidates proposed per capture pass. |
| `captureOnCompact` | `true` | When auto-capture is armed, also mine the transcript at compaction, before the summarizer replaces it. Its 5-minute cooldown is separate from the turn-end one, so the two triggers' hit-rates stay measurable. Setting it while `autoCapture` is `false` does nothing and reports `switch_mismatch` on the `plugin_load` line. |
| `captureGuidedRules` | `false` | POC: deterministic guided-candidate pre-pass. The user's own lines decide which stated values or rules are guided (numbers, rates, currency, explicit rule assertions) and attach the verbatim quote; the capture model may phrase such a row but cannot clear the flag or the quote, and a guided quote the user never wrote is refused at the write boundary instead of silently stripped. Fires alongside the model pass only — no extra model calls. |
| `pullOutputChars` | `512` | How many characters of a tool's own **output** join the contextual pull's query, after its arguments. `0` searches the arguments only. This is how a fact keyed to something the model only just discovered — an error string, a symbol in a file body — can reach a seat that never calls `memory_recall`. See the measurement below. |
| `pullTools` | `["grep", "glob", "read"]` | Which tool results may carry a pull at all. A malformed list falls back to the default rather than to an empty one. |

### What the contextual pull searches, and what it costs

The pull is the one delivery channel that needs no cooperation from the model: it
appends a short block to a tool result the seat is about to read anyway. That makes
it the right channel for a model that never calls the plugin's tools, and the wrong
place to be careless — a wrong pull is paid for by every later turn, and unlike the
injected block it does not ride the prompt cache.

`bench/runners/pull-precision.ts` measures the scope on the committed recall dataset
(355 tool calls per store, stores of 52/200/800, plus random and store-order negative
controls). At store 200, `R@1`/`R@3` are split by whether the gold row was reachable
from the tool's arguments, and `noise%` is the share of no-gold calls that pulled
anything at all:

| Scope | R@1 args | R@3 args | R@1 output-only | noise% on ordinary traffic | bytes/call |
| --- | ---: | ---: | ---: | ---: | ---: |
| arguments only | 98.6 | 100 | 0 | 65 | 122 |
| arguments + output, no merge | 92.9 | 94.3 | 18.8 | 0 | 216 |
| **shipped: arguments + output, arguments merged first** | 98.6 | 100 | 17.9 | 65 | 252 |
| the same, with `shell` in scope | 98.6 | 100 | 43.9 | 100 | 388 |

Two things that doc comment would hide. The merge is load-bearing: a combined query is
longer, and a longer query raises the two-concept threshold, so searching
`table_manager.save grep results` on its own drops the row the model's own words matched
exactly. And `shell` doubles the reach while bolting a block onto every plain command —
it is excluded by measurement, not taste. Both arms stay in the bench so the next reader
has the numbers rather than a prohibition.

Read the no-merge row's `noise% 0` carefully: it is not precision, it is silence. On
every arg-visible call it misses, it pulls nothing at all (the bench's `miss-abstain%`
column reads 100 for that arm), so it spends 5.7 points of recall the model was already
getting to buy reach it could have had for free.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `OPENCODE_MEMORY_DIR` | Store location (default `~/.config/opencode/memory`). |
| `OPENCODE_MEMORY_ALLOW_OUTSIDE_PATHS` | Operator-only. When truthy, `memory_export`/`memory_import` accept paths anywhere on disk instead of confining themselves to the store. Off by default. It is read from the plugin process's own environment, so a model cannot grant it to itself through a tool argument. See [docs/import-quarantine.md](import-quarantine.md). |
| `OPENCODE_MEMORY_INJECT_BUDGET` | Fallback for `injectBudget`. |
| `OPENCODE_MEMORY_FRONTIER_BUDGET` | Fallback for `frontierBudget`. |
| `OPENCODE_COMMANDS_DIR` | Where the plugin mirrors its slash commands (default `~/.config/opencode/commands`). |
| `OPENCODE_VIEWER_HOST` | Interface the editor binds to (default `127.0.0.1`). A non-loopback bind serves the store over plain HTTP with no authentication — only do it on a network you control. |
| `OPENCODE_VIEWER_PORT` | Admin editor port (default `8787`). |
| `OPENCODE_VIEWER_ALLOWED_HOSTS` | Comma-separated hosts beyond loopback. |

`OPENCODE_MEMORY_DEDUP`, `OPENCODE_MEMORY_SYMPTOM` and `OPENCODE_MEMORY_QUERY_GATE` are documented separately in [docs/flags.md](flags.md): they switch behaviour that a measurement decided, so the evidence behind each one matters more than the default.

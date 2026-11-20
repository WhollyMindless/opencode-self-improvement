# Surfaces

Four ways to see the same data. All of them read `memory_status`; none of them
makes a model call.

## Terminal (opencode CLI)

The plugin ships a TUI half (`@opencode/plugin/tui`) that loads automatically.

- **Footer badge** — illustrative `● mem 1157/1200c · cache 96%`: the injected
  block against its budget, plus the measured session prompt-cache hit rate. The
  dot is green (stable and warm), yellow (recent recompute, or 50–90% reads) or
  red (last turn served almost nothing from cache); `—` until the first assistant
  turn, and `—` throughout on a provider that reports no cache usage.
- **`/memory`** — session panel: **CONTEXT** (what is riding the prompt now and
  how much of the budget it uses), **CACHE** (busts this session and the measured
  cache-served share of prompt tokens), **INJECTED BLOCK** (the verbatim block, or
  an explicit abstention), **RECENT BLOCKED WRITES** (with gate reasons), **STORE**
  (active / superseded / open / scopes, plus `malformed` when a row's `ts` is not
  a valid ISO instant — those rows are skipped by every reader). Keys: `r`
  refresh, `f` fullscreen.
- **Block toast** when a write is refused (`notifyBlocked: false` to silence).

## Desktop / web / IDE

The terminal slots do not exist there, so use the self-installed
**`/memory-report`** chat command: the same sections rendered in the conversation.

## Browser editor

`bun memory-view`, then http://127.0.0.1:8787. Bound to loopback; requests are
checked against `Host` and `Origin`, so other hosts must be listed explicitly in
`OPENCODE_VIEWER_ALLOWED_HOSTS`. Listing a non-loopback host serves the store over
plain HTTP with no authentication — only do it on a network you control.
`OPENCODE_VIEWER_HOST` changes the bind interface.

The viewer is a trusted admin seat. Its edits and deleted-entry restores skip the
model-facing grounding and deduplication gates but honor the same value
rejections: [docs/internals/import-quarantine.md](../internals/import-quarantine.md).

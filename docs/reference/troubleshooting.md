# Troubleshooting, full list

The whole list: the problems people actually run into, and the rarer ones. The
README points here rather than repeating the table.

## Rarer problems

| Problem | Fix |
| --- | --- |
| STORE shows `N malformed` | A daily file has a `ts=` that is not a valid ISO instant (typically a hand-edit). Every reader skips those rows; fix the `ts=` or restore the file with `memory_undo`. |
| Stray `*.logfmt.lock` or `*.tmp` in the store | Write bookkeeping left by an older release; safe to delete while nothing is writing. Current releases leave `.store-lock.<file>.sqlite` beside each store file and `.store-batch.<name>.sqlite`: coordination state, holding no rows, one file per lock, safe to delete while nothing is writing. |
| `/repo-init` missing from the command list | The self-install couldn't write to `~/.config/opencode/commands/`. Create it and restart, or ask the model to "init memory for this repo" — the same tool. |
| `memory_init` rejects a call naming `mode` | The code-graph integration was removed (#231) and the tool schema refuses unknown arguments — drop `mode` from the call. Stamps written by older versions (their text carries `graph=`/`mode=`) still read fine; no re-init is forced. |
| `Error: Plugin is not configured` right after `plugin add` | An opencode bug ([#54654](https://github.com/anomalyco/opencode/issues/54654)), not a config problem: the first `plugin list/check/update` against a cold background service reads the plugin inventory before activation finishes. The plugin is installed and loading — just run the command again. |
| Reset all memories | Stop any running opencode session first, then delete `~/.config/opencode/memory/`. On Windows the delete fails with `EBUSY` while a session is live: the store lock is an open SQLite connection, and Windows will not delete a directory that contains one. |

## Common problems

The seven cases a session actually hits.

| Problem | Fix |
| --- | --- |
| `memory_*` tools not available | The plugin didn't load. Restart opencode and check the `plugins` entry in your config. |
| `memory_remember` says blocked | A gate rejected the write: a stale code reference, a cited path that doesn't exist in the repo, overlap with a superseded memory, or an ambiguous claim. The reason is in `memory_evidence`; rephrase against current code and retry. |
| `invalid arguments to memory_*` | The call didn't match the tool's input schema; nothing was done and the message names the offending fields. Gate blocks look different (`blocked at GATE (…)`). |
| `memory store is busy` | A store write exhausted its 5s lock-wait budget, so the mutation is refused rather than run unlocked. Retry after contention clears. An operation spanning several files or steps may have completed earlier steps; refusal is not a rollback of those steps. If the reply reports `PARTIAL`, inspect the named rows and `memory_evidence` / `memory_undo` before retrying. A process that is killed releases the lock when it dies — there is no stale window to wait out. |
| Writes report a disk I/O error and the store is on a share | The lock's write-ahead log needs mmap'd shared memory, which SQLite does not support on network filesystems. SMB, NFS and OneDrive-mounted roots are unsupported — move `OPENCODE_MEMORY_DIR` to local disk. |
| Stale plugin after an update | `opencode plugin update opencode-self-improvement` (or bump the pinned `@version` in the `plugins` entry) and restart opencode. On desktop use `opencode service restart`: relaunching the app leaves the background service — and the plugin version and options it already parsed — alive. |
| Auto-capture does nothing | `memory_evidence` says which case you are in from the `plugin_load` line: `capture=on` (the default), `capture=off` (you set `autoCapture: false`), `invalid_model`, `no_capabilities` or `switch_mismatch`. `capture=on` with no `auto_capture_*` line after a session means the pass did not complete, and is not your configuration — see [Auto-capture](../../README.md#auto-capture). On desktop, changing any of these options needs `opencode service restart`. The same `plugin_load` line carries `subscribed=[…]`, listing the event types that subscription really reacts to. |

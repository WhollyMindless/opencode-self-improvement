# Export, import, and moving a store between machines

`memory_export` writes the store as JSONL and `memory_import` reads such a file
back. The contract worth memorizing: **you get what you can read, and an import
is not trusted input.**

## What each tool exports

`memory_export` writes the store **as its caller can read it**: from a plugin
session that means your repository plus global rows. Full-store breadth belongs
to a session-less caller outside the plugin — the library route; the viewer has
no export route. `memory_import` reads such a file back, and every imported row
re-enters through the same four gates as `memory_remember` (tagged `import`,
original tags preserved).

## The move

```
Export my memories                              # -> <memory-root>/exports/<timestamp>-<unique>.jsonl
# …copy that file to the other machine's <memory-root>/…
Import <memory-root>/memories.jsonl             # memory_import
```

Both tools are model-facing, so a path is not a privilege: `file` must stay
inside the store — exports under `<memory-root>/exports`, imports anywhere under
`<memory-root>` — and a symbolic link cannot carry a request out of it. Pass
`scope` to export one scope. An operator running a one-off migration can restore
the old anywhere-on-disk behaviour with `OPENCODE_MEMORY_ALLOW_OUTSIDE_PATHS=1`,
which is read from the plugin process's own environment so a model cannot grant
it to itself.

## The reply is a tally, not a yes/no

| Outcome | Meaning |
| --- | --- |
| `promoted` | passed the gates and was stored |
| `collapsed` | near-duplicate of an existing memory; nothing written |
| `blocked` | rejected by a gate; reason in `memory_evidence` |
| `skipped` | malformed line; never reached the gates |
| `downgraded` | imported as settled because its `status:"open"` could not be vouched for |

## What the format is, and what confinement costs

The line format, what an import will believe about `status:"open"`, and the two
confinement limits no path check closes (a hard link inside `exports/`, and the
looser check on intermediate components):
[docs/internals/import-quarantine.md](import-quarantine.md).

## Quarantine

Import and auto-capture also scan incoming prose for instruction-override,
role-header and download/execute patterns. A promoted match is tagged `quarantine`
and withheld from recall, prompt and frontier injection, compaction anchors,
contextual pull, consolidation and decay. Think of it as a spam folder, not a
virus scanner: legitimate documentation can match, and several forms evade it.
Review the queue in the viewer's **quarantined** filter.

What the screen covers, what it misses, how an existing store is re-tagged, what
releasing quarantine does and what it leaves alone, and why direct
`memory_remember` and viewer edits are not scanned:
[docs/internals/import-quarantine.md](import-quarantine.md).

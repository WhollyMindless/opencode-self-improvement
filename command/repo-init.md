---
description: Initialize build/test memories for this repo
---
Initialize this repository for durable memory.

1. Re-derive build/lint/test/typecheck commands and write them as pattern
   memories (scope = this repo name).
2. Store an init stamp keyed on git HEAD so future sessions can cheaply tell
   whether the repo has drifted.

Everything is local: manifests are parsed in place and no external indexer is
spawned (the codebase-memory graph integration was removed, #231).

Call the `memory_init` tool to do this. If the user typed arguments (e.g.
"force"), pass them through: set `force: true` when $ARGUMENTS mentions force,
otherwise run a fresh idempotent init.

Then report concisely: scripts recorded and the stamp head.
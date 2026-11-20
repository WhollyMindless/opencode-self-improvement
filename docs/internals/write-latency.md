# Write latency: one tree walk per write

A write that cites code references could scan your source tree once per
reference. It does not: one recursive walk, shared by GATE-1 and GATE-2, prunes
`node_modules` and VCS directories, and reads each source file at most once. The
table below is the difference between "walk the tree" and "walk it five times".

**Bench** — measured on a 5,300-file fixture (300 sources + 5,000 `node_modules`
decoys), scope seeded with 5 embedded call forms:

| Call forms in the write | Shipped | One scan per form |
| --- | ---: | ---: |
| 1 | 17ms | 105ms |
| 3 | 15ms | 136ms |
| 5 | 20ms | 169ms |

The shipped column is flat: the tree is walked once no matter how many references
the write cites.

```sh
bun run bench:write
```

What each gate does with what the walk finds:
[docs/internals/write-gates.md](write-gates.md).

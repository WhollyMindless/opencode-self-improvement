# Transport keyword lookup

Measured 2026-11-19 against upstream `ebc083a`, using Bun 1.4.4 on Windows and a synthetic store. No model or paid seat was used.

For the 21 transport queries with 10 gold memories and 180 keyword-bearing
distractors, the explicit `memory_recall` tool returned the gold in its first
three results for 14 queries, up from 13 with the ordinary two-concept gate.
The newly recovered query uses `throttling` to find the Redis rate-limit row.
The exception requires a whole authored keyword that occurs in one visible
candidate after scope and type filtering.

The automatic injection scorer remains stricter. With a 300-character budget
it abstains on the throttling query and on two unrelated prompts about CPU
frequency throttling and stadium lighting fixtures. The explicit lookup can
still return an unrelated row when the same word has another meaning.
Reproduce the targeted check with
`bun test test/recall-gate.test.ts -t "transport keyword lookup"`.
Rerunning `bun run bench:recall` reproduced the upstream injection tables: strict keyword R@1/R@3 was 24%/24% with 50 rows and 26%/26% with 200. The README headline uses the 200-row store. Live-prompt precision is unmeasured.

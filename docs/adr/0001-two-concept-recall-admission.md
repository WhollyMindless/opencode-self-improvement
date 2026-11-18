# ADR 0001 — Two-concept admission for the recall tool

Status: accepted (2026-11). Code: `src/recall/gate.ts`. Flag: `OPENCODE_MEMORY_QUERY_GATE`.

## Decision

A `memory_recall` query of three or more concepts must share two whole-word concepts with a row for that row to be returned. Shorter queries keep the permissive one-concept admission. ON by default; off only for an explicit negative value.

## Why

The tool scored rows by counting query words appearing as substrings and returned anything above zero. Measured on 404 real recall queries from 30 days of session transcripts, relevance labelled by two independent readers against a pinned store snapshot: a large share of returned rows was judged irrelevant rather than answering. The injection path already refused single-concept matches for deliberate searches; the two paths disagreeing was the bug.

## History

- The first implementation reused the tool's own substring test. It was satisfiable by accidents: `on` occurs inside `context` and `decision`, `pr` inside `preference`, `283` inside `build2837` — the motivating query `watermark 283 287 head` still admitted the row it was meant to refuse. The numbers measured with substring counting are void; do not quote them.
- Default-ON was decided with the rule: a quality fix that nobody flips on is not a fix. The off-list is explicit negatives (`off`, `no`, `n`, `false`, any zero); unset, empty, or a typo means ON.
- Admission vocabulary carries the scorer tokenizer's identifier granularity plus the underscore- and dot-joined whole forms, so prose queries find identifiers written in any style (`discount tiers` finds `DISCOUNT_TIERS`; `discount` finds `discountTiers`; `db_id` finds `table.db_id`). This closed three reproduced regressions in review; each is pinned by a composed-handler test.
- Evidence: 404-query case bank (data deliberately never committed; only aggregates were published). See issues #409 and #418 and PR #426 for the measured tables.

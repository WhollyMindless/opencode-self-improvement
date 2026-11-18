# ADR 0003 — Identifier-aware tokenizer at two granularities

Status: accepted (2026-11). Code: `words()` in `src/recall/score.ts`.

## Decision

Each identifier (a maximal run of letters, digits, `_`, `.`, `-`, `/`) emits two granularities: the whole identifier lower-cased, and its segments split at camelCase boundaries and separators. The scan is one linear pass with no backtracking.

## Why

The shipped tokenizer kept `_` inside a token and never touched case, so `getUserAccount`, `get_user_account` and `get-user-account` were three unrelated tokens. Segments make identifier styles match each other: a query typed `getUserAccount` shares `get`, `user`, `account` with a row written `get_user_account`.

The whole form is not redundant: it preserves the exact match the shipped tokenizer had — `db_id` and `OPENCODE_MEMORY_DIR` stay single tokens, and an authored keyword stored fused (`memoryrecallthreshold`) still matches the query that cites it.

## History

- The first version of this change dropped the whole form. It abstained on `db_id` queries and broke the vocabulary bridge for camelCase aliases (#40). Both granularities are load-bearing; the regression tests say so.
- Measured on the bench fixture at the shipped configuration (`kw` indexed, store 200 and 48): lexical R@1 stays 98% and top-1 noise stays 6%. The fixture's queries never spell the same identifier two ways, so this is a correctness fix the fixture cannot price, not a measured win. The no-keyword arm moves (R@1 98% → 100%), but production indexes keywords.
- Admission (ADR 0001) reuses this tokenizer plus the underscore/dot-joined whole forms; it must never be narrower than the scorer.

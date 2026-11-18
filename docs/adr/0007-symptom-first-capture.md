# ADR 0007 — Symptom-first opening for learning and blocker rows

Status: accepted (2026-11). Code: GATE-3 region of `src/gate/gate.ts` (`symptomRuleEnabled`). Flag: `OPENCODE_MEMORY_SYMPTOM`.

## Decision

A `learning` or `blocker` row must open with the observable trigger a future session will hit: `When <symptom>: ...`. ON by default; `OPENCODE_MEMORY_SYMPTOM=off` is the escape hatch for automation holding a pre-0.28 backlog.

## Why

The measured gap is the whole argument: the same lesson surfaced 0/8 written as a session diary and ranked 1-7 written symptom-first, because the future searcher is typing the symptom, not the lesson.

## Consequences

- The backlog is repairable (`scripts/symptom-fixer.ts`); silence is not.
- New-vs-legacy distinction: a rewrite that carries the supersede target's content byte-identical is a metadata repair, not a new lesson. Retagging quarantined rows and metadata-only `memory_update` on a legacy row re-submit unchanged prose — blocking them would stall quarantine repair forever and make legacy rows uneditable. New prose against a `supersedesTs` is still a new lesson and still blocked.
- Evidence: issue #419.

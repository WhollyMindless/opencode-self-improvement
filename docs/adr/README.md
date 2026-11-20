# Architecture decision records

One row per decision. `supersedes` and `superseded by` keep the chain
readable: a reader can tell an accepted decision from a retired one without
opening the file.

| ID   | Title                                                                                     | Status           | Supersedes | Superseded by |
| ---- | ----------------------------------------------------------------------------------------- | ---------------- | ---------- | ------------- |
| 0001 | [Two-concept admission for the recall tool](0001-two-concept-recall-admission.md)         | accepted (2026-11) | —          | —             |
| 0002 | [Near-duplicate suppression inside the recall window](0002-window-dedup.md)               | accepted (2026-11) | —          | —             |
| 0003 | [Identifier-aware tokenizer at two granularities](0003-identifier-tokenizer.md)           | accepted (2026-11) | —          | —             |
| 0004 | [Viewer startup token on non-loopback binds](0004-viewer-startup-token.md)                | accepted (2026-11) | —          | —             |
| 0005 | [Two-phase teardown for capture passes](0005-capture-teardown-phases.md)                  | accepted (2026-11) | —          | —             |
| 0006 | [Capture prompt integrity: redaction order and faithful citation](0006-capture-prompt-integrity.md) | accepted (2026-11) | —      | —             |
| 0007 | [Symptom-first opening for learning and blocker rows](0007-symptom-first-capture.md)      | accepted (2026-11) | —          | —             |
| 0008 | [Availability verdicts tag rows; they never refuse them](0008-availability-tags-not-refusals.md) | accepted (2026-11) | —      | —             |

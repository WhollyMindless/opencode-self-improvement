# Write gates and promotion evidence

What promotion evidence samples, and how the four gates order their audit
lines. The gate list and the undo contract stay in the README.

Promotion evidence keeps a bounded sample of call IDs: the ten most recent code-engagement calls, plus the latest gate check, the latest recorded gate FAIL/fix/PASS recovery, and the latest recorded tool FAIL/PASS retry (at most 16 distinct IDs). `evidence_refs_count` is the total number of recorded session calls before sampling, including non-code tools; the sampled IDs are audit pointers, not a complete history. Grounding and memory attribution still use the full in-memory ledger. Existing evidence day-files are left unchanged: this upgrade does not backfill, compact, or delete historical audit records.

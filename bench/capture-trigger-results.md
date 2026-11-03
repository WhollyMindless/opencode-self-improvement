# Capture on compaction vs capture on idle — measured retrieval hit-rate

49 queries over 24 session facts (committed dataset), 150 equal distractors per store, shipped matcher, k=3. Cliff simulation: idle world mines AFTER a compaction that retained 13/24 facts (53% per arXiv:2608.22752); compaction world mines the full transcript AT the hook. Capture model: scripted faithful extractor (prompt containment asserted by control 6).

| world | trigger | captured rows | R@3 | gold missing (lost to cliff) | rank miss | model calls |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| off | none (control) | 0 | 0% (0/49) | 49 | 0 | 0 |
| compaction | session.compaction | 0 | 0% (0/49) | 49 | 0 | 0 |
| idle | session.idle | 13 | 24% (12/49) | 22 | 15 | 1 |

| query class | off R@3 | compaction R@3 | idle R@3 |
| --- | ---: | ---: | ---: |
| lexical | 0% (0/20) | 0% (0/20) | 55% (11/20) |
| near | 0% (0/10) | 0% (0/10) | 10% (1/10) |
| strict | 0% (0/19) | 0% (0/19) | 0% (0/19) |

## Controls

- PASS — negative control: capture OFF hit-rate is 0 (got 0/49) — a harness that cannot fail does not count
- FAIL — trigger earns its tokens: capture-at-compaction (0/49) beats OFF (0/49) — RED on src without the compaction trigger
- PASS — cliff simulation bites: 13/24 facts survive, idle lost 22 queryable golds
- FAIL — the cliff is the difference: compaction (0/49) beats idle-after-compaction (12/49)
- FAIL — conservation: captured rows == mined facts (compaction 0/24, idle 13/13, off 0/0) — nothing else wrote rows
- FAIL — prompt containment: every mined fact really rode the capture prompt (the scripted model reads what the trigger hands it)

Production follow-through: evidence lines `auto_capture_*` (trigger=idle) vs `auto_capture_compaction_*` (trigger=compaction) carry a `trigger` field, and rows carry the auto_capture_compaction tag, so the real-world month-long comparison this simulates a proxy for needs no new plumbing.

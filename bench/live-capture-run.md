# Live auto-capture dogfood — runbook

**Status: armed.** `autoCapture` is ON in `~/.config/opencode/opencode.jsonc` as of
2026-10-26, pending a service/app restart. Everything below assumes you are a
session that started *after* that restart.

## Why this exists

Every dogfood so far ran with `autoCapture` off, so the one path that writes
memories nobody asked for has never been exercised in real use. #78 proved what
that costs: capture was silently dead on 2.x for weeks and nothing said so.
This is a short, reversible, real-config run to find out what it actually does.

## Paths

| | |
|---|---|
| store (live) | `~/.config/opencode/memory` |
| **pre-run backup** | `~/.config/opencode/memory-backups/20261026-131603` (6.1 MB, 320 files, taken 13:16 local) |
| config backup | `~/.config/opencode/opencode.jsonc.bak-20261026-pre-capture-live` |
| audit tool | `bench/live-capture-audit.ts` (rubric locked **before** the run — do not edit it after seeing data) |
| plugin under test | npm `opencode-self-improvement@0.14.9`, cache `~/.cache/opencode/npm/opencode-self-improvement@latest/<ts>/` |
| capture model | `evo/Qwen3.8-Flash-Next-UD-Q4_K_XL` (same seat as the session) |

## 0. Prove the SERVICE restarted (relaunching the app is not enough)

Measured 2026-10-26: quitting and reopening the desktop app leaves the background
`opencode-cli` service running, and the service is what holds the parsed plugin
options. The host noticed the config edit (`event.type=config.updated`) and even
re-ran plugin `setup()` for new locations, yet `ctx.options` still carried the
pre-edit values — capture stayed off and said nothing.

```
ps -eo pid,lstart,etime,comm | grep opencode-cli      # service start time
ls -l ~/.config/opencode/opencode.jsonc               # config edit time
```

If the service started BEFORE the config edit, nothing was loaded: use
`opencode service restart` (or kill that PID). The README's "restart opencode"
(README.md:18, :266, :287, :293, :295) does not say this — a field user hits the
same trap.

## 1. After restart — confirm it is actually on (do this first)

Do 2-3 real turns, then:

```
grep -a 'ev=capture_lag\|ev=auto_capture' ~/.config/opencode/memory/evidence/$(date +%F).logfmt | tail
grep -a 'auto-capture\|autoCapture' ~/.local/share/opencode/log/opencode.log | tail -5
```

- Rows present → it is live; continue.
- Nothing yet → not necessarily broken: the idle trigger fires on `session.idle`
  with a **5-minute per-session, per-trigger cooldown**, and needs a transcript
  ≥200 chars. Check the second grep for the startup warning instead.
- A startup warning naming `captureModel` → the option did not survive the
  restart; check `bun -e 'await import("~/.config/opencode/opencode.jsonc")'`.
- **No warning and no rows after several sessions is the #78 failure class.**
  That is the most valuable possible outcome — record it and stop.

## 2. Run tasks

Work normally for a short window. To get more than n=1: use **2-3 separate
sessions**, and let at least one session reach **compaction** (the compaction
trigger has its own cooldown and its own `auto_capture_compaction_*` lines, so
the two triggers stay separately measurable).

Keep it short. Captured rows land in this repo's scope and get injected into
subsequent sessions — junk capture actively degrades the thing being measured.

While working, notice (this is JUDGE-3, invisible to every metric): *am I
changing what I type because the plugin might save it?*

## 3. Audit

```
cd ~/Documents/opencode-self-improvement
bun bench/live-capture-audit.ts ~/.config/opencode/memory-backups/20261026-131603 --show 30
```

Read, in order: (1) did it fire, (2) every new row in full, (3) the rubric —
R1/R3/R6 are mechanical, `JUDGE-1..3` are yours, then make the call on what to
fix. Expected findings to look for specifically:

- restatements of rows that already exist (dup flags) — capture's real cost
- rows in a *new* scope, or `status=open` rows it had no business creating
- anything credential-shaped (the config holds an `evo` apiKey that appears in
  transcripts; `src/secrets.ts` is supposed to catch it — this is a live test
  of #74/#38)
- model-call count vs sessions × triggers (the #108 duplicate-`setup()` class)

## FINDINGS (measured 2026-10-26, before any capture ever ran)

**F1 — Root cause: `session.idle` does not exist on opencode 2.x.** The idle
trigger at `src/index.ts:1241` (`if (event?.type !== "session.idle") continue;`)
can never match. Three independent lines of evidence:

- Live: subscribed to the running desktop service (`GET /api/event`, SSE,
  127.0.0.1:49374) for 45 s while a fresh session ran a full turn — 59 events,
  `session.execution.started` → steps/text/reasoning → `session.usage.updated` →
  `session.execution.succeeded`. **Zero `session.idle`, zero `session.status`.**
- Schema: the 2.x event manifest declares `session.status` (durability
  `ephemeral`) with `data: { sessionID, status: {type:"idle"} | {type:"retry",…} }`.
  There is no `session.idle` event type at all.
- Binary: `"session.idle"` appears exactly once in the 214 MB 2.1.4 CLI.

So #78 was the same bug class one layer down: #79 fixed *where* `sessionID` is
read, but the type guard rejects the event before that line ever runs.

**F2 — Fixing the name is probably not enough.** The schema-correct
`session.status{status.type:"idle"}` was *also* absent from the live stream
during a completed turn. The signal that reliably exists is the
**`session.execution.*` family** (`started` / `succeeded`, and presumably
`failed` / `interrupted`). Capture should key off execution end, not idle.
(`session.viewed` carries `data.idle` — a last-viewed timestamp, unrelated.)

**F3 — The suite could not have caught this: our fakes fabricate the event.**
`test/capture.test.ts:291,297,320` and `test/capture-compaction.test.ts:237,270,
389-390` all push hand-written `{type:"session.idle"}` payloads. Fake and prod
are wrong together, so 480 tests stay green against a trigger the host has never
sent. This is the #86/#90 fake-payload-drift lesson for the second time; the fix
is to drive capture tests from a recorded host recording, and to make a
host-fidelity test that fails when the plugin subscribes to an event type absent
from the manifest.

**F4 — Zero observability on the disabled paths.** Config loaded, plugin set up
3×, sessions active, capture silently inert: no evidence line, no status line,
no warning. R1 "never ran" was the only signal in the system, and it came from a
tool we wrote an hour earlier.

**F5 — `captureModel` is required but inheritable.** See the
`learning/capture/config-design` row: `event.model` is already on every session
hook the plugin registers and is never read.

**F6 — "Restart opencode" is ambiguous on desktop** (step 0 above): app
relaunch leaves the service, and therefore the parsed plugin options, alive.

## 7. Reset (do it even if the run looked clean)

```
# 1. revert config
cp ~/.config/opencode/opencode.jsonc.bak-20261026-pre-capture-live ~/.config/opencode/opencode.jsonc
# 2. STOP the app/service first, or the live plugin re-appends after the restore
# 3. restore the store whole
rsync -a --delete ~/.config/opencode/memory-backups/20261026-131603/ ~/.config/opencode/memory/
# 4. restart, then sanity-check the counts
```

Note: the restore also discards any row *this* session wrote deliberately via
`memory_remember` after 13:16 — that is intended, but copy anything worth
keeping into the run notes first.

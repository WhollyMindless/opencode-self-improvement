# Secret redaction: what it covers and what it cannot

One best-effort credential rule set (`src/secrets.ts`) replaces recognized values
with `[redacted]`. Think of it as a metal detector at every door, not a safe: it
stops the recognized shapes, and it will never promise it saw everything.

It runs at every boundary a credential could persist, not one:

- over the auto-capture prompt before it leaves the plugin — the complete
  transcript is redacted *before* the character budget crops it, so a credential
  cut in half still matches its pattern;
- at the write gate, before content is hashed or analysed;
- again in the final write choke point used by gated writes and by the viewer's
  edit and restore paths;
- at the durable audit boundaries — every evidence line, every supersede field
  written into a retired row, and every deletion-audit reason.

So a recognized credential cannot persist in a new `evidence/` line, in a
deletion-audit `reason`, or in a supersede field written into a retired row,
whichever path carried it. It is not scrubbed from everything those paths touch —
see the limits below.

## Covered patterns

OpenAI `sk-`, GitHub `ghp_` / `gho_` / `github_pat_`, Slack `xoxb-` / `xoxp-`,
AWS `AKIA`, Google `AIza`, bearer tokens containing digits, PEM private-key
blocks, and high-entropy values assigned to names ending in `_KEY`, `_TOKEN`,
`_SECRET` or `_PASSWORD` (plus `password`).

## Limits worth knowing

- It can miss hex-only secrets, low-diversity passwords, and credentials written
  in prose without an assignment.
- The credential-shaped sweep needs 16 characters, so `password=hunter2` is
  stored exactly as written. That floor is what keeps a short ordinary value —
  a version string, an identifier carrying a digit — from being blanked wherever
  it follows a name ending in `_KEY`, `_TOKEN`, `_SECRET` or `_PASSWORD`, which
  is why it is a floor rather than a number to lower in passing.
- Credential-shaped `scope`, `tags` or `issue` metadata is rejected rather than
  silently rewritten.
- `memory_remember` still replies `Remembered` when content was redacted, so the
  stored text can differ from what was sent.
- Redaction is forward-only: existing stores are not scrubbed. `memory_export`
  scrubs credentials out of `content`, `issue`, `scope`, `tags` and `kw` as it
  serialises, so the file that leaves the machine carries `[redacted]` where a
  stored row still holds a token; the store itself is untouched, and origin
  stamps (`repo`, `repoPath`) are written as stored. The scrubber is a
  best-effort sweep over known token families and high-entropy credential-shaped
  values — an exotic credential can survive it, so an export is still a file you
  hand out deliberately.
- Deleting a row copies it, it does not scrub it. `deletions.logfmt` keeps the
  deleted row's `content`, `tags`, `kw` and `issue` exactly as the row held them
  — a restore-entry built from that line has to re-stamp and re-attach precisely
  what was there — and redacts only the `reason`. So deleting a row that predates
  redaction writes its credential into the audit. Snapshots carry whatever a
  stored row holds, for the same reason. That retention is deliberate (#292).

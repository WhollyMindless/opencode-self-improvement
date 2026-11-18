# ADR 0004 — Viewer startup token on non-loopback binds

Status: accepted (2026-11). Code: `src/viewer/server.ts`.

## Decision

A non-loopback bind or allowed host mints a startup token (0600, in the store root); every request must present it. Loopback stays open. The Host/Origin layer remains as the CSRF defence it always was, but it is not the only thing between the LAN and the store.

## Why

Exposure without authentication was the defect: with a non-loopback bind every read and mutation was open HTTP for the whole LAN.

## History

- Concurrent first starts (same process or separate processes) must agree on ONE token. The claim is an atomic hard-link of a fully-written 0600 temp: `link(2)` refuses an existing target, so exactly one starter's content lands and every loser reads back the winner's complete token.
- The hard-link claim solves an ABSENT file, not a CORRUPT one. Two starters that both read the same corrupt winner used to replace it unconditionally — disagreeing on Linux, throwing EPERM on Windows. Recovery is now serialized twice over: within one process every mint runs through a promise chain, so the second starter re-reads the repaired file instead of racing the repair; across processes an `O_EXCL` lock file elects one repairman and the others adopt its token. A replacement is never unconditional.
- The reuse path enforces the 0600 contract too: `preparePrivateFile` tightens an existing file to owner-only (keeping owner bits, refusing a final-component symlink), so a token file left world-readable is repaired before it is accepted.
- The repair takes the STORE's lock. It used to take its own `O_EXCL` `.recover` file — the same shape as the #407 defect: lock state lived in a directory entry, and on Windows that entry outlives the holder whenever a third-party handle is open without `FILE_SHARE_DELETE`. An age-based steal could not rescue that case either, because the steal is itself an unlink and the same refusal applies — a viewer that hit it could never start again.
- The cookie is read WITHOUT `decodeURIComponent`: the value is a fixed-hex token we mint and set verbatim, and decoding junk like `osi-viewer=%` throws `URIError` on the auth path — a 500 where a malformed credential must simply be refused. The raw value cannot match, so it falls through to 401.
- A stale cookie from before a supported rotation is refused as one (F2): the token file is the single truth.
- Evidence: the review thread on issue #223.

// The init stamp: plugin-internal bookkeeping for /repo-init idempotency.
//
// It deliberately does NOT live in the memory store (#374). A store row is
// reachable through `memory_remember` and `memory_import`, and nothing reserved
// the `init-stamp` tag, so any session could write a `context` row naming the
// current short HEAD and make every later `memory_init` answer "Already
// initialized" for that commit — silently, with no line saying why. Moving the
// stamp to a file under the memory root that only src/init/ reads and writes
// closes that door, and it takes the row out of `memory_recall`, export and the
// viewer, where internal state was never meant to be read.
//
// A one-time migration keeps checkouts initialized by an older release from
// re-running init. Honouring "any row that looks like a stamp" is exactly the
// forgery this ticket removes, so the migration honours a legacy row only when an
// `init_complete` evidence line names its ts. Evidence is written only by the
// plugin's own record() — no tool hands a session a write path to it — so the
// pairing says a real init audited that row. A legacy row with no matching audit
// is ignored, and init re-runs: idempotent, cheap, and the safe answer to a
// provenance the plugin cannot check.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryRoot } from "../core/config/paths.ts";
import { preparePrivateFile, tightenDirectory } from "../core/permissions.ts";
import { parseLine } from "../core/logfmt/format.ts";
import { readLines } from "../core/logfmt/read.ts";
import { evidenceFileFor } from "../evidence/record.ts";
import { resolveRepo } from "../identity/repokey.ts";
import { loadAll } from "../store/files/load.ts";
import {
  isVisibleTo,
  readerFromSid,
  type Reader,
} from "../store/model/visibility.ts";

export interface InitStamp {
  ts: string;
  head: string;
}

/** Where the stamps live. A sibling directory of the day files, never one of them. */
export function stampDir(): string {
  return join(memoryRoot(), "init-stamps");
}

// The file name is the repository identity key: a 12-hex-char token derived from
// the normalized origin (or the normalized path when there is no origin), so it
// survives a re-clone and never aliases two checkouts that merely share a
// directory basename. Validated anyway — a component the plugin did not mint is
// not authority to write outside the stamp directory.
function stampPath(key: string): string | null {
  if (!/^[0-9a-f]{12}$/.test(key)) return null;
  return join(stampDir(), `${key}.json`);
}

function parseStamp(raw: string): InitStamp | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { ts, head } = data as { ts?: unknown; head?: unknown };
  if (typeof ts !== "string" || typeof head !== "string") return null;
  if (!ts || !head) return null;
  return { ts, head };
}

function readStampFile(key: string): InitStamp | null {
  const path = stampPath(key);
  if (!path) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Absent, unreadable, or a directory. A file that cannot be read is treated
    // like no stamp at all: init is idempotent, so re-running it is cheap, while
    // trusting a stamp the plugin cannot parse is not.
    return null;
  }
  return parseStamp(raw);
}

/**
 * Did a real init audit this row? The pre-#374 run wrote `stamp=<row ts>` into
 * its `init_complete` evidence line, so the pairing is the provenance check the
 * row itself cannot supply. Parsed field-by-field: a value that merely contains
 * the text cannot satisfy it.
 */
async function initAudited(ts: string): Promise<boolean> {
  const day = /^(\d{4}-\d{2}-\d{2})T/.exec(ts)?.[1];
  if (!day) return false;
  const file = evidenceFileFor(day);
  if (!file) return false;
  let lines: string[];
  try {
    lines = await readLines(file);
  } catch {
    return false;
  }
  for (const line of lines) {
    const fields = parseLine(line);
    if (!fields) continue;
    if (fields.ev === "init_complete" && fields.stamp === ts) return true;
  }
  return false;
}

/** The pre-#374 stamp: a `context` row in this scope tagged `init-stamp`. */
async function legacyStampRow(
  scope: string,
  reader: Reader,
): Promise<InitStamp | null> {
  const mems = (await loadAll()).filter(
    (m) => !m.superseded_by && isVisibleTo(m, reader),
  );
  for (const m of mems) {
    if (m.type !== "context" || m.scope !== scope) continue;
    if (!m.tags?.some((t) => t === "init-stamp")) continue;
    if (!(await initAudited(m.ts))) continue;
    const head = /head=([^ ,]+)/.exec(m.content)?.[1] ?? "-";
    return { ts: m.ts, head };
  }
  return null;
}

export interface StampRead {
  stamp: InitStamp | null;
  /** The repository identity key the stamp file is (or would be) named for. */
  key: string;
  /** True when a pre-#374 store row was honoured and copied to the file. */
  migrated: boolean;
}

/**
 * The stamp for one repository.
 *
 * `root` is the repository root init resolved. `keyHint` is the identity the
 * caller already holds (its write target), so a normal init pays no second pair
 * of git probes; with neither, identity is resolved from `root`.
 *
 * Order: the file, then one audited legacy row (honoured once, then migrated).
 * Returns `stamp: null` when neither applies.
 */
export async function readStamp(
  scope: string,
  root: string,
  keyHint?: string,
  sid?: string,
  reader: Reader = readerFromSid(sid),
): Promise<StampRead> {
  const key =
    keyHint && /^[0-9a-f]{12}$/.test(keyHint) ? keyHint : resolveRepo(root).key;
  const file = readStampFile(key);
  if (file) return { stamp: file, key, migrated: false };
  const legacy = await legacyStampRow(scope, reader);
  if (!legacy) return { stamp: null, key, migrated: false };
  writeStampFile(key, scope, root, legacy.head, legacy.ts);
  return { stamp: legacy, key, migrated: true };
}

/**
 * Record that `scope` was initialized at `head`.
 *
 * Best-effort by contract: a store on a read-only mount must not fail an init
 * whose command rows already landed, so a fault is returned for the caller to
 * report rather than thrown. The consequence of a fault is one re-run of an
 * idempotent command, never a silently skipped init.
 */
export function writeStampFile(
  key: string,
  scope: string,
  root: string,
  head: string,
  ts: string,
): string | undefined {
  const path = stampPath(key);
  if (!path) return "stamp key is not a repository identity token";
  try {
    mkdirSync(stampDir(), { recursive: true, mode: 0o700 });
    tightenDirectory(stampDir());
    preparePrivateFile(path);
    // Per-call temp name (#89): two inits on one store must never rename each
    // other's half-written temp over a stamp.
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ key, scope, path: root, head, ts })}\n`,
      {
        mode: 0o600,
      },
    );
    renameSync(tmp, path);
    return undefined;
  } catch (err) {
    return err instanceof Error && err.message ? err.message : String(err);
  }
}

/** The identity key init stamps a repository under (exported for tests). */
export function stampKey(root: string): string {
  return resolveRepo(root).key;
}

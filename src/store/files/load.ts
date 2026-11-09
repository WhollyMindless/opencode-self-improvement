// load — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.
// Durable memory store engine. Reproduces the opencode-memory logfmt format
// (MIT, github.com/shuans/opencode-memory; license retained under
// vendor/opencode-memory/LICENSE) and extends it with the fields the write-gate
// needs: supersession markers, snapshots and audited deletion.
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { HITS_FILENAME, memoryRoot } from "../../core/config/paths.ts";
import { parseLine } from "../../core/logfmt/format.ts";
import { readLines } from "../../core/logfmt/read.ts";
import { blockedTs } from "../blocklist.ts";
import {
  ISO_TS_RE,
  type Memory,
  malformedWarnedFiles,
} from "../model/memory.ts";
import {
  isVisibleTo,
  type Reader,
  readerForAmbient,
} from "../model/visibility.ts";

const RESERVED = new Set([
  "deletions.logfmt",
  "deleted.logfmt",
  "canonical.logfmt",
  "blocklist.logfmt",
  // Value-keyed rejection tombstones (#35). Hashes only, never prose — and it
  // must never be ingested as a row, exported, or restored by undo.
  "rejected.logfmt",
  // The use ledger (src/hits.ts): telemetry, not memory. A hit line must never
  // be able to become a row — or to be superseded, exported, or injected.
  HITS_FILENAME,
]);

let malformedRows = 0;

/** Rows skipped as malformed by the most recent store read (approximate, in-process). */
export function malformedCount(): number {
  return malformedRows;
}

export function toMemory(
  fields: Record<string, unknown>,
  file: string,
  index: number,
): Memory | null {
  const ts = fields.ts;
  const type = fields.type;
  const scope = fields.scope;
  if (typeof ts !== "string" || typeof type !== "string") return null;
  if (typeof scope !== "string") return null;
  if (!ISO_TS_RE.test(ts) || Number.isNaN(Date.parse(ts))) {
    malformedRows++;
    if (!malformedWarnedFiles.has(file)) {
      malformedWarnedFiles.add(file);
      console.warn(
        `[memory] malformed row skipped in ${file} (ts is not an ISO instant): ${JSON.stringify(ts.slice(0, 48))}`,
      );
    }
    return null;
  }
  return {
    ts,
    type,
    scope,
    content: typeof fields.content === "string" ? fields.content : "",
    issue: typeof fields.issue === "string" ? fields.issue : undefined,
    tags: typeof fields.tags === "string" ? fields.tags.split(",") : undefined,
    kw:
      typeof fields.kw === "string" && fields.kw
        ? fields.kw
            .split(",")
            .map((k) => k.trim())
            .filter((k) => k.length > 0)
        : undefined,
    superseded_by:
      typeof fields.superseded_by === "string"
        ? fields.superseded_by
        : undefined,
    ref: typeof fields.ref === "string" && fields.ref ? fields.ref : undefined,
    claim:
      typeof fields.claim === "string" && fields.claim
        ? fields.claim
        : undefined,
    klass:
      fields.klass === "spec" || fields.klass === "behavior"
        ? fields.klass
        : undefined,
    reason: typeof fields.reason === "string" ? fields.reason : undefined,
    status:
      fields.status === "open" || fields.status === "settled"
        ? fields.status
        : undefined,
    repo: typeof fields.repo === "string" ? fields.repo : undefined,
    repoPath: typeof fields.repoPath === "string" ? fields.repoPath : undefined,
    file,
    index,
  };
}

export async function memoryFiles(): Promise<string[]> {
  const root = memoryRoot();
  // Bun.Glob.scan throws ENOENT on a missing root; a fresh store must read as
  // empty so the system-digest hook never throws (it runs on every request,
  // including the compaction model call).
  if (!existsSync(root)) return [];
  const glob = new Bun.Glob("*.logfmt");
  const files: string[] = [];
  for await (const f of glob.scan(root)) {
    if (!RESERVED.has(f)) files.push(join(root, f));
  }
  return files.sort();
}

/**
 * The day file a row's own ts names, as a `YYYY-MM-DD.logfmt` basename, or null
 * when the string is not an ISO instant. `appendMemory` mints ts at write time
 * and appends to that same day file, so for every row the plugin wrote the ts
 * date IS the file date (#215).
 */
export function dayFileName(ts: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(ts);
  return m ? `${m[1]}.logfmt` : null;
}

/**
 * Day files ordered so the ones these ts values name come first (#215). A
 * single-row mutation that stops as soon as it has SEEN the row then locks one
 * file instead of one per day of store age — the cost that made supersing a row
 * 25x a full read on a 30-day store.
 *
 * The mapping is a hint, never a proof: a store edited outside the plugin can
 * hold a row in a file its ts does not name. Callers must keep walking the rest
 * of the list until they find the row, which is the behaviour this replaced.
 */
export async function filesOrderedFor(tsValues: string[]): Promise<string[]> {
  const all = await memoryFiles();
  const names = new Set<string>();
  for (const ts of tsValues) {
    const name = dayFileName(ts);
    if (name) names.add(name);
  }
  if (!names.size) return all;
  const near: string[] = [];
  const rest: string[] = [];
  for (const file of all) {
    (names.has(basename(file)) ? near : rest).push(file);
  }
  return [...near, ...rest];
}

/**
 * The day BEFORE `YYYY-MM-DD`, UTC. Month and year boundaries included: the
 * only caller uses it to name a file that may hold a row appended a millisecond
 * before midnight.
 */
export function previousDayName(day: string): string {
  return new Date(new Date(`${day}T12:00:00.000Z`).getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * The day files that could hold a copy of `ts` — the addresses a single-row
 * mutation must try before it may report success (#373 review).
 *
 * Two files, at most. The one the ts names, plus the previous day's file ONLY
 * when a text scan finds the identity in it: `appendMemory` used to pick the
 * file from the clock and bump a colliding ts inside the lock, so a row whose ts
 * is one millisecond past midnight could be filed under the day before it. That
 * is the only way the plugin can write a row outside its own day, so the
 * neighbour scan is complete, and scanning (not locking) keeps the ordinary
 * single-row mutation at ONE lock.
 *
 * Reading without a lock is sound because this only decides what to lock next:
 * every mutation re-reads under the lock it takes.
 *
 * Empty for a ts that is not an ISO instant — the caller then sweeps, as before.
 */
export async function filesHoldingTs(
  ts: string,
  present?: Set<string>,
): Promise<string[]> {
  const name = dayFileName(ts);
  if (!name) return [];
  const have =
    present ?? new Set((await memoryFiles()).map((f) => basename(f)));
  const out: string[] = [];
  if (have.has(name)) out.push(join(memoryRoot(), name));
  const prev = `${previousDayName(name.slice(0, 10))}.logfmt`;
  if (have.has(prev)) {
    const file = join(memoryRoot(), prev);
    const text = await Bun.file(file).text();
    if (text.includes(`ts=${ts}`)) out.push(file);
  }
  return out;
}

export async function loadAll(): Promise<Memory[]> {
  malformedRows = 0; // per-load telemetry: the most recent read wins
  const blocked = await blockedTs();
  const out: Memory[] = [];
  for (const file of await memoryFiles()) {
    const lines = await readLines(file);
    lines.forEach((line, index) => {
      const m = toMemory(parseLine(line) ?? {}, file, index);
      if (m && !blocked.has(m.ts)) out.push(m);
    });
  }
  return out;
}

export async function loadScope(
  scope: string,
  reader: Reader = readerForAmbient(),
): Promise<Memory[]> {
  // Gate dedup/stale reads are repo-scoped: a row from another repo must not
  // collapse or supersede a write here. The reader is the CALLER's identity,
  // resolved at flow entry — not whatever current says after this await.
  return (await loadAll()).filter(
    (m) => m.scope === scope && isVisibleTo(m, reader),
  );
}

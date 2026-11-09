// supersede — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.

import { basename } from "node:path";
import {
  type Fields,
  formatLine,
  parseLine,
} from "../../core/logfmt/format.ts";
import { fileIdentity, writeAtomic } from "../../core/logfmt/publish.ts";
import { readLines } from "../../core/logfmt/read.ts";
import { LOCK_WRITE, withStoreLock } from "../lock.ts";
import { redactSecrets } from "../secrets.ts";
import { appendMemory } from "./append.ts";
import { filesHoldingTs, filesOrderedFor, memoryFiles } from "./load.ts";
import { snapshotBefore, stampRow } from "./snapshots.ts";

export interface SupersedeFields {
  superseded_by: string;
  reason: string;
  symbol?: string;
  from?: string;
  to?: string;
  entity?: string;
}

// Mark an existing memory as superseded IN PLACE (entry retained, recoverable).
// Idempotent: a second call is a no-op, so no double `superseded_by`.
export async function markSuperseded(
  ts: string,
  fields: SupersedeFields,
  durable?: string[],
): Promise<boolean> {
  return (
    (await markManySupersededReport([{ ts, fields }], durable)).marked.length >
    0
  );
}

// Batch supersession (#61): one lock acquisition, one read, one snapshot and
// one publish PER FILE touched - N rows retire as one undo point instead of
// N. decay and the gate's drift/canonical loops used to call markSuperseded
// per row, which meant N full read-modify-write cycles, N undo points, and
// N windows where two runs interleave and each re-pays the other's work.
// Idempotence is unchanged: a row already carrying superseded_by is skipped,
// so a repeat run marks nothing and writes nothing. Duplicate ts entries in
// one batch: the FIRST entry's fields win (mirrors row-by-row first-call-wins).
// Returns the number of rows actually marked.
export async function markManySuperseded(
  entries: { ts: string; fields: SupersedeFields }[],
  durable?: string[],
): Promise<number> {
  return (await markManySupersededReport(entries, durable)).marked.length;
}

// Same operation, reporting WHICH rows retired rather than how many (#158
// round 3): the write gate needs the ids to keep a durable-mutation ledger,
// because a failed audit line after a persisted retirement must still be able
// to name what actually landed. Skipped-by-the-batch rows (already retired
// out of band) are absent from `marked` — the ledger never claims a retirement
// this call did not perform.
export async function markManySupersededReport(
  entries: { ts: string; fields: SupersedeFields }[],
  // Updated immediately after EACH publish, even if a later file refuses its
  // lock or lock cleanup throws. A rejected promise is not a rollback.
  durable?: string[],
): Promise<{ marked: string[] }> {
  if (entries.length === 0) return { marked: [] };
  const wanted = new Map<string, SupersedeFields>();
  for (const e of entries) if (!wanted.has(e.ts)) wanted.set(e.ts, e.fields);
  const marked: string[] = [];
  const seen = new Set<string>();
  const markFile = (file: string) =>
    withStoreLock(
      file,
      async () => {
        // #106: identity BEFORE the read, like every other whole-file
        // read-modify-write (#89's contract) - the publish below may retry a
        // Windows handover only while the destination still matches this.
        const since = await fileIdentity(file);
        const lines = await readLines(file);
        const ids: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          const parsed = parseLine(lines[i]);
          if (!parsed) continue;
          if (typeof parsed.ts === "string" && wanted.has(parsed.ts))
            seen.add(parsed.ts);
          if (typeof parsed.superseded_by === "string") continue;
          const fields =
            typeof parsed.ts === "string" ? wanted.get(parsed.ts) : undefined;
          if (!fields) continue;
          // Whole line rewritten, not extended: an old-format line comes out in
          // the current format with its values unchanged (as markSuperseded did).
          // The one exception is SECRET SCRUB (#128, review probe 4): the
          // fields a merge/decay/update copies into the loser's row carry
          // caller-authored prose (the rotation note "key ghp_... rotated"),
          // and content already scrubs at this same boundary (appendMemory
          // redacts content in src/store/files/append.ts). The
          // durable row must not be the one place a credential survives when
          // the evidence line beside it was cleaned.
          const clean: SupersedeFields = { ...fields };
          for (const k of Object.keys(clean)) {
            const v = (clean as unknown as Record<string, unknown>)[k];
            if (typeof v === "string")
              (clean as unknown as Record<string, unknown>)[k] =
                redactSecrets(v);
          }
          lines[i] = formatLine({ ...parsed, ...clean });
          ids.push(parsed.ts as string);
        }
        if (ids.length === 0) return [];
        await snapshotBefore(file);
        await writeAtomic(file, lines.join("\n") + "\n", since);
        durable?.push(...ids);
        return ids;
      },
      LOCK_WRITE,
    );

  // #215 + #373 review: retire every address a row can have, and pay for it.
  // Pass 1 walks the day files the batch's own ts values name, plus the previous
  // day's file ONLY where a cheap scan proves a second copy lives there — the
  // one shape an older `appendMemory` could write at UTC midnight. A one-row
  // supersede therefore still costs one lock, and a success can never leave a
  // live copy behind under the same identity.
  const present = new Set((await memoryFiles()).map((f) => basename(f)));
  const addressed = new Set<string>();
  for (const ts of wanted.keys())
    for (const f of await filesHoldingTs(ts, present)) addressed.add(f);
  for (const file of addressed) marked.push(...(await markFile(file)));
  // Pass 2: a target neither address held — a store edited outside the plugin,
  // or a day file that was renamed — keeps the full sweep this replaced.
  if (seen.size < wanted.size) {
    for (const file of await filesOrderedFor([...wanted.keys()])) {
      if (addressed.has(file)) continue;
      marked.push(...(await markFile(file)));
      if (seen.size === wanted.size) break;
    }
  }
  // A ts that appears in more than one file retires in EVERY file that holds it
  // (#373 review): reporting a retirement while a live copy stands would be the
  // worse bug, so the neighbour-day scan above exists. `appendMemory` now also
  // refuses to create the collision in the first place; the scan is what keeps a
  // store written before that fix honest.
  return { marked };
}

// The #126 provenance guard: which supersession a merge_review may clear.
export interface ClearProvenance {
  // The review's loser: a survivor the loser itself superseded first is the
  // legitimate revival the merge exists for.
  supersededBy: string;
  // The review's reason: a marker this very review wrote (a retried apply)
  // is its own provenance.
  reason: string;
}

// Drop a row's supersession markers IN PLACE (snapshot-first), making it active
// again. Used by memory_merge_review: a declared survivor must be recallable
// even when an earlier row — now the loser — had superseded it first.
// #126: with a provenance guard the marker is cleared ONLY when it points at
// this review's loser or carries the review's reason. A survivor superseded by
// anything else (e.g. a memory_update that retired it after the review was
// filed) keeps its marker and the clear reports false — erasing that later
// supersession would revive the retired row next to its live replacement.
export async function clearSuperseded(
  ts: string,
  provenance?: ClearProvenance,
): Promise<boolean> {
  const clear = (parsed: Fields) => {
    if (typeof parsed.superseded_by !== "string") return null;
    if (
      provenance &&
      parsed.superseded_by !== provenance.supersededBy &&
      parsed.reason !== provenance.reason
    )
      return null;
    // These six keys are written only by markSuperseded (drift, canonical,
    // update and merge_review), never by appendMemory, so they are all part of
    // the marker and go with it. Field order round-trips because parseLine
    // inserts keys in source order.
    for (const key of [
      "superseded_by",
      "reason",
      "symbol",
      "from",
      "to",
      "entity",
    ]) {
      delete parsed[key];
    }
    return formatLine(parsed);
  };
  // #215 + #373 review: revive every copy a row has. The common case is the one
  // day file the ts names; the previous day's file joins ONLY when a scan finds
  // the same identity in it, which is what an older midnight-boundary append
  // could write. Reviving one copy while a duplicate stayed retired would put
  // the row back in recall with a stale sibling still on disk.
  const present = new Set((await memoryFiles()).map((f) => basename(f)));
  const candidates = await filesHoldingTs(ts, present);
  let found = false;
  let cleared = false;
  for (const file of candidates) {
    const outcome = await stampRow(file, ts, clear);
    if (outcome === null) continue;
    found = true;
    cleared = cleared || outcome;
  }
  if (found) return cleared;
  // Never seen where it should be: the sweep this replaced, unchanged. A store
  // edited outside the plugin can hold the row under any name, so this one reads
  // every file rather than trusting the day mapping.
  const tried = new Set(candidates);
  for (const file of await memoryFiles()) {
    if (tried.has(file)) continue;
    const outcome = await stampRow(file, ts, clear);
    if (outcome !== null) return outcome;
  }
  return false;
}

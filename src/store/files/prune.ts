// prune — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.
import { join, basename } from "node:path";
import { parseLine } from "../../core/logfmt/format.ts";
import { fileIdentity, writeAtomic } from "../../core/logfmt/publish.ts";
import { readLines } from "../../core/logfmt/read.ts";
import { withStoreLock, LOCK_WRITE } from "../lock.ts";
import { tombstoneMany } from "../tombstones/tombstone.ts";
import { type DeletedMemory, logDeletion } from "./deletions.ts";
import { memoryFiles, toMemory } from "./load.ts";
import { snapshotFiles } from "./snapshots.ts";
import {
  type Reader,
  isVisibleTo,
  readerForAmbient,
} from "../model/visibility.ts";

export interface PruneResult {
  deleted: DeletedMemory[];
  snapshot: string[];
}

// Remove matching memories (used by memory_forget), snapshotting first and
// logging every deletion with its reason. Each file is filtered and republished
// under the store lock, so a row another session appended while we were reading
// is not quietly filtered out along with the targets. The reader is the
// caller's captured identity (#127); out-of-plugin callers keep ambient.
export async function prune(
  scope: string,
  type: string,
  reason: string,
  reader: Reader = readerForAmbient(),
  durable: PruneResult = { deleted: [], snapshot: [] },
): Promise<PruneResult> {
  const { deleted, snapshot } = durable;
  // #206: a later file failing must not undo the bookkeeping an earlier file
  // already earned, and no bookkeeping may claim a row the store never let go
  // of. So the order per file is: publish, then audit; and the tombstone pass
  // runs over everything committed even when the loop itself threw. Errors are
  // collected, never swallowed: the primary (loop) error is rethrown with any
  // secondary (audit/tombstone) failure appended, so pruneMemory's PARTIAL
  // reply names both.
  let loopError: unknown;
  let bookkeepingError: string | undefined;
  const note = (msg: string) => {
    bookkeepingError = bookkeepingError ? `${bookkeepingError}; ${msg}` : msg;
  };
  try {
    for (const file of await memoryFiles()) {
      const fileDeleted: DeletedMemory[] = [];
      await withStoreLock(
        file,
        async () => {
          const since = await fileIdentity(file);
          const lines = await readLines(file);
          const kept: string[] = [];
          let changed = false;
          for (const line of lines) {
            const parsed = parseLine(line);
            const m = parsed ? toMemory(parsed, file, 0) : null;
            // Repo floor: forgetting scope X here must never delete
            // another repo's row for scope X — same basename collisions are real
            // (a fork next to its upstream).
            if (
              m &&
              m.scope === scope &&
              m.type === type &&
              isVisibleTo(m, reader)
            ) {
              fileDeleted.push({ memory: m, reason });
              changed = true;
              continue;
            }
            kept.push(line);
          }
          if (!changed) return;
          snapshot.push(...(await snapshotFiles([file])));
          await writeAtomic(
            file,
            kept.join("\n") + (kept.length ? "\n" : ""),
            since,
          );
          deleted.push(...fileDeleted);
        },
        LOCK_WRITE,
      );
      // #206 STORE-2: the deletion audit FOLLOWS the publish, as in the viewer's
      // delete (mutate.ts audits after its locked handover). Auditing inside the
      // read loop claimed rows as deleted when a snapshot/publish failure left
      // them live: the viewer's Deleted panel listed a still-live row, its
      // restore-entry action would duplicate it, and undo's auditedDeletions()
      // treated the ts as intentionally removed. appendLog needs no store lock
      // (deletions.logfmt is append-only), so this stays outside the day-file
      // lock and keeps the one consistent lock order across the codebase. An
      // audit failure after a committed publish cannot be undone — it is
      // reported as PARTIAL and recoverable by inspecting the store.
      for (const d of fileDeleted) {
        try {
          await logDeletion(d.memory, d.reason);
        } catch (err) {
          note(
            `deletion audit failed for ${d.memory.ts}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    loopError = err;
  }
  // #35: tombstone every forgotten VALUE, keyed on content rather than on the
  // row's `ts`, so replaying the source cannot store the fact again.
  //
  // ONE batched call, not one per row: `memory_forget` deletes by scope+type and
  // routinely removes hundreds of rows, and the per-row form issued a store-lock
  // create/unlink pair plus a full re-read of the tombstone file for each one.
  // Done AFTER the per-file locks are released as well — appending inside the
  // loop would nest a second store lock (day file, then rejected.logfmt) inside
  // the first, and one consistent order across the codebase is what keeps the
  // lock manager from having to reason about nesting at all.
  //
  // #206 STORE-1: this runs even when the loop threw. The committed rows are
  // already out of the store, so a retry of the forget will never see them
  // again — skipping the tombstone here is how a partial forget quietly
  // reopened the rejection hole #35 closed. If THIS write fails too, the
  // PARTIAL reply names it: the committed rows are gone and unprotected, and
  // only a human (the viewer's reject route) can restore the marker — the
  // agreed recoverable partial-result semantics, pinned by test.
  if (deleted.length) {
    try {
      await tombstoneMany(
        deleted.map((d) => ({
          content: d.memory.content,
          scope: d.memory.scope,
          type: d.memory.type,
        })),
        { reason, source: "forget" },
      );
    } catch (err) {
      note(
        `rejection tombstones incomplete: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (loopError) {
    if (bookkeepingError)
      throw new Error(
        `${loopError instanceof Error ? loopError.message : String(loopError)}; ${bookkeepingError}`,
      );
    throw loopError;
  }
  if (bookkeepingError) throw new Error(bookkeepingError);
  return { deleted, snapshot };
}

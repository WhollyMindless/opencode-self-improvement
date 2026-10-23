// Serialization for the store's write paths.
//
// Daily store files are shared by every opencode session on the machine plus
// the viewer, which is a separate process. Appending is atomic on its own
// (O_APPEND, see logfmt.ts), but supersede, prune, viewer delete and snapshot
// restore each REWRITE a whole file: a writer that read before someone else
// wrote publishes a stale copy and silently drops the other's rows. Measured
// before this module existed: 40 concurrent appends against 40 supersedes left
// 40 rows on disk; four processes writing one store kept 20 of 120.
//
// One lock per store file, held across the whole read-modify-write. Appends take
// the same lock so they cannot land inside an RMW window. Two layers, sharing
// one timeout budget:
//   - a FIFO hand-off between async tasks in THIS process, so contending
//     writers take their turn instead of spinning;
//   - a lock FILE created with O_EXCL, which is atomic across processes (and
//     exclusive against our own tasks too, since the check is in the kernel).
// A killed holder is recovered by age. A writer that waits past the budget
// gives up waiting — see onTimeout.
//
// Readers take NO lock: publishers hand over the new file with a rename
// (writeAtomic in logfmt.ts), so a reader always sees a complete store, never
// the middle of a rewrite.
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";

const LOCK_SUFFIX = ".lock";
// A lock older than this belongs to a process that died holding it.
const STALE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_BACKOFF_MS = 1;
const MAX_BACKOFF_MS = 25;

export function lockFileFor(file: string): string {
  return file + LOCK_SUFFIX;
}

/** Waiting past the timeout, or taking over a dead holder's lock. */
export type LockEvent = "steal" | "timeout";

export interface LockOptions {
  timeoutMs?: number;
  /**
   * What waiting past `timeoutMs` means. "fail" refuses the mutation (for
   * callers where proceeding unlocked could destroy more than it saves, e.g.
   * snapshot restore). "proceed" runs it anyway: strictly no worse than the
   * pre-lock behaviour, and it never costs a user their write.
   */
  onTimeout?: "proceed" | "fail";
  onEvent?: (event: LockEvent, waitedMs: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resolves when the task stored as this key has finished, handing the turn to
// whoever queued after it.
const turns = new Map<string, Promise<void>>();

async function timed(prev: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gained = await Promise.race([
    prev.then(() => true),
    new Promise<boolean>((res) => (timer = setTimeout(() => res(false), ms))),
  ]);
  clearTimeout(timer);
  return gained;
}

async function stealIfStale(lockPath: string, now: number): Promise<boolean> {
  let age = -1;
  try {
    age = now - (await stat(lockPath)).mtimeMs;
  } catch {
    return true; // vanished between EEXIST and stat: retry the create
  }
  if (age < STALE_MS) return false;
  try {
    await unlink(lockPath);
  } catch {
    return false; // another stealer won; its create decides
  }
  return true;
}

/** Cross-process half: hold the lock file while `fn` runs. */
async function holdFileLock<T>(
  lockPath: string,
  file: string,
  fn: () => Promise<T>,
  opts: LockOptions,
  budgetMs: number,
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const started = Date.now();
  let backoff = MIN_BACKOFF_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.write(token);
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (await stealIfStale(lockPath, Date.now())) {
        opts.onEvent?.("steal", Date.now() - started);
        continue;
      }
      if (Date.now() - started >= budgetMs) {
        opts.onEvent?.("timeout", Date.now() - started);
        if (opts.onTimeout === "fail") {
          throw new Error(
            `memory store is busy: ${basename(file)} has been locked for ${Date.now() - started}ms — retry`,
          );
        }
        return fn();
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
  try {
    return await fn();
  } finally {
    // Never release a lock that is no longer ours: if we ran long and someone
    // stole it, unlinking would clobber the new holder.
    try {
      if ((await Bun.file(lockPath).text()) === token) await unlink(lockPath);
    } catch {
      // already gone
    }
  }
}

/**
 * Run `fn` as the only writer of `file`, in this process and every other one.
 * Sections run flat: calling this again for the same file from inside `fn`
 * waits for its own lock.
 */
export async function withStoreLock<T>(
  file: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const lockPath = lockFileFor(file);

  let releaseTurn!: () => void;
  const myTurnEnded = new Promise<void>((res) => (releaseTurn = res));
  const queuedBehind = turns.get(file);
  turns.set(file, myTurnEnded);

  const finish = () => {
    releaseTurn();
    if (turns.get(file) === myTurnEnded) turns.delete(file);
  };

  if (queuedBehind) {
    const gained = await timed(queuedBehind, timeoutMs);
    if (!gained) {
      // Give up our place in line rather than park everyone behind us on a
      // writer that is not going to finish.
      finish();
      opts.onEvent?.("timeout", Date.now() - started);
      if (opts.onTimeout === "fail") {
        throw new Error(
          `memory store is busy: ${basename(file)} has been locked for ${Date.now() - started}ms — retry`,
        );
      }
      return fn();
    }
  }

  try {
    return await holdFileLock(lockPath, file, fn, opts, timeoutMs - (Date.now() - started));
  } finally {
    finish();
  }
}

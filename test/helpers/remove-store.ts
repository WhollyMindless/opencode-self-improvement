// Teardown for a temporary store directory.
//
// The store lock is a SQLite connection, and a connection is an open
// file. Windows refuses to delete a directory that contains one, so a fixture
// that removes its store while this process still holds the connection fails
// with EBUSY — measured on the Windows runner, where it took down most of the
// suite. Under the old lock file there was no handle outliving a write, so this
// is a requirement the new mechanism brings: whoever deletes a store says so
// first.
//
// That is also the answer for a real user. Deleting the memory root while an
// opencode session is alive is a stop-the-session operation on Windows.
import { rmSync } from "node:fs";
import {
  closeAllLockDatabases,
  heldLockSectionsUnder,
} from "../../src/store/lock.ts";

/**
 * Codes that mean "something still has this open", not "this delete is wrong".
 * `EPERM` belongs here because Windows reports it for a directory whose child
 * is mapped, and `ENOTEMPTY` is what a recursive delete reports when a file
 * reappears between the unlink pass and the rmdir pass.
 */
const STILL_OPEN = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);

/** The most a teardown will wait for a handle, and the gap it grows to. */
const BUDGET_MS = 2000;
const FIRST_GAP_MS = 25;
const MAX_GAP_MS = 400;

type Warn = (message: string) => void;

const toConsole: Warn = (message) => console.error(message);

interface BusyOptions {
  /** Stop waiting once the next gap would pass this. */
  budgetMs?: number;
  warn?: Warn;
  /**
   * The lock sections of THIS process that still own something under `dir`.
   * Defaults to the real seam in src/store/lock.ts.
   */
  held?: () => string[];
  /** Release this process's idle lock connections. Runs before every retry. */
  closeIdle?: () => void;
}

/**
 * Removes `dir`, releasing this process's lock handles first. Returns whether
 * the directory went.
 *
 * SYNCHRONOUS, so it cannot help a lock section that is still running in this
 * process: the section is a callback waiting for the event loop, and this
 * function owns the loop while it waits. That case is therefore decided before
 * the first gap — reported at once, with no wait spent on an outcome that
 * cannot change. An `afterEach` that can await should call `removeStoreAsync`,
 * which does reclaim such a store.
 *
 * A delete refused for any other reason throws: a path that cannot be resolved
 * is a defect in the caller, and silence would hide it.
 */
export function removeStore(dir: string, warn: Warn = toConsole): boolean {
  return removeWhileBusy(
    dir,
    () => rmSync(dir, { recursive: true, force: true }),
    { warn },
  );
}

/**
 * The teardown an async hook should call. Same contract, but it yields between
 * attempts, which is what makes a same-process holder reclaimable: the holder
 * resumes, its connection goes idle, and the next attempt closes it before
 * deleting.
 */
export async function removeStoreAsync(
  dir: string,
  warn: Warn = toConsole,
): Promise<boolean> {
  return removeWhileBusyAsync(
    dir,
    () => rmSync(dir, { recursive: true, force: true }),
    { warn },
  );
}

interface RetrySeams extends BusyOptions {
  /** Stands in for the wait. */
  sleep?: (ms: number) => void;
}

/**
 * One delete attempt, then a doubling wait up to the budget.
 *
 * Before each retry it closes whatever lock connections have gone idle, because
 * a connection that was inside a section on the previous pass is the handle
 * being waited on. Exposed for tests: a held handle cannot be produced on
 * Linux or macOS, which both delete a file another descriptor still has open,
 * so a test that waited for the real thing would assert nothing off Windows.
 */
export function removeWhileBusy(
  dir: string,
  remove: () => void,
  opts: RetrySeams = {},
): boolean {
  const budgetMs = opts.budgetMs ?? BUDGET_MS;
  const warn = opts.warn ?? toConsole;
  const held = opts.held ?? (() => heldLockSectionsUnder(dir));
  const closeIdle = opts.closeIdle ?? closeAllLockDatabases;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  closeIdle();
  let attempts = 0;
  let waited = 0;
  let gap = FIRST_GAP_MS;
  for (;;) {
    attempts++;
    const code = attempt(remove);
    if (code === null) return true;
    const holders = held();
    if (holders.length) {
      warn(
        `[opencode-self-improvement] teardown: ${dir} refused with ${code} while ${holders.length} store-lock section(s) still run in this process — left in place. A synchronous teardown holds the event loop, so such a section cannot finish; await the holder or tear down with removeStoreAsync.`,
      );
      return false;
    }
    if (waited + gap > budgetMs) {
      warn(
        `[opencode-self-improvement] teardown: ${dir} still ${code} after ${waited} ms and ${attempts} attempts — left in place. A store directory is only deletable once every session holding its lock has stopped.`,
      );
      return false;
    }
    sleep(gap);
    waited += gap;
    gap = Math.min(gap * 2, MAX_GAP_MS);
    closeIdle();
  }
}

interface RetrySeamsAsync extends BusyOptions {
  wait?: (ms: number) => Promise<void>;
}

/** The yielding half of `removeWhileBusy`; same seams, same contract. */
export async function removeWhileBusyAsync(
  dir: string,
  remove: () => void,
  opts: RetrySeamsAsync = {},
): Promise<boolean> {
  const budgetMs = opts.budgetMs ?? BUDGET_MS;
  const warn = opts.warn ?? toConsole;
  const held = opts.held ?? (() => heldLockSectionsUnder(dir));
  const closeIdle = opts.closeIdle ?? closeAllLockDatabases;
  const wait =
    opts.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  closeIdle();
  let attempts = 0;
  let waited = 0;
  let gap = FIRST_GAP_MS;
  for (;;) {
    attempts++;
    const code = attempt(remove);
    if (code === null) return true;
    if (waited + gap > budgetMs) {
      const holders = held();
      warn(
        `[opencode-self-improvement] teardown: ${dir} still ${code} after ${waited} ms and ${attempts} attempts${holders.length ? `, with ${holders.length} store-lock section(s) still running in this process` : ""} — left in place. A store directory is only deletable once every session holding its lock has stopped.`,
      );
      return false;
    }
    // Await rather than sleep: a section running in this process resumes only
    // when the event loop gets a turn, and closing its connection once it is
    // idle is what actually frees the handle.
    await wait(gap);
    waited += gap;
    gap = Math.min(gap * 2, MAX_GAP_MS);
    closeIdle();
  }
}

/** Null when the delete landed, otherwise the OS code that refused it. */
function attempt(remove: () => void): string | null {
  try {
    remove();
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (!STILL_OPEN.has(code)) throw err;
    return code;
  }
}

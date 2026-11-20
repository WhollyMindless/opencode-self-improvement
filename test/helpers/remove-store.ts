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
import { closeAllLockDatabases } from "../../src/store/lock.ts";

/**
 * Codes that mean "something still has this open", not "this delete is wrong".
 * `EPERM` belongs here because Windows reports it for a directory whose child
 * is mapped, and `ENOTEMPTY` is what a recursive delete reports when a file
 * reappears between the unlink pass and the rmdir pass.
 */
const STILL_OPEN = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);

/**
 * Removes `dir`, releasing this process's lock handles first.
 *
 * A handle can outlive the test that opened it: a lock connection inside a
 * section that is still running is left closed-by-nobody, because closing it
 * would give up a lock its writer still believes it holds
 * (`closeAllLockDatabases` skips it for exactly that reason). Windows then
 * refuses the delete, and the failure lands on whichever test happened to be
 * tearing down — not on the one that leaked the handle.
 *
 * So a busy delete is waited out, and a delete that is STILL busy after the
 * budget is reported and abandoned rather than thrown. The directory is inside
 * the OS temporary tree, which the runner reclaims; a red test on an unrelated
 * assertion is not reclaimable. Anything that is not a held handle — a path
 * that cannot be resolved, a delete the OS refuses outright — still throws,
 * because that is a defect in the caller and silence would hide it.
 */
export function removeStore(
  dir: string,
  warn: (message: string) => void = (message) => console.error(message),
): void {
  closeAllLockDatabases();
  removeWhileBusy(() => rmSync(dir, { recursive: true, force: true }), {
    label: dir,
    warn,
  });
}

/**
 * Runs `remove` until it succeeds, waiting between attempts for a handle to
 * close. Doubles the gap up to 400 ms and stops once the next wait would pass
 * `budgetMs`; a non-busy error leaves immediately.
 *
 * Returns whether the delete landed. Exposed for the tests in
 * test/store/temp-store-fixture.test.ts, which drive each branch with an
 * injected remover — a held handle cannot be produced on Linux or macOS, so a
 * test that waited for the real thing would assert nothing off Windows.
 */
export function removeWhileBusy(
  remove: () => void,
  opts: {
    budgetMs?: number;
    label?: string;
    warn?: (message: string) => void;
  } = {},
): boolean {
  const budgetMs = opts.budgetMs ?? 2000;
  const warn = opts.warn ?? ((message: string) => console.error(message));
  let delay = 25;
  let waited = 0;
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      remove();
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!STILL_OPEN.has(code)) throw err;
      if (waited + delay > budgetMs) {
        warn(
          `[opencode-self-improvement] teardown: ${opts.label ?? "path"} still ${code} after ${waited} ms and ${attempts} attempts — left in place. A store directory is only deletable once every session holding its lock has stopped.`,
        );
        return false;
      }
      Bun.sleepSync(delay);
      waited += delay;
      delay = Math.min(delay * 2, 400);
    }
  }
}

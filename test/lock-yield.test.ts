// Waiting WITHOUT the store lock (#407).
//
// The lock covers a whole store directory, so a section that sleeps while
// holding it stops every writer in the store — including writers to files it has
// nothing to do with. The Windows handover waits up to 2 s for a reader to let
// go of a destination, so that wait goes through `yieldStoreLock`: give the lock
// back, wait, queue again, take it back. These pin all three steps, because a
// yield that gives up without taking back is a lost lock, and a yield that takes
// back without giving up is the stall this exists to remove.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIdentity, writeAtomic } from "../src/core/logfmt/publish.ts";
import {
  closeAllLockDatabases,
  lockDatabaseFor,
  withStoreLock,
  yieldStoreLock,
} from "../src/store/lock.ts";
import { childHolder } from "./helpers/hold-cross-process.ts";
import { removeStore } from "./helpers/remove-store.ts";
import { sleep } from "./helpers/logfmt.ts";

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "osi-lock-yield-"));
  roots.push(root);
  return root;
}
function twoFilesOneStore(): [string, string] {
  const root = newRoot();
  return [join(root, "a.logfmt"), join(root, "b.logfmt")];
}
afterEach(() => {
  closeAllLockDatabases();
  for (const root of roots.splice(0)) removeStore(root);
});

/** Can a second connection take the lock right now? (true = nobody holds it) */
function freeToAcquire(target: string): boolean {
  const other = new Database(lockDatabaseFor(target));
  other.run("PRAGMA busy_timeout=0");
  try {
    other.run("BEGIN IMMEDIATE");
    other.run("ROLLBACK");
    return true;
  } catch (e) {
    expect(String(e)).toContain("database is locked");
    return false;
  } finally {
    other.close();
  }
}

async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("until: condition never held");
    await sleep(2);
  }
}

test("a yield hands the store to another file's writer and takes the lock back", async () => {
  const [held, other] = twoFilesOneStore();
  let phase = "start";
  let excludedInside = false;
  let yielded: boolean | undefined;
  let heldAfter = false;
  const section = withStoreLock(held, async () => {
    // Control, taken from inside: the store really is excluded while a section
    // runs. It cannot be checked from out here — the section yields within
    // microseconds of starting, so an outside probe would race it.
    excludedInside = !freeToAcquire(held);
    phase = "yielding";
    yielded = await yieldStoreLock(150);
    heldAfter = !freeToAcquire(held);
  });
  await until(() => phase === "yielding");
  // Now it is inside the wait, so the store must be open to the next writer.
  await until(() => freeToAcquire(held));
  const t0 = performance.now();
  await withStoreLock(other, async () => undefined);
  const otherMs = performance.now() - t0;
  await section;
  expect(excludedInside).toBe(true);
  expect(yielded).toBe(true);
  // A hold kept through the wait would cost this writer the full 150 ms.
  expect(otherMs).toBeLessThan(80);
  // And the section resumed holding what it gave up (checked in-section: once it
  // returns, the lock is of course free again).
  expect(heldAfter).toBe(true);
});

test("a yield that cannot take the lock back fails the section closed", async () => {
  const root = newRoot();
  const target = join(root, "a.logfmt");
  let ranAfterLoss = false;
  let phase = "start";
  const section = withStoreLock(
    target,
    async () => {
      phase = "yielding";
      await yieldStoreLock(400);
      ranAfterLoss = true; // must not be reached
    },
    { timeoutMs: 450 },
  );
  // Wait for the section to be INSIDE its wait before taking the lock: probing
  // for a free lock from the start would race the section's own acquisition and
  // make it fail before it ever yielded.
  await until(() => phase === "yielding");
  await until(() => freeToAcquire(target));
  // Take it from another process and keep it: the section's re-acquisition has
  // no room left, and continuing without it would publish over this writer.
  const rival = await childHolder(target);
  let error = "";
  try {
    await section;
  } catch (err) {
    error = String(err);
  }
  expect(ranAfterLoss).toBe(false);
  expect(error).toContain("memory store is busy");
  await rival.release();
});

test("a section that yields still excludes a second process once it resumes", async () => {
  const root = newRoot();
  const target = join(root, "a.logfmt");
  let excludedAfterResume: boolean | undefined;
  const section = withStoreLock(target, async () => {
    await yieldStoreLock(20);
    const rival = new Database(lockDatabaseFor(target));
    rival.run("PRAGMA busy_timeout=0");
    try {
      rival.run("BEGIN IMMEDIATE");
      rival.run("ROLLBACK");
      excludedAfterResume = false; // the rival got in: exclusion was lost
    } catch {
      excludedAfterResume = true;
    } finally {
      rival.close();
    }
  });
  await section;
  expect(excludedAfterResume).toBe(true);
});

test("outside a section there is nothing to yield, and the caller is told", async () => {
  expect(await yieldStoreLock(1)).toBe(false);
});

test.skipIf(process.platform !== "win32")(
  "a blocked Windows handover does not stall the rest of the store",
  async () => {
    // The end-to-end shape on the platform that has the defect: a reader handle
    // makes Windows refuse the rename, and the handover waits up to 2 s. Before
    // #407 that wait happened on the store lock, so every other writer in the
    // store paid for it. The control is that the handover is STILL pending when
    // the unrelated write runs — if the reader did not actually block it, this
    // test reports that instead of passing quietly.
    const [blocked, other] = twoFilesOneStore();
    await Bun.write(blocked, "seed\n");
    const since = await fileIdentity(blocked);
    const reader = await open(blocked, "r");
    let publishDone = false;
    let error = "";
    const publish = withStoreLock(blocked, async () => {
      await writeAtomic(blocked, "published\n", since);
    })
      .then(() => {
        publishDone = true;
      })
      .catch((err) => {
        error = String(err);
      });
    await sleep(150);
    expect(publishDone).toBe(false);
    const t0 = performance.now();
    await withStoreLock(other, async () => undefined);
    const otherMs = performance.now() - t0;
    await reader.close();
    await publish;
    expect(error).toBe("");
    expect(publishDone).toBe(true);
    expect(await readFile(blocked, "utf8")).toBe("published\n");
    // Held through the wait, this writer would have paid ~1.85 s of the 2 s
    // handover window instead.
    expect(otherMs).toBeLessThan(200);
  },
);

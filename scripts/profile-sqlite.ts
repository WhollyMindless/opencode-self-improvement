// TEMPORARY diagnostic (#407): can SQLite be the lock manager?
//
// SQLite's own concurrency control is the primitive the store lock is missing:
// fcntl(F_SETLK) on POSIX and LockFileEx on Windows, both kernel-owned and both
// released when the handle closes or the process dies, with no directory entry
// in the protocol. bun:sqlite ships inside Bun, so it costs no dependency.
//
// The questions this answers, in order of "would break us":
//   1. does BEGIN IMMEDIATE actually block a second PROCESS?
//   2. does it create a rollback journal that SQLite then DELETES on commit?
//      That is the Windows delete-pending operation, moved onto the lock path,
//      and it is the whole reason for asking. If we write nothing, no journal.
//   3. is the lock released when the holder is SIGKILLed?
//   4. what does an acquire/release cost against the current 173ms/300 on
//      Windows and 65ms/300 on ubuntu?
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The parent creates the directory; every child must open the SAME database,
// so the path is handed over rather than re-derived. (The first version of
// this file mkdtemp'd per process, so the "second process" opened its own
// empty database and of course obtained the lock — a result that proved
// nothing and read as if SQLite did not lock at all.)
const dir =
  process.env.OSI_SQLOCK_DIR ?? mkdtempSync(join(tmpdir(), "osi-sqlock-"));
const dbPath = join(dir, "store-lock.sqlite");
const mode = process.argv[2] ?? "self";
if (process.env.OSI_SQLOCK_DIR) process.env.OSI_KEEP_SQLOCK = "1";

const JOURNAL = process.env.OSI_JOURNAL ?? "";

function open(): Database {
  const db = new Database(dbPath);
  if (JOURNAL) db.run(`PRAGMA journal_mode = ${JOURNAL}`);
  // Default is 0: SQLite returns SQLITE_BUSY immediately instead of sleeping
  // inside C. That matters — busy_timeout blocks the JS thread, and this runs
  // inside the user's host event loop. The wait policy stays ours.
  db.run("PRAGMA busy_timeout = 0");
  return db;
}

function files(): string[] {
  try {
    return readdirSync(dir).filter((f) => f.startsWith("store-lock.sqlite"));
  } catch {
    return [];
  }
}

if (mode === "probe") {
  // Runs in its own process: report whether the lock is obtainable right now.
  const db = open();
  try {
    db.run("BEGIN IMMEDIATE");
    db.run("ROLLBACK");
    console.log(JSON.stringify({ obtainable: true }));
  } catch (e) {
    console.log(
      JSON.stringify({ obtainable: false, err: (e as Error).message }),
    );
  }
  db.close();
} else if (mode === "hold") {
  const db = open();
  db.run("BEGIN IMMEDIATE");
  console.log(
    JSON.stringify({
      mode,
      locked: true,
      pid: process.pid,
      journalMode: db.query("PRAGMA journal_mode").get(),
      filesDuringHold: files(),
    }),
  );
  Bun.sleepSync(30_000); // hold until killed
} else if (mode === "cost") {
  const db = open();
  let acquired = 0;
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) {
    try {
      db.run("BEGIN IMMEDIATE");
      acquired++;
      db.run("ROLLBACK");
    } catch (e) {
      console.log(`cost aborted: ${(e as Error).message}`);
      break;
    }
  }
  const total = performance.now() - t0;
  console.log(
    JSON.stringify({
      mode,
      acquired,
      totalMs: Math.round(total),
      perOpUs: Math.round((total * 1000) / Math.max(1, acquired)),
      filesAfter: files(),
      journalMode: db.query("PRAGMA journal_mode").get(),
    }),
  );
  db.close();
} else {
  // 1 + 2: take the lock, then try to take it again from a SECOND PROCESS.
  const db = open();
  db.run("BEGIN IMMEDIATE");
  const during = files();
  const second = Bun.spawnSync([process.execPath, import.meta.path, "probe"], {
    env: { ...process.env, OSI_SQLOCK_DIR: dir },
  });
  const released = (() => {
    db.run("ROLLBACK");
    const third = Bun.spawnSync([process.execPath, import.meta.path, "probe"], {
      env: { ...process.env, OSI_SQLOCK_DIR: dir },
    });
    return third.stdout.toString().trim();
  })();
  console.log(
    JSON.stringify({
      mode,
      journalMode: db.query("PRAGMA journal_mode").get(),
      filesWhileHeld: during,
      secondProcessWhileHeld:
        second.stdout.toString().trim() ||
        second.stderr.toString().slice(0, 120),
      thirdProcessAfterRollback: released,
      filesAfterAll: files(),
    }),
  );
  db.close();
}

if (mode !== "hold" && !process.env.OSI_KEEP_SQLOCK) {
  rmSync(dir, { recursive: true, force: true });
}

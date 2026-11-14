// TEMPORARY diagnostic (Windows flake investigation, #407). Delete once the
// cause is attributed.
//
// Round 2. Round 1 proved two things: Bun on Windows ignores the
// UV_FS_O_EXLOCK bit (a second open of the same path succeeds, so the flag is
// decoration), and the suite's Windows penalty sits in directory churn (5x)
// rather than in lock acquire/release (2x). This round asks what primitives
// Bun DOES give us there, because the answer decides the fix:
//
//   A. does Bun expose O_EXLOCK / O_TEMPORARY in fs.constants on win32?
//   B. does O_TEMPORARY (FILE_FLAG_DELETE_ON_CLOSE) work — file gone on close,
//      and does it exclude a second opener?
//   C. does process.kill(pid, 0) distinguish a live from a dead pid on win32?
//      This is the fallback: the lock token already carries the holder's pid
//      and nothing reads it back, so liveness can correct a directory entry
//      whose lifetime Windows controls and we do not.
//   D. is bun:ffi usable, i.e. is kernel32 LockFileEx on the table at all?
//   E. how expensive is the delete-pending window itself?
import {
  constants as FS,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import {
  appendFile,
  open,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { withStoreLock } from "../src/store/lock.ts";

const UV_FS_O_EXLOCK_WIN = 0x10000000;
const UV_FS_O_TEMPORARY_WIN = 0x00040000;

type Row = {
  name: string;
  total: number;
  p50: number;
  p90: number;
  note?: string;
};
const rows: Row[] = [];

async function bench(
  name: string,
  n: number,
  fn: (i: number) => Promise<unknown>,
  note?: string,
): Promise<void> {
  const each: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    await fn(i);
    each.push(performance.now() - s);
  }
  const total = performance.now() - t0;
  each.sort((a, b) => a - b);
  rows.push({
    name,
    total: Math.round(total),
    p50: Math.round(each[Math.floor(n * 0.5)] ?? 0),
    p90: Math.round(each[Math.floor(n * 0.9)] ?? 0),
    note,
  });
}

const dir = mkdtempSync(join(tmpdir(), "osi-profile-"));
const file = join(dir, "2026-11-13.logfmt");
const lockPath = file + ".lock";
const N = 300;
await writeFile(file, "seed\n");

await bench("withStoreLock (current protocol)", N, () =>
  withStoreLock(file, async () => 1),
);

await bench("raw create+write+close+read+unlink", N, async () => {
  const h = await open(lockPath, "wx", 0o600);
  await h.write("token");
  await h.close();
  await Bun.file(lockPath).text();
  await unlink(lockPath);
});

await bench("stat", N, () => stat(file));
await bench("append 24 bytes", N, () =>
  appendFile(file, "x".repeat(24) + "\n"),
);
await bench("publish-style write+rename", N, async (i) => {
  const tmp = `${file}.${i}.tmp`;
  await writeFile(tmp, "payload\n");
  await rename(tmp, file);
});
await bench("mkdir+5 files+rmSync (test fixture)", 60, async (i) => {
  const d = join(dir, `fx${i}`);
  mkdirSync(d, { recursive: true });
  for (let k = 0; k < 5; k++) writeFileSync(join(d, `f${k}.logfmt`), "row\n");
  rmSync(d, { recursive: true, force: true });
});

// E: the delete-pending window. Create, unlink, then ask how long the name
// stays visible. On POSIX this is 0; on Windows a lingering third-party handle
// is what makes the name outlive the delete.
{
  const each: number[] = [];
  let visible = 0;
  for (let i = 0; i < 200; i++) {
    const p = join(dir, `dp${i}.tmp`);
    writeFileSync(p, "x");
    unlink(p);
    const t0 = performance.now();
    while (existsSync(p) && performance.now() - t0 < 50) {
      // spin: measure how long the name survives its own delete
    }
    const waited = performance.now() - t0;
    each.push(waited);
    if (existsSync(p)) visible++;
  }
  each.sort((a, b) => a - b);
  rows.push({
    name: "delete-pending visibility (200)",
    total: Math.round(each.reduce((a, b) => a + b, 0)),
    p50: Math.round(each[100] ?? 0),
    p90: Math.round(each[180] ?? 0),
    note: `still visible after 50ms: ${visible}`,
  });
}

// A: what does Bun's constants table actually contain here?
const interesting = Object.keys(FS)
  .filter((k) => /EXLOCK|SHLOCK|TEMPORARY|SHORT_LIVED|FILEMAP/.test(k))
  .map((k) => `${k}=0x${(FS as Record<string, number>)[k].toString(16)}`);
rows.push({
  name: "fs.constants lock/temporary keys",
  total: 0,
  p50: 0,
  p90: 0,
  note: interesting.join(" ") || "none",
});

// B + the round-1 EXLOCK result, repeated so both rounds are comparable.
if (process.platform === "win32") {
  const base = FS.O_CREAT | FS.O_RDWR | FS.O_NONBLOCK;
  for (const [label, bit] of [
    ["EXLOCK", UV_FS_O_EXLOCK_WIN],
    ["TEMPORARY", UV_FS_O_TEMPORARY_WIN],
    ["EXLOCK|TEMPORARY", UV_FS_O_EXLOCK_WIN | UV_FS_O_TEMPORARY_WIN],
  ] as const) {
    const flags = base | bit;
    const probe = join(dir, `probe-${label}.lock`);
    let excludes = false;
    let deletedOnClose: boolean | undefined;
    try {
      const a = await open(probe, flags, 0o600);
      try {
        const b = await open(probe, flags, 0o600);
        await b.close();
        excludes = false;
      } catch (e) {
        excludes = true;
        void e;
      }
      await a.close();
      deletedOnClose = !existsSync(probe);
    } catch (e) {
      rows.push({
        name: `${label} open`,
        total: 0,
        p50: 0,
        p90: 0,
        note: `open failed: ${(e as Error & { code?: string }).code}`,
      });
      continue;
    }
    rows.push({
      name: `${label} (win32 candidate)`,
      total: 0,
      p50: 0,
      p90: 0,
      note: `excludes=${excludes} deletedOnClose=${deletedOnClose}`,
    });
    rmSync(probe, { force: true });
  }
}

// C: can we ask the OS whether a pid is alive?
{
  const alive = (() => {
    try {
      process.kill(process.pid, 0);
      return "alive=ok";
    } catch (e) {
      return `alive=${(e as Error & { code?: string }).code}`;
    }
  })();
  // A child that has definitely exited. spawnSync reaps it, so the pid is gone.
  const kid = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    encoding: "utf8",
  });
  const deadPid = kid.pid ?? 0;
  let dead: string;
  try {
    process.kill(deadPid, 0);
    dead = "DEAD_PID_STILL_ANSWERS";
  } catch (e) {
    dead = (e as Error & { code?: string }).code ?? "unknown";
  }
  let bogus: string;
  try {
    process.kill(999_999, 0);
    bogus = "answers";
  } catch (e) {
    bogus = (e as Error & { code?: string }).code ?? "unknown";
  }
  rows.push({
    name: "process.kill(pid,0)",
    total: 0,
    p50: 0,
    p90: 0,
    note: `self=${alive} exited=${dead} bogus=${bogus}`,
  });
}

// D: is FFI on the table? kernel32 LockFileEx is the correct Windows advisory
// lock and is released by the kernel when the handle closes or the process dies.
{
  let note = "unavailable";
  try {
    const ffi = await import("bun:ffi");
    const k32 = ffi.dlopen("kernel32", {
      LockFileEx: {
        args: ["u32", "u32", "u32", "u32", "u32", "ptr"],
        returns: "i32",
      },
      UnlockFileEx: {
        args: ["u32", "u32", "u32", "u32", "u32", "ptr"],
        returns: "i32",
      },
      GetLastError: { args: [], returns: "u32" },
    });
    const p = join(dir, "ffi.lock");
    writeFileSync(p, "");
    const fd = openSync(p, "r+");
    const overlapped = ffi.ptr(Buffer.alloc(32));
    const got = k32.symbols.LockFileEx(
      fd,
      2 /* LOCK_EX */,
      0,
      0,
      1,
      overlapped,
    );
    const err = k32.symbols.GetLastError();
    k32.symbols.UnlockFileEx(fd, 0, 0, 1, overlapped);
    closeSync(fd);
    note = `dlopen ok, LockFileEx returned ${got} err ${err}`;
  } catch (e) {
    note = `failed: ${(e as Error & { code?: string }).code ?? (e as Error).message}`;
  }
  rows.push({
    name: "bun:ffi kernel32 LockFileEx",
    total: 0,
    p50: 0,
    p90: 0,
    note,
  });
}

rmSync(dir, { recursive: true, force: true });

console.log(
  `PROFILE platform=${process.platform} bun=${Bun.version} cpus=${cpus().length}`,
);
for (const r of rows) {
  console.log(
    `PROFILE ${r.name.padEnd(38)} total=${String(r.total).padStart(6)}ms p50=${
      r.p50
    }ms p90=${r.p90}ms${r.note ? ` note=${r.note}` : ""}`,
  );
}

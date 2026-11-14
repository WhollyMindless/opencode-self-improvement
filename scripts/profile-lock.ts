// TEMPORARY diagnostic (Windows flake investigation, #407). Delete once the
// cause is attributed.
//
// Round 2. Round 1 proved two things: Bun on Windows ignores the
// UV_FS_O_EXLOCK bit (a second open of the same path succeeds, so the flag is
// decoration), and the suite's Windows penalty sits in directory churn (5x)
// rather than in lock acquire/release (2x).
//
// This round asks what primitives Bun DOES give us there, because the answer
// decides the fix. Rows print as they complete: the first version of this file
// buffered everything and a segfault in the FFI probe lost the whole run.
// Anything that can take the process down runs in a child (see
// scripts/profile-ffi.ts).
import {
  constants as FS,
  existsSync,
  mkdirSync,
  mkdtempSync,
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

function row(
  name: string,
  total: number,
  p50: number,
  p90: number,
  note?: string,
) {
  console.log(
    `PROFILE ${name.padEnd(38)} total=${String(total).padStart(6)}ms p50=${p50}ms p90=${p90}ms${
      note ? ` note=${note}` : ""
    }`,
  );
}

async function bench(
  name: string,
  n: number,
  fn: (i: number) => Promise<unknown>,
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
  row(
    name,
    Math.round(total),
    Math.round(each[Math.floor(n * 0.5)] ?? 0),
    Math.round(each[Math.floor(n * 0.9)] ?? 0),
  );
}

console.log(
  `PROFILE platform=${process.platform} bun=${Bun.version} cpus=${cpus().length}`,
);

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

// The delete-pending window itself: create, unlink, then measure how long the
// name stays visible. POSIX is 0 by construction; Windows owes us nothing.
{
  const each: number[] = [];
  let visible = 0;
  for (let i = 0; i < 200; i++) {
    const p = join(dir, `dp${i}.tmp`);
    writeFileSync(p, "x");
    unlink(p);
    const t0 = performance.now();
    while (existsSync(p) && performance.now() - t0 < 50) {
      // spin: how long does the name survive its own delete
    }
    each.push(performance.now() - t0);
    if (existsSync(p)) visible++;
  }
  each.sort((a, b) => a - b);
  row(
    "delete-pending visibility (200)",
    Math.round(each.reduce((a, b) => a + b, 0)),
    Math.round(each[100] ?? 0),
    Math.round(each[180] ?? 0),
    `still visible after 50ms: ${visible}`,
  );
}

// What does Bun's constants table actually contain here?
const interesting = Object.keys(FS)
  .filter((k) => /EXLOCK|SHLOCK|TEMPORARY|SHORT_LIVED|FILEMAP/.test(k))
  .map((k) => `${k}=0x${(FS as Record<string, number>)[k].toString(16)}`);
row(
  "fs.constants lock/temporary keys",
  0,
  0,
  0,
  interesting.join(" ") || "none",
);

// Candidates, win32 only.
if (process.platform === "win32") {
  const base = FS.O_CREAT | FS.O_RDWR | FS.O_NONBLOCK;
  for (const [label, bit] of [
    ["EXLOCK", UV_FS_O_EXLOCK_WIN],
    ["TEMPORARY", UV_FS_O_TEMPORARY_WIN],
    ["EXLOCK|TEMPORARY", UV_FS_O_EXLOCK_WIN | UV_FS_O_TEMPORARY_WIN],
  ] as const) {
    const flags = base | bit;
    const probe = join(dir, `probe-${label}.lock`);
    try {
      const a = await open(probe, flags, 0o600);
      let excludes: boolean;
      try {
        const b = await open(probe, flags, 0o600);
        await b.close();
        excludes = false;
      } catch {
        excludes = true;
      }
      await a.close();
      row(
        `${label} (win32 candidate)`,
        0,
        0,
        0,
        `excludes=${excludes} deletedOnClose=${!existsSync(probe)}`,
      );
    } catch (e) {
      row(
        `${label} (win32 candidate)`,
        0,
        0,
        0,
        `open failed: ${(e as Error & { code?: string }).code}`,
      );
    }
    rmSync(probe, { force: true });
  }
}

// Can we ask the OS whether a pid is alive? Answers "crashed holder", which is
// NOT the same question as "released holder" — see #407.
{
  const self = (() => {
    try {
      process.kill(process.pid, 0);
      return "ok";
    } catch (e) {
      return (e as Error & { code?: string }).code ?? "?";
    }
  })();
  const kid = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    encoding: "utf8",
  });
  let dead: string;
  try {
    process.kill(kid.pid ?? 0, 0);
    dead = "STILL_ANSWERS";
  } catch (e) {
    dead = (e as Error & { code?: string }).code ?? "?";
  }
  row("process.kill(pid,0)", 0, 0, 0, `self=${self} exited=${dead}`);
}

// SQLite as the lock manager (#407 decision): does WAL work here, and does it
// cost what it cost on macOS? Runs the same child-process probes so the
// comparison is like for like.
{
  const script = join(import.meta.dir, "profile-sqlite.ts");
  const sqDir = mkdtempSync(join(tmpdir(), "osi-sqlock-ci-"));
  const env = { ...process.env, OSI_SQLOCK_DIR: sqDir, OSI_JOURNAL: "wal" };
  const run = (mode: string) =>
    spawnSync(process.execPath, [script, mode], {
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
  for (const mode of ["self", "cost"]) {
    const r = run(mode);
    row(
      `sqlite ${mode} (wal)`,
      0,
      0,
      0,
      r.status === 0
        ? (r.stdout ?? "").trim()
        : `status=${r.status} signal=${r.signal ?? "-"} stderr=${(
            r.stderr ?? ""
          )
            .slice(0, 140)
            .replace(/\n/g, " ")}`,
    );
  }
  // Release on death: hold it in a child, SIGKILL the child, take it again.
  const holder = Bun.spawn([process.execPath, script, "hold"], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  let heldLine = "";
  try {
    const reader = holder.stdout.getReader();
    const { value } = await reader.read();
    if (value) heldLine = new TextDecoder().decode(value).trim();
  } catch {
    // the kill probe below still answers the question
  }
  holder.kill(9);
  await holder.exited;
  const after = run("probe");
  row(
    "sqlite release after SIGKILL",
    0,
    0,
    0,
    `holder=${heldLine || "no-output"} then ${
      after.status === 0
        ? (after.stdout ?? "").trim()
        : `status=${after.status}`
    }`,
  );
  rmSync(sqDir, { recursive: true, force: true });
}

rmSync(dir, { recursive: true, force: true });
console.log("PROFILE done");

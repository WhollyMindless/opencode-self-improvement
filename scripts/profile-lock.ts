// TEMPORARY diagnostic (Windows flake investigation, #407). Delete once the
// cause is attributed.
//
// `test-windows` runs the same suite as `test` and takes ~4x as long (median
// 132s vs 34s over 14 runs). This measures the primitives the suite actually
// pounds on, on whatever machine runs the job, so the gap is attributed to a
// syscall class instead of guessed at. Prints one line per measurement.
import { constants as FS, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

// UV_FS_O_EXLOCK from libuv's uv/win.h. Darwin's <fcntl.h> value is 0x20; glibc
// has no O_EXLOCK at all, so the flag is only attempted on win32.
const UV_FS_O_EXLOCK_WIN = 0x10000000;

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

await bench("open wx then unlink (no read)", N, async () => {
  const h = await open(lockPath, "wx", 0o600);
  await h.close();
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

// The setup/teardown shape every test file pays: a fresh directory, a few files,
// then a recursive delete.
await bench("mkdir+5 files+rmSync (test fixture)", 60, async (i) => {
  const d = join(dir, `fx${i}`);
  mkdirSync(d, { recursive: true });
  for (let k = 0; k < 5; k++) await writeFile(join(d, `f${k}.logfmt`), "row\n");
  rmSync(d, { recursive: true, force: true });
});

// Contended: the shape a parallel suite produces, 8 writers on one store file.
{
  const rounds = 40;
  const s = performance.now();
  for (let r = 0; r < rounds; r++) {
    await Promise.all(
      Array.from({ length: 8 }, () => withStoreLock(file, async () => 1)),
    );
  }
  const total = performance.now() - s;
  rows.push({
    name: "8-way contended lock (per round)",
    total: Math.round(total),
    p50: Math.round(total / rounds),
    p90: Math.round(total / rounds),
  });
}

// Candidate primitive: handle-scoped lock, released by close(), never deleted.
if (process.platform === "win32") {
  const flags =
    FS.O_CREAT | FS.O_TRUNC | FS.O_RDWR | FS.O_NONBLOCK | UV_FS_O_EXLOCK_WIN;
  const probe = join(dir, "exlock-probe");
  let works = false;
  try {
    const a = await open(probe, flags, 0o600);
    try {
      const b = await open(probe, flags, 0o600);
      await b.close();
      works = false; // second open succeeded: the flag does not exclude
    } catch {
      works = true;
    }
    await a.close();
  } catch (e) {
    works = false;
    rows.push({
      name: "EXLOCK open",
      total: 0,
      p50: 0,
      p90: 0,
      note: `open failed: ${(e as Error & { code?: string }).code}`,
    });
  }
  if (works) {
    await bench("EXLOCK open+close (candidate)", N, async () => {
      const h = await open(probe, flags, 0o600);
      await h.write("token");
      await h.close();
    });
  } else if (!rows.some((r) => r.name === "EXLOCK open")) {
    rows.push({
      name: "EXLOCK open+close (candidate)",
      total: 0,
      p50: 0,
      p90: 0,
      note: "DOES NOT EXCLUDE — unusable",
    });
  }
} else {
  rows.push({
    name: "EXLOCK open+close (candidate)",
    total: 0,
    p50: 0,
    p90: 0,
    note: "skipped: no O_EXLOCK on this platform",
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

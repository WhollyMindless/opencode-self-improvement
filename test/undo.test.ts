// Conflict-aware snapshot restore contract: a whole-file restore would clobber
// rows a CONCURRENT session promoted after the snapshot. Contract:
//   - check (default): refuse when the current file has rows added/changed
//     since the snapshot, listing them; file untouched;
//   - merge: restore the snapshot AND keep the divergent rows (superset);
//   - force: exact rollback (the pre-fix behavior, now opt-in);
//   - a bare snapshot name (as printed by list) resolves against snapshots/.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import { join } from "node:path";
import { memoryRoot } from "../src/config.ts";
import { snapshotFiles } from "../src/memory.ts";
import { restoreSnapshot } from "../src/undo.ts";
import { loadPlugin } from "./harness.ts";

const DAY = "2026-01-01";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-undo-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  mkdirSync(memoryRoot(), { recursive: true });
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
});

const store = () => join(memoryRoot(), `${DAY}.logfmt`);
const row = (n: number, extra = "") =>
  `ts=2026-01-01T00:00:0${n}.000Z type=learning scope=demo content="row ${n}"${extra}`;
const seed = (rows: string[]) => writeFileSync(store(), rows.join("\n") + "\n");
const lines = () => readFileSync(store(), "utf8").split("\n").filter(Boolean);

async function snapshotOfStore(): Promise<string> {
  const snaps = await snapshotFiles([store()]);
  expect(snaps.length).toBe(1);
  return snaps[0]!;
}

describe("restoreSnapshot modes", () => {
  test("clean file (no divergence): default check restores immediately", async () => {
    seed([row(1), row(2), row(3)]);
    const snap = await snapshotOfStore();
    const res = await restoreSnapshot(snap, memoryRoot());
    expect(res.restored).toBe(true);
    expect(lines()).toEqual([row(1), row(2), row(3)]);
  });

  test("concurrent rows: check refuses and leaves the file untouched", async () => {
    seed([row(1), row(2), row(3)]);
    const snap = await snapshotOfStore();
    // another session appends two rows after the snapshot
    seed([row(1), row(2), row(3), row(4), row(5)]);

    const res = await restoreSnapshot(snap, memoryRoot());
    expect(res.restored).toBe(false);
    expect(res.concurrentAdded).toEqual([
      "2026-01-01T00:00:04.000Z",
      "2026-01-01T00:00:05.000Z",
    ]);
    expect(lines().length).toBe(5); // file untouched
  });

  test("merge keeps the concurrent rows; force drops them", async () => {
    seed([row(1), row(2), row(3)]);
    const snap = await snapshotOfStore();
    seed([row(1), row(2), row(3), row(4), row(5)]);

    const merged = await restoreSnapshot(snap, memoryRoot(), "merge");
    expect(merged.restored).toBe(true);
    expect(lines()).toEqual([row(1), row(2), row(3), row(4), row(5)]);

    const forced = await restoreSnapshot(snap, memoryRoot(), "force");
    expect(forced.restored).toBe(true);
    expect(lines()).toEqual([row(1), row(2), row(3)]);
  });

  test("in-place edit after the snapshot counts as changed; merge keeps the edited row", async () => {
    seed([row(1), row(2), row(3)]);
    const snap = await snapshotOfStore();
    // another session stamps row 2 as superseded (in-place rewrite)
    seed([row(1), row(2, ' superseded_by="x" reason="drift"'), row(3)]);

    const refused = await restoreSnapshot(snap, memoryRoot());
    expect(refused.restored).toBe(false);
    expect(refused.concurrentChanged).toEqual(["2026-01-01T00:00:02.000Z"]);
    expect(refused.concurrentAdded).toEqual([]);

    const merged = await restoreSnapshot(snap, memoryRoot(), "merge");
    expect(merged.restored).toBe(true);
    expect(lines()).toEqual([row(1), row(2, ' superseded_by="x" reason="drift"'), row(3)]);
  });

  test("bare snapshot name (as printed by list) resolves against snapshots/", async () => {
    seed([row(1), row(2)]);
    const snap = await snapshotOfStore();
    seed([row(1), row(2), row(3)]);
    const res = await restoreSnapshot(basename(snap), memoryRoot(), "force");
    expect(res.restored).toBe(true);
    expect(lines()).toEqual([row(1), row(2)]);
  });

  test("missing snapshot still throws", async () => {
    await expect(restoreSnapshot("nope.logfmt", memoryRoot())).rejects.toThrow("snapshot not found");
  });
});

describe("memory_undo tool guidance", () => {
  test("refusal message names the divergent rows and both escape hatches", async () => {
    const p = await loadPlugin(root);
    seed([row(1), row(2)]);
    const snap = basename(await snapshotOfStore());
    seed([row(1), row(2), row(3)]);

    const refused = await p.tools.memory_undo!.execute({ snapshot: snap });
    expect(refused.content).toContain("Undo refused");
    expect(refused.content).toContain("2026-01-01T00:00:03.000Z");
    expect(refused.content).toContain("merge=true");
    expect(refused.content).toContain("force=true");
    expect(lines().length).toBe(3);

    const kept = await p.tools.memory_undo!.execute({ snapshot: snap, merge: true });
    expect(kept.content).toContain("Restored");
    expect(kept.content).toContain("Kept 1 added");
    expect(lines().length).toBe(3);

    p.cleanup();
  });
});

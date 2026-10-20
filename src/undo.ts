// Snapshot/rollback (/undo analog). Snapshots are written by memory.ts before
// any mutation; restore copies one back over its original file.
//
// Daily logfmt files are SHARED across concurrent sessions, so a naive
// whole-file write can silently clobber rows another session appended after
// the snapshot (live data loss observed 2026-10-20). Restore is therefore
// conflict-aware. The snapshot cannot tell "rows I added since the snapshot,
// which undo should remove" apart from "rows another session added, which
// must survive" — that call belongs to the caller, so the default mode CHECK
// refuses and lists the divergent rows; MERGE replays them on top of the
// snapshot; FORCE is the old exact rollback.
import { join, basename } from "node:path";
import { snapshotDir } from "./config.ts";
import { ensureDir } from "./logfmt.ts";

export interface SnapshotInfo {
  file: string;
  name: string;
  bytes: number;
  mtime: number;
}

export async function listSnapshots(): Promise<SnapshotInfo[]> {
  const glob = new Bun.Glob("*.logfmt");
  const out: SnapshotInfo[] = [];
  try {
    for await (const f of glob.scan(snapshotDir())) {
      const info = Bun.file(join(snapshotDir(), f));
      out.push({
        file: join(snapshotDir(), f),
        name: f,
        bytes: info.size,
        mtime: info.lastModified ?? 0,
      });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export type RestoreMode = "check" | "merge" | "force";

export interface RestoreResult {
  target: string;
  restored: boolean;
  mode: RestoreMode;
  // ts of rows present in the CURRENT file but absent from the snapshot
  // (added after it — or in-place edits, listed under their original ts).
  concurrentAdded: string[];
  concurrentChanged: string[];
}

// Rows are keyed by their ts= field; unparseable lines key on the whole line.
function rowKey(line: string): string {
  return line.match(/^ts=(\S+)/)?.[1] ?? line;
}

function rows(text: string): string[] {
  return text.split("\n").filter((l) => l.trim());
}

// Restore `snapshot` over its original file. The snapshot name is
// `<stamp>-<original>.logfmt`; strip the stamp to recover the target. A bare
// name (as printed by the list) resolves against <memory-root>/snapshots/.
export async function restoreSnapshot(
  snapshot: string,
  memoryRootDir: string,
  mode: RestoreMode = "check",
): Promise<RestoreResult> {
  const name = basename(snapshot);
  let snapPath = snapshot;
  if (!(await Bun.file(snapPath).exists())) {
    const candidate = join(memoryRootDir, "snapshots", name);
    if (await Bun.file(candidate).exists()) snapPath = candidate;
  }
  const f = Bun.file(snapPath);
  if (!(await f.exists())) throw new Error(`snapshot not found: ${snapshot}`);

  const original = name.replace(/^\d+-/, "");
  const target = join(memoryRootDir, original);
  const snapLines = rows(await f.text());
  const cur = Bun.file(target);
  const curLines = (await cur.exists()) ? rows(await cur.text()) : [];

  const snapByKey = new Map(snapLines.map((l) => [rowKey(l), l]));
  const concurrentAdded: string[] = [];
  const concurrentChanged: string[] = [];
  const curByKey = new Map<string, string>();
  for (const l of curLines) {
    const k = rowKey(l);
    curByKey.set(k, l);
    const s = snapByKey.get(k);
    if (s === undefined) concurrentAdded.push(k);
    else if (s !== l) concurrentChanged.push(k);
  }

  if (mode === "check" && (concurrentAdded.length || concurrentChanged.length)) {
    return { target, restored: false, mode, concurrentAdded, concurrentChanged };
  }

  let out = snapLines;
  if (mode === "merge") {
    // Keep the CURRENT version of rows the snapshot also has (in-place edits —
    // e.g. a supersede stamp — made after the snapshot win), then append the
    // rows the snapshot never saw. Merge is a deliberate superset: rows the
    // snapshotter wrote after the snapshot are NOT dropped here; choose FORCE
    // for that.
    out = snapLines.map((l) => curByKey.get(rowKey(l)) ?? l).concat(
      curLines.filter((l) => !snapByKey.has(rowKey(l))),
    );
  }
  await ensureDir(memoryRootDir);
  await Bun.write(target, out.length ? out.join("\n") + "\n" : "");
  return { target, restored: true, mode, concurrentAdded, concurrentChanged };
}

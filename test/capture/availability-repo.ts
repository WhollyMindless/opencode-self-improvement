// Throwaway git repos for the capture availability tests.
//
// A repo costs two `git` spawns, and on a Windows runner that spawn cost, not
// the matcher, decides whether these tests fit their timeout. So a repo is
// keyed by the bytes it tracks: cases sharing a passage share one directory.
// That keeps the isolation a per-case directory existed to guarantee — a
// candidate still cannot see a line its own tree does not contain, because the
// haystack is byte-identical — and it drops the spawn count from one per bank
// row to one per distinct passage.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availabilityIndex } from "../../src/capture/available.ts";

const root = mkdtempSync(join(tmpdir(), "osi-availability-repo-"));
const dirs = new Map<string, string>();

/** The bank's tracked passages, one entry per distinct set of tracked bytes.
 * Two cases with the same files present the same haystack to the same matcher,
 * so sweeping the union sweeps every sentence the per-row sweep swept. */
export function trackedPassages(
  cases: { tree: string; files?: Record<string, string> }[],
): Map<string, { tree: string; files?: Record<string, string> }> {
  const passages = new Map<
    string,
    { tree: string; files?: Record<string, string> }
  >();
  for (const c of cases) passages.set(repoKey(c.tree, c.files), c);
  return passages;
}

/** The index over exactly `tree` plus `files`, tracked in git. */
export function indexFor(
  tree: string,
  files?: Record<string, string>,
): ReturnType<typeof availabilityIndex> {
  const key = repoKey(tree, files);
  let dir = dirs.get(key);
  if (!dir) {
    dir = join(root, String(dirs.size));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), tree);
    for (const [path, content] of Object.entries(files ?? {})) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    // `--template=` skips copying the hook samples: three files read and
    // written per repo, and nothing here runs a hook.
    execFileSync("git", ["-C", dir, "init", "-q", "--template="], {
      stdio: "pipe",
    });
    execFileSync("git", ["-C", dir, "add", "."], { stdio: "pipe" });
    dirs.set(key, dir);
  }
  return availabilityIndex(dir);
}

function repoKey(tree: string, files?: Record<string, string>): string {
  return `${JSON.stringify(files ?? {})}\u0000${tree}`;
}

process.on("exit", () => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

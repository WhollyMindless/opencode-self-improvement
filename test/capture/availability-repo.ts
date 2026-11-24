// One base git repo per test process, one branch per distinct tracked set, and
// a cached index per branch.
//
// The matcher takes the tracked set from `git ls-files` and then reads those
// paths out of the working tree, so a reused repo has to present BOTH a
// matching index and a matching working tree at the moment it is read. So:
// every distinct tracked set in the fixture data becomes a branch, all of them
// written by ONE `git fast-import`, and a case gets `git checkout` of its
// branch immediately before its index is built — one git process per distinct
// passage instead of `init` plus `add`, and never a merged tree that would let
// a candidate match a different case's line.
//
// The index is then cached by tracked bytes, which is what actually saves the
// time: `availabilityIndex` lists the tracked files and reads every one of them
// before it returns, so the cached object is a full snapshot of that passage and
// stays correct after the working tree moves on to another branch. Cases share a
// snapshot only when their tracked bytes are identical.
//
// The checkout and the snapshot happen inside one synchronous call, so no other
// test can observe the working tree in a third branch's state. A linked
// worktree per passage was measured and rejected: `git worktree add` runs
// `update-ref` and `reset` as separate processes, 410 git spawns for both
// availability test files against 130 this way.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AVAILABILITY_CASES } from "../../bench/fixtures/availability-cases.ts";
import { availabilityIndex } from "../../src/capture/available.ts";

type Index = ReturnType<typeof availabilityIndex>;

const root = mkdtempSync(join(tmpdir(), "osi-availability-repo-"));
const base = join(root, "base");

const branches = new Map<string, string>();
const indexes = new Map<string, Index>();
let built = false;

function repoKey(tree: string, files?: Record<string, string>): string {
  return `${JSON.stringify(files ?? {})}\u0000${tree}`;
}

/** Every tracked set the bank can ask for: each case's files, and each case's
 * README on its own, because the sweep walks passages without the manifests. */
function trackedSets(): Map<
  string,
  { tree: string; files?: Record<string, string> }
> {
  const sets = new Map<
    string,
    { tree: string; files?: Record<string, string> }
  >();
  for (const c of AVAILABILITY_CASES) {
    sets.set(repoKey(c.tree), { tree: c.tree });
    sets.set(repoKey(c.tree, c.files), { tree: c.tree, files: c.files });
  }
  return sets;
}

/** Every branch, in one git process. `data` counts bytes, not UTF-16 units. */
function importBranches(
  sets: Map<string, { tree: string; files?: Record<string, string> }>,
): void {
  let stream = "";
  let n = 0;
  for (const [key, { tree, files }] of sets) {
    const branch = `p${n++}`;
    branches.set(key, branch);
    stream += `commit refs/heads/${branch}\ncommitter ocsi <ocsi@invalid> 0 +0000\ndata ${branch.length}\n${branch}\n`;
    const paths: [string, string][] = [["README.md", tree]];
    for (const [path, content] of Object.entries(files ?? {}))
      paths.push([path, content]);
    for (const [path, content] of paths) {
      stream += `M 100644 inline ${path}\ndata ${Buffer.byteLength(content, "utf8")}\n${content}`;
      if (!content.endsWith("\n")) stream += "\n";
    }
    stream += "\n";
  }
  git(["-C", base, "fast-import", "--quiet", "--done"], {
    input: `${stream}done\n`,
  });
}

function git(args: string[], options: object = {}): void {
  execFileSync("git", args, { stdio: "pipe", ...options });
}

/** The index over exactly `tree` plus `files`, tracked in git. */
export function indexFor(tree: string, files?: Record<string, string>): Index {
  const key = repoKey(tree, files);
  const cached = indexes.get(key);
  if (cached) return cached;
  if (!built) {
    mkdirSync(base, { recursive: true });
    git(["-C", base, "init", "-q", "--template="]);
    importBranches(trackedSets());
    built = true;
  }
  const branch = branches.get(key);
  let dir = base;
  if (branch === undefined) {
    // A passage the fixture data does not contain: its own repo, so the pin
    // still gets a tracked tree and the shared branch list stays untouched.
    dir = join(root, `x${indexes.size}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), tree);
    for (const [path, content] of Object.entries(files ?? {})) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git(["-C", dir, "init", "-q", "--template="]);
    git(["-C", dir, "add", "."]);
  } else {
    git(["-C", base, "checkout", "-q", branch]);
  }
  const index = availabilityIndex(dir);
  indexes.set(key, index);
  return index;
}

process.on("exit", () => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// Repo identity for memory scoping (issue #8). One plugin process serves one
// workspace, so the scope resolves ONCE at setup; every store write stamps
// it and every model-facing read filters by it.
//
// Two keys, both cheap, with opposite failure modes:
//   key  — sha1 of the normalized origin URL: survives re-clone, moves, and
//          export/import to another machine. Absent when the repo has no
//          origin (fresh or remote-less), where the path is used as the key.
//   path — resolved git toplevel: the secondary match, so rows stamped
//          before an origin was added keep recognizing their repo.
// Rows carry no stamp when their writer had no scope (viewer process,
// tests) and legacy rows predate the field: both read as GLOBAL — visible
// everywhere — which keeps every upgrade non-breaking.
import { createHash } from "node:crypto";

export interface RepoScope {
  key: string;
  path: string;
}

let current: RepoScope | null = null;

export function setRepoScope(scope: RepoScope | null): void {
  current = scope;
}

export function repoScope(): RepoScope | null {
  return current;
}

// git@github.com:Owner/Repo.git / https://GitHub.com/owner/repo/ ->
// github.com/owner/repo — the same repo must hash identically whichever
// remote form (and case) the clone used.
export function normalizeRemote(url: string): string {
  let u = url.trim().toLowerCase();
  u = u.replace(/^(?:https?:\/\/|ssh:\/\/|git:\/\/)/, "");
  u = u.replace(/^git@/, "");
  u = u.replace(/\/$/, "");
  u = u.replace(/\.git$/, "");
  // scp-style "github.com:owner/repo" -> slash form, so every transport of
  // one repo hashes to one id. (First colon only; URL ports in remotes are
  // rarer than the scp form and merely produce a stable different id.)
  u = u.replace(":", "/");
  return u;
}

function git(args: string[], cwd: string): string | null {
  try {
    const p = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "ignore" });
    const out = p.stdout?.toString().trim();
    return p.exitCode === 0 && out ? out : null;
  } catch {
    return null;
  }
}

// Resolve the current repo from any start dir (never throws; a non-git dir
// simply scopes by its own path).
export function resolveRepo(startDir: string): RepoScope {
  const path = git(["git", "rev-parse", "--show-toplevel"], startDir) ?? startDir;
  const remote = git(["git", "remote", "get-url", "origin"], path);
  const key = remote
    ? createHash("sha1").update(normalizeRemote(remote)).digest("hex").slice(0, 12)
    : path;
  return { key, path };
}

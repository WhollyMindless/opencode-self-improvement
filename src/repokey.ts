// Repo identity for memory scoping. A server process can host sessions from
// several workspaces, and setup() can run before the host attaches a session
// location — so identity is resolved PER SESSION from the event stream and
// falls back to the module scope (which itself may be null, never a guessed
// cwd). Every store write stamps it; every model-facing read filters by it.
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

// --- per-session identity -----------------------------------------------------
// Learned from session events (created / execution.started / moved). Bounded:
// a long-lived server must not grow this with every session ever seen.
const SESSION_CAP = 64;
const byDir = new Map<string, RepoScope>();
const bySession = new Map<string, { dir: string; scope: RepoScope }>();

function scopeForDir(dir: string): RepoScope {
  let s = byDir.get(dir);
  if (!s) {
    s = resolveRepo(dir);
    byDir.set(dir, s);
  }
  return s;
}

export function rememberSessionDir(sid: string, dir: string): void {
  const prev = bySession.get(sid);
  if (prev && prev.dir === dir) return;
  bySession.set(sid, { dir, scope: scopeForDir(dir) });
  while (bySession.size > SESSION_CAP) bySession.delete(bySession.keys().next().value as string);
}

export function sessionDir(sid?: string): string | undefined {
  if (!sid || sid === "?") return undefined;
  return bySession.get(sid)?.dir;
}

// The scope a write/read belongs to: the session's when known, else the
// module scope (null = unscoped process = global rows).
export function repoScopeFor(sid?: string): RepoScope | null {
  if (sid && sid !== "?") {
    const e = bySession.get(sid);
    if (e) return e.scope;
  }
  return current;
}

export function resetSessionScopes(): void {
  bySession.clear();
  byDir.clear();
}

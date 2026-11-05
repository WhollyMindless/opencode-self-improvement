// #305 (decision #212 A): viewer-originated evidence inherits the TARGET
// ROW's repository. The viewer is an admin entry point with no repository of
// its own, and its record() calls used to emit unstamped lines — which
// evidenceVisibleTo reads as GLOBAL. So editing or deleting another
// repository's private row from the viewer broadcast the operator's reason
// and row ids to every other repository's memory_evidence. GREEN: the line
// carries the target's stamp and is invisible to a stranger repo, visible to
// the target's repo and to the admin reader; an edit of a `repo=global` row
// still reads as global.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import {
  rememberSessionDir,
  resetSessionScopes,
  resolveRepo,
  setRepoScope,
} from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";
import { resetCaptureCooldowns } from "../src/index.ts";
import { evidenceDir, memoryRoot } from "../src/core/config/paths.ts";
import { dateStr } from "../src/core/time.ts";
import { formatLine, parseLine } from "../src/core/logfmt/format.ts";
import { editMemory } from "../src/viewer/mutate.ts";
import {
  ADMIN_READER,
  evidenceVisibleTo,
} from "../src/store/model/visibility.ts";

let root: string;
let a: string;
let b: string;
let plugins: LoadedPlugin[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-viewrepo-"));
  a = join(root, "repo-a");
  b = join(root, "repo-b");
  mkdirSync(a);
  mkdirSync(b);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  resetCaptureCooldowns();
  // Viewer-shaped process: no ambient repository, no session.
  setRepoScope(null);
  plugins = [];
});

afterEach(async () => {
  for (const p of plugins) await p.cleanup();
  plugins = [];
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function seed(ts: string, repo?: string, repoPath?: string): void {
  const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    formatLine({
      ts,
      type: "learning",
      scope: "auth",
      content: `seeded row (${repo ?? "unstamped"})`,
      repo,
      repoPath,
    }) + "\n",
  );
}

function evidenceLines(evName: string): Record<string, unknown>[] {
  return readFileSync(join(evidenceDir(), `${dateStr()}.logfmt`), "utf8")
    .trim()
    .split("\n")
    .map(parseLine)
    .filter((l): l is Record<string, unknown> => !!l && l.ev === evName);
}

test("viewer edit of a repo-B row is invisible to a repo-A memory_evidence, visible to B and admin (#305)", async () => {
  const scopeA = resolveRepo(a);
  const scopeB = resolveRepo(b);
  const T1 = "2026-01-05T00:00:00.000Z";
  seed(T1, scopeB.key, scopeB.path);
  // The viewer's own route handler calls editMemory directly; no session, no
  // repository scope — exactly the viewer-shaped process the defect lived in.
  await editMemory({
    ts: T1,
    type: "learning",
    scope: "auth",
    content: "edited row content",
    reason: "REPO_B_EDIT_REASON_305",
  });

  const line = evidenceLines("viewer_edit").find((f) =>
    String(f.reason).includes("REPO_B_EDIT_REASON_305"),
  );
  expect(line).toBeDefined();
  // The line must carry B's stamp. On main it is unstamped, which
  // evidenceVisibleTo below reads as global — RED for exactly the defect.
  expect(line!.repo).toBe(scopeB.key);
  expect(line!.repoPath).toBe(scopeB.path);
  expect(
    evidenceVisibleTo(line!, { kind: "repo", scope: scopeA }, "ses-a"),
  ).toBe(false);
  expect(
    evidenceVisibleTo(line!, { kind: "repo", scope: scopeB }, "ses-b"),
  ).toBe(true);
  expect(evidenceVisibleTo(line!, ADMIN_READER)).toBe(true);

  // Tool level: the real memory_evidence read path, repo-A session.
  const pa = await loadPlugin(a);
  const pb = await loadPlugin(b);
  plugins = [pa, pb];
  rememberSessionDir("ses-a", a);
  rememberSessionDir("ses-b", b);
  const resA = await pa.tools.memory_evidence.execute(
    { ev: "viewer_edit" },
    { sessionID: "ses-a", id: "evidence-a" },
  );
  expect(String((resA as { content?: string }).content ?? "")).not.toContain(
    "REPO_B_EDIT_REASON_305",
  );
  // B still reads its own audit trail — privacy, not loss.
  const resB = await pb.tools.memory_evidence.execute(
    { ev: "viewer_edit" },
    { sessionID: "ses-b", id: "evidence-b" },
  );
  expect(String((resB as { content?: string }).content ?? "")).toContain(
    "REPO_B_EDIT_REASON_305",
  );
});

test("viewer edit of a repo=global row still yields a globally visible line (#305)", async () => {
  const scopeA = resolveRepo(a);
  const T1 = "2026-01-05T00:00:00.000Z";
  seed(T1, "global");
  await editMemory({
    ts: T1,
    type: "learning",
    scope: "auth",
    content: "edited global row",
    reason: "GLOBAL_EDIT_REASON_305",
  });
  const line = evidenceLines("viewer_edit").find((f) =>
    String(f.reason).includes("GLOBAL_EDIT_REASON_305"),
  );
  expect(line).toBeDefined();
  expect(line!.repo).toBe("global");
  expect(
    evidenceVisibleTo(line!, { kind: "repo", scope: scopeA }, "ses-a"),
  ).toBe(true);
  const pa = await loadPlugin(a);
  plugins = [pa];
  rememberSessionDir("ses-a", a);
  const res = await pa.tools.memory_evidence.execute(
    { ev: "viewer_edit" },
    { sessionID: "ses-a", id: "evidence-a" },
  );
  expect(String((res as { content?: string }).content ?? "")).toContain(
    "GLOBAL_EDIT_REASON_305",
  );
});

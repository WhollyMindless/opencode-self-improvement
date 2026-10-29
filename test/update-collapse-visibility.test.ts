// #175: a duplicate survivor must be visible to the call's captured reader
// and preserve the target's visibility to other readers, including path fallback.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as evidence from "../src/evidence.ts";
import { appendMemory, isVisibleTo, loadAll, readerForSession, type Memory } from "../src/memory.ts";
import { rememberSessionDir, resetSessionScopes, resolveRepo, sessionScope, setRepoScope } from "../src/repokey.ts";
import { resetState } from "../src/state.ts";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";

const envKeys = ["OPENCODE_MEMORY_DIR", "OPENCODE_COMMANDS_DIR"] as const;
const oldProse = "Plan to rotate service certificates every Monday";
const newProse = "Plan to archive warehouse receipts every December";
const fields = { type: "context", scope: "planning", status: "open" as const };
const ctx = (sessionID: string) => ({ sessionID, id: "collapse-visibility" });
let savedEnv: Record<string, string | undefined>;
let root: string;
let a: string;
let b: string;
let plugins: LoadedPlugin[];
let restoreRecord: () => void;

function resetGlobals(): void {
  resetState();
  resetSessionScopes();
  setRepoScope(null);
}

beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), "osi-collapse-visibility-"));
  a = join(root, "checkout-a");
  b = join(root, "checkout-b");
  mkdirSync(a);
  mkdirSync(b);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  plugins = [];
  restoreRecord = () => {};
  resetGlobals();
});

afterEach(async () => {
  restoreRecord();
  for (const p of plugins) await p.cleanup();
  resetGlobals();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("osi-collapse-visibility-")) {
    throw new Error("Unexpected fixture cleanup target");
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function git(dir: string, ...args: string[]): void {
  const p = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
}

async function plugin(dir: string): Promise<LoadedPlugin> {
  const p = await loadPlugin(dir);
  plugins.push(p);
  return p;
}

async function remember(p: LoadedPlugin, sid: string, content: string, issue?: string): Promise<Memory> {
  const reply = await p.tools.memory_remember.execute({ ...fields, content, issue }, ctx(sid));
  expect(reply.content).toMatch(/^Remembered/);
  const row = (await loadAll()).find((m) => m.content === content);
  if (!row) throw new Error("Remembered row missing");
  return row;
}

async function sharedCheckouts() {
  for (const dir of [a, b]) {
    git(dir, "init", "--quiet");
    git(dir, "remote", "add", "origin", "https://example.invalid/visibility/shared.git");
  }
  const pa = await plugin(a);
  const pb = await plugin(b);
  const target = await remember(pa, "seed-a", oldProse);
  const survivor = await remember(pb, "seed-b", newProse);
  expect(target.repo).toBe(survivor.repo);
  expect(target.repoPath).not.toBe(survivor.repoPath);
  return { pa, pb, target, survivor };
}

function changeOrigin(): void {
  git(a, "remote", "set-url", "origin", "https://example.invalid/visibility/fork.git");
  // Model fresh host resolution after an origin change; directory scopes are cached.
  resetSessionScopes();
  rememberSessionDir("reader-a", a);
}

const update = (p: LoadedPlugin, target: string, sid = "writer") =>
  p.tools.memory_update.execute({ ...fields, query: target, content: newProse }, ctx(sid));
const recall = (p: LoadedPlugin) => p.tools.memory_recall.execute({ scope: fields.scope }, ctx("reader-a"));
async function row(ts: string): Promise<Memory> {
  const found = (await loadAll()).find((m) => m.ts === ts);
  if (!found) throw new Error(`Row missing: ${ts}`);
  return found;
}

function moveDuringGate(p: LoadedPlugin): () => boolean {
  const record = evidence.record;
  let moved = false;
  const spy = spyOn(evidence, "record").mockImplementation(async (...args: Parameters<typeof record>) => {
    if (args[0] === "gate_start" && !moved) {
      moved = true;
      // The real listener changes the binding during the gate's existing await.
      // No fabricated gate result or store mutation is involved.
      p.capture.events.push({
        type: "session.moved",
        location: { directory: a },
        data: { sessionID: "writer", location: { directory: b } },
      });
      const expected = resolveRepo(b);
      const deadline = Date.now() + 2000;
      while (sessionScope("writer")?.path !== expected.path) {
        if (Date.now() >= deadline) throw new Error("Session move was not delivered");
        await Bun.sleep(1);
      }
      expect(sessionScope("writer")).toEqual(expected);
    }
    return record(...args);
  });
  restoreRecord = () => spy.mockRestore();
  return () => moved;
}

test("same-origin checkouts with different paths do not fold even while both can read the survivor", async () => {
  const { pb, target, survivor } = await sharedCheckouts();
  const reply = await update(pb, target.ts);
  expect(reply.content).toContain("was NOT retired");
  expect(reply.content).toContain("repository path visibility differs");
  expect((await row(target.ts)).superseded_by).toBeUndefined();
  expect((await row(survivor.ts)).superseded_by).toBeUndefined();
  expect(reply.content).toContain(`memory_merge_review with loser="${target.ts}", survivor="${survivor.ts}"`);
  expect(reply.content).toContain("explicit reason");
  expect(reply.content).not.toContain("memory_forget");

  // An explicit choice may cross paths (#131); the suggested remedy must
  // retire exactly the named loser, not every row of this scope and type.
  const unrelated = await appendMemory({
    ...fields, content: "Plan to audit payroll each quarter", repo: target.repo, repoPath: target.repoPath,
  });
  const merged = await pb.tools.memory_merge_review.execute({
    loser: target.ts, survivor: survivor.ts, reason: "Explicitly keep the survivor's standing",
  }, ctx("writer"));
  expect(merged.content).toMatch(/^Resolved merge:/);
  expect((await row(target.ts)).superseded_by).toBe(survivor.ts);
  expect((await row(survivor.ts)).superseded_by).toBeUndefined();
  expect((await row(unrelated)).superseded_by).toBeUndefined();
});

test("a fold preserves another checkout's path-fallback recall after its origin changes", async () => {
  const { pa, pb, target, survivor } = await sharedCheckouts();
  changeOrigin();
  const reader = readerForSession("reader-a");
  expect(isVisibleTo(target, reader)).toBe(true);
  expect(isVisibleTo(survivor, reader)).toBe(false);
  expect((await recall(pa)).content).toContain(oldProse);

  const reply = await update(pb, target.ts);
  expect(reply.content).toContain("was NOT retired");
  expect(reply.content).toContain("repository path visibility differs");
  expect((await row(target.ts)).superseded_by).toBeUndefined();
  const after = await recall(pa);
  expect(after.content).toContain(oldProse);
  expect(after.content).not.toContain(newProse);
});

test("a session move cannot retire a target into an entry-invisible survivor", async () => {
  const { pa, target, survivor } = await sharedCheckouts();
  changeOrigin();
  rememberSessionDir("writer", a);
  expect(isVisibleTo(survivor, readerForSession("writer"))).toBe(false);
  const moved = moveDuringGate(pa);
  const reply = await update(pa, target.ts);
  expect(moved()).toBe(true);
  expect(reply.content).not.toContain(survivor.ts);
  expect((await row(target.ts)).superseded_by).toBeUndefined();
  expect((await recall(pa)).content).toContain(oldProse);
});

test("a session move cannot expose invisible survivor metadata in a refusal", async () => {
  const pa = await plugin(a);
  const pb = await plugin(b);
  const target = await remember(pa, "seed-a", oldProse);
  const survivor = await remember(pb, "seed-b", newProse, "PRIVATE-SURVIVOR-175");
  rememberSessionDir("writer", a);
  expect(isVisibleTo(survivor, readerForSession("writer"))).toBe(false);
  const moved = moveDuringGate(pa);
  const reply = await update(pa, target.ts);
  expect(moved()).toBe(true);
  expect(reply.content).not.toContain("PRIVATE-SURVIVOR-175");
  expect(reply.content).not.toContain(survivor.ts);
  expect((await row(target.ts)).superseded_by).toBeUndefined();
});

test.each([
  ["same private path", "private", "same", "same", true],
  ["absent and empty private paths", "private", undefined, "", true],
  ["absent target path", "private", undefined, "same", false],
  ["absent survivor path", "private", "same", undefined, false],
  ["explicit global rows", "global", "old-path", "other-path", true],
  ["legacy global target", undefined, "old-path", "other-path", true],
] as const)("collapse visibility: %s", async (_name, ownership, targetPath, survivorPath, folds) => {
  // Seed before setup so the legacy target has no ambient repository stamp.
  const repo = ownership === "private" ? resolveRepo(a).key : ownership;
  const target = await appendMemory({ ...fields, content: oldProse, repo, repoPath: targetPath });
  const survivor = await appendMemory({ ...fields, content: newProse, repo: repo ?? "global", repoPath: survivorPath });
  const pa = await plugin(a);
  const reply = await update(pa, target);
  if (folds) {
    expect(reply.content).toContain("was retired in its favor");
    expect((await row(target)).superseded_by).toBe(survivor);
  } else {
    expect(reply.content).toContain("was NOT retired");
    expect(reply.content).toContain("repository path visibility differs");
    expect((await row(target)).superseded_by).toBeUndefined();
  }
  expect((await row(survivor)).superseded_by).toBeUndefined();
});

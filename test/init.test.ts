// Init phase: memory_init tool behavior. Hermetic — the fixture dir is a plain
// (non-git) temp tree. The codebase-memory graph integration was removed
// (#231): nothing in src read the index back, so /repo-init spawns no external
// binary at all and the suite no longer needs a spawn spy or a fake binary.
// Scope = directory basename ("repo"), matching the repo-name convention.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugin } from "./harness.ts";
import { resetState } from "../src/core/state.ts";
import { loadAll } from "../src/store/files/load.ts";
import { isActive } from "../src/store/model/predicates.ts";

let memoryDir: string;
let fixture: string;
let root: string;
let init: { execute(args: { force?: boolean }): Promise<string> };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "osi-init-"));
  memoryDir = join(root, "memory");
  process.env.OPENCODE_MEMORY_DIR = memoryDir;
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  fixture = join(root, "repo");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "fixture-app",
      scripts: { test: "vitest run", lint: "eslint .", deploy: "x" },
    }),
  );
  resetState();
  const hooks = await loadPlugin(fixture);
  init = hooks.tool!.memory_init as never;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("memory_init", () => {
  test("writes script pattern memories + an init stamp", async () => {
    const out = await init.execute({});
    expect(out).toContain("Initialized repo");
    expect(out).toContain("npm run test");
    expect(out).toContain("npm run lint");

    const mems = (await loadAll()).filter(isActive);
    const patterns = mems.filter(
      (m) => m.type === "pattern" && m.scope === "repo",
    );
    expect(patterns.length).toBe(2);
    expect(patterns.every((m) => m.tags?.includes("init"))).toBe(true);

    const stamps = mems.filter((m) => m.tags?.includes("init-stamp"));
    expect(stamps.length).toBe(1);
    expect(stamps[0].content).toContain("repo=repo");
    expect(stamps[0].content).toContain("head=-");
  });

  test("no external binary is spawned: the graph integration is gone (#231)", async () => {
    // The whole point of the removal: /repo-init is local-only. A spy on
    // Bun.spawn proves no child process is launched for any argument set.
    const calls: string[][] = [];
    const original = Bun.spawn;
    Bun.spawn = ((cmd: string[]) => {
      calls.push([...cmd]);
      return original(cmd);
    }) as unknown as typeof Bun.spawn;
    try {
      await init.execute({});
      await init.execute({ force: true });
    } finally {
      Bun.spawn = original;
    }
    expect(calls).toEqual([]);
  });

  test("idempotent: second run is a no-op, no duplicate memories", async () => {
    await init.execute({});
    const out2 = await init.execute({});
    expect(out2).toContain("Already initialized");

    const mems = (await loadAll()).filter(isActive);
    expect(
      mems.filter((m) => m.type === "pattern" && m.scope === "repo").length,
    ).toBe(2);
    expect(mems.filter((m) => m.tags?.includes("init-stamp")).length).toBe(1);
  });

  test("force re-derives without duplicating", async () => {
    const out = await init.execute({ force: true });
    expect(out).not.toContain("Already initialized");

    const mems = (await loadAll()).filter(isActive);
    const patterns = mems.filter(
      (m) => m.type === "pattern" && m.scope === "repo",
    );
    expect(patterns.length).toBe(2);
    const stamps = mems.filter((m) => m.tags?.includes("init-stamp"));
    expect(stamps.length).toBe(1);
  });

  test("force with unchanged HEAD collapses everything", async () => {
    await init.execute({});
    const out = await init.execute({ force: true });
    expect(out).not.toContain("Already initialized");
    expect(out).toContain("written=0");
  });
});

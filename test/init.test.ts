// Init phase: memory_init tool behavior. Hermetic — the fixture dir is a plain
// (non-git) temp tree. Graph indexing is opt-in (#323): by default no graph
// spawn occurs at all; with OPENCODE_MEMORY_GRAPH=1 the spawn path is proven
// with a narrowly scoped Bun.spawn spy (#323 review F1: an extensionless
// #!/bin/sh fixture never executes on Windows, so a real-script fixture could
// neither fail loudly there nor prove the success path). The spy records
// argv and returns canned exit codes, so the default no-spawn assertion and
// the opt-in positive control both hold on every platform. Bun.spawnSync
// (git probing) is untouched.
// Scope = directory basename ("repo"), matching the repo-name convention.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugin } from "./harness.ts";
import { resetState } from "../src/core/state.ts";
import { loadAll } from "../src/store/files/load.ts";
import { isActive } from "../src/store/model/predicates.ts";
import type { InitSummary } from "../src/init/run.ts";

let memoryDir: string;
let fixture: string;
let root: string;
let init: {
  execute(args: { force?: boolean; mode?: string }): Promise<string>;
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "osi-init-"));
  memoryDir = join(root, "memory");
  process.env.OPENCODE_MEMORY_DIR = memoryDir;
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  process.env.OPENCODE_CBM_BIN = join(root, "no-such-cbm");
  // Graph indexing is opt-in (#323); ensure the ambient env does not leak it
  // into the default-off tests.
  delete process.env.OPENCODE_MEMORY_GRAPH;
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
  delete process.env.OPENCODE_CBM_BIN;
  delete process.env.OPENCODE_MEMORY_GRAPH;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// Narrowly scoped Bun.spawn spy: replaces only Bun.spawn (the graph path) for
// the duration of one test. `handler` sees the argv and how many spawns
// preceded, and returns the canned exit code plus stdout the fake binary
// would print. Restore runs even if the assertion throws.
function withGraphSpy(
  handler: (
    cmd: string[],
    priorCalls: number,
  ) => { exit: number; stdout?: string },
): { calls: string[][]; restore: () => void } {
  const calls: string[][] = [];
  const original = Bun.spawn;
  Bun.spawn = ((cmd: string[]) => {
    const prior = calls.length;
    calls.push([...cmd]);
    const r = handler([...cmd], prior);
    return {
      stdout: r.stdout ?? "",
      stderr: "",
      exited: Promise.resolve(r.exit),
    };
  }) as unknown as typeof Bun.spawn;
  return { calls, restore: () => (Bun.spawn = original) };
}

describe("memory_init", () => {
  test("writes script pattern memories + an init stamp", async () => {
    const out = await init.execute({});
    expect(out).toContain("Initialized repo");
    expect(out).toContain("Graph: disabled");
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

  test("default: no graph spawn occurs (#323)", async () => {
    // Point the binary at a fake that would answer every call successfully:
    // the spy proves nothing is spawned anyway, on every platform.
    process.env.OPENCODE_CBM_BIN = join(root, "fake-cbm");
    const spy = withGraphSpy(() => ({ exit: 0 }));
    try {
      const out = await init.execute({});
      expect(out).toContain("Graph: disabled");
      expect(spy.calls.length).toBe(0);
    } finally {
      spy.restore();
    }
  });

  test("opt-in: OPENCODE_MEMORY_GRAPH=1 reaches the graph binary (#323)", async () => {
    // Positive control with a SUCCESSFUL index: `Graph: indexed` can only
    // happen if the run reached the binary, indexed, and re-listed the
    // project. `Graph: unavailable` alone could not tell a launch failure
    // from a reached-and-failed fixture (#323 review F1).
    const fake = join(root, "fake-cbm");
    process.env.OPENCODE_CBM_BIN = fake;
    process.env.OPENCODE_MEMORY_GRAPH = "1";
    let indexed = false;
    const spy = withGraphSpy((cmd) => {
      if (cmd.includes("index_repository")) {
        indexed = true;
        return { exit: 0 };
      }
      // list_projects: the fixture root appears only after indexing.
      return {
        exit: 0,
        stdout: JSON.stringify({
          projects: indexed ? [{ name: "repo", root_path: fixture }] : [],
        }),
      };
    });
    try {
      const out = await init.execute({});
      expect(out).toContain("Graph: indexed (repo)");
      const indexCall = spy.calls.find((c) => c.includes("index_repository"));
      expect(indexCall?.[0]).toBe(fake);
      expect(indexCall?.[indexCall.indexOf("--repo-path") + 1]).toBe(fixture);
      expect(indexCall?.[indexCall.indexOf("--mode") + 1]).toBe("moderate");
    } finally {
      spy.restore();
    }
  });

  test("opt-in: a failing graph binary degrades to unavailable (#323)", async () => {
    const fake = join(root, "fake-cbm");
    process.env.OPENCODE_CBM_BIN = fake;
    process.env.OPENCODE_MEMORY_GRAPH = "1";
    const spy = withGraphSpy(() => ({ exit: 3 }));
    try {
      const out = await init.execute({});
      expect(out).toContain("Graph: unavailable");
      // The spawn was really attempted against the configured binary.
      expect(spy.calls.length).toBeGreaterThan(0);
      expect(spy.calls[0][0]).toBe(fake);
    } finally {
      spy.restore();
    }
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

  // Init mines repo-derived text: the scope is the checkout directory basename
  // and the command comes from the manifest. A clone directory named to match an
  // injection pattern used to promote with no quarantine tag and no provenance
  // marker, then ride into every later session of that repo (#302).
  test("a directory name matching an injection pattern quarantines the script row", async () => {
    const nasty = join(root, "eval (x)");
    mkdirSync(nasty, { recursive: true });
    writeFileSync(
      join(nasty, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    const loaded = await loadPlugin(nasty);
    const runInitTool = loaded.tool!.memory_init as never as {
      execute(args: Record<string, never>): Promise<string>;
    };
    const out = await runInitTool.execute({});
    expect(out).toContain("Initialized");

    const rows = (await loadAll()).filter(
      (m) => isActive(m) && m.type === "pattern",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const tags = row.tags ?? [];
      expect(tags).toContain("quarantine");
      expect(tags.some((t) => t.startsWith("quarantine:"))).toBe(true);
    }
    // The stamp interpolates the same basename, so it is screened too...
    const stamps = (await loadAll()).filter(
      (m) => isActive(m) && m.tags?.includes("init-stamp"),
    );
    expect(stamps.length).toBe(1);
    expect(stamps[0].tags).toContain("quarantine");
    // ...and screening does not break idempotency: init still reads its stamp.
    expect(await runInitTool.execute({})).toContain("Already initialized");
    await loaded.cleanup();
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

  test("mode passthrough; force with unchanged HEAD collapses everything", async () => {
    const out = await init.execute({ force: true, mode: "full" });
    expect(out).toContain("[mode=full]");
    const out2 = await init.execute({ force: true });
    expect(out2).not.toContain("Already initialized");
    expect(out2).toContain("written=0");
  });
});

describe("init internals", () => {
  test("gitRootOf/gitHead degrade on non-git dirs", async () => {
    const { gitRootOf, gitHead, detectScripts } = await import(
      "../src/init/detect.ts"
    );
    expect(await gitRootOf(fixture)).toBe(fixture);
    expect(await gitHead(fixture)).toBe("-");
    const recs = await detectScripts(fixture);
    expect(recs.map((r) => r.key).sort()).toEqual(["lint", "test"]);
  });

  // A package.json key is external text: a checkout can ship any string. The
  // row it produces is tagged init/package.json, so it carries no [via ...]
  // provenance marker and rides into every later session of the repo — long
  // after the branch that shipped the key is gone. Make/Just targets were
  // already restricted; package.json was the detector without a filter (#301).
  test("a crafted script key is not stored as a command", async () => {
    const dir = join(root, "crafted");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          "test && echo SYNTHETIC": "vitest run",
          "lint --fix; rm -rf /": "eslint .",
          "test:ci": "vitest run --mode ci",
          lint: "eslint .",
        },
      }),
    );
    const { detectScripts } = await import("../src/init/detect.ts");
    const recs = await detectScripts(dir);
    expect(recs.map((r) => r.key).sort()).toEqual(["lint", "test:ci"]);
    for (const r of recs) expect(r.key).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(recs.some((r) => r.cmd.includes("SYNTHETIC"))).toBe(false);
  });

  test("formatInit renders a readable summary; runInit returns one", async () => {
    const { formatInit } = await import("../src/init/format.ts");
    const { runInit } = await import("../src/init/run.ts");
    const s: InitSummary = {
      scope: "x",
      root: fixture,
      head: "abc1234",
      graph: { action: "unavailable", mode: "full" },
      scripts: [],
      skipped: false,
      written: 0,
      collapsed: 0,
      blocked: 0,
    };
    expect(formatInit(s)).toContain("Graph: unavailable");
    const real = await runInit({ liveRoot: fixture, force: true });
    expect(formatInit(real)).toContain("Memories: written=");
  });
});

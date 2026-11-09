// Init phase: memory_init tool behavior. Hermetic — the fixture dir is a plain
// (non-git) temp tree. The codebase-memory graph integration was removed
// (#231): nothing in src read the index back, so /repo-init spawns no external
// binary at all and the suite no longer needs a spawn spy or a fake binary.
// Scope = directory basename ("repo"), matching the repo-name convention.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugin } from "./harness.ts";
import { resetState } from "../src/core/state.ts";
import { record } from "../src/evidence/record.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { loadAll } from "../src/store/files/load.ts";
import { isActive } from "../src/store/model/predicates.ts";
import type { InitSummary } from "../src/init/run.ts";
import { stampDir } from "../src/init/stamp.ts";

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
  test("writes script pattern memories and a stamp FILE, and no stamp row", async () => {
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

    // #374: the stamp is plugin bookkeeping, not a memory. A row here was
    // forgeable by any session, so init writes a file under the memory root.
    expect(mems.some((m) => m.tags?.includes("init-stamp"))).toBe(false);
    const files = readdirSync(stampDir());
    expect(files.length).toBe(1);
    const stamp = JSON.parse(readFileSync(join(stampDir(), files[0]), "utf8"));
    expect(stamp.scope).toBe("repo");
    expect(stamp.head).toBe("-");
    expect(typeof stamp.ts).toBe("string");
    expect(typeof stamp.key).toBe("string");
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
    // The stamp is one file per repository (#374), never a row.
    expect(mems.some((m) => m.tags?.includes("init-stamp"))).toBe(false);
    expect(readdirSync(stampDir()).length).toBe(1);
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
    // #374: the stamp is a file, so the basename screen has no stamp row left to
    // tag — and screening the rows that ARE written still leaves init idempotent.
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
    expect(mems.some((m) => m.tags?.includes("init-stamp"))).toBe(false);
    expect(readdirSync(stampDir()).length).toBe(1);
  });

  test("force with unchanged HEAD collapses everything", async () => {
    await init.execute({});
    const out = await init.execute({ force: true });
    expect(out).not.toContain("Already initialized");
    expect(out).toContain("written=0");
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
      scripts: [],
      skipped: false,
      written: 0,
      collapsed: 0,
      blocked: 0,
    };
    expect(formatInit(s)).toContain("Initialized x");
    const real = await runInit({ liveRoot: fixture, force: true });
    expect(formatInit(real)).toContain("Memories: written=");
  });
});

// #374: the stamp used to be a `context` row tagged `init-stamp`. Any session
// could write one with memory_remember, name the current HEAD, and make every
// later memory_init answer "Already initialized" for that commit — the store
// talking to itself through a door a model can knock on. It is a file under the
// memory root now, read and written only by src/init/.
describe("init stamp is plugin state, not a memory (#374)", () => {
  test("a hand-written init-stamp row cannot suppress init", async () => {
    const ts = await appendMemory({
      type: "context",
      scope: "repo",
      content: "Init stamp: repo=repo, head=-, scripts=2",
      tags: ["init-stamp"],
    });
    expect(ts).toBeTruthy();

    const out = await init.execute({});
    expect(out).toContain("Initialized repo");
    expect(out).not.toContain("Already initialized");
    const mems = (await loadAll()).filter(isActive);
    expect(
      mems.filter((m) => m.type === "pattern" && m.scope === "repo").length,
    ).toBe(2);
  });

  test("a store row an init audited is honoured once and migrated to the file", async () => {
    // Exactly what the previous release left behind: the row, plus the
    // init_complete line naming it. The audit pairing is the provenance a row
    // cannot supply about itself.
    const ts = await appendMemory({
      type: "context",
      scope: "repo",
      content: "Init stamp: repo=repo, head=-, scripts=2",
      tags: ["init-stamp"],
    });
    await record(
      "init_complete",
      {
        scope: "repo",
        head: "-",
        scripts: 2,
        written: 2,
        collapsed: 0,
        blocked: 0,
        stamp: ts,
      },
      false,
    );

    const out = await init.execute({});
    expect(out).toContain("Already initialized");
    expect(out).toContain("migrated");

    const files = readdirSync(stampDir());
    expect(files.length).toBe(1);
    const stamp = JSON.parse(readFileSync(join(stampDir(), files[0]), "utf8"));
    expect(stamp.ts).toBe(ts);
    expect(stamp.head).toBe("-");

    // The migration leaves the old row alone, and the file now answers: a third
    // run is a plain no-op with no second migration.
    const again = await init.execute({});
    expect(again).toContain("Already initialized");
    expect(again).not.toContain("migrated");
  });

  test("a stamp file that cannot be parsed is no stamp at all", async () => {
    await init.execute({});
    const files = readdirSync(stampDir());
    expect(files.length).toBe(1);
    writeFileSync(join(stampDir(), files[0]), "{not json", "utf8");

    const out = await init.execute({});
    expect(out).toContain("Initialized repo");
    expect(out).not.toContain("Already initialized");
    // ...and the re-run repaired the file, so the next one is a no-op again.
    expect(await init.execute({})).toContain("Already initialized");
  });
});

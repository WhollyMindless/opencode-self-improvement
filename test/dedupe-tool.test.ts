// Dedup default ON through the real memory_recall handler. The unit
// suite pins dedupeWindow directly; without this file, hardcoding `0` at
// src/tools/recall.ts could pass CI while the shipped default silently
// stayed off — the exact failure mode the flag flip is meant to end.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryRoot } from "../src/core/config/paths.ts";
import { formatLine } from "../src/core/logfmt/format.ts";
import { resetState } from "../src/core/state.ts";
import { setRepoScope } from "../src/identity/repokey.ts";
import { loadPlugin } from "./harness.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-dedup-tool-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  // Isolate dedup: the query gate is a separate default-ON path with its own
  // suite (recall-gate.test.ts).
  process.env.OPENCODE_MEMORY_QUERY_GATE = "off";
  delete process.env.OPENCODE_MEMORY_DEDUP;
  delete process.env.OPENCODE_MEMORY_AMBIGUOUS;
  resetState();
  setRepoScope(null);
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_QUERY_GATE;
  delete process.env.OPENCODE_MEMORY_DEDUP;
  delete process.env.OPENCODE_MEMORY_AMBIGUOUS;
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  removeStore(root);
});

function seed(content: string, ts: string, scope = "release") {
  const day = "2026-01-01";
  const file = join(memoryRoot(), `${day}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    `${formatLine({
      ts,
      type: "learning",
      scope,
      content,
      status: "settled",
    })}\n`,
  );
}

// Same scope, Jaccard 6/7 ≈ 0.86 >= 0.8 on content tokens; the weekday is
// the only difference, so the newer row must take the slot (§17).
const FRIDAY =
  "the deploy runbook rotates the signing key every friday after the backup window";
const MONDAY =
  "the deploy runbook rotates the signing key every monday after the backup window";

describe("memory_recall dedup default", () => {
  test("by default, the near-copy is suppressed and the newer copy survives", async () => {
    seed(FRIDAY, "2026-01-01T00:00:00.000Z");
    seed(MONDAY, "2026-01-01T00:00:01.000Z");
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "deploy runbook signing key",
      limit: 5,
    });
    expect(out).toContain("every monday");
    expect(out).not.toContain("every friday");
    await loaded.cleanup();
  });

  test("OPENCODE_MEMORY_DEDUP=0 returns both copies", async () => {
    seed(FRIDAY, "2026-01-01T00:00:00.000Z");
    seed(MONDAY, "2026-01-01T00:00:01.000Z");
    process.env.OPENCODE_MEMORY_DEDUP = "0";
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "deploy runbook signing key",
      limit: 5,
    });
    expect(out).toContain("every monday");
    expect(out).toContain("every friday");
    await loaded.cleanup();
  });
});

// The pair that motivated the grouping rule, end to end: without this file the
// rule could pass its unit suite while the shipped tool still returned one
// command, or return both without ever saying why.
const BUILD =
  'BabylonDocs build command: run "npm run build" from the repo root (package.json).';
const BUILD_EXAMPLES =
  'BabylonDocs build:example-images command: run "npm run build:example-images" from the repo root (package.json).';

describe("memory_recall additive clash", () => {
  test("both commands return, with a line naming why", async () => {
    seed(BUILD, "2026-01-01T00:00:00.000Z", "BabylonDocs");
    seed(BUILD_EXAMPLES, "2026-01-01T00:00:01.000Z", "BabylonDocs");
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "BabylonDocs build command",
      limit: 5,
    });
    expect(out).toContain("npm run build");
    expect(out).toContain("npm run build:example-images");
    expect(out).toContain("AMBIGUOUS (BabylonDocs)");
    expect(out).toContain("neither supersedes the other");
    await loaded.cleanup();
  });

  test("OPENCODE_MEMORY_AMBIGUOUS=0 collapses the pair again", async () => {
    seed(BUILD, "2026-01-01T00:00:00.000Z", "BabylonDocs");
    seed(BUILD_EXAMPLES, "2026-01-01T00:00:01.000Z", "BabylonDocs");
    process.env.OPENCODE_MEMORY_AMBIGUOUS = "0";
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "BabylonDocs build command",
      limit: 5,
    });
    expect(out).toContain("npm run build:example-images");
    expect(out).not.toContain("AMBIGUOUS");
    await loaded.cleanup();
  });

  test("a corrected fact returns one row and no marker", async () => {
    // The marker is only for pairs that both hold. A stale row must not come
    // back wearing one.
    seed(FRIDAY, "2026-01-01T00:00:00.000Z");
    seed(MONDAY, "2026-01-01T00:00:01.000Z");
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "deploy runbook signing key",
      limit: 5,
    });
    expect(out).toContain("every monday");
    expect(out).not.toContain("every friday");
    expect(out).not.toContain("AMBIGUOUS");
    await loaded.cleanup();
  });
});

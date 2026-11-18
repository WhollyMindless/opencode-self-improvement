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
  resetState();
  setRepoScope(null);
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_QUERY_GATE;
  delete process.env.OPENCODE_MEMORY_DEDUP;
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  removeStore(root);
});

function seed(content: string, ts: string) {
  const day = "2026-01-01";
  const file = join(memoryRoot(), `${day}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    `${formatLine({
      ts,
      type: "learning",
      scope: "release",
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

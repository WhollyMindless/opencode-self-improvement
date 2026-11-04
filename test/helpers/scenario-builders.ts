// Scenario builders for setup sequences that were duplicated verbatim across
// test files (#228). These are fixtures, not coverage: each builder is called
// by two tests that assert genuinely different properties, so a change to the
// import path or the plan-row shape needs editing in one place while every
// test keeps its own clear failure message.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "bun:test";
import { memoryRoot } from "../../src/core/config/paths.ts";
import { appendMemory } from "../../src/store/files/append.ts";
import { resolveRepo } from "../../src/identity/repokey.ts";
import type { LoadedPlugin } from "../harness.ts";

// Seed the open plan row that the memory_update probes edit, stamped with the
// given repo's scope — the sequence update-partial-failure.test.ts and
// update-provenance.test.ts each repeated verbatim.
export async function seedPlanRow(
  dir: string,
  content: string,
  extra?: { tags?: string[]; issue?: string; kw?: string[] },
): Promise<string> {
  const scope = resolveRepo(dir);
  return appendMemory({
    type: "context",
    scope: "planning",
    content,
    status: "open",
    ...extra,
    repo: scope.key,
    repoPath: scope.path,
  });
}

// Export the live store, hop the file into a fresh store, and import it there.
// The hop copies the export in first because a store reads only from inside
// itself (#24) — the step actually moving a file to another machine involves.
// Returns the tool outputs plus the hop path so callers can re-import the same
// file. `beforeImport` grounds the session when the seeded rows are ref-free
// settled ones.
export async function roundTripThroughImport(
  loaded: LoadedPlugin,
  root: string,
  opts: { hopName?: string; beforeImport?: () => Promise<void> } = {},
): Promise<{ exportOut: string; hop: string; importOut: string }> {
  const exportOut = await loaded.tool.memory_export!.execute({});
  const file = exportOut.split(" -> ")[1]!;
  expect(existsSync(file)).toBe(true);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory2");
  mkdirSync(memoryRoot(), { recursive: true });
  const hop = join(memoryRoot(), opts.hopName ?? "hop.jsonl");
  copyFileSync(file, hop);
  if (opts.beforeImport) await opts.beforeImport();
  const importOut = await loaded.tool.memory_import!.execute({ file: hop });
  return { exportOut, hop, importOut };
}

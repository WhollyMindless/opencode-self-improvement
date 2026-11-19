// The test tree mirrors the src module layout: every module's behavior is
// pinned under `test/<module>/`, so a path tells you what a test covers.
// Modules covered cross-cuttingly (their behavior is pinned through the host
// or other modules' tests) must appear in the allowlist below; adding a src
// module without either a test directory or an allowlist entry fails here,
// which is what keeps the mapping from drifting back to a flat directory.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * src directories whose behavior is pinned outside a same-named test
 * directory: `core` through the host and every module's use of it, `tui`
 * through the terminal smoke suite in `e2e/`. An entry is stale the moment
 * `test/<module>/` with at least one test exists — remove it then.
 */
const COVERED_CROSS_CUTTING = new Set([
  "capture",
  "core",
  "gate",
  "identity",
  "inject",
  "recall",
  "store",
  "tui",
  "viewer",
]);

function srcModules(): string[] {
  return readdirSync(join(ROOT, "src"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function hasTests(module: string): boolean {
  const dir = join(ROOT, "test", module);
  return (
    existsSync(dir) &&
    readdirSync(dir).some((name) => name.endsWith(".test.ts"))
  );
}

describe("test layout", () => {
  test("every src module has a test directory or an allowlist entry", () => {
    const missing = srcModules().filter(
      (m) => !COVERED_CROSS_CUTTING.has(m) && !hasTests(m),
    );
    expect(missing).toEqual([]);
  });

  test("the allowlist names no module that has outgrown it", () => {
    const stale = [...COVERED_CROSS_CUTTING].filter(hasTests);
    expect(stale).toEqual([]);
  });

  test("the suite is looking at the real module set", () => {
    // A walk that finds nothing would make both checks above pass vacuously.
    expect(srcModules().length).toBeGreaterThan(5);
  });
});

// Each src module needs a matching test directory or a documented exception.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * Host and module tests exercise core. For tui, e2e/load.test.ts checks that
 * the packed entry compiles with the expected JSX runtime. Panel interactions
 * have no behavioral test here. Remove an exception when its test directory
 * gains a test.
 */
const LAYOUT_EXCEPTIONS = new Set(["core", "tui"]);

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
      (m) => !LAYOUT_EXCEPTIONS.has(m) && !hasTests(m),
    );
    expect(missing).toEqual([]);
  });

  test("the allowlist names no module that has outgrown it", () => {
    const stale = [...LAYOUT_EXCEPTIONS].filter(hasTests);
    expect(stale).toEqual([]);
  });

  test("the suite is looking at the real module set", () => {
    // A walk that finds nothing would make both checks above pass vacuously.
    expect(srcModules().length).toBeGreaterThan(5);
  });
});

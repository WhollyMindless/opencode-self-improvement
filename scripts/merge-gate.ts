#!/usr/bin/env bun
// Full merge gate: the exact sequence the CI jobs enforce (typecheck, lint,
// unit tests, terminal smoke + BDD integration against a real opencode host).
// The .githooks/pre-push hook runs this so a broken build never even reaches
// a PR; CI remains the authoritative gate via the required "smoke" check.
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

const steps: [string, string[]][] = [
  ["typecheck (tsc)", ["bunx", "tsc", "--noEmit", "-p", "tsconfig.json"]],
  ["lint (biome)", ["bunx", "biome", "lint"]],
  ["unit tests", ["bun", "test", "./test/"]],
  ["terminal smoke + BDD (real opencode host)", ["bun", "test", "./e2e/", "--timeout", "240000"]],
];

for (const [label, cmd] of steps) {
  console.log(`\n=== merge gate: ${label} ===`);
  const p = Bun.spawnSync(cmd, { cwd: REPO, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) {
    console.error(`\nmerge gate FAILED at: ${label}`);
    process.exit(p.exitCode ?? 1);
  }
}
console.log("\nmerge gate: all green");

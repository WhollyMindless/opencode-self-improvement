#!/usr/bin/env bun
// Full merge gate: the exact sequence the CI jobs enforce (typecheck, lint,
// unit tests, terminal smoke + BDD integration against a real opencode host).
// The .githooks/pre-push hook runs this so a broken build never even reaches
// a PR; CI remains the authoritative gate via the required "smoke" check.
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

const steps: [string, string[]][] = [
  ["typecheck (tsc)", ["bun", "x", "tsc", "--noEmit", "-p", "tsconfig.json"]],
  ["lint (biome)", ["bun", "x", "biome", "lint"]],
  ["unit tests", ["bun", "test", "./test/"]],
  ["terminal smoke + BDD (real opencode host)", ["bun", "test", "./e2e/", "--timeout", "240000"]],
];

// A pre-push hook runs with git's OWN environment exported — GIT_DIR,
// GIT_WORK_TREE, GIT_INDEX_FILE, GIT_PREFIX. Tests that assert a temp dir is
// NOT a git repo, or that resolve repo scope from the working tree, then see
// this repository instead of nothing. Measured: `test/init.test.ts` goes from
// 6/6 green to 2 failures on `GIT_DIR` alone, so every push looked like a
// broken build that was not. CI runs the same suite without these variables,
// so scrub them here — the gate has to measure the same tree in both places or
// its verdict means nothing.
const env: Record<string, string> = {};
let scrubbed = 0;
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue;
  if (/^GIT_/.test(k)) {
    scrubbed++;
    continue;
  }
  env[k] = v;
}
if (scrubbed) console.log(`(scrubbed ${scrubbed} GIT_* variables — running under a git hook)`);

for (const [label, cmd] of steps) {
  console.log(`\n=== merge gate: ${label} ===`);
  const p = Bun.spawnSync(cmd, { cwd: REPO, env, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) {
    console.error(`\nmerge gate FAILED at: ${label}`);
    process.exit(p.exitCode ?? 1);
  }
}
console.log("\nmerge gate: all green");

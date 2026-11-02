// The pre-push hook must not promise CI enforcement on a push (#236):
// ci.yml triggers on pull_request and workflow_dispatch only, so a direct
// push with SKIP_GATE=1 runs no CI at all.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hookPath = join(import.meta.dir, "..", ".githooks", "pre-push");

// A line that mentions CI and enforcement without negating it is the false
// promise, whatever its exact wording. Matching the claim (not one sentence)
// means a reworded hook cannot reintroduce it.
function falseCiClaims(text: string): string[] {
  return text
    .split("\n")
    .filter(
      (line) =>
        /\bCI\b/i.test(line) &&
        /enforc/i.test(line) &&
        !/\b(no|not|never|nothing)\b/i.test(line),
    );
}

test("hook text makes no un-negated CI-enforcement claim", () => {
  expect(falseCiClaims(readFileSync(hookPath, "utf8"))).toEqual([]);
});

test("hook text states the true consequence of skipping the gate", () => {
  const text = readFileSync(hookPath, "utf8");
  expect(text).toMatch(/no CI/i);
  expect(text).toMatch(/pull request/i);
});

test("skip path exits 0, mentions SKIP_GATE, promises nothing about CI", () => {
  const cwd = mkdtempSync(join(tmpdir(), "osi236-hook-"));
  try {
    const proc = Bun.spawnSync(["sh", hookPath], {
      cwd,
      env: { SKIP_GATE: "1", PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const out = proc.stdout.toString();
    expect(out).toContain("SKIP_GATE");
    expect(falseCiClaims(out)).toEqual([]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("non-skip path still runs the merge gate and fails closed (text pin)", () => {
  const text = readFileSync(hookPath, "utf8");
  expect(text).toMatch(/bun run gate/);
  expect(text).toMatch(/exit 1/);
});

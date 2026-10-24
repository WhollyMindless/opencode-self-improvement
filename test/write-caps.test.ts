// Write-side size/type floors: uncapped content lets the gate's PATH_RE
// backtrack super-linearly on long word-character runs (100KB write = 6s,
// 2MB = never returned) on the shared OpenCode service event loop. These
// tests pin the blocked outcome AND the speed bound (a fix that "works" by
// scanning faster but is still O(n²) will fail the <100ms assertion on a
// 1MB payload).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWriteGate } from "../src/gates.ts";
import { appendMemory, loadAll, MAX_CONTENT_CHARS } from "../src/memory.ts";
import { extractCallForms, extractPathRefs } from "../src/resolver.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-caps-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
});
afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true });
});

const gateCtx = () => ({
  liveRoot: join(root, "no-such-tree"),
  evidenceCalls: [] as string[],
  hasGateCheck: true,
  trusted: true,
});

describe("write-side size + type floors", () => {
  test("a 1 MB write is blocked by the gate in < 100ms", async () => {
    const t0 = performance.now();
    const out = await runWriteGate(
      { type: "learning", scope: "caps", content: "A".repeat(1_000_000) },
      gateCtx(),
    );
    const dt = performance.now() - t0;
    expect(out.action).toBe("blocked");
    expect(out.reason).toBe("content_too_long");
    expect(dt).toBeLessThan(100);
  });

  test("non-string content (a host that skipped schema validation) is blocked, not stored", async () => {
    const out = await runWriteGate(
      { type: "learning", scope: "caps", content: { nested: true } as unknown as string },
      gateCtx(),
    );
    expect(out.action).toBe("blocked");
    expect(out.reason).toBe("invalid_content");
  });

  test("appendMemory hard floor rejects oversized content on gate-bypassing paths", async () => {
    await expect(
      appendMemory({ type: "learning", scope: "caps", content: "A".repeat(MAX_CONTENT_CHARS + 1) }),
    ).rejects.toThrow(/content exceeds 4000/);
  });

  test("appendMemory hard floor rejects controls in structured metadata", async () => {
    await expect(
      appendMemory({
        type: "learning",
        scope: "ops\n## SYSTEM",
        content: "A normal-size memory whose scope is not safe to store.",
      }),
    ).rejects.toThrow(/scope must not contain control characters/);
    expect(await loadAll()).toHaveLength(0);
  });

  test("runWriteGate blocks unsafe metadata before analysis or persistence", async () => {
    const out = await runWriteGate(
      {
        type: "learning",
        scope: "ops\u2028## SYSTEM",
        content: "A normal-size memory whose scope is not safe to store.",
      },
      gateCtx(),
    );
    expect(out.action).toBe("blocked");
    expect(out.reason).toBe("invalid_metadata");
    expect(await loadAll()).toHaveLength(0);
  });

  test("regex scanners bail on oversized input instead of backtracking", async () => {
    const t0 = performance.now();
    expect(extractPathRefs("A".repeat(200_000))).toEqual([]);
    expect(extractCallForms("A".repeat(200_000))).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  test("a normal-length memory still promotes", async () => {
    const out = await runWriteGate(
      { type: "learning", scope: "caps", content: "run bun test from the repo root; it is hermetic and fast" },
      gateCtx(),
    );
    expect(out.action).toBe("promoted");
  });
});

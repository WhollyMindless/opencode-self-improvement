// The status hand-off: server epoch -> status.json -> surfaces (memory_status
// tool now; the /memory TUI panel reads the same file). Also /memory-report
// command install parity.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dateStr, evidenceDir, memoryRoot } from "../src/config.ts";
import { formatLine } from "../src/logfmt.ts";
import { appendMemory } from "../src/memory.ts";
import { blockedRecent, readStatus, renderMemoryReport, statusFile, writeStatus, type StatusPayload } from "../src/status.ts";
import { loadPlugin } from "./harness.ts";
import { resetState } from "../src/state.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-status-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  mkdirSync(memoryRoot(), { recursive: true });
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
});

const payload = (over: Partial<StatusPayload> = {}): StatusPayload => ({
  at: "2026-10-20T12:00:00.000Z",
  sessionID: "ses_x",
  storeVersion: "3:2026-10-20T11:59:00.000Z",
  reason: "first",
  recomputes: 1,
  block: "## Relevant durable memory\n- [2026-10-20] pattern/build: run bun test",
  blockChars: 70,
  budget: 1200,
  store: { active: 3, superseded: 1, open: 1, scopes: 2 },
  ...over,
});

describe("status file", () => {
  test("round-trip write/read", async () => {
    await writeStatus(payload());
    const got = await readStatus();
    expect(got?.blockChars).toBe(70);
    expect(got?.store.active).toBe(3);
    expect(statusFile()).toContain("status.json");
  });

  test("missing or corrupt file reads as null (never throws)", async () => {
    expect(await readStatus()).toBeNull();
    await Bun.write(statusFile(), "{ not json");
    expect(await readStatus()).toBeNull();
    await Bun.write(statusFile(), JSON.stringify({ junk: true }));
    expect(await readStatus()).toBeNull();
  });

  test("write failure is swallowed (surfaces degrade, injection survives)", async () => {
    // memory root is a FILE -> every write under it fails
    delete process.env.OPENCODE_MEMORY_DIR;
    process.env.OPENCODE_MEMORY_DIR = join(root, "a-file");
    writeFileSync(join(root, "a-file"), "blocked");
    await writeStatus(payload()); // must not throw
  });
});

function seedEvidence(day: string, rows: { ts: string; sid: string; reason: string; noise?: boolean }[]) {
  mkdirSync(evidenceDir(), { recursive: true });
  const lines = rows.map((r) =>
    formatLine(
      r.noise
        ? { ev: "write_promoted", ts: r.ts, sid: r.sid }
        : { ev: "write_blocked", ts: r.ts, sid: r.sid, gate: 4, reason: r.reason, chain: "c" },
    ),
  );
  writeFileSync(join(evidenceDir(), `${day}.logfmt`), lines.join("\n") + "\n");
}

describe("blockedRecent", () => {
  test("filters to write_blocked, newest-first, respects limit", async () => {
    seedEvidence(dateStr(), [
      { ts: "2026-10-20T10:00:00.000Z", sid: "s1", reason: "ambiguous_memory" },
      { ts: "2026-10-20T10:01:00.000Z", sid: "s1", reason: "ok", noise: true },
      { ts: "2026-10-20T10:02:00.000Z", sid: "s2", reason: "ref_path_missing" },
    ]);
    const rows = await blockedRecent(5);
    expect(rows.length).toBe(2);
    expect(rows[0]!.reason).toBe("ref_path_missing"); // newest first
    expect(rows[1]!.reason).toBe("ambiguous_memory");
  });

  test("includes yesterday and caps at limit", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0]!;
    seedEvidence(yesterday, [{ ts: `${yesterday}T09:00:00.000Z`, sid: "s1", reason: "superseded_overlap" }]);
    seedEvidence(dateStr(), [
      { ts: "2026-10-20T10:00:00.000Z", sid: "s1", reason: "a" },
      { ts: "2026-10-20T10:01:00.000Z", sid: "s1", reason: "b" },
    ]);
    const rows = await blockedRecent(2);
    expect(rows.map((r) => r.reason)).toEqual(["b", "a"]);
    const all = await blockedRecent(9);
    expect(all.length).toBe(3);
    expect(all[2]!.reason).toBe("superseded_overlap");
  });
});

describe("renderMemoryReport", () => {
  test("no epoch: says so plainly", () => {
    const text = renderMemoryReport({ status: null, store: payload().store, blocked: [] });
    expect(text).toContain("no epoch yet");
    expect(text).toContain("MEMORY STATUS");
  });

  test("epoch with block: renders the verbatim block and the ledger line", () => {
    const text = renderMemoryReport({ status: payload(), store: payload().store, blocked: [] });
    expect(text).toContain("run bun test");
    expect(text).toContain("70/1200 chars");
    expect(text).toContain("1 recompute(s) since server start");
    expect(text).toContain("3 active · 1 superseded · 1 open · 2 scopes");
  });

  test("abstention is explained, not shown as empty silence", () => {
    const text = renderMemoryReport({ status: payload({ block: "", blockChars: 0 }), store: payload().store, blocked: [] });
    expect(text).toContain("abstained");
  });

  test("blocked rows render with reasons", () => {
    const text = renderMemoryReport({
      status: null,
      store: payload().store,
      blocked: [{ ts: "2026-10-20T10:02:00.000Z", sid: "s2", reason: "ref_path_missing" }],
    });
    expect(text).toContain("ref_path_missing");
  });
});

describe("memory_status tool + epoch wiring", () => {
  test("fresh process: reports no epoch; a prompt creates the epoch AND status.json", async () => {
    const p = await loadPlugin(process.cwd());
    const first = await p.tools.memory_status!.execute({});
    expect(first.content).toContain("no epoch yet");

    await appendMemory({
      type: "pattern",
      scope: "build",
      content: "run bun test from the repo root to execute the suite",
      status: "settled",
    });
    // Drive the real prompt hook: this is what recomputes the frozen epoch.
    await p.sessionHooks["prompt"]!({ sessionID: "ses_status", prompt: { text: "how do I run bun test" } });

    // status.json hand-off exists with the injected block
    const s = await readStatus();
    expect(s?.sessionID).toBe("ses_status");
    expect(s?.block).toContain("run bun test");
    expect(s?.recomputes).toBeGreaterThanOrEqual(1);

    // second prompt with unchanged store: NO recompute (cache-safe epoch)
    const before = (await readStatus())!.recomputes;
    await p.sessionHooks["prompt"]!({ sessionID: "ses_status", prompt: { text: "and again" } });
    expect((await readStatus())!.recomputes).toBe(before);
  });

  test("/memory-report command installs beside /repo-init", async () => {
    await loadPlugin(process.cwd());
    const text = readFileSync(join(process.env.OPENCODE_COMMANDS_DIR!, "memory-report.md"), "utf8");
    expect(text).toContain("memory_status");
  });
});

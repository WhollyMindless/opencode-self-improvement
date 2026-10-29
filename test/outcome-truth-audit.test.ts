// Contracts from the maintainer review of #158 (CHANGES_REQUESTED), verified
// against a probe of this branch. (1) The collapse-completion added for #155
// convergence retired the named row into a survivor UNCONDITIONALLY — so an
// update whose prose duplicated a DIFFERENT live row destroyed the named row's
// issue link, keywords and OPEN standing, inverting #154's rule ("an update is
// built FROM the row it replaces") while reporting a clean no-op. The store's
// two rules must agree: GATE-3 says same-prose-different-metadata is an EDIT,
// so the fold may only retire when the survivor already carries what the named
// row carries — otherwise both ids are reported and a human decides. (2) The
// PARTIAL audit-fault handling reached only memory_update: a durable row with
// a failed write_promoted line let memory_remember, memory_import and
// auto-capture report a CLEAN success while memory_evidence — the place the
// message points the reader — showed nothing for the write.
//
// Hermetic: temp OPENCODE_MEMORY_DIR / OPENCODE_COMMANDS_DIR, no network, no
// real home directory.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dateStr, evidenceDir } from "../src/config.ts";
import * as evidence from "../src/evidence.ts";
import { appendMemory, isActive, loadAll } from "../src/memory.ts";
import { resetCaptureCooldowns } from "../src/index.ts";
import { EXPORT_HEADER, EXPORT_VERSION } from "../src/portable.ts";
import { resetSessionScopes, resolveRepo, setRepoScope } from "../src/repokey.ts";
import { resetState } from "../src/state.ts";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { parseLine, type Fields } from "../src/logfmt.ts";

let root: string;
let a: string;
let plugins: LoadedPlugin[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-outcome-"));
  a = join(root, "repo-a");
  mkdirSync(a);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  resetCaptureCooldowns(); // module-level since #108, and bun shares modules across files
  setRepoScope(null);
  plugins = [];
});

afterEach(async () => {
  for (const p of plugins) await p.cleanup();
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

async function plugin(dir: string, opts?: Record<string, unknown>): Promise<LoadedPlugin> {
  const p = await loadPlugin(dir, opts);
  plugins.push(p);
  return p;
}
function stampOf(dir: string): { repo: string; repoPath: string } {
  const s = resolveRepo(dir);
  return { repo: s.key, repoPath: s.path };
}
const ctx = (sessionID: string) => ({ sessionID, id: "outcome" });
const active = () => loadAll().then((ms) => ms.filter((m) => !m.superseded_by));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}
function evidenceLines(): Fields[] {
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => parseLine(l))
    .filter((f): f is Fields => f !== null);
}

describe("the collapse-completion keeps #154's rule", () => {
  test("a survivor that lacks the named row's metadata may not receive the fold — both ids are reported", async () => {
    // The review's probe shape: editing A (OPEN frontier thread, issue link,
    // keywords) with prose that happens to byte-equal a DIFFERENT live row B.
    // Retiring A into B silently leaves the frontier and destroys metadata no
    // call named; keeping both is merely two rows stating one fact, which a
    // human (or a follow-up update on the survivor) can resolve.
    const PROSE = "Session ledger snapshots ride the frozen epoch boundary";
    const pa = await plugin(a);
    const A = await appendMemory({
      type: "pattern",
      scope: "rev",
      content: `${PROSE}, refreshed after every write`,
      status: "open",
      issue: "GH-9001",
      kw: ["widget", "arm64"],
      ...stampOf(a),
    });
    const B = await appendMemory({
      type: "pattern",
      scope: "rev",
      content: PROSE,
      status: "settled",
      ...stampOf(a),
    });
    const out = await pa.tools.memory_update.execute(
      { type: "pattern", scope: "rev", query: A, content: PROSE },
      ctx("ses-fold"),
    );
    expect(out.content).toContain(A);
    expect(out.content).toContain(B);
    expect(out.content).toMatch(/NOT retired/);
    const rows = await loadAll();
    expect(isActive(rows.find((m) => m.ts === A)!)).toBe(true);
    expect(isActive(rows.find((m) => m.ts === B)!)).toBe(true);
    // It is a verdict, not a step: the retry reports the same fork.
    const retry = await pa.tools.memory_update.execute(
      { type: "pattern", scope: "rev", query: A, content: PROSE },
      ctx("ses-fold"),
    );
    expect(retry.content).toMatch(/NOT retired/);
    expect(await active()).toHaveLength(2);
  });

  test("when the survivor already carries the metadata, the fold still completes (control)", async () => {
    // The #155 convergence path must survive the guard: a retry whose rows
    // agree on standing, issue, tags and kw retires exactly as before.
    const PROSE = "Session ledger snapshots ride the frozen epoch boundary unchanged";
    const pa = await plugin(a);
    const A = await appendMemory({
      type: "pattern",
      scope: "revctl",
      content: `${PROSE} at all`,
      status: "open",
      ...stampOf(a),
    });
    const B = await appendMemory({
      type: "pattern",
      scope: "revctl",
      content: PROSE,
      status: "open",
      ...stampOf(a),
    });
    const out = await pa.tools.memory_update.execute(
      { type: "pattern", scope: "revctl", query: A, content: PROSE, status: "open" },
      ctx("ses-foldctl"),
    );
    expect(out.content).toMatch(/retired in its favor/);
    expect(out.content).toContain(B);
    const rows = await active();
    expect(rows).toHaveLength(1);
    expect(rows[0].ts).toBe(B);
  });
});

describe("a durable row with no audit line is never a clean success", () => {
  // The gate already refuses to throw past the append (#155); what was
  // missing was LISTENING to the flag on the other three writers.
  function unauditedSpy(): { restore: () => void } {
    const record = evidence.record;
    const spy = spyOn(evidence, "record").mockImplementation(async (...args: Parameters<typeof record>) => {
      if (args[0] === "write_promoted") throw new Error("simulated audit disk fault");
      return record(...args);
    });
    return { restore: () => spy.mockRestore() };
  }

  test("memory_remember reports the row it could not audit", async () => {
    const pa = await plugin(a);
    const spy = unauditedSpy();
    let out: { content: string };
    try {
      out = await pa.tools.memory_remember.execute(
        { type: "context", scope: "aud", content: "Imported vendor pricing sheet revision twelve", status: "open" },
        ctx("ses-ra"),
      );
    } finally {
      spy.restore();
    }
    expect(out.content).toMatch(/^Remembered/);
    expect(out.content).toMatch(/audit line was not recorded/);
    expect(out.content).toContain("simulated audit disk fault");
    // The row itself is durable — the caveat must not imply a failed write.
    expect(await active()).toHaveLength(1);
  });

  test("memory_import counts rows that landed without their audit line", async () => {
    const pa = await plugin(a);
    const future = (i: number) => new Date(Date.now() + 24 * 3600_000 + i).toISOString();
    writeFileSync(
      join(process.env.OPENCODE_MEMORY_DIR!, "audit-import.jsonl"),
      [
        JSON.stringify({
          _export: EXPORT_HEADER,
          version: EXPORT_VERSION,
          exportedAt: new Date().toISOString(),
          count: 2,
        }),
        JSON.stringify({
          ts: future(1),
          type: "learning",
          scope: "audimp",
          content: "Vendor contract renews each March with a ninety day notice window",
          status: "open",
        }),
        JSON.stringify({
          ts: future(2),
          type: "learning",
          scope: "audimp",
          content: "The warehouse escalates unsorted pallets after four failed reads",
          status: "open",
        }),
      ].join("\n") + "\n",
    );
    const spy = unauditedSpy();
    let out: { content: string };
    try {
      out = await pa.tools.memory_import.execute({ file: "audit-import.jsonl" }, ctx("ses-rb"));
    } finally {
      spy.restore();
    }
    expect(out.content).toContain("2 promoted");
    expect(out.content).toMatch(/without (their |an )?write_promoted audit line/);
    expect(out.content).toContain("simulated audit disk fault");
    expect(await active()).toHaveLength(2);
  });

  test("auto-capture marks its evidence line when the audit line fell", async () => {
    // Capture has no reply to caveat, and its own auto_capture_* line is a
    // SEPARATE record from the write_promoted line that failed — so without a
    // field pointing at the fault, the row's only trail omits that the trail
    // is incomplete.
    const loaded = await plugin(a, { autoCapture: true, captureModel: "fake/model" });
    await loaded["tool.execute.after"](
      { tool: "read", sessionID: "ses-rc", callID: "C1", args: { filePath: "x.ts" } },
      { title: "read", output: "content", metadata: {} },
    );
    loaded.capture.generate.response = JSON.stringify([
      {
        type: "learning",
        scope: "capaudit",
        content: "The nightly archive job runs at 02:30 UTC and keeps fourteen days of tarballs",
      },
    ]);
    const spy = unauditedSpy();
    try {
      await loaded.sessionHooks["compaction"]?.({
        sessionID: "ses-rc",
        system: [],
        messages: [
          {
            role: "user",
            content:
              "Note for the runbook that the nightly archive job runs at 02:30 UTC and keeps " +
              "fourteen days of tarballs for restore drills, and that the drill checklist " +
              "lives next to the restore script in the ops folder of the tooling repo.",
          },
          {
            role: "assistant",
            content:
              "Understood: 02:30 UTC nightly archive, fourteen days of tarballs retained, " +
              "drill checklist next to the restore script.",
          },
        ],
      });
      await waitFor(() => evidenceLines().some((l) => l.ev === "auto_capture_compaction_promoted"));
    } finally {
      spy.restore();
    }
    const line = evidenceLines().find((l) => l.ev === "auto_capture_compaction_promoted")!;
    expect(String(line.audit_error ?? "")).toContain("simulated audit disk fault");
  });
});

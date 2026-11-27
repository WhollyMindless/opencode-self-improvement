// Contract: a write the author marks session-scoped travels a volatile lane.
// The gate verdict says session-scoped, the evidence line records the incoming
// text, and nothing durable happens: no append, no authorship note, and no
// retirement of any row — not the numeric-conflict plan (the lane sits before
// it) and not the canonical/drift batches (a fact that dies at compaction may
// not be the tombstone of a row that outlives it). The lane sits after the
// collapse checks, so a fact the store already holds collapses first, and the
// grounding gates still apply: the flag relaxes durability, never grounding.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  afterTool,
  evidenceCalls,
  hasEngagement,
  hasGateCheck,
} from "../../src/capture/triggers.ts";
import { canonicalFile, memoryRoot } from "../../src/core/config/paths.ts";
import { formatLine } from "../../src/core/logfmt/format.ts";
import { resetState, setCurrent, authoredFor } from "../../src/core/state.ts";
import { runWriteGate, type WriteCandidate } from "../../src/gate/gate.ts";
import { rememberSessionDir } from "../../src/identity/repokey.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { isActive } from "../../src/store/model/predicates.ts";
import { ev, field, readEvidenceLog as evidence } from "../helpers/logfmt.ts";
import { removeStore } from "../helpers/remove-store.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-seclang-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
  lane.adds.length = 0;
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  removeStore(root);
});

// A stand-in for the injection controller's volatile map: the gate's contract
// is only "hand the accepted fact to the lane", so the lane itself is pinned
// in the epoch tests.
const lane = {
  adds: [] as { sid: string; content: string }[],
  addSessionFact(sid: string, content: string) {
    this.adds.push({ sid, content });
  },
};

let callN = 0;
// An engaged session write through the real gate — engagement is what lets an
// ungrounded-but-observed write promote at all, so the control (non-session)
// path must pass for the lane verdict to mean anything.
async function writeAs(
  sid: string,
  content: string,
  opts: { session?: boolean; scope?: string; engage?: boolean } = {},
) {
  rememberSessionDir(sid, liveRoot);
  const scope = opts.scope ?? "api";
  if (opts.engage !== false) {
    const probe = `C${++callN}`;
    setCurrent({ sessionID: sid, callID: probe, tool: "grep" });
    await afterTool(
      { tool: "grep", sessionID: sid, callID: probe, args: { pattern: scope } },
      { output: "1 match" },
    );
  }
  const candidate: WriteCandidate = { type: "context", scope, content };
  if (opts.session === true) candidate.session = true;
  return runWriteGate(candidate, {
    liveRoot,
    sessionID: sid,
    evidenceCalls: evidenceCalls(sid),
    hasGateCheck: hasGateCheck(sid),
    hasEngagement: hasEngagement(sid),
    sessionFacts: lane,
  });
}

async function seedRow(type: string, scope: string, content: string) {
  const out = await writeAs("ses-seeder", content, { scope });
  if (out.action !== "promoted")
    throw new Error(`seed write not promoted: ${out.action}`);
  return out.ts;
}

// Byte truth for the store: the daily row files, hashed whole. A volatile
// verdict must leave these bytes untouched, not merely the parsed count.
function storeBytes(): string {
  const hash = createHash("sha256");
  const days = readdirSync(memoryRoot())
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.logfmt$/.test(f))
    .sort();
  for (const f of days) hash.update(readFileSync(join(memoryRoot(), f)));
  return hash.digest("hex");
}

describe("the session-scoped lane", () => {
  test("a session-scoped write returns the volatile verdict and stores nothing", async () => {
    const out = await writeAs("ses-volatile", "Use 90 seconds for this run.", {
      session: true,
    });
    expect(out.action).toBe("session_scoped");
    expect(lane.adds).toEqual([
      { sid: "ses-volatile", content: "Use 90 seconds for this run." },
    ]);
    expect(await loadAll()).toHaveLength(0);
    expect(evidence().filter((l) => l.ev === "write_promoted")).toHaveLength(0);
    expect(evidence().filter((l) => l.ev === "write_blocked")).toHaveLength(0);
    const lines = ev(evidence(), "session_scoped");
    expect(lines).toHaveLength(1);
    expect(field(lines[0], "content")).toBe("Use 90 seconds for this run.");
    expect(field(lines[0], "scope")).toBe("api");
  });

  test("the same content without the flag still promotes (control)", async () => {
    const out = await writeAs("ses-durable", "Use 90 seconds for this run.");
    expect(out.action).toBe("promoted");
    expect(lane.adds).toHaveLength(0);
    expect((await loadAll()).filter(isActive)).toHaveLength(1);
  });

  test("a volatile verdict notes no authorship", async () => {
    await writeAs("ses-unauthored", "Retry the flaky suite once per push.", {
      session: true,
    });
    expect(authoredFor("ses-unauthored").size).toBe(0);
    const out = await writeAs("ses-authored", "Ship patches on Tuesdays.");
    expect(out.action).toBe("promoted");
    expect(authoredFor("ses-authored").size).toBe(1);
  });

  test("a value rivaling a durable row retires nothing", async () => {
    const seeded = await seedRow(
      "context",
      "api",
      "The default timeout is 30 seconds.",
    );
    lane.adds.length = 0;
    const bytesBefore = storeBytes();
    const out = await writeAs("ses-rival", "Use 90 seconds for this run.", {
      session: true,
    });
    expect(storeBytes()).toBe(bytesBefore);
    expect(out.action).toBe("session_scoped");
    const rows = await loadAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].ts).toBe(seeded);
    expect(rows[0].superseded_by).toBeUndefined();
    expect(evidence().filter((l) => l.ev === "superseded_by")).toHaveLength(0);
  });

  test("a canonical-matching volatile write neutralizes nothing", async () => {
    const old = await seedRow(
      "context",
      "planning",
      "The queue backend runs on redis today.",
    );
    writeFileSync(
      canonicalFile(),
      `${formatLine({
        ts: "2026-01-01T00:00:00.000Z",
        type: "canonical",
        scope: "planning",
        entity: "queue backend",
        value: "postgres",
        source: "fixture",
      })}\n`,
    );
    lane.adds.length = 0;
    const out = await writeAs("ses-canon", "The queue backend is postgres", {
      session: true,
      scope: "planning",
    });
    expect(out.action).toBe("session_scoped");
    const rows = await loadAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].ts).toBe(old);
    expect(rows[0].superseded_by).toBeUndefined();
    expect(evidence().filter((l) => l.ev === "superseded_by")).toHaveLength(0);
  });

  test("a durable canonical match does neutralize (control)", async () => {
    const old = await seedRow(
      "context",
      "planning",
      "The queue backend runs on redis today.",
    );
    writeFileSync(
      canonicalFile(),
      `${formatLine({
        ts: "2026-01-01T00:00:00.000Z",
        type: "canonical",
        scope: "planning",
        entity: "queue backend",
        value: "postgres",
        source: "fixture",
      })}\n`,
    );
    lane.adds.length = 0;
    const out = await writeAs(
      "ses-canon-durable",
      "The queue backend is postgres",
      {
        scope: "planning",
      },
    );
    expect(out.action).toBe("promoted");
    const rows = await loadAll();
    expect(rows.find((m) => m.ts === old)?.superseded_by).toBeTruthy();
  });

  test("the flag does not relax the grounding gates", async () => {
    const out = await writeAs(
      "ses-ungrounded",
      "The staging drain window opens at midnight.",
      { session: true, engage: false },
    );
    expect(out.action).toBe("blocked");
    expect(lane.adds).toHaveLength(0);
    expect(await loadAll()).toHaveLength(0);
  });

  test("global contradicts a write that stores nothing", async () => {
    rememberSessionDir("ses-global", liveRoot);
    const probe = `C${++callN}`;
    setCurrent({ sessionID: "ses-global", callID: probe, tool: "grep" });
    await afterTool(
      {
        tool: "grep",
        sessionID: "ses-global",
        callID: probe,
        args: { pattern: "api" },
      },
      { output: "1 match" },
    );
    const out = await runWriteGate(
      {
        type: "context",
        scope: "api",
        content: "Keep the canary green for this run.",
        repo: "global",
        session: true,
      },
      {
        liveRoot,
        sessionID: "ses-global",
        evidenceCalls: evidenceCalls("ses-global"),
        hasGateCheck: hasGateCheck("ses-global"),
        hasEngagement: hasEngagement("ses-global"),
        sessionFacts: lane,
      },
    );
    expect(out.action).toBe("blocked");
    if (out.action === "blocked") expect(out.reason).toContain("session");
    expect(lane.adds).toHaveLength(0);
    expect(await loadAll()).toHaveLength(0);
  });

  test("without a lane to hold it, a session write is refused, never stored", async () => {
    rememberSessionDir("ses-nolane", liveRoot);
    const probe = `C${++callN}`;
    setCurrent({ sessionID: "ses-nolane", callID: probe, tool: "grep" });
    await afterTool(
      {
        tool: "grep",
        sessionID: "ses-nolane",
        callID: probe,
        args: { pattern: "api" },
      },
      { output: "1 match" },
    );
    const out = await runWriteGate(
      {
        type: "context",
        scope: "api",
        content: "Hold the release train for this run.",
        session: true,
      },
      {
        liveRoot,
        sessionID: "ses-nolane",
        evidenceCalls: evidenceCalls("ses-nolane"),
        hasGateCheck: hasGateCheck("ses-nolane"),
        hasEngagement: hasEngagement("ses-nolane"),
      },
    );
    expect(out.action).toBe("blocked");
    expect(await loadAll()).toHaveLength(0);
  });

  test("an exact duplicate of a durable row collapses before the lane runs", async () => {
    const content = "The deploy gate runs make verify first.";
    await seedRow("context", "api", content);
    lane.adds.length = 0;
    const out = await writeAs("ses-dupe", content, { session: true });
    expect(out.action).toBe("collapsed");
    expect(lane.adds).toHaveLength(0);
    expect(evidence().filter((l) => l.ev === "session_scoped")).toHaveLength(0);
  });
});

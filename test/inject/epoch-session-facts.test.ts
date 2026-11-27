// Contract: a session-scoped fact (a memory_remember write carrying the
// session flag) rides only its author's delivered block. It lives in the
// injection controller's per-session volatile map: keyed by session, so an
// epoch rewrite that ADOPTS new bytes keeps it, and destroyed only by the
// epoch's death — compaction, session eviction, process exit. It never enters
// the store, the stable core, the fingerprint, or the use ledger, and every
// byte-move it causes is accounted as a prompt move. Because the facts are
// part of what the block is rendered from, a session holding BOTH a fact and
// a self-authored correction must still reproduce the frozen bytes of the
// held predecessor — pinned here in both arrival orders.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterTool } from "../../src/capture/triggers.ts";
import { memoryRoot } from "../../src/core/config/paths.ts";
import { type Fields, formatLine } from "../../src/core/logfmt/format.ts";
import { SESSION_CAP } from "../../src/core/lru.ts";
import { resetState } from "../../src/core/state.ts";
import { addBlock } from "../../src/store/blocklist.ts";
import { readLedger } from "../../src/telemetry/ledger.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { readStatus } from "../../src/status/write.ts";
import { startViewer } from "../../src/viewer/server.ts";
import { rememberSessionDir } from "../../src/identity/repokey.ts";
import { loadPlugin } from "../harness.ts";
import { readEvidenceLog } from "../helpers/logfmt.ts";
import { removeStore } from "../helpers/remove-store.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-sessfact-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  removeStore(root);
});

function seed(type: string, scope: string, content: string): string {
  const ts = new Date().toISOString();
  const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, formatLine({ ts, type, scope, content }) + "\n");
  return ts;
}

type Loaded = Awaited<ReturnType<typeof loadPlugin>>;

async function deliveredContextBlock(
  loaded: Loaded,
  sid: string,
): Promise<string> {
  const delivered: {
    sessionID: string;
    system: Array<{ type: string; text: string }>;
  } = { sessionID: sid, system: [] };
  await loaded.sessionHooks["context"]!(delivered);
  return delivered.system.map((p) => p.text).join("\n");
}

async function deliveredRelevanceBlock(
  loaded: Loaded,
  sid: string,
): Promise<string> {
  const delivered: {
    sessionID: string;
    system: Array<{ type: string; text: string }>;
  } = { sessionID: sid, system: [] };
  await loaded.sessionHooks["context"]!(delivered);
  return delivered.system
    .map((p) => p.text)
    .filter((t) => t.includes("## Relevant durable memory"))
    .join("\n");
}

async function deliveredBlock(
  loaded: Loaded,
  sid: string,
  text: string,
): Promise<string> {
  await loaded.sessionHooks["prompt"]!({ sessionID: sid, prompt: { text } });
  return deliveredContextBlock(loaded, sid);
}

function digestOf(system: string): string {
  const start = system.indexOf("## Persistent memory");
  if (start === -1) return "";
  const next = system.indexOf("\n## ", start + 5);
  return next === -1 ? system.slice(start) : system.slice(start, next);
}

let callN = 0;
async function sessionFact(
  loaded: Loaded,
  sid: string,
  content: string,
  scope = "run",
): Promise<string> {
  const call = `sf-${++callN}`;
  await afterTool(
    { tool: "grep", sessionID: sid, callID: call, args: { pattern: scope } },
    { output: "1 match" },
  );
  const res = await loaded.tools.memory_remember.execute(
    { type: "context", scope, content, session: true },
    { sessionID: sid, id: call },
  );
  return res.content;
}

function epochRecomputes(sid: string): Fields[] {
  return readEvidenceLog().filter(
    (l) => l.ev === "epoch_recompute" && String(l.session) === sid,
  );
}

async function updateDeployment(
  loaded: Loaded,
  sid: string,
  target: string,
  content: string,
): Promise<string> {
  const call = `update-${target}`;
  await afterTool(
    { tool: "grep", sessionID: sid, callID: call, args: { pattern: "deploy" } },
    { output: "1 match" },
  );
  const update = await loaded.tools.memory_update.execute(
    { type: "pattern", scope: "deploy", query: target, content },
    { sessionID: sid, id: call },
  );
  expect(update.content).toStartWith("Updated pattern in deploy");
  const rows = await loadAll();
  const successor = rows.find((row) => row.content === content);
  if (!successor) throw new Error("Expected a durable replacement");
  return successor.ts;
}

describe("session-scoped facts in the delivered block", () => {
  test("the reply says plainly that nothing was stored", async () => {
    const loaded = await loadPlugin(liveRoot);
    const reply = await sessionFact(
      loaded,
      "ses-reply",
      "Keep the soak timer at ninety seconds for this run.",
    );
    expect(reply).toMatch(/nothing was stored/i);
    expect(reply).toMatch(/session/i);
    expect(await loadAll()).toHaveLength(0);
    const schema = (
      loaded.tools.memory_remember as unknown as {
        input: { properties: Record<string, { type?: string }> };
      }
    ).input;
    expect(schema.properties.session?.type).toBe("boolean");
  });

  test("the fact rides its author's block, never a fresh session's", async () => {
    seed("pattern", "deploy", "Widget releases run from the trunk branch.");
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-author";
    const before = await deliveredBlock(loaded, sid, "widget releases trunk");
    const digestBefore = digestOf(before);
    await sessionFact(
      loaded,
      sid,
      "The soak timer stays at ninety seconds for this run only.",
    );
    const after = await deliveredContextBlock(loaded, sid);
    expect(after).toContain("ninety seconds for this run only");
    expect(digestOf(after)).toBe(digestBefore);
    const fresh = await deliveredBlock(
      loaded,
      "ses-fresh",
      "widget releases trunk",
    );
    expect(fresh).toContain("Widget releases run from the trunk branch.");
    expect(fresh).not.toContain("ninety seconds");
    expect((await readStatus("ses-fresh"))?.block).not.toContain(
      "ninety seconds",
    );
    // Evidence visibility is repo-scoped, not session-scoped: a sibling in
    // the author's repo can read the recorded text, and the sibling's own
    // counters show one plain epoch untouched by the fact.
    const sibling = await loaded.tools.memory_evidence.execute(
      { ev: "session_scoped" },
      { sessionID: "ses-fresh", id: "sib-ev" },
    );
    expect(sibling.content).toContain("ninety seconds for this run only");
    expect(epochRecomputes("ses-fresh").map((e) => e.reason)).toEqual([
      "first",
    ]);
    const reasons = epochRecomputes(sid).map((e) => e.reason);
    expect(reasons).toEqual(["first", "prompt_reveal"]);
    const status = await readStatus(sid);
    expect(status?.stats?.storeMoves).toBe(0);
    expect(status?.block).toContain("ninety seconds for this run only");
    // A repeat turn with no store and no fact change: identical bytes, no
    // new accounting line, no new evidence line, status unmoved.
    const repeat = await deliveredContextBlock(loaded, sid);
    expect(repeat).toBe(after);
    expect(epochRecomputes(sid)).toHaveLength(2);
    expect(
      readEvidenceLog().filter((l) => l.ev === "session_scoped"),
    ).toHaveLength(1);
    expect((await readStatus(sid))?.block).toBe(status?.block);
  });

  test("an identical re-send replaces in place; a rewording is its own key", async () => {
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-keys";
    await deliveredBlock(loaded, sid, "nightly cache warmup window");
    const first = "Warm the nightly cache at midnight for this run.";
    const second = "Warm the nightly cache at noon for this run only.";
    await sessionFact(loaded, sid, first);
    await sessionFact(loaded, sid, second);
    await sessionFact(loaded, sid, first);
    const block = await deliveredContextBlock(loaded, sid);
    expect(block.split(first).length - 1).toBe(1);
    expect(block.split(second).length - 1).toBe(1);
    expect(block.indexOf(first)).toBeLessThan(block.indexOf(second));
  });

  test("the per-session cap drops the oldest fact and the change is accounted", async () => {
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-cap";
    await deliveredBlock(loaded, sid, "partition maintenance schedule");
    const facts: string[] = [];
    for (let i = 1; i <= 17; i++) {
      const fact = `Partition ${i} reindex is allowed for this run.`;
      facts.push(fact);
      await sessionFact(loaded, sid, fact);
    }
    const block = await deliveredContextBlock(loaded, sid);
    expect(block).not.toContain(facts[0]);
    expect(block).toContain(facts[1]);
    expect(block).toContain(facts[16]);
    const reasons = epochRecomputes(sid).map((e) => e.reason);
    expect(reasons).toEqual(["first", "prompt_reveal"]);
    const status = await readStatus(sid);
    expect(status?.stats?.storeMoves).toBe(0);
    expect(status?.block).not.toContain(facts[0]);
    expect(status?.block).toContain(facts[16]);
    // Every accepted write logs one line; the eviction itself logs none.
    expect(
      readEvidenceLog().filter((l) => l.ev === "session_scoped"),
    ).toHaveLength(17);
  });

  test("adopting new epoch bytes keeps the session's facts", async () => {
    seed("pattern", "deploy", "Widget releases run from the trunk branch.");
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-adopt";
    const before = await deliveredBlock(loaded, sid, "widget releases trunk");
    await sessionFact(
      loaded,
      sid,
      "Freeze the trunk merge queue for this run.",
    );
    const withFact = await deliveredContextBlock(loaded, sid);
    expect(withFact).toContain("Freeze the trunk merge queue");
    expect(withFact).not.toBe(before);
    // A store change the model is never shown: a row outside the selection
    // moves the fingerprint, the rendered bytes do not, and the epoch adopts
    // them silently. Adoption is a rewrite of the epoch record — the facts
    // are keyed by session precisely so this rewrite cannot drop them.
    seed(
      "pattern",
      "helm",
      "The helm deploy renders chart templates for the production cluster.",
    );
    const afterAdopt = await deliveredContextBlock(loaded, sid);
    expect(afterAdopt).toContain("Freeze the trunk merge queue");
    expect(afterAdopt).toBe(withFact);
    const reasons = epochRecomputes(sid).map((e) => e.reason);
    expect(reasons).toEqual(["first", "prompt_reveal"]);
    const status = await readStatus(sid);
    expect(status?.stats?.storeMoves).toBe(0);
    expect(status?.block).toContain("Freeze the trunk merge queue");
    expect(
      readEvidenceLog().filter((l) => l.ev === "session_scoped"),
    ).toHaveLength(1);
  });

  test("compaction ends the session's facts", async () => {
    seed("pattern", "deploy", "Widget releases run from the trunk branch.");
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-compact";
    await deliveredBlock(loaded, sid, "widget releases trunk");
    await sessionFact(loaded, sid, "Skip the soak stage for this run.");
    expect(await deliveredContextBlock(loaded, sid)).toContain(
      "Skip the soak stage",
    );
    await loaded.sessionHooks["compaction"]?.({ sessionID: sid });
    const after = await deliveredBlock(loaded, sid, "widget releases trunk");
    expect(after).toContain("Widget releases run from the trunk branch.");
    expect(after).not.toContain("Skip the soak stage");
    // The durable half outlives the epoch: the line stays inspectable, the
    // rebuilt block and status carry no trace, and the fresh build is a
    // plain first epoch, not a fact move.
    const res = await loaded.tools.memory_evidence.execute(
      { ev: "session_scoped" },
      { sessionID: sid, id: "compact-ev" },
    );
    expect(res.content).toContain("Skip the soak stage");
    expect(epochRecomputes(sid).map((e) => e.reason)).toEqual([
      "first",
      "prompt_reveal",
      "first",
    ]);
    expect((await readStatus(sid))?.block).not.toContain("Skip the soak stage");
  });

  test.each(["fact first", "correction first"] as const)(
    "a session fact and a self-correction, %s, keep the held bytes stable",
    async (order) => {
      const old =
        "The widget deployment uses the blue release lane for staging.";
      const corrected =
        "The widget deployment uses the green release lane for staging.";
      const fact = "The staging drill pauses every release lane tonight.";
      const prompt =
        "Which release lane does the widget deployment use for staging?";
      const target = seed("pattern", "deploy", old);
      const loaded = await loadPlugin(liveRoot);
      const sid = `ses-hold-${order === "fact first" ? "a" : "b"}`;
      await deliveredBlock(loaded, sid, prompt);
      if (order === "correction first") {
        await updateDeployment(loaded, sid, target, corrected);
        expect(await deliveredContextBlock(loaded, sid)).toContain(old);
      }
      await sessionFact(loaded, sid, fact);
      const held = await deliveredContextBlock(loaded, sid);
      expect(held).toContain(fact);
      expect(held).toContain(old);
      expect(held).not.toContain(corrected);
      if (order === "fact first") {
        await updateDeployment(loaded, sid, target, corrected);
        const afterUpdate = await deliveredContextBlock(loaded, sid);
        expect(afterUpdate).toContain(fact);
        expect(afterUpdate).toContain(old);
        expect(afterUpdate).not.toContain(corrected);
      }
      // Re-rendering reproduces the frozen bytes: the counterfactual rebuild
      // sees the same facts the epoch was frozen with.
      expect(await deliveredContextBlock(loaded, sid)).toBe(held);
      const reasons = epochRecomputes(sid).map((e) => e.reason);
      expect(reasons).toEqual(["first", "prompt_reveal"]);
      const status = await readStatus(sid);
      expect(status?.stats?.storeMoves).toBe(0);
    },
  );

  test("a volatile fact never reaches the use ledger", async () => {
    seed("pattern", "deploy", "Widget releases run from the trunk branch.");
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-ledger";
    await deliveredBlock(loaded, sid, "zebrafish widget releases trunk");
    await sessionFact(
      loaded,
      sid,
      "The zebrafish habitat report ships after this deploy for this run.",
    );
    expect(await deliveredContextBlock(loaded, sid)).toContain("zebrafish");
    const ledger = await readLedger();
    expect([...ledger.byRow.keys()].every((id) => id.includes("T"))).toBe(true);
    let leaked = "";
    for (const [id, signal] of ledger.byRow) {
      if (signal.terms.some((t) => t.includes("zebrafish"))) leaked = id;
    }
    expect(leaked).toBe("");
  });

  test("memory_evidence reads the volatile verdict by event name", async () => {
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-evid";
    await sessionFact(
      loaded,
      sid,
      "The audit evidence line survives the fact for this run.",
    );
    const res = await loaded.tools.memory_evidence.execute(
      { ev: "session_scoped" },
      { sessionID: sid, id: "ev-1" },
    );
    expect(res.content).toContain("ev=session_scoped");
    expect(res.content).toContain("The audit evidence line survives");
  });

  test("a fresh controller starts the session without the facts and keeps the evidence", async () => {
    seed("pattern", "deploy", "Widget releases run from the trunk branch.");
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-restart";
    await deliveredBlock(loaded, sid, "widget releases trunk");
    await sessionFact(loaded, sid, "Hold the rollback button for this run.");
    expect(await deliveredContextBlock(loaded, sid)).toContain(
      "Hold the rollback button",
    );
    // A new plugin instance owns a new volatile map — what a process restart
    // does to in-process state is exactly this.
    const booted = await loadPlugin(liveRoot);
    const after = await deliveredBlock(booted, sid, "widget releases trunk");
    expect(after).toContain("Widget releases run from the trunk branch.");
    expect(after).not.toContain("Hold the rollback button");
    expect(epochRecomputes(sid).map((e) => e.reason)).toEqual([
      "first",
      "prompt_reveal",
      "first",
    ]);
    // The status snapshot is rewritten by the fresh build: the stale block
    // written before the restart, which did hold the fact, is replaced.
    expect((await readStatus(sid))?.block).not.toContain(
      "Hold the rollback button",
    );
    const res = await booted.tools.memory_evidence.execute(
      { ev: "session_scoped" },
      { sessionID: sid, id: "ev-restart" },
    );
    expect(res.content).toContain("Hold the rollback button");
  });

  test("evicting the session from the bounded cache drops its facts", async () => {
    seed("pattern", "sessions", "frozen epoch session cap sentinel");
    const loaded = await loadPlugin(liveRoot);
    const prompt = "find the frozen epoch session cap sentinel";
    const evicted = "ses-fact-cap-0";
    const kept = "ses-fact-cap-1";
    await deliveredBlock(loaded, evicted, prompt);
    await sessionFact(loaded, evicted, "Evict me with the session, please.");
    expect(await deliveredContextBlock(loaded, evicted)).toContain(
      "Evict me with the session",
    );
    const keptBlock = await deliveredBlock(loaded, kept, prompt);
    for (let i = 2; i <= SESSION_CAP; i++) {
      await deliveredBlock(loaded, `ses-fact-cap-${i}`, prompt);
      await deliveredContextBlock(loaded, kept);
    }
    expect(await deliveredRelevanceBlock(loaded, evicted)).toBe("");
    await loaded.sessionHooks["prompt"]!({
      sessionID: evicted,
      prompt: { text: prompt },
    });
    const after = await deliveredContextBlock(loaded, evicted);
    expect(after).toContain("session cap sentinel");
    expect(after).not.toContain("Evict me with the session");
    // first (initial epoch) -> prompt_reveal (the fact arrived) -> first
    // (eviction wiped the epoch; re-prompt builds a fresh one without it).
    expect(epochRecomputes(evicted).map((e) => e.reason)).toEqual([
      "first",
      "prompt_reveal",
      "first",
    ]);
    expect((await readStatus(evicted))?.block).not.toContain(
      "Evict me with the session",
    );
    expect(
      readEvidenceLog().filter((l) => l.ev === "session_scoped"),
    ).toHaveLength(1);
  });

  test("the fact stays off recall, the export file, and the viewer", async () => {
    seed("pattern", "deploy", "Widget releases run from the trunk branch.");
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-surfaces";
    await deliveredBlock(loaded, sid, "widget releases trunk");
    const needle = "vellum bureau rotation for this run";
    await sessionFact(loaded, sid, `The ${needle} only.`);
    expect(await deliveredContextBlock(loaded, sid)).toContain(needle);
    // The status report echoes the bytes its own session was delivered, so
    // the fact appears in the author's report and in no other session's.
    const st = await loaded.tools.memory_status.execute(
      {},
      { sessionID: sid, id: "st-call" },
    );
    expect(st.content).toContain(needle);
    await loaded.sessionHooks["prompt"]!({
      sessionID: "ses-surfaces-b",
      prompt: { text: "widget releases trunk" },
    });
    const stB = await loaded.tools.memory_status.execute(
      {},
      { sessionID: "ses-surfaces-b", id: "st-call-b" },
    );
    expect(stB.content).not.toContain(needle);
    const recall = await loaded.tools.memory_recall.execute(
      { query: needle },
      { sessionID: sid, id: "r-call" },
    );
    expect(recall.content).not.toContain(needle);
    const res = await loaded.tools.memory_export.execute(
      {},
      { sessionID: sid, id: "x-call" },
    );
    const path = res.content.split("-> ")[1]?.trim();
    if (!path) throw new Error(`export path missing: ${res.content}`);
    expect(readFileSync(path, "utf8")).not.toContain(needle);
    const vm = await startViewer(0);
    try {
      const data = await (await fetch(`${vm.url}/api/data`)).text();
      expect(data).not.toContain(needle);
    } finally {
      await vm.server.stop();
    }
  });

  test("a reader without visibility does not see the volatile verdict's line", async () => {
    const other = join(root, "other-repo");
    mkdirSync(other, { recursive: true });
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-owner";
    await sessionFact(loaded, sid, "Visible to the author repo only.");
    rememberSessionDir("ses-foreign", other);
    const foreign = await loaded.tools.memory_evidence.execute(
      { ev: "session_scoped" },
      { sessionID: "ses-foreign", id: "f-call" },
    );
    expect(foreign.content).toBe("No evidence");
    const own = await loaded.tools.memory_evidence.execute(
      { ev: "session_scoped" },
      { sessionID: sid, id: "o-call" },
    );
    expect(own.content).toContain("Visible to the author repo only.");
    // And it is not in the foreign session's delivered bytes either.
    expect(
      await deliveredBlock(loaded, "ses-foreign", "nothing relevant here"),
    ).not.toContain("Visible to the author repo only.");
    const foreignRecall = await loaded.tools.memory_recall.execute(
      { query: "Visible to the author repo only" },
      { sessionID: "ses-foreign", id: "f-recall" },
    );
    expect(foreignRecall.content).not.toContain("Visible to the author repo");
    expect((await readStatus("ses-foreign"))?.block).not.toContain(
      "Visible to the author repo only.",
    );
    const foreignExport = await loaded.tools.memory_export.execute(
      {},
      { sessionID: "ses-foreign", id: "f-export" },
    );
    expect(foreignExport.content).not.toContain("Visible to the author repo");
    expect(epochRecomputes("ses-foreign").map((e) => e.reason)).toEqual([
      "first",
    ]);
  });

  test("revoking an unrelated riding row keeps the fact and moves the block", async () => {
    const row = seed(
      "pattern",
      "deploy",
      "Widget releases run from the trunk branch.",
    );
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-revoke";
    await deliveredBlock(loaded, sid, "widget releases trunk");
    await sessionFact(loaded, sid, "Trunk freeze stays for this run.");
    const withBoth = await deliveredContextBlock(loaded, sid);
    expect(withBoth).toContain("Widget releases run from the trunk branch.");
    expect(withBoth).toContain("Trunk freeze stays");
    await addBlock(row, "withdraw old content");
    const after = await deliveredContextBlock(loaded, sid);
    expect(after).not.toContain("Widget releases run from the trunk branch.");
    expect(after).toContain("Trunk freeze stays");
    const reasons = epochRecomputes(sid).map((e) => e.reason);
    expect(reasons[reasons.length - 1]).toBe("store_changed");
    expect((await readStatus(sid))?.block).toContain("Trunk freeze stays");
    expect(
      readEvidenceLog().filter((l) => l.ev === "session_scoped"),
    ).toHaveLength(1);
  });

  test("a later durable write to the row the fact rivals keeps the fact riding", async () => {
    const row = seed(
      "pattern",
      "deploy",
      "The widget deployment uses the blue release lane for staging.",
    );
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-rival-write";
    await deliveredBlock(loaded, sid, "widget deployment release lane");
    await sessionFact(loaded, sid, "Staging drill pauses every lane tonight.");
    const before = await deliveredContextBlock(loaded, sid);
    expect(before).toContain("Staging drill pauses");
    await updateDeployment(
      loaded,
      "ses-other-writer",
      row,
      "The widget deployment uses the amber release lane for staging.",
    );
    const after = await deliveredContextBlock(loaded, sid);
    expect(after).toContain("amber release lane");
    expect(after).toContain("Staging drill pauses");
    const reasons = epochRecomputes(sid).map((e) => e.reason);
    expect(reasons[reasons.length - 1]).toBe("store_changed");
    expect((await readStatus(sid))?.stats?.storeMoves).toBe(1);
    expect((await readStatus(sid))?.block).toContain("Staging drill pauses");
    expect(
      readEvidenceLog().filter((l) => l.ev === "session_scoped"),
    ).toHaveLength(1);
  });
});

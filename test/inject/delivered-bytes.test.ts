// Contract: the bytes the host is handed each turn, and how a move of them is
// counted.
//
// The epoch's byte key decides how a move is ACCOUNTED. The system parts the
// context hook pushes are what the model actually receives, and the two are
// not the same surface: the relevance block rides the system channel with the
// stable core, so a turn whose selection set grows delivers different bytes
// even when the store never moved.
//
// This file pins the delivered bytes — the block arrives verbatim on the
// system channel, its bytes move with the selection set, the core bytes do
// not — and both halves of the accounting split: a prompt-driven move is a
// byte-moving epoch with no store move, and a write that reaches the block is
// both. How a moved byte inside the system channel is billed at the provider
// is not measured here, so no assertion here says it is.
//
// The block is delivered on the pre-split source too, so the byte assertions
// hold there by delivery, not by this change. The store-move count is the
// assertion that cannot hold before the split exists.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryRoot } from "../../src/core/config/paths.ts";
import { formatLine } from "../../src/core/logfmt/format.ts";
import { resetState } from "../../src/core/state.ts";
import { setRepoScope } from "../../src/identity/repokey.ts";
import { readStatus } from "../../src/status/write.ts";
import { loadPlugin } from "../harness.ts";
import { readEvidenceLog as evidence } from "../helpers/logfmt.ts";
import { removeStore } from "../helpers/remove-store.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-delivered-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  setRepoScope(null);
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  removeStore(root);
});

function seedAt(
  ts: string,
  type: string,
  scope: string,
  content: string,
): void {
  const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${formatLine({ ts, type, scope, content })}\n`);
}

type Loaded = Awaited<ReturnType<typeof loadPlugin>>;

function hook(loaded: Loaded, name: "context" | "prompt") {
  const fn = loaded.sessionHooks[name];
  if (!fn) throw new Error(`the plugin registered no ${name} hook`);
  return fn;
}

/** Every system part the plugin pushed onto one request, in push order. */
async function deliveredParts(
  loaded: Loaded,
  sid: string,
  text?: string,
): Promise<string[]> {
  if (text !== undefined) {
    await hook(loaded, "prompt")({ sessionID: sid, prompt: { text } });
  }
  const delivered: {
    sessionID: string;
    system: Array<{ type: string; text: string }>;
  } = {
    sessionID: sid,
    system: [],
  };
  await hook(loaded, "context")(delivered);
  return delivered.system.map((p) => p.text);
}

// The relevance block is the one part the selector writes; everything else on
// the channel is the stable core (standing digest + frontier + convergence).
const BLOCK_HEAD = "## Relevant durable memory";
const blockOf = (parts: string[]): string =>
  parts.filter((t) => t.includes(BLOCK_HEAD)).join("\n");
const coreOf = (parts: string[]): string =>
  parts.filter((t) => !t.includes(BLOCK_HEAD)).join("\u0000");
const bytesOf = (parts: string[]): number =>
  parts.reduce((n, t) => n + t.length, 0);

function recomputeReasons(sid: string): string[] {
  return evidence()
    .filter((l) => l.ev === "epoch_recompute" && String(l.session) === sid)
    .map((l) => String(l.reason));
}

const ROW_A = "The proto build runs make proto from the repo root.";
const ROW_B = "The helm deploy runs make helm with charts.";
const ROW_OMEGA = "The proto omega cut runs make omega from the release lane.";
const PROMPT_A = "proto alpha build make";
const PROMPT_AB = "proto beta deploy helm make";

describe("the bytes handed to the host each turn", () => {
  test("the relevance block rides the system channel verbatim", async () => {
    seedAt("2026-10-01T09:00:00.000Z", "pattern", "build", ROW_A);
    seedAt("2026-10-05T09:00:00.000Z", "pattern", "deploy", ROW_B);
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-delivered-channel";

    const parts = await deliveredParts(loaded, sid, PROMPT_A);
    const blocks = parts.filter((t) => t.includes(BLOCK_HEAD));
    // One block part, on the system channel, carrying this turn's row.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain(ROW_A);
    expect(blocks[0]).not.toContain(ROW_B);
    // Delivered verbatim: the bytes the surfaces report are the bytes pushed.
    const status = await readStatus(sid);
    expect(status?.block).toBe(blocks[0]);
    expect(bytesOf(parts)).toBe(status?.sectionChars ?? 0);
  });

  test("a growing set moves the delivered block while the store does not move", async () => {
    seedAt("2026-10-01T09:00:00.000Z", "pattern", "build", ROW_A);
    seedAt("2026-10-05T09:00:00.000Z", "pattern", "deploy", ROW_B);
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-delivered-growth";

    const before = await deliveredParts(loaded, sid, PROMPT_A);
    const after = await deliveredParts(loaded, sid, PROMPT_AB);

    // The core bytes held; the delivered block did not. The row the new
    // prompt needs is in what the model is shown, so this is freshness, not
    // drift.
    expect(coreOf(after)).toBe(coreOf(before));
    expect(blockOf(after)).not.toBe(blockOf(before));
    expect(blockOf(after)).toContain(ROW_B);
    expect(bytesOf(after)).toBeGreaterThan(bytesOf(before));

    // The reason records which input moved: the store fingerprint did not.
    expect(recomputeReasons(sid)).toEqual(["first", "prompt_reveal"]);
    const status = await readStatus(sid);
    expect(status?.stats?.invalidations ?? 0).toBe(1);
    expect(status?.stats?.storeMoves).toBe(0);
  });

  test("a write that reaches the block moves both counts", async () => {
    seedAt("2026-10-01T09:00:00.000Z", "pattern", "build", ROW_A);
    seedAt("2026-10-05T09:00:00.000Z", "pattern", "deploy", ROW_B);
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-delivered-write";

    const before = await deliveredParts(loaded, sid, PROMPT_AB);
    seedAt(new Date().toISOString(), "pattern", "release", ROW_OMEGA);
    const after = await deliveredParts(loaded, sid, PROMPT_AB);

    // A store write is still delivered: the split is an account, not a freeze.
    expect(after.join("\u0000")).not.toBe(before.join("\u0000"));
    expect(blockOf(after)).toContain(ROW_OMEGA);
    expect(bytesOf(after)).toBeGreaterThan(bytesOf(before));
    expect(recomputeReasons(sid)).toEqual(["first", "store_changed"]);
    const status = await readStatus(sid);
    expect(status?.stats?.storeMoves).toBe(1);
    expect(status?.stats?.invalidations ?? 0).toBe(1);
    expect(status?.stats?.lastInvalidation?.reason).toBe("store_changed");
  });
});

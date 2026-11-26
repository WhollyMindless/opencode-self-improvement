// Contract: the stable core rides the prompt cache; only the turn tail moves.
//
// The injected memory block busts the prompt cache when the selection SET
// changes. The epoch's cache key is the stable core alone — the digest parts
// (standing digest + frontier + convergence, prompt-independent by
// construction) joined. The prompt-dependent tail (the relevance block) is
// delivered per turn and never busts the prefix, so a set-growth turn keeps
// the same bytes and records no invalidation.
//
// This file pins that case: a turn whose selection set grows must NOT move
// the stable core, the new row must still be delivered (stability is not
// staleness), and no invalidation may fire.
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
import { removeStore } from "../helpers/remove-store.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-stable-core-"));
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

async function deliveredContextBlock(
  loaded: Loaded,
  sid: string,
): Promise<string> {
  const delivered: {
    sessionID: string;
    system: Array<{ type: string; text: string }>;
  } = {
    sessionID: sid,
    system: [],
  };
  await hook(loaded, "context")(delivered);
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
  await hook(loaded, "prompt")({ sessionID: sid, prompt: { text } });
  return deliveredContextBlock(loaded, sid);
}

async function deliveredSystem(loaded: Loaded, sid: string): Promise<string> {
  const delivered: {
    sessionID: string;
    system: Array<{ type: string; text: string }>;
  } = {
    sessionID: sid,
    system: [],
  };
  await hook(loaded, "context")(delivered);
  return delivered.system.map((p) => p.text).join("\n");
}

// The stable core: the digest section, everything before the relevance block.
// Byte-identical prefixes are what the provider's cache keys on; the block
// below them is the turn tail.
function digestOf(system: string): string {
  const start = system.indexOf("## Persistent memory");
  if (start === -1) return "";
  const next = system.indexOf("\n## ", start + 5);
  return next === -1 ? system.slice(start) : system.slice(start, next);
}

// The ticket's Scenario A shape: two rows, a prompt that selects the first,
// then a prompt that selects both — the set grows without the store moving.
const ROW_A = "The proto build runs make proto from the repo root.";
const ROW_B = "The helm deploy runs make helm with charts.";
const PROMPT_A = "proto alpha build make";
const PROMPT_AB = "proto beta deploy helm make";

describe("the stable core does not move on a set-growth turn", () => {
  test("a turn whose selection set grew keeps the identical prefix", async () => {
    seedAt("2026-10-01T09:00:00.000Z", "pattern", "build", ROW_A);
    seedAt("2026-10-05T09:00:00.000Z", "pattern", "deploy", ROW_B);
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-growth";

    const blockA = await deliveredBlock(loaded, sid, PROMPT_A);
    expect(blockA).toContain(ROW_A);
    expect(blockA).not.toContain(ROW_B);
    const coreA = digestOf(await deliveredSystem(loaded, sid));

    const blockAB = await deliveredBlock(loaded, sid, PROMPT_AB);
    // The new row is delivered: stability is not staleness.
    expect(blockAB).toContain(ROW_A);
    expect(blockAB).toContain(ROW_B);

    // The prefix never moved: the stable core is byte-identical, only the
    // tail (the relevance block) changed.
    expect(digestOf(await deliveredSystem(loaded, sid))).toBe(coreA);

    // No invalidation fired for the growth turn — only the store-changing
    // half of the AC may.
    const status = await readStatus(sid);
    expect(status?.stats?.invalidations ?? 0).toBe(0);
  });
});

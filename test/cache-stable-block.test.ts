// Contract (#388): the bytes that ride the prompt cache do not move when the
// RANKING moves.
//
// The epoch's cache key is the rendered memory section joined onto the system
// parts (src/inject/epochs.ts). Anything in those bytes that depends on the
// current prompt re-bills the prefix. Row CONTENT is prompt-independent; row
// ORDER was not — scoreMemories ranks by overlap with the live prompt, so two
// turns that selected the same rows in a different rank order produced
// different bytes and told the model nothing new.
//
// Proves: re-ranking does not move the bytes and does not recompute an epoch;
// a prompt that needs a row the stable block does not carry still receives it
// (stability must not become staleness); a store change still busts; and the
// rendered order is canonical rather than score-derived.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryRoot } from "../src/core/config/paths.ts";
import { injectedRows } from "../src/inject/budget.ts";
import { formatMemory } from "../src/inject/format.ts";
import { formatLine, type Fields } from "../src/core/logfmt/format.ts";
import { resetState } from "../src/core/state.ts";
import { setRepoScope } from "../src/identity/repokey.ts";
import { selectRelevant } from "../src/recall/relevant.ts";
import { loadPlugin } from "./harness.ts";
import { readEvidenceLog as evidence } from "./helpers/logfmt.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-cacheblk-"));
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
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function seedAt(
  ts: string,
  type: string,
  scope: string,
  content: string,
): void {
  const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, formatLine({ ts, type, scope, content }) + "\n");
}

type Loaded = Awaited<ReturnType<typeof loadPlugin>>;

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

function epochRecomputes(sid: string): Fields[] {
  return evidence().filter(
    (l) => l.ev === "epoch_recompute" && String(l.session) === sid,
  );
}

// Two rows that BOTH prompts select, with the ranking inverted between them.
// The shared rare term `widget` clears the relevance gate for both rows under
// either prompt; the discriminating terms decide the rank, and they differ.
const OLDER = "2026-10-01T09:00:00.000Z";
const NEWER = "2026-10-05T09:00:00.000Z";
const ROW_OLD = "The widget alpha build runs make all from the repo root.";
const ROW_NEW = "The widget beta deploy runs make deploy with helm.";
const PROMPT_ALPHA = "widget alpha build make";
const PROMPT_BETA = "widget beta deploy helm make";

describe("re-ranking does not move the cache-critical bytes", () => {
  test("two prompts that rank the same rows differently render identically", async () => {
    seedAt(OLDER, "pattern", "build", ROW_OLD);
    seedAt(NEWER, "pattern", "deploy", ROW_NEW);

    const a = await selectRelevant(PROMPT_ALPHA, 5);
    const b = await selectRelevant(PROMPT_BETA, 5);
    // Precondition: the ranking really is inverted, otherwise this test proves
    // nothing about order and would pass on a fixture that never varied.
    expect(a.selected[0]?.content).toBe(ROW_OLD);
    expect(b.selected[0]?.content).toBe(ROW_NEW);
    expect(a.block).toBe(b.block);
  });

  test("the rendered order is canonical (newest first), not score order", async () => {
    seedAt(OLDER, "pattern", "build", ROW_OLD);
    seedAt(NEWER, "pattern", "deploy", ROW_NEW);
    const { block } = await selectRelevant(PROMPT_ALPHA, 5);
    expect(block.indexOf(ROW_NEW)).toBeLessThan(block.indexOf(ROW_OLD));
  });

  test("a re-rank does not recompute an epoch, so the prefix is not re-billed", async () => {
    seedAt(OLDER, "pattern", "build", ROW_OLD);
    seedAt(NEWER, "pattern", "deploy", ROW_NEW);
    const loaded = await loadPlugin(liveRoot);

    const first = await deliveredBlock(loaded, "ses-rerank", PROMPT_ALPHA);
    expect(first).toContain(ROW_OLD);
    const reranked = await deliveredBlock(loaded, "ses-rerank", PROMPT_BETA);
    expect(reranked).toBe(first);

    const recomputes = epochRecomputes("ses-rerank");
    expect(recomputes.length).toBe(1);
    expect(String(recomputes[0].reason)).toBe("first");
  });
});

describe("stability is not staleness", () => {
  test("a prompt needing a row the current block does not carry still receives it", async () => {
    seedAt(OLDER, "pattern", "build", ROW_OLD);
    seedAt(NEWER, "pattern", "deploy", ROW_NEW);
    const loaded = await loadPlugin(liveRoot);

    const first = await deliveredBlock(
      loaded,
      "ses-stale",
      "widget alpha build make",
    );
    expect(first).toContain(ROW_OLD);
    // A prompt about a row that is NOT in the riding block must pull it in.
    // A block frozen at session start would pass the test above and fail here.
    const moved = await deliveredBlock(
      loaded,
      "ses-stale",
      "widget beta deploy helm chart values",
    );
    expect(moved).toContain(ROW_NEW);
    expect(moved).not.toBe(first);
    const reasons = epochRecomputes("ses-stale").map((r) => String(r.reason));
    expect(reasons).toEqual(["first", "prompt_reveal"]);
  });

  test("a store change still busts, with store_changed taking precedence", async () => {
    seedAt(OLDER, "pattern", "build", ROW_OLD);
    const loaded = await loadPlugin(liveRoot);
    await deliveredBlock(loaded, "ses-store", "widget alpha build make");

    seedAt(
      new Date().toISOString(),
      "pattern",
      "build",
      "The widget gamma release runs make gamma.",
    );
    const after = await deliveredBlock(
      loaded,
      "ses-store",
      "widget alpha build make",
    );
    expect(after).toContain("make gamma");
    const reasons = epochRecomputes("ses-store").map((r) => String(r.reason));
    expect(reasons[reasons.length - 1]).toBe("store_changed");
  });
});

// The canonical render order has one consequence that must not be lost: under
// budget pressure, the newest row is now FIRST, so capping the rendered string
// would drop the oldest row — the opposite of what a relevance block should do.
// The budget therefore has to be applied to the priority order, before the
// re-order.
describe("budget pressure keeps relevance, not recency", () => {
  const ROW_MID = "2026-10-03T09:00:00.000Z";
  test("who rides is decided by priority, and the survivors render newest first", async () => {
    seedAt(OLDER, "pattern", "build", ROW_OLD);
    seedAt(
      ROW_MID,
      "pattern",
      "deploy",
      "The widget alpha build also runs make proto.",
    );
    seedAt(NEWER, "pattern", "notes", "The widget alpha note.");

    const full = await selectRelevant(PROMPT_ALPHA, 5);
    expect(full.selected.length).toBe(3);
    const lines = full.selected.map((m) => formatMemory(m));
    const header = (full.block.split("\n")[0] ?? "").length;
    // Room for exactly the two highest-priority rows.
    const budget = header + 1 + lines[0]!.length + 1 + lines[1]!.length;

    const capped = await selectRelevant(
      PROMPT_ALPHA,
      5,
      undefined,
      undefined,
      undefined,
      {
        budget,
      },
    );
    expect(capped.block.length).toBeLessThanOrEqual(budget);
    const rode = injectedRows(capped.block, capped.selected, capped.rendered);
    expect(rode.map((m) => m.ts)).toEqual([
      full.selected[0]!.ts,
      full.selected[1]!.ts,
    ]);
    // Rendering is still canonical among the survivors, whatever the ranking was.
    const [a, b] = rode;
    const older = a!.ts < b!.ts ? a! : b!;
    const newer = older === a ? b : a;
    expect(capped.block.indexOf(formatMemory(newer))).toBeLessThan(
      capped.block.indexOf(formatMemory(older)),
    );
  });

  test("a budget that cannot hold a row plus its header renders nothing, not a dangling header", async () => {
    seedAt(OLDER, "pattern", "build", ROW_OLD);
    const { block } = await selectRelevant(
      PROMPT_ALPHA,
      5,
      undefined,
      undefined,
      undefined,
      {
        budget: 10,
      },
    );
    expect(block).toBe("");
  });
});

// AC 1 of #388, in the scripted form the ticket states. Six turns against a
// non-empty store. Turns 1-5 are five phrasings of work that selects the SAME
// rows; turn 6 writes a row, which must still bust.
//
// Read the criterion carefully: it asks for 0 `prompt_reveal` invalidations
// while `store_changed` still fires. It does NOT ask for a block that never
// moves — criterion 3 forbids that, and turn 6 below is the half that keeps
// this test from being satisfiable by freezing the block at session start.
describe("six-turn scripted chat", () => {
  test("five re-phrasings bust nothing; a store write busts once", async () => {
    seedAt(OLDER, "pattern", "build", ROW_OLD);
    seedAt(NEWER, "pattern", "deploy", ROW_NEW);
    const loaded = await loadPlugin(liveRoot);
    const sid = "ses-sixturn";

    const turns = [
      "widget alpha build make",
      "widget beta deploy helm make",
      "widget alpha build make deploy",
      "widget beta deploy make helm",
      "widget alpha beta make deploy helm",
    ];
    const bytes: string[] = [];
    for (const turn of turns) {
      bytes.push(await deliveredBlock(loaded, sid, turn));
    }
    // Every turn carries both rows, in the same order, from the same bytes.
    for (const text of bytes) {
      expect(text).toContain(ROW_OLD);
      expect(text).toContain(ROW_NEW);
      expect(text).toBe(bytes[0]);
    }
    expect(
      epochRecomputes(sid).filter((r) => String(r.reason) === "prompt_reveal"),
    ).toHaveLength(0);

    // The store write must still bust, or the fix would be a freeze.
    seedAt(
      new Date().toISOString(),
      "pattern",
      "release",
      "The widget omega cut runs make omega.",
    );
    const after = await deliveredBlock(loaded, sid, "widget alpha build make");
    expect(after).toContain("make omega");
    expect(after).not.toBe(bytes[0]);
    const reasons = epochRecomputes(sid).map((r) => String(r.reason));
    expect(reasons).toEqual(["first", "store_changed"]);
  });
});

// #409 case bank: the recall tool's matcher returns any row that shares a single
// word with the query, so a three-word search is answered by whatever happens to
// mention one of them. The gate applies the injection path's two-concept rule to
// the tool. The property that matters for a release is the first one: with the
// flag unset the tool's output is unchanged.
//
// Evidence: poc-409/casebank — 404 real recall queries from 30 days of session
// transcripts, relevance labelled by two independent readers against a pinned
// store snapshot. Held-out half, measured through this handler with the flag
// flipped: answers in the window 148 before and 149 after, answers at rank 1 125
// before and 125 after (zero discordant pairs against recall), returned rows
// 571 -> 480 and non-answering rows 363 -> 272.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryRoot } from "../src/core/config/paths.ts";
import { formatLine } from "../src/core/logfmt/format.ts";
import { resetState } from "../src/core/state.ts";
import { setRepoScope } from "../src/identity/repokey.ts";
import {
  admitsRow,
  GATE_ENV,
  gateEnabled,
  queryTokens,
  sharedTokens,
} from "../src/recall/gate.ts";
import type { Memory } from "../src/store/model/memory.ts";
import { loadPlugin } from "./harness.ts";
import { removeStore } from "./helpers/remove-store.ts";

function mem(content: string, over: Partial<Memory> = {}): Memory {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    type: "learning",
    scope: "review",
    content,
    status: "settled",
    file: "",
    index: 0,
    ...over,
  };
}

const ONE_CONCEPT = mem(
  "The head of the release branch must be rebuilt after the remote moved to SSH",
);
const TWO_CONCEPTS = mem(
  "pr-watch watermark: #283 head 9f1c2bd, CI green, approved at that head",
);
const NOTHING = mem(
  "Bun appends with O_APPEND; never use Bun.write with append, it silently truncates",
);

describe("gateEnabled", () => {
  test("unset, empty and the documented off values mean off", () => {
    expect(gateEnabled({})).toBe(false);
    expect(gateEnabled({ [GATE_ENV]: "" })).toBe(false);
    expect(gateEnabled({ [GATE_ENV]: "  " })).toBe(false);
    expect(gateEnabled({ [GATE_ENV]: "0" })).toBe(false);
    expect(gateEnabled({ [GATE_ENV]: "FALSE" })).toBe(false);
    expect(gateEnabled({ [GATE_ENV]: "off" })).toBe(false);
  });
  test("anything else means on", () => {
    expect(gateEnabled({ [GATE_ENV]: "1" })).toBe(true);
    expect(gateEnabled({ [GATE_ENV]: "true" })).toBe(true);
  });
});

describe("queryTokens", () => {
  test("lower-cases and de-duplicates, splitting where the matcher splits", () => {
    expect(queryTokens("Head  head WATERMARK")).toEqual(["head", "watermark"]);
    expect(queryTokens("   ")).toEqual([]);
  });
});

describe("admitsRow", () => {
  test("counts a token found in the keywords as shared", () => {
    const m = mem("unrelated prose", { kw: ["watermark"] });
    expect(sharedTokens(m, ["watermark", "head"])).toBe(1);
  });
  test("a query of three words or more needs two shared concepts", () => {
    const tokens = queryTokens("head watermark 283");
    expect(admitsRow(ONE_CONCEPT, tokens)).toBe(false);
    expect(admitsRow(TWO_CONCEPTS, tokens)).toBe(true);
    expect(admitsRow(NOTHING, tokens)).toBe(false);
  });
  test("a short query is too vague to hold a row to two concepts", () => {
    expect(admitsRow(ONE_CONCEPT, queryTokens("head watermark"))).toBe(true);
  });
  test("an empty query admits nothing rather than everything", () => {
    expect(admitsRow(TWO_CONCEPTS, queryTokens(""))).toBe(false);
  });
});

describe("memory_recall with the gate", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osi-gate-"));
    process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
    resetState();
    setRepoScope(null);
  });
  afterEach(() => {
    delete process.env[GATE_ENV];
    setRepoScope(null);
    delete process.env.OPENCODE_MEMORY_DIR;
    removeStore(root);
  });

  function seed(...rows: Memory[]) {
    const day = "2026-01-01";
    const file = join(memoryRoot(), `${day}.logfmt`);
    mkdirSync(dirname(file), { recursive: true });
    rows.forEach((m, i) => {
      appendFileSync(
        file,
        `${formatLine({
          ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
          type: m.type,
          scope: m.scope,
          content: m.content,
          status: m.status,
        })}\n`,
      );
    });
  }

  test("flag off, a one-concept row is still returned", async () => {
    seed(ONE_CONCEPT, TWO_CONCEPTS);
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "head watermark 283",
      limit: 5,
    });
    expect(out).toContain("head of the release branch");
    expect(out).toContain("pr-watch watermark");
    await loaded.cleanup();
  });

  test("flag on, the one-concept row is dropped and the two-concept row stays", async () => {
    seed(ONE_CONCEPT, TWO_CONCEPTS);
    process.env[GATE_ENV] = "1";
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "head watermark 283",
      limit: 5,
    });
    expect(out).not.toContain("head of the release branch");
    expect(out).toContain("pr-watch watermark");
    await loaded.cleanup();
  });

  test("flag on, a store with nothing two-concept abstains instead of filling the window", async () => {
    seed(ONE_CONCEPT, NOTHING);
    process.env[GATE_ENV] = "1";
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "head watermark 283",
      limit: 5,
    });
    expect(out).toContain("No matching memories");
    await loaded.cleanup();
  });

  test("flag on, a two-word query keeps the permissive behaviour", async () => {
    seed(ONE_CONCEPT);
    process.env[GATE_ENV] = "1";
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "head watermark",
      limit: 5,
    });
    expect(out).toContain("head of the release branch");
    await loaded.cleanup();
  });
});

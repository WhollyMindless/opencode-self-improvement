// The recall window's default size (#409, RESULTS §12 and §14).
//
// Lane 0 joined 1,090 live `memory_recall` events to their session transcripts
// and asked whether the returned rows were used: a row at rank 1 goes on to be
// referenced in 3.4x the rate of a random store row, ranks 2-3 at 2.4x, ranks
// 4-10 at 1.4x, and ranks 11-20 at 1.16x — indistinguishable from noise against
// a 0.129 null. The tool was returning 17.7 rows per call, so 62% of what it
// put in context was statistically worthless.
//
// The honest per-query cost, measured through the shipped handler over the 404
// case-bank queries with adjudicated full-text labels (poc-409/casebank,
// limit-windows): the window holds an answer for 231 of 404 queries at limit
// 20 and 216 at limit 5 — 15 queries reach their answer only at ranks 6-20
// (McNemar p<0.001; held-out 131 -> 125, p=0.031). What limit 5 buys: 69%
// fewer rows and 74% fewer non-answering rows per call. This is a disclosed
// trade of context against recall, not a free win; an earlier framing of this
// lane as "precision rises 4.1% -> 13.1%" was denominator arithmetic that hid
// the gold loss.
//
// What the caller keeps: an explicit `limit` overrides the default, the header
// still reports the full match count, and non-positive limits are coerced to
// the default — slice(0, -n) would otherwise return MORE rows, not fewer.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRepoScope } from "../src/identity/repokey.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { loadPlugin } from "./harness.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;

/** Twelve rows that all answer the same query, so only rank can separate them. */
async function seedTwelve() {
  for (let i = 0; i < 12; i++)
    await appendMemory({
      type: "learning",
      scope: "deploys",
      content: `note ${String(i).padStart(2, "0")} about deploys`,
      status: "settled",
    });
}

const rendered = (out: string) => out.split("note ").length - 1;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-window-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  setRepoScope(null);
});

afterEach(() => {
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  removeStore(root);
});

describe("the recall window default (#409)", () => {
  test("a query returns 5 rows by default, not 20", async () => {
    const { tool } = await loadPlugin(root);
    await seedTwelve();
    const out = await tool.memory_recall!.execute({ query: "deploys" });
    expect(rendered(out)).toBe(5);
  });

  test("the header still reports the full match count, so a narrow window does not hide depth", async () => {
    const { tool } = await loadPlugin(root);
    await seedTwelve();
    const out = await tool.memory_recall!.execute({ query: "deploys" });
    expect(out).toContain("Found 12 (12 total)");
  });

  test("an explicit limit still overrides the default", async () => {
    const { tool } = await loadPlugin(root);
    await seedTwelve();
    const out = await tool.memory_recall!.execute({
      query: "deploys",
      limit: 12,
    });
    expect(rendered(out)).toBe(12);
  });

  test("a negative or zero limit cannot widen the window", async () => {
    // slice(0, -1) drops one row and slice(-(-1)) drops none: an unclamped
    // negative limit returns MORE rows than the default, not fewer.
    const { tool } = await loadPlugin(root);
    await seedTwelve();
    for (const bad of [-1, -12, 0]) {
      const out = await tool.memory_recall!.execute({
        query: "deploys",
        limit: bad,
      });
      expect(rendered(out)).toBe(5);
    }
  });

  test("the filter-only path is capped too, and keeps the most recent rows", async () => {
    const { tool } = await loadPlugin(root);
    await seedTwelve();
    const out = await tool.memory_recall!.execute({ scope: "deploys" });
    expect(rendered(out)).toBe(5);
    // slice(-limit): the newest five, not the first five written.
    expect(out).toContain("note 11");
    expect(out).not.toContain("note 00");
  });
});

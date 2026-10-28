// BDD: the use ledger as a user observes it — a captured fact that keeps
// matching later turns accrues `inject` hits, an explicit memory_recall
// accrues `recall` hits, and memory_status reports what was never retrieved.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPO, type Fake, type Guest, makeGuest, startFake, turn } from "./support/harness.ts";

let fake: Fake;
const guests: Guest[] = [];

beforeAll(async () => {
  fake = await startFake();
});
afterEach(() => {
  // KEEP=1 leaves guest dirs behind for debugging store/ledger assertions.
  if (process.env.KEEP) {
    for (const g of guests.splice(0)) console.log(`[keep] ${g.root} store=${join(g.root, "home", ".opencode")}`);
    return;
  }
  for (const g of guests.splice(0)) rmSync(g.root, { recursive: true, force: true });
});
afterAll(() => fake.stop());

function guest(): Guest {
  const g = makeGuest(fake, REPO);
  guests.push(g);
  return g;
}

function call(id: string, tool: string, args: Record<string, unknown>) {
  return { tool_calls: [{ id, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] };
}

function hostLedger(g: Guest): string[] {
  const p = join(g.memoryDir, "hits.logfmt");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean) : [];
}
function storeLines(g: Guest): string[] {
  const dir = g.memoryDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.logfmt$/.test(f))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean));
}

const FACT =
  "the quixotic flimflam widget pipeline on the arm64 build box compiles with bun build " +
  "using the standard tsconfig defaults in single pass mode without extra flags";
const UNRELATED =
  "the zebra brasserie ledger reconciliation job runs nightly on the accounting box and mails a short " +
  "digest to finance before the opening bell so that nobody has to chase the numbers by hand";

/** A scripted memory_remember step. `open` keeps the row out of ref-grounding. */
function remember(id: string, scope: string, content: string) {
  return call(id, "memory_remember", { type: "learning", scope, content, status: "open" });
}

describe("use ledger end-to-end", () => {
  test("matching turns and explicit recall are recorded; status counts never-retrieved", async () => {
    const g = guest();

    // Given two captured facts, one of which later turns will keep matching.
    fake.setSteps({
      "SMOKE::cap": [
        remember("a1", "flimflam", FACT),
        remember("a2", "zebra", UNRELATED),
        { content: "CAP-DONE" },
      ],
    });
    const cap = await turn(fake, g, "SMOKE::cap please store both facts: " + FACT + " — and: " + UNRELATED);
    expect(cap.exit).toBe(0);
    expect(storeLines(g).length).toBe(2);

    // When a later message shares the first fact's terms, the block rides and
    // the ledger credits that row — and only that row — under the new session.
    fake.setSteps({ "SMOKE::next": [{ content: "NEXT-DONE" }] });
    const t2 = await turn(
      fake,
      g,
      "SMOKE::next how does the flimflam widget pipeline compile on the arm64 build box with bun build?",
    );
    expect(t2.exit).toBe(0);
    const injected = hostLedger(g).filter((l) => l.includes("src=inject"));
    // One line per epoch build that was ADOPTED with something to credit. The
    // writing session contributes none: its first epoch had an empty store to
    // score, and the rows written after it are its own thoughts, which #165
    // keeps off its prefix. The next session is the first to be SHOWN them, and
    // it saw only the flimflam row (zebra shares no vocabulary with it).
    const last = injected[injected.length - 1];
    expect(injected.length).toBe(1);
    expect(last).toInclude("flimflam");
    expect(last).not.toInclude("zebra");
    // Terms are memory-side words. The triggering message is never stored.
    expect(last).toInclude("terms=[");
    expect(last).not.toInclude("SMOKE::next");
    expect(last).not.toInclude("how does");

    // When the model calls memory_recall explicitly, that source is recorded too.
    fake.setSteps({
      "SMOKE::rc": [call("r1", "memory_recall", { query: "flimflam widget pipeline compile" }), { content: "RC-DONE" }],
    });
    const t3 = await turn(fake, g, "SMOKE::rc what do we know about the flimflam widget pipeline compiling?");
    expect(t3.exit).toBe(0);
    expect(t3.outputs("memory_recall").join("\n")).toInclude("flimflam");
    expect(hostLedger(g).filter((l) => l.includes("src=recall")).length).toBeGreaterThanOrEqual(1);

    // When the store report is asked for, retrieval is counted and the row that
    // never matched is on the record as never retrieved.
    fake.setSteps({ "SMOKE::st": [call("s1", "memory_status", {}), { content: "ST-DONE" }] });
    const t4 = await turn(fake, g, "SMOKE::st give me the memory store report");
    expect(t4.exit).toBe(0);
    const report = t4.outputs("memory_status").join("\n");
    // The dead-weight line is present and internally consistent: retrieved +
    // never retrieved = active. Flimflam was injected into a later session and
    // then explicitly recalled; zebra was never retrieved by anyone — its author
    // is not re-shown its own row (#165) and no later turn matched its
    // vocabulary. That is real dead weight, which is exactly what this line
    // exists to surface.
    const m = report.match(/retrieved (\d+) rows in the last 30d; never retrieved (\d+) \((\d+)%\)/);
    expect(m, "the report carries the use-ledger line").not.toBeNull();
    const [used, dead] = [Number(m![1]), Number(m![2])];
    expect(used + dead).toBe(2);
    expect(used).toBe(1);
    expect(dead).toBe(1);
    // And the ledger really does distinguish them.
    const led = hostLedger(g);
    const flimHits = led.filter((l) => l.includes("flimflam")).length;
    const zebraHits = led.filter((l) => l.includes("zebra")).length;
    expect(flimHits).toBeGreaterThan(0);
    expect(zebraHits).toBe(0);
  }, 240_000);
});

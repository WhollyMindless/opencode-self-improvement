// Value-keyed rejection tombstones (#35).
//
// The promise under test: when a human rejects a value, that value stays
// rejected — even after the row carrying it is deleted, and even when the
// thing that comes back is the same statement reworded rather than the same
// bytes. The blocklist cannot provide this (it keys on `ts`, and a re-ingested
// fact arrives with a new one) and neither can prune (it deletes the rejection
// along with the row).
//
// The two failure directions are not symmetric, and the suite treats them that
// way:
//   - UNDER-blocking is the bug the ticket is about: a rejected fact returns.
//   - OVER-blocking is the bug that would make the mechanism unusable: a
//     legitimate new write silently refused because it resembles something a
//     human once deleted. Short content is the dangerous shape (small token
//     sets score high against almost anything), so it is pinned explicitly.
//
// Also pinned here: the tombstone file stores hashes and metadata only (atlas
// step-10 inversion — a deletion log that reproduces what it deleted is a
// compliance problem), it is never ingested as a memory row, and lifting a
// rejection is reachable by a HUMAN and by no plugin tool, so a session whose
// write was refused cannot clear its own refusal.
//
// Hermetic like the rest of the suite: temp OPENCODE_MEMORY_DIR, no repo touch.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRoot } from "../src/config.ts";
import { runWriteGate } from "../src/gates.ts";
import { loadAll, prune } from "../src/memory.ts";
import { resetSessionScopes, setRepoScope } from "../src/repokey.ts";
import { resetState } from "../src/state.ts";
import {
  findRejection,
  rejectedFile,
  removeTombstone,
  sketchOf,
  tombstone,
  tombstones,
} from "../src/tombstones.ts";
import { blockMemory, unblockMemory } from "../src/viewer/mutate.ts";
import { blockedEntries } from "../src/blocklist.ts";
import { loadPlugin } from "./harness.ts";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-tomb-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  resetState();
  resetSessionScopes();
  setRepoScope(null);
});

afterEach(() => {
  setRepoScope(null);
  resetSessionScopes();
  resetState();
  delete process.env.OPENCODE_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

let root: string;

/** A grounded gate context: refs/engagement satisfied, so the ONLY thing that
 *  can refuse these writes is the rejection check. */
const ctx = () => ({ liveRoot: root, evidenceCalls: [], hasGateCheck: true, hasEngagement: true });

const REJECTED =
  "decided to adopt the express framework for the http layer and terminate tls at the load balancer";
// The same statement, reworded: different bytes (so `ch` differs), same claim
// (so the token set is nearly the same).
const REWORDED =
  "the http layer adopts express, with tls terminated at the load balancer";
// A different fact in the same scope, sharing only domain vocabulary.
const UNRELATED =
  "the image pipeline resizes uploads to 2048 pixels before writing them to object storage";

async function promote(content: string, scope = "http", type = "decision") {
  return runWriteGate({ type, scope, content }, ctx());
}

describe("rejection survives deletion of the row that held it", () => {
  test("exact content replayed after a forget is refused, not stored", async () => {
    expect((await promote(REJECTED)).action).toBe("promoted");

    const res = await prune("http", "decision", "wrong call, do not record this");
    expect(res.deleted).toHaveLength(1);

    const replay = await promote(REJECTED);
    expect(replay.action).toBe("blocked");
    expect(replay.reason).toBe("previously_rejected");
    expect(await loadAll()).toHaveLength(0);
  });

  test("the refusal names when, why, and the hash the human needs to lift it", async () => {
    await tombstone(REJECTED, { reason: "wrong call", source: "forget", scope: "http", type: "decision" });

    const replay = await promote(REJECTED);
    const hint = replay.hint ?? "";
    expect(hint).toContain("wrong call");
    expect(hint).toContain(new Date().toISOString().slice(0, 10));
    expect(hint).toMatch(/[0-9a-f]{12}/);
    expect(hint).toContain("no tool that lifts a rejection");
  });

  // The escape hatch has to be present on BOTH verdicts. An earlier shape put
  // it only on the near-match hint, which left the common case — a byte-exact
  // replay — reported as a dead end.
  test("both the exact and the near refusal carry the way out", async () => {
    await tombstone(REJECTED, { reason: "wrong call", source: "forget" });
    const exact = (await promote(REJECTED)).hint ?? "";
    const near = (await promote(REWORDED)).hint ?? "";
    for (const hint of [exact, near]) {
      expect(hint).toContain("un-reject");
      expect(hint).toContain("no tool that lifts a rejection");
    }
    // And they are distinguishable: one says exact, the other quotes a score.
    expect(exact).toContain("This exact content");
    expect(near).toContain("similar to a value rejected");
  });

  test("the refusal is audited: dedup_rejected then write_blocked, value never logged", async () => {
    await tombstone(REJECTED, { reason: "poisoned", source: "forget" });
    const ev: string[] = [];
    const outcome = await runWriteGate(
      { type: "decision", scope: "http", content: REJECTED },
      { ...ctx(), evidenceCalls: ev },
    );
    expect(outcome.action).toBe("blocked");

    const log = readFileSync(join(memoryRoot(), "evidence", `${new Date().toISOString().slice(0, 10)}.logfmt`), "utf8");
    expect(log).toContain("ev=dedup_rejected");
    expect(log).toContain("match_kind=exact");
    expect(log).toContain("reason=previously_rejected");
    // The prose must not appear in EITHER the evidence log or the tombstone.
    expect(log).not.toContain("terminate tls at the load balancer");
  });
});

describe("near-match closes the rewording hole", () => {
  test("a reworded rejected value is refused", async () => {
    expect((await promote(REJECTED)).action).toBe("promoted");
    await prune("http", "decision", "wrong call");

    const reworded = await promote(REWORDED);
    expect(reworded.action).toBe("blocked");
    expect(reworded.reason).toBe("previously_rejected");
    expect(reworded.hint ?? "").toContain("similar");
    expect(await loadAll()).toHaveLength(0);
  });

  test("the sketch scores a rewording far above an unrelated fact", () => {
    const rejected = sketchOf(REJECTED);
    const reworded = sketchOf(REWORDED);
    const unrelated = sketchOf(UNRELATED);
    expect(jac(rejected, reworded)).toBeGreaterThanOrEqual(0.5);
    expect(jac(rejected, unrelated)).toBeLessThan(0.2);
  });

  test("an unrelated fact in the same scope still stores clean", async () => {
    await tombstone(REJECTED, { reason: "wrong call", source: "forget", scope: "http", type: "decision" });
    expect((await promote(UNRELATED)).action).toBe("promoted");
  });

  // The UPPER side of the floor. "An unrelated fact stores clean" is not enough
  // to pin it: genuinely unrelated prose scores 0.0, so it stays green even with
  // a near-floor of 0.05 and an over-aggressive mechanism looks fine. These are
  // the pairs that actually score against a floor — same vocabulary, same topic,
  // a DIFFERENT claim (measured 0.059-0.235). A human deleting one must not be
  // allowed to veto the others.
  test("a different claim in the same topic is NOT refused", async () => {
    const sameTopicDifferentClaim = [
      [
        "decided to adopt the express framework for the http layer and terminate tls at the load balancer",
        "decided to move the http layer to fastify because express lacks schema validation",
      ],
      [
        "we run migrations with bun migrate before every deploy",
        "migrations were rolled back manually once bun migrate timed out",
      ],
      [
        "the release workflow publishes to npm before it creates the github release",
        "the release workflow failed because the npm token expired mid run",
      ],
    ] as const;
    const refused: string[] = [];
    for (const [wasRejected, newClaim] of sameTopicDifferentClaim) {
      expect((await promote(wasRejected)).action).toBe("promoted");
      await prune("http", "decision", "wrong call");
      const next = await promote(newClaim);
      if (next.action === "blocked") refused.push(`${newClaim} <- ${next.hint ?? "?"}`);
    }
    // Empty means no legitimate rewrite was vetoed; a failure prints exactly
    // which claim was refused and by what reasoning.
    expect(refused).toEqual([]);
  });

  test("near-match never fires on short content, which is where false positives live", async () => {
    await tombstone("use bun for scripts", { reason: "stale", source: "forget" });
    // Byte-identical: still refused, because that is an exact match, not a guess.
    expect((await promote("use bun for scripts", "tooling")).action).toBe("blocked");
    // Different short content: must NOT be refused. Two dozen-token strings can
    // share most of their tokens by accident; a refusal here would be a lie.
    expect((await promote("prefer pnpm workspaces for monorepos", "tooling")).action).toBe("promoted");
  });

  test("findRejection reports the strongest near-match, not the first", async () => {
    await tombstone(REJECTED, { reason: "first", source: "forget" });
    await tombstone(
      "the http layer adopts express and terminates tls at the load balancer today",
      { reason: "second", source: "forget" },
    );
    const hit = await findRejection(REWORDED);
    expect(hit?.kind).toBe("near");
    if (hit?.kind === "near") expect(hit.score).toBeGreaterThan(0);
  });
});

describe("the tombstone holds hashes, never values", () => {
  test("rejected prose appears nowhere in rejected.logfmt", async () => {
    // A real forget, so the contrast below is produced by the same flow rather
    // than by hand-written fixtures.
    expect((await promote(REJECTED)).action).toBe("promoted");
    await prune("http", "decision", "wrong call, do not record this");

    const raw = readFileSync(rejectedFile(), "utf8");
    expect(raw).not.toContain("express");
    expect(raw).not.toContain("balancer");
    expect(raw).toContain("ch=");
    expect(raw).toContain("sig=");
    // The contrast that stops this pin passing vacuously: the DELETION audit
    // does keep the prose verbatim (that is its documented job), which is
    // precisely why the tombstone must not add a second copyable body.
    const deletions = readFileSync(join(memoryRoot(), "deletions.logfmt"), "utf8");
    expect(deletions).toContain("balancer");
  });

  test("rejected.logfmt is never ingested as a memory row", async () => {
    await tombstone(REJECTED, { reason: "wrong call", source: "forget" });
    expect(await loadAll()).toHaveLength(0);
  });

  test("an idempotent rejection does not append a second line for the same value", async () => {
    await tombstone(REJECTED, { reason: "first", source: "forget" });
    const second = await tombstone(REJECTED, { reason: "again", source: "forget" });
    expect(second.recorded).toBe(false);
    expect(await tombstones()).toHaveLength(1);
  });

  // A bulk forget is the common shape (prune deletes by scope+type, not by row),
  // and tombstones are written as ONE batched append. Every value in the batch
  // has to survive as its own parseable line: an earlier version joined the
  // batch with "" — formatLine returns no terminator — so 40 records landed as
  // one line and only the first parsed. Nothing else in this suite wrote more
  // than one value per call, so nothing caught it.
  test("a bulk forget records EVERY value, not just the first", async () => {
    // type "learning" on purpose: 40 near-identical rows are exactly what a bulk
    // scope forget produces, and decisions compete at a 0.3 overlap floor, which
    // would block them here for a reason unrelated to what this pins.
    const lines = Array.from(
      { length: 40 },
      (_, i) => `release gate ${i} requires a distinct green pipeline run`,
    );
    for (const content of lines) {
      expect((await promote(content, "http", "learning")).action).toBe("promoted");
    }
    const res = await prune("http", "learning", "bulk");
    expect(res.deleted).toHaveLength(40);

    const all = await tombstones();
    expect(all).toHaveLength(40);
    // Every one of them must be individually matched by the gate, which is the
    // whole point: a rejection that failed to parse rejects nothing.
    const refused: number[] = [];
    for (const [i, content] of lines.entries()) {
      const again = await promote(content, "http", "learning");
      if (again.action === "blocked") refused.push(i);
    }
    expect(refused).toHaveLength(40);
    // And the raw file really is 40 lines, so the count above cannot be a
    // parser coincidence.
    expect(readFileSync(rejectedFile(), "utf8").trimEnd().split("\n")).toHaveLength(40);
  });
});

describe("lifting a rejection is a human action", () => {
  test("un-tombstone lets the value be stored again", async () => {
    const { ch } = await tombstone(REJECTED, { reason: "wrong call", source: "forget" });
    expect((await promote(REJECTED)).action).toBe("blocked");
    expect(await removeTombstone(ch)).toBe(true);
    expect((await promote(REJECTED)).action).toBe("promoted");
  });

  test("blocking tombstones the value; unblocking withdraws it", async () => {
    const first = await promote(REJECTED);
    expect(first.action).toBe("promoted");
    const ts = first.action === "promoted" ? first.ts : "";

    await blockMemory({ ts, reason: "poison" });
    expect(await tombstones()).toHaveLength(1);
    // The row is still on disk (block is non-destructive) but refused on the way in.
    expect((await promote(REJECTED)).action).toBe("blocked");

    await unblockMemory(ts);
    expect(await blockedEntries()).toHaveLength(0);
    expect(await tombstones()).toHaveLength(0);
    // Not `promoted`: the blocked row was never destroyed, so the identical
    // write collapses onto it (GATE-3 exact duplicate) rather than adding a
    // second copy. What matters is that it is no longer REFUSED.
    const after = await promote(REJECTED);
    expect(after.action).toBe("collapsed");
    expect(after.action).not.toBe("blocked");
  });

  test("no plugin tool can lift a rejection", async () => {
    const { ch } = await tombstone(REJECTED, { reason: "wrong call", source: "forget" });
    expect((await promote(REJECTED)).action).toBe("blocked");

    // Name scan first: nothing registered is even shaped like an un-reject.
    const names = Object.keys((await loadPlugin()).tool);
    expect(names.filter((n) => /unreject|tombstone|lift|approve/i.test(n))).toEqual([]);

    // Then the behavioral half: every IN-PROCESS tool is offered the most
    // plausible arguments it could take for clearing a tombstone, and none may
    // change the file. memory_init is excluded deliberately — it spawns the
    // external indexer (a child process, not a store mutation), which is what
    // tripped this test under the parallel test workers.
    const loaded = await loadPlugin();
    const invokable = names.filter((n) => n !== "memory_init");
    expect(invokable.length).toBeGreaterThan(8);
    const before = readFileSync(rejectedFile(), "utf8");
    for (const name of invokable) {
      await loaded.tool[name]
        .execute({ ch, ts: ch, scope: "http", type: "decision", reason: "lift", file: "x.jsonl" })
        .catch(() => undefined);
    }
    expect(readFileSync(rejectedFile(), "utf8")).toBe(before);
    expect((await promote(REJECTED)).action).toBe("blocked");
  });
});

function jac(a: string[], b: string[]): number {
  const sb = new Set(b);
  const inter = new Set(a.filter((x) => sb.has(x))).size;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

// Contract (#390): a correction retires the row it corrects IN THE DATA. R3
// (`results-stale-x5/`, 2150 → 1900) kept both values, the correction winning
// only because the model wrote "this supersedes the earlier 2150 bps figure"
// and retrieval happened to prefer it. R3c narrowed the exposure to the
// same-instant tie (3/10) and to any retrieval surfacing the stale row alone.
// GATE-3 rivalry cannot cover this: it competes only decision/preference rows,
// and corrections of remembered facts are context/learning.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAll } from "../src/store/files/load.ts";
import { relevantKnowledge } from "../src/recall/relevant.ts";
import { runWriteGate } from "../src/gate/gate.ts";
import { symbolValues, valueConflicts } from "../src/gate/value-conflict.ts";
import { setRepoScope } from "../src/identity/repokey.ts";
import type { Memory } from "../src/store/model/memory.ts";
import { readEvidenceLog } from "./helpers/logfmt.ts";

const mem = (
  ts: string,
  content: string,
  extra: Partial<Memory> = {},
): Memory =>
  ({
    ts,
    type: "context",
    scope: "config",
    content,
    status: "settled",
    ...extra,
  }) as Memory;

describe("symbolValues", () => {
  test("a number after the symbol is its value; the fallback looks before", () => {
    expect(symbolValues("The VAT_BPS constant is 2150 basis points.")).toEqual(
      new Map([["VAT_BPS", "2150"]]),
    );
    expect(symbolValues("Set to 2150, the VAT_BPS constant stands.")).toEqual(
      new Map([["VAT_BPS", "2150"]]),
    );
  });

  test("prose with no symbol yields nothing", () => {
    expect(symbolValues("the rate is 2150 basis points").size).toBe(0);
  });

  test("the scan does not depend on which row ran last", () => {
    // A module-level `g` regex carries lastIndex between calls — the #393 bug.
    // A retirement rule whose answer depends on call order is worse than none,
    // because it looks deterministic.
    const a = "The VAT_BPS constant is 2150 basis points.";
    const b = "The RATE_MAX constant is 30 attempts.";
    symbolValues(a);
    expect(symbolValues(b).get("RATE_MAX")).toBe("30");
    expect(symbolValues(a).get("VAT_BPS")).toBe("2150");
  });
});

describe("valueConflicts", () => {
  const old = mem(
    "2026-10-01T09:00:00.000Z",
    "This site's fallback VAT rate is 2150 basis points.",
  );
  const fix = mem(
    "2026-10-02T09:00:00.000Z",
    "This site's fallback VAT rate is 1900 basis points.",
  );

  test("the R3 hand-seeded pair conflicts on the shared symbol", () => {
    const hits = valueConflicts(fix, [old]);
    expect(hits.length).toBe(1);
    expect(hits[0]?.ts).toBe(old.ts);
    expect(hits[0]?.from).toBe("2150");
    expect(hits[0]?.to).toBe("1900");
  });

  test("agreeing numbers are one fact restated, not a conflict", () => {
    const same = mem(
      "2026-10-02T09:00:00.000Z",
      "This site's fallback VAT rate is 2150 basis points, confirmed by finance.",
    );
    expect(valueConflicts(same, [old])).toEqual([]);
  });

  test("two different facts in one scope coexist", () => {
    // No shared symbol anchor: "retries" and "timeout" are separate claims.
    const a = mem(
      "2026-10-01T09:00:00.000Z",
      "MAX_RETRIES is 3 for the queue.",
    );
    const b = mem(
      "2026-10-02T09:00:00.000Z",
      "TIMEOUT_MS is 30000 for the queue.",
    );
    expect(valueConflicts(b, [a])).toEqual([]);
  });

  test("a history note does not retire the fact it mentions", () => {
    // The misfire class #393 accepted for a REFUSAL is not accepted for a
    // RETIREMENT: with the numbers stripped these are different sentences,
    // and the shape floor must stop it.
    const fact = mem(
      "2026-10-01T09:00:00.000Z",
      "The VAT_BPS constant for this site is 2150 basis points.",
    );
    const note = mem(
      "2026-10-02T09:00:00.000Z",
      "VAT_BPS was introduced in 2024 by the customs team.",
    );
    expect(valueConflicts(note, [fact])).toEqual([]);
  });

  test("an inferred write never retires a user-guided row", () => {
    // The user is the stronger claim; a captured inference burying stated
    // guidance is the wrong-direction fix R3 must not ship with.
    const guided = mem(
      "2026-10-01T09:00:00.000Z",
      "This site's fallback VAT rate is 2150 basis points.",
      {
        tags: ["user-guided"],
      },
    );
    expect(valueConflicts(fix, [guided])).toEqual([]);
    const guidedFix = { ...fix, tags: ["user-guided"] };
    expect(valueConflicts(guidedFix, [guided]).length).toBe(1);
  });

  test("different types and retired rows are never victims", () => {
    const asLearning = mem(old.ts, old.content, { type: "learning" });
    expect(valueConflicts(fix, [asLearning])).toEqual([]);
    const retired = mem(old.ts, old.content, { superseded_by: "x" });
    expect(valueConflicts(fix, [retired])).toEqual([]);
  });
});

describe("the gate retires a corrected row in the data", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osi-valconf-"));
    process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
    setRepoScope(null);
  });
  afterEach(() => {
    setRepoScope(null);
    delete process.env.OPENCODE_MEMORY_DIR;
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  const write = (content: string, extra: Record<string, unknown> = {}) =>
    runWriteGate(
      { type: "context", scope: "site-config", content, ...extra },
      { liveRoot: root, evidenceCalls: [], hasGateCheck: true, trusted: true },
    );

  test("the stale row carries superseded_by pointing at the correction", async () => {
    const first = await write(
      "This site's fallback VAT rate is 2150 basis points (VAT_BPS).",
    );
    expect(first.action).toBe("promoted");
    const second = await write(
      "This site's fallback VAT rate is 1900 basis points (VAT_BPS).",
    );
    expect(second.action).toBe("promoted");
    const rows = await loadAll();
    const stale = rows.find((m) => m.ts === first.ts);
    expect(stale?.superseded_by).toBe(second.ts);
    expect(stale?.reason).toBe("numeric_conflict");
  });

  test("AC 1: the retired row cannot be injected without the correction", async () => {
    await write(
      "This site's fallback VAT rate is 2150 basis points (VAT_BPS).",
    );
    const fix = await write(
      "This site's fallback VAT rate is 1900 basis points (VAT_BPS).",
    );
    const block = await relevantKnowledge(
      "write the declaration file with the fallback VAT rate",
      3,
    );
    expect(block).toContain("1900");
    expect(block).not.toContain("2150");
    // And the retired row is still there — recoverable, not deleted.
    const rows = await loadAll();
    expect(rows.find((m) => m.ts !== fix.ts)?.content).toContain("2150");
  });

  test("the failed check is auditable: superseded_by names the values", async () => {
    await write(
      "This site's fallback VAT rate is 2150 basis points (VAT_BPS).",
    );
    await write(
      "This site's fallback VAT rate is 1900 basis points (VAT_BPS).",
    );
    const line = readEvidenceLog().find(
      (l) => l.ev === "superseded_by" && l.reason === "numeric_conflict",
    );
    expect(line).toBeDefined();
    expect(String(line?.from)).toBe("2150");
    expect(String(line?.to)).toBe("1900");
    expect(String(line?.symbol)).toBe("VAT");
  });

  test("an open planning row does not retire a settled fact", async () => {
    await write(
      "This site's fallback VAT rate is 2150 basis points (VAT_BPS).",
    );
    const open = await write(
      "This site's fallback VAT rate is 1900 basis points (VAT_BPS).",
      { status: "open" },
    );
    expect(open.action).toBe("promoted");
    const rows = await loadAll();
    expect(rows.filter((m) => !m.superseded_by).length).toBe(2);
  });

  test("a blocked correction retires nothing", async () => {
    await write(
      "This site's fallback VAT rate is 2150 basis points (VAT_BPS).",
    );
    // Exact duplicate: GATE-3 collapses it, nothing lands, nothing retires.
    const dup = await write(
      "This site's fallback VAT rate is 2150 basis points (VAT_BPS).",
    );
    expect(dup.action).toBe("collapsed");
    const rows = await loadAll();
    expect(rows.every((m) => !m.superseded_by)).toBe(true);
  });
});

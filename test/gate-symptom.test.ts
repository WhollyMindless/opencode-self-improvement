// The #419 capture convention, enforced at the write gate: `learning` and
// `blocker` rows must open with the observable trigger ("When <symptom>:").
// The measured gap justifies enforcement — the same lesson surfaced 0/8 as a
// session diary and ranked 1-7 symptom-first, because the future searcher
// types the symptom, not the lesson. The rule is production default ON;
// OPENCODE_MEMORY_SYMPTOM=off is the escape hatch (the suite pins off globally
// in preload-isolation.ts, so every test here sets its own state).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWriteGate, symptomRuleEnabled } from "../src/gate/gate.ts";
import { loadAll } from "../src/store/files/load.ts";
import { setRepoScope } from "../src/identity/repokey.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-symptom-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  setRepoScope(null);
});

afterEach(() => {
  setRepoScope(null);
  // Restore the suite-wide off (preload-isolation.ts), NOT a delete: deleting
  // re-exposes the production default ON to every later file in the runner
  // process — which is how portable.test.ts failed in the full run.
  process.env.OPENCODE_MEMORY_SYMPTOM = "off";
  delete process.env.OPENCODE_MEMORY_DIR;
  removeStore(root);
});

const candidate = (type: string, content: string) => ({
  type,
  scope: "payments",
  content,
  status: "settled" as const,
});

describe("symptomRuleEnabled", () => {
  test("on by default; off only for off/0/false", () => {
    expect(symptomRuleEnabled({})).toBe(true);
    expect(symptomRuleEnabled({ OPENCODE_MEMORY_SYMPTOM: "off" })).toBe(false);
    expect(symptomRuleEnabled({ OPENCODE_MEMORY_SYMPTOM: "0" })).toBe(false);
    expect(symptomRuleEnabled({ OPENCODE_MEMORY_SYMPTOM: "FALSE" })).toBe(
      false,
    );
    expect(symptomRuleEnabled({ OPENCODE_MEMORY_SYMPTOM: "1" })).toBe(true);
  });
});

describe("write gate with the symptom rule on", () => {
  beforeEach(() => {
    process.env.OPENCODE_MEMORY_SYMPTOM = "1";
  });

  test("a diary-shaped learning is blocked with a rephrase hint", async () => {
    const out = await runWriteGate(
      candidate(
        "learning",
        "In this session we fixed the rounding drift in totals",
      ),
      { liveRoot: root, evidenceCalls: [], hasGateCheck: true, trusted: true },
    );
    expect(out.action).toBe("blocked");
    if (out.action === "blocked") {
      expect(out.reason).toBe("symptom_missing");
      expect(out.hint).toContain("When <symptom>: <fact>");
    }
    expect(await loadAll()).toHaveLength(0);
  });

  test("a blocker without a trigger is blocked", async () => {
    const out = await runWriteGate(
      candidate(
        "blocker",
        "the deploy pipeline is broken until infra rotates the cert",
      ),
      { liveRoot: root, evidenceCalls: [], hasGateCheck: true, trusted: true },
    );
    expect(out.action).toBe("blocked");
    if (out.action === "blocked") expect(out.reason).toBe("symptom_missing");
  });

  test("the trigger clause is accepted and stored", async () => {
    const out = await runWriteGate(
      candidate(
        "learning",
        "When totals are off by one cent: tax uses roundHalfEven but pricing requires half-up",
      ),
      { liveRoot: root, evidenceCalls: [], hasGateCheck: true, trusted: true },
    );
    expect(out.action).toBe("promoted");
    const rows = await loadAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toStartWith("When totals are off by one cent:");
  });

  test("other types are unaffected", async () => {
    for (const type of ["context", "decision", "pattern", "preference"]) {
      const out = await runWriteGate(
        candidate(type, `plain ${type} prose with no trigger clause at all`),
        {
          liveRoot: root,
          evidenceCalls: [],
          hasGateCheck: true,
          trusted: true,
        },
      );
      expect(out.action).toBe("promoted");
    }
  });
});

describe("write gate with the escape hatch off", () => {
  test("a diary-shaped learning stores again", async () => {
    process.env.OPENCODE_MEMORY_SYMPTOM = "off";
    const out = await runWriteGate(
      candidate(
        "learning",
        "In this session we fixed the rounding drift in totals",
      ),
      { liveRoot: root, evidenceCalls: [], hasGateCheck: true, trusted: true },
    );
    expect(out.action).toBe("promoted");
  });
});

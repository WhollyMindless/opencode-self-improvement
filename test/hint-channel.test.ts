import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { selectRelevant } from "../src/recall/relevant.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { capToBudget, injectedRows } from "../src/inject/budget.ts";
import type { Memory } from "../src/store/model/memory.ts";
import { loadPlugin, withTempStore } from "./harness.ts";

describe("capture-only hint injection (#343b)", () => {
  const fixture = withTempStore({ prefix: "osi-hint-channel-" });
  const row = (number: number, extra: Partial<Memory> = {}): Memory => ({
    ts: `2026-11-08T00:00:0${number}.000Z`,
    type: "context",
    scope: "pricing",
    content: `Guided pricing rule ${number}: the sales tax is 8.25 percent after discounts.`,
    tags: ["user-guided"],
    file: "fixture",
    index: number,
    ...extra,
  });

  test("guidance rides without lexical overlap, capped newest-first and never duplicated", async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row(n));
    const selection = await selectRelevant(
      "Repair deployment manifest",
      3,
      rows,
      undefined,
      undefined,
      { guidedCap: 3 },
    );
    expect(selection.selected).toEqual([rows[4], rows[3], rows[2]]);
    expect(selection.block).toContain("user-stated guidance may be stale");
    expect(selection.block).toContain("verify against the current code");
    const matching = await selectRelevant(
      "sales tax pricing",
      5,
      rows,
      undefined,
      undefined,
      { guidedCap: 3 },
    );
    expect(new Set(matching.selected).size).toBe(matching.selected.length);
  });

  test("pull-style selection stays query-driven; quarantined guidance never rides", async () => {
    expect(
      (await selectRelevant("Repair deployment manifest", 3, [row(1)]))
        .selected,
    ).toEqual([]);
    const quarantined = row(2, { tags: ["user-guided", "quarantine"] });
    expect(
      (
        await selectRelevant(
          "Repair deployment manifest",
          3,
          [quarantined],
          undefined,
          undefined,
          { guidedCap: 3 },
        )
      ).selected,
    ).toEqual([]);
    const selected = await selectRelevant(
      "",
      3,
      [row(1)],
      undefined,
      undefined,
      { guidedCap: 3 },
    );
    expect(
      injectedRows(capToBudget(selected.block, 1), selected.selected),
    ).toEqual([]);
  });

  test("the real prompt/context hooks deliver captured guidance on re-entry", async () => {
    const repo = join(fixture.root, "repo");
    mkdirSync(repo);
    const plugin = await loadPlugin(repo);
    try {
      await appendMemory({
        type: "context",
        scope: "pricing",
        content: "The sales tax rate is 8.25 percent, applied after discounts.",
        tags: ["auto-capture", "user-guided"],
        repo: "global",
      });
      await plugin.sessionHooks.prompt({
        sessionID: "hint-reentry",
        prompt: { text: "Repair deployment manifest" },
      });
      const out = {
        sessionID: "hint-reentry",
        system: [] as Array<{ type: string; text: string }>,
      };
      await plugin.sessionHooks.context(out);
      const block = out.system.map((part) => part.text).join("\n");
      expect(block).toContain("8.25 percent");
      expect(block).toContain("verify against the current code");
    } finally {
      await plugin.cleanup();
    }
  });
});

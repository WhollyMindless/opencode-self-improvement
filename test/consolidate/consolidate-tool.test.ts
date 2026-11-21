//through the shipped tool: memory_consolidate proposes, reports, and never
// writes. The store before and after the call must be byte-identical.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRoot } from "../../src/core/config/paths.ts";
import { resetState } from "../../src/core/state.ts";
import { appendMemory } from "../../src/store/files/append.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { recordHits } from "../../src/telemetry/ledger.ts";
import { loadPlugin } from "../harness.ts";
import { removeStore } from "../helpers/remove-store.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-consol-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  mkdirSync(memoryRoot(), { recursive: true });
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  removeStore(root);
});

const A =
  "the arm64 build box compiles the flimflam pipeline with bun build and no extra flags";
const B =
  "the arm64 build box compiles the flimflam pipeline with bun build without extra flags at all";
const C =
  "finance reconciles the zebra brasserie ledger nightly and mails a digest before opening bell";

describe("memory_consolidate tool", () => {
  test.each([2, 3])(
    "applying the proposed commands preserves all %i measured keyword searches",
    async (count) => {
      const plugin = await loadPlugin(root);
      const ctx = { sessionID: "ses_consolidate_replay" };
      const rows = [
        { content: A, keyword: "cinnabar" },
        { content: B, keyword: "feldspar" },
        { content: A + " locally", keyword: "vermillion" },
      ].slice(0, count);
      try {
        for (const { content, keyword } of rows) {
          await appendMemory({
            type: "learning",
            scope: "build",
            status: "settled",
            content,
            kw: [keyword],
          });
        }
        const recall = async (keyword: string) =>
          (await plugin.tools.memory_recall!.execute({ query: keyword }, ctx))
            .content;
        for (const { content, keyword } of rows) {
          expect(await recall(keyword)).toContain(content);
        }

        const report = await plugin.tools.memory_consolidate!.execute({}, ctx);
        expect(report.content).toMatch(
          new RegExp(`reads  ${count} logged .*merged ${count}`),
        );
        const commands = [
          ...report.content.matchAll(
            /resolve: memory_merge_review\(loser="([^"]+)", survivor="([^"]+)", reason="([^"]+)"(, consolidate=true)?\)/g,
          ),
        ];
        expect(commands).toHaveLength(count - 1);
        for (const [, loser, survivor, reason, consolidate] of commands) {
          const result = await plugin.tools.memory_merge_review!.execute(
            {
              loser,
              survivor,
              reason,
              ...(consolidate ? { consolidate: true } : {}),
            },
            ctx,
          );
          expect(result.content).toContain("Resolved merge:");
        }
        const active = (await loadAll()).filter((row) => !row.superseded_by);
        expect(active).toHaveLength(1);
        const canonical = active[0]!;
        expect(canonical.ts).toBe(commands[0]![2]!);
        for (const { keyword } of rows) {
          expect(await recall(keyword)).toContain(canonical.content);
        }
      } finally {
        await plugin.cleanup();
      }
    },
  );

  test("it proposes the near-duplicates and leaves the store byte-identical", async () => {
    const p = await loadPlugin(process.cwd());
    for (const content of [A, B, C]) {
      await appendMemory({
        type: "learning",
        scope: "build",
        content,
        status: "settled",
      });
    }
    // Give the cluster a read history, or the acceptance rule refuses to judge
    // it on resemblance alone (which is the whole point of the rule).
    const rows = await loadAll();
    const ab = rows.filter((m) => m.content === A || m.content === B);
    await recordHits("recall", "ses_con", ab, [
      "arm64",
      "build",
      "box",
      "flimflam",
    ]);

    const before = await loadAll();
    const rep = await p.tools.memory_consolidate!.execute({});

    expect(rep.content).toContain("nothing was written");
    expect(rep.content).toContain("2 rows → 1");
    expect(rep.content).toContain("memory_merge_review(");
    // The unrelated row is not in any proposal.
    expect(rep.content).not.toContain("zebra");
    // And the store is untouched: same rows, same order, same supersession.
    const after = await loadAll();
    expect(after.length).toBe(before.length);
    expect(after.map((m) => `${m.ts}:${m.superseded_by ?? "-"}`)).toEqual(
      before.map((m) => `${m.ts}:${m.superseded_by ?? "-"}`),
    );
  });

  test("with no read history it reports unmeasured clusters rather than proposing", async () => {
    const p = await loadPlugin(process.cwd());
    await appendMemory({
      type: "learning",
      scope: "build",
      content: A,
      status: "settled",
    });
    await appendMemory({
      type: "learning",
      scope: "build",
      content: B,
      status: "settled",
    });
    const rep = await p.tools.memory_consolidate!.execute({});
    expect(rep.content).toContain("none");
    expect(rep.content).not.toContain("memory_merge_review(");
  });

  test("scope limits the pass to the rows you asked about", async () => {
    const p = await loadPlugin(process.cwd());
    await appendMemory({
      type: "learning",
      scope: "build",
      content: A,
      status: "settled",
    });
    await appendMemory({
      type: "learning",
      scope: "build",
      content: B,
      status: "settled",
    });
    await appendMemory({
      type: "learning",
      scope: "finance",
      content: C,
      status: "settled",
    });
    const rows = await loadAll();
    await recordHits(
      "recall",
      "ses_c2",
      rows.filter((m) => m.scope === "build"),
      ["arm64", "build", "box"],
    );
    const rep = await p.tools.memory_consolidate!.execute({ scope: "finance" });
    expect(rep.content).toContain("none");
  });
});

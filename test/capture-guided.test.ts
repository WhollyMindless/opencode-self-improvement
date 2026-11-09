import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseCandidates } from "../src/capture/candidates.ts";
import { buildCapturePrompt } from "../src/capture/prompt.ts";
import { resetCaptureCooldowns, resetSessionModels } from "../src/index.ts";
import { loadAll } from "../src/store/files/load.ts";
import { loadPlugin, withTempStore } from "./harness.ts";
import { readEvidenceLog } from "./helpers/logfmt.ts";

const fact = {
  type: "context",
  scope: "pricing",
  content: "The sales tax rate is 8.25 percent after discounts.",
};

describe("capture guidance provenance (#343a)", () => {
  const fixture = withTempStore({ prefix: "osi-capture-guided-" });
  describe("capture contract", () => {
    let plugin: Awaited<ReturnType<typeof loadPlugin>> | undefined;
    beforeEach(() => {
      resetCaptureCooldowns();
      resetSessionModels();
    });
    afterEach(async () => {
      await plugin?.cleanup();
      plugin = undefined;
    });

    test("only literal guided:true is accepted; other metadata remains unchanged", () => {
      expect(
        parseCandidates(JSON.stringify([{ ...fact, guided: true }]), 3),
      ).toEqual([{ ...fact, guided: true }]);
      for (const guided of [false, "true", "yes", 1, null, {}]) {
        expect(
          parseCandidates(JSON.stringify([{ ...fact, guided }]), 3),
        ).toEqual([fact]);
      }
    });

    test("the prompt distinguishes user-stated facts from agent inference", () => {
      const prompt = buildCapturePrompt("user: The tax rate is 8.25%.");
      expect(prompt).toContain('"guided": true');
      expect(prompt).toContain("user STATED this fact");
      expect(prompt).toContain(
        "Omit guided for anything the agent discovered by itself",
      );
      expect(prompt).toContain("Few is better than full");
    });

    test("real capture keeps the reserved tag only on guided promotions", async () => {
      const repo = join(fixture.root, "repo");
      mkdirSync(repo);
      plugin = await loadPlugin(repo, {
        autoCapture: true,
        captureModel: "fake/model",
      });
      await plugin["tool.execute.after"](
        {
          tool: "read",
          sessionID: "guided-capture",
          callID: "read",
          args: { filePath: "pricing.ts" },
        },
        { output: "observed source", metadata: {} },
      );
      plugin.capture.context.messages = [
        { role: "user", content: fact.content.repeat(6) },
      ];
      plugin.capture.generate.response = JSON.stringify([
        { ...fact, guided: true },
        {
          type: "learning",
          scope: "importer",
          content:
            "The staging import API accepts two hundred rows in each batch.",
        },
      ]);
      plugin.capture.events.push({
        type: "session.execution.succeeded",
        data: { sessionID: "guided-capture" },
      });
      const deadline = Date.now() + 4000;
      while (
        !readEvidenceLog().some(
          (event) =>
            event.ev === "capture_lag" && event.session === "guided-capture",
        )
      ) {
        if (Date.now() >= deadline) throw new Error("capture did not complete");
        await Bun.sleep(5);
      }
      const rows = await loadAll();
      expect(rows.find((row) => row.scope === "pricing")?.tags).toEqual([
        "auto-capture",
        "user-guided",
      ]);
      expect(rows.find((row) => row.scope === "importer")?.tags).toEqual([
        "auto-capture",
      ]);
      expect(rows).toHaveLength(2);
    });
  });
});

// Ported from the retrieval-fix branch (d8ffe27): the verbatim quote field.
// Mystery 2 (FINDINGS §3): the bench's exact-text needle missed guided rows
// the capture model had paraphrased. `original` carries the user's words, and
// only the user's words — the runtime drops any quote that is not a
// transcript substring.
describe("verbatim original on guided rows", () => {
  const GOOD = {
    type: "learning",
    scope: "build",
    content: "Run the full test suite with bun test from the repo root.",
  };

  test("the prompt asks for a verbatim original on guided rows", () => {
    const p = buildCapturePrompt("user: the tax rate is 8.25%", 5);
    expect(p).toContain('"original"');
    expect(p).toContain("VERBATIM");
  });

  test("parseCandidates keeps original on guided rows; junk and ungguided drop it", () => {
    const full = { ...GOOD, guided: true, original: "the tax rate is 8.25%" };
    expect(parseCandidates(JSON.stringify([full]), 3)).toEqual([full]);
    // Not guided: original never attaches.
    const { guided: _g, ...unguided } = full;
    expect(parseCandidates(JSON.stringify([unguided]), 3)).toEqual([GOOD]);
    // Over-long or control-character quotes drop the field, never the row.
    expect(
      parseCandidates(
        JSON.stringify([{ ...GOOD, guided: true, original: "x".repeat(301) }]),
        3,
      ),
    ).toEqual([{ ...GOOD, guided: true }]);
    expect(
      parseCandidates(
        JSON.stringify([
          { ...GOOD, guided: true, original: "line one\nline two" },
        ]),
        3,
      ),
    ).toEqual([{ ...GOOD, guided: true }]);
  });
});

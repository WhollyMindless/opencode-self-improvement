import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildCapturePrompt } from "../src/capture/prompt.ts";
import { parseCandidates } from "../src/capture/candidates.ts";
import { resetCaptureCooldowns, resetSessionModels } from "../src/index.ts";
import { loadAll } from "../src/store/files/load.ts";
import { loadPlugin, withTempStore } from "./harness.ts";
import { readEvidenceLog } from "./helpers/logfmt.ts";

describe("capture contradiction emission (#350)", () => {
  const fixture = withTempStore({ prefix: "osi-conflict-emission-" });
  test.each([
    ["ref", "bad.path", undefined],
    ["ref", "A", undefined],
    ["ref", "A".repeat(65), undefined],
    ["ref", 12, undefined],
    ["claim", "x".repeat(33), undefined],
    ["claim", "0.08\n25", undefined],
    ["claim", " ", undefined],
    ["claim", " 0.0825 ", "0.0825"],
    ["klass", "unsure", undefined],
  ] as const)(
    "strict %s parsing retains prose and other valid fields (%j)",
    (field, value, expected) => {
      const valid = {
        type: "context",
        scope: "pricing",
        content: "The user requires a tax rate of 8.25 percent on orders.",
        guided: true,
        ref: "TAX_RATE",
        claim: "0.0825",
        klass: "spec",
      };
      const parsed = parseCandidates(
        JSON.stringify([{ ...valid, [field]: value }]),
        1,
      );
      expect(parsed).toHaveLength(1);
      const retained: Record<string, unknown> = { ...valid };
      if (expected === undefined) delete retained[field];
      else retained[field] = expected;
      expect<unknown>(parsed[0]).toEqual(retained);
    },
  );
  describe("promoted evidence", () => {
    let plugin: Awaited<ReturnType<typeof loadPlugin>> | undefined;
    beforeEach(() => {
      resetCaptureCooldowns();
      resetSessionModels();
    });
    afterEach(async () => {
      await plugin?.cleanup();
      plugin = undefined;
    });

    test("one worked example carries the strict triple and preserves the authority ban", () => {
      const prompt = buildCapturePrompt(
        "user: TAX_RATE in src/pricing.ts must be 0.0825",
      );
      expect(prompt).toContain(
        "only when the user actually states this requirement",
      );
      expect(prompt.match(/"ref":"TAX_RATE"/g)).toHaveLength(1);
      expect(prompt).toContain('"claim":"0.0825","klass":"spec"');
      expect(prompt).toContain("never claim what hidden tests");
      expect(prompt).toContain('omit "klass"');
    });

    test("full/partial/absent guided fields are auditable; junk never drops the prose", async () => {
      const repo = join(fixture.root, "repo");
      mkdirSync(repo);
      plugin = await loadPlugin(repo, {
        autoCapture: true,
        captureModel: "fake/model",
        captureMax: 4,
      });
      await plugin["tool.execute.after"](
        {
          tool: "read",
          sessionID: "emission",
          callID: "read",
          args: { filePath: "pricing.ts" },
        },
        { output: "observed source", metadata: {} },
      );
      plugin.capture.context.messages = [
        {
          role: "user",
          content:
            "The tax rate is 0.0825, the billing surcharge is 0.025, and the deployment retry limit is three. ".repeat(
              4,
            ),
        },
      ];
      plugin.capture.generate.response = JSON.stringify([
        {
          type: "context",
          scope: "tax",
          content:
            "The sales tax rate is 8.25 percent after applying discounts.",
          guided: true,
          ref: "TAX_RATE",
          claim: "0.0825",
          klass: "spec",
        },
        {
          type: "context",
          scope: "billing",
          content: "Late invoices have a billing surcharge of 2.5 percent.",
          guided: true,
          ref: "LATE_FEE",
          claim: "0.025",
          klass: "unsure",
        },
        {
          type: "context",
          scope: "limits",
          content:
            "The user stated RETRY_LIMIT must be three for deployment attempts.",
          guided: true,
          ref: "not an identifier",
          claim: "x".repeat(33),
          klass: "unsure",
        },
        {
          type: "learning",
          scope: "runner",
          content:
            "The agent observed that staging validates deployment manifests.",
          guided: false,
          ref: "STAGING",
          claim: "1",
          klass: "behavior",
        },
      ]);
      plugin.capture.events.push({
        type: "session.execution.succeeded",
        data: { sessionID: "emission" },
      });
      const deadline = Date.now() + 4000;
      while (
        !readEvidenceLog().some(
          (e) => e.ev === "capture_lag" && e.session === "emission",
        )
      ) {
        if (Date.now() >= deadline) throw new Error("capture did not complete");
        await Bun.sleep(5);
      }
      const promoted = readEvidenceLog().filter(
        (e) => e.ev === "auto_capture_promoted" && e.session === "emission",
      );
      expect(promoted).toHaveLength(4);
      expect(
        Object.fromEntries(promoted.map((e) => [e.scope, e.conflict])),
      ).toEqual({
        tax: "full",
        billing: "partial",
        limits: "absent",
        runner: undefined,
      });
      const rows = await loadAll();
      expect(rows).toHaveLength(4);
      expect(rows.find((row) => row.scope === "tax")).toMatchObject({
        ref: "TAX_RATE",
        claim: "0.0825",
        klass: "spec",
      });
      expect(
        rows.find((row) => row.scope === "billing")?.klass,
      ).toBeUndefined();
      expect(rows.find((row) => row.scope === "limits")?.ref).toBeUndefined();
      expect(rows.find((row) => row.scope === "runner")?.ref).toBeUndefined();
      expect(
        promoted.every(
          (e) =>
            !Object.hasOwn(e, "ref") &&
            !Object.hasOwn(e, "claim") &&
            !Object.hasOwn(e, "klass"),
        ),
      ).toBe(true);
    });
  });
});

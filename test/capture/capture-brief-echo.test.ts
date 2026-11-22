import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resetCaptureCooldowns, resetSessionModels } from "../../src/index.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { loadPlugin, withTempStore } from "../harness.ts";
import { readEvidenceLog } from "../helpers/logfmt.ts";

// The brief sentence the store turned into a permanent hint-channel row: the
// user did type it, so attribution alone cannot refuse it.
const BRIEF =
  "You are working in a scratch repository. Documentation in docs/ may be " +
  "stale: trust the code's invariants over the docs. Fix the failing test in " +
  "src/pricing.test.ts.";

const BOILERPLATE = {
  type: "preference",
  scope: "docs",
  content:
    "In this repository, src module invariants are authoritative over docs/ARCHITECTURE.md; documentation may contain stale behavior claims.",
  status: "settled",
  kw: ["docs", "ARCHITECTURE.md", "stale"],
  guided: true,
  original:
    "Documentation in docs/ may be stale: trust the code's invariants over the docs.",
};

async function capture(
  repo: string,
  brief: string,
  response: unknown,
  sid: string,
): Promise<Awaited<ReturnType<typeof loadPlugin>>> {
  const loaded = await loadPlugin(repo, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  for (const [call, tool, args, output] of [
    [
      "read",
      "read",
      { filePath: "src/pricing.ts" },
      "export const TAX_RATE = 0.0825;\n\nexport function total(n: number) {\n  return n * (1 + TAX_RATE);\n}\n",
    ],
    [
      "test",
      "bash",
      { command: "bun test src/pricing.test.ts" },
      "bun test v1.4.3\n(pass) total > applies the declared rate\n 1 pass\n 0 fail\n",
    ],
  ] as const) {
    await loaded["tool.execute.after"](
      { tool, sessionID: sid, callID: call, args },
      { output, metadata: {} },
    );
  }
  loaded.capture.context.messages = [
    { role: "user", content: brief },
    {
      role: "assistant",
      content:
        "Reading src/pricing.ts to see what the code declares, then running the failing test to confirm the expected value.",
    },
    {
      role: "user",
      content: "Yes. Make the change and re-run the test until it passes.",
    },
    {
      role: "assistant",
      content: "The test now passes after updating the constant.",
    },
  ];
  loaded.capture.generate.response = JSON.stringify(response);
  loaded.capture.events.push({
    type: "session.execution.succeeded",
    data: { sessionID: sid },
  });
  const deadline = Date.now() + 6000;
  while (
    !readEvidenceLog().some(
      (event) => event.ev === "capture_lag" && event.session === sid,
    )
  ) {
    if (Date.now() >= deadline) throw new Error("capture did not complete");
    await Bun.sleep(5);
  }
  return loaded;
}

describe("hint-channel entry in a real capture pass", () => {
  const fixture = withTempStore({ prefix: "osi-attest-" });
  let plugin: Awaited<ReturnType<typeof loadPlugin>> | undefined;
  beforeEach(() => {
    resetCaptureCooldowns();
    resetSessionModels();
  });
  afterEach(async () => {
    await plugin?.cleanup();
    plugin = undefined;
  });

  test("a brief sentence naming nothing the session used loses the grant", async () => {
    const repo = join(fixture.root, "repo-echo");
    mkdirSync(repo);
    plugin = await capture(repo, BRIEF, [BOILERPLATE], "attest-echo");
    const rows = await loadAll();
    const row = rows.find((r) => r.scope === "docs");
    expect(row?.content).toBe(BOILERPLATE.content);
    expect(row?.tags).toEqual(["auto-capture"]);
    expect(row?.original).toBeUndefined();
    expect(
      readEvidenceLog().find((event) => event.ev === "auto_capture_brief_echo"),
    ).toMatchObject({ withheld: "1", session: "attest-echo" });
  });

  test("a value stated in the brief keeps the grant and the verbatim quote", async () => {
    const repo = join(fixture.root, "repo-value");
    mkdirSync(repo);
    plugin = await capture(
      repo,
      "Fix src/pricing.test.ts. The constant TAX_RATE in src/pricing.ts must be 0.0825.",
      [
        {
          type: "context",
          scope: "pricing",
          content: "The constant TAX_RATE in src/pricing.ts must be 0.0825.",
          status: "settled",
          kw: ["TAX_RATE", "sales tax"],
          guided: true,
          original: "The constant TAX_RATE in src/pricing.ts must be 0.0825.",
          ref: "TAX_RATE",
          claim: "0.0825",
          klass: "spec",
        },
      ],
      "attest-value",
    );
    const rows = await loadAll();
    const row = rows.find((r) => r.scope === "pricing");
    expect(row?.tags).toEqual(["auto-capture", "user-guided"]);
    expect(row?.original).toBe(
      "The constant TAX_RATE in src/pricing.ts must be 0.0825.",
    );
    expect(
      readEvidenceLog().some((event) => event.ev === "auto_capture_brief_echo"),
    ).toBe(false);
  });

  test("a tool convention the session exercised keeps the grant", async () => {
    const repo = join(fixture.root, "repo-tool");
    mkdirSync(repo);
    plugin = await capture(
      repo,
      "Fix the failing test. We use bun here, not npm.",
      [
        {
          type: "preference",
          scope: "build",
          content: "Use bun, not npm, to run scripts and tests in this repo.",
          status: "settled",
          kw: ["bun", "npm", "package manager"],
          guided: true,
          original: "We use bun here, not npm.",
        },
      ],
      "attest-tool",
    );
    const rows = await loadAll();
    const row = rows.find((r) => r.scope === "build");
    expect(row?.tags).toEqual(["auto-capture", "user-guided"]);
    expect(row?.original).toBe("We use bun here, not npm.");
  });
});

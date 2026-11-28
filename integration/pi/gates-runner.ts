import assert from "node:assert/strict";
import {
  createBashTool,
  createPowerShellTool,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createPiMemory } from "../../src/adapters/pi/extension.ts";
import { readEvidenceLog } from "../../test/helpers/logfmt.ts";
import { openSession } from "./session.ts";

const [cwd, agentDir, baseUrl, stepsFile, shell = "bash"] =
  process.argv.slice(2);
const observed: Array<{ isError: boolean; details: unknown }> = [];
const fixture: ExtensionFactory = async (pi) => {
  await createPiMemory({ options: { autoCapture: false } })(pi);
  let next = 1;
  // Use Pi's real shell tool, substituting only the operating-system executor.
  // This checks its native error flag and structured exit fields for drift.
  const create = shell === "powershell" ? createPowerShellTool : createBashTool;
  pi.registerTool(
    create(cwd, {
      operations: {
        async exec(_command, _cwd, options) {
          options.onData(Buffer.from("test runner finished"));
          return { exitCode: next-- };
        },
      },
    }),
  );
  pi.on("tool_result", async (event) => {
    if (event.toolName === shell)
      observed.push({
        isError: event.isError,
        details:
          event.structuredContent &&
          typeof event.structuredContent === "object" &&
          "exit_code" in event.structuredContent
            ? { exit_code: event.structuredContent.exit_code }
            : undefined,
      });
  });
};
const { session, runtime } = await openSession(cwd, agentDir, baseUrl, {
  extensions: [fixture],
});
try {
  const call = (code: number) => ({
    tool_calls: [
      {
        id: `gate-${code}`,
        type: "function",
        function: {
          name: shell,
          arguments: JSON.stringify({ command: "bun test" }),
        },
      },
    ],
  });
  await Bun.write(
    stepsFile,
    JSON.stringify({
      "GATES::turn": [call(1), call(0), { content: "Recovered." }],
    }),
  );
  await session.prompt(
    "GATES::turn Run the scripted failing test, then the passing test.",
  );
  assert.deepEqual(observed, [
    { isError: true, details: { exit_code: 1 } },
    { isError: false, details: { exit_code: 0 } },
  ]);
  const log = readEvidenceLog();
  assert.deepEqual(
    log.filter((e) => e.ev === "gate_check").map((e) => e.status),
    ["FAIL", "PASS"],
  );
  assert.ok(
    log.some(
      (e) => e.ev === "t4_learning" && e.from === "FAIL" && e.to === "PASS",
    ),
  );
  console.log("GATES-PASS");
} finally {
  await runtime.dispose();
}

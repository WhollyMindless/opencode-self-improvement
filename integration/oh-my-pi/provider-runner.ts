import assert from "node:assert/strict";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@oh-my-pi/pi-ai";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { openSession } from "./session.ts";
import { loadAll } from "../../src/store/files/load.ts";

const [cwd, agentDir, baseUrl, stepsFile, extensionPath, scenario] =
  process.argv.slice(2);
const fact = "The nightly archive job keeps fourteen days of tarballs.";
const called = Promise.withResolvers<void>();
let calls = 0;
const provider: ExtensionFactory = (pi) => {
  pi.registerProvider("capture-fixture", {
    baseUrl: "https://unused.invalid",
    apiKey: "fixture-key",
    api: "capture-fixture-api",
    models: [
      {
        id: "capture",
        name: "Capture",
        input: ["text"],
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context) {
      calls++;
      assert.equal(model.id, "capture");
      assert.deepEqual(context.messages, []);
      assert.deepEqual(context.tools, []);
      assert.ok(JSON.stringify(context.systemPrompt).includes(fact));
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                type: "context",
                scope: "batch",
                content: fact,
                status: "settled",
              },
            ]),
          },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: scenario === "error" ? "error" : "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.end(message);
      called.resolve();
      return stream;
    },
  });
};
await Bun.write(
  process.env.OMP_MEMORY_CONFIG!,
  JSON.stringify({ captureModel: "capture-fixture/capture" }),
);
await Bun.write(join(cwd, "archive.txt"), fact);
await Bun.write(
  stepsFile,
  JSON.stringify({
    "PROVIDER::turn": [
      {
        tool_calls: [
          {
            id: "read",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: join(cwd, "archive.txt") }),
            },
          },
        ],
      },
      {
        content:
          "The archive policy has been verified and the importer respects the staging limit.",
      },
    ],
  }),
);
const { session } = await openSession(cwd, agentDir, baseUrl, {
  extensions: [provider],
  extensionPath,
});
try {
  await session.prompt(
    `PROVIDER::turn We finished the archive change. Remember that ${fact} The batch importer respects the staging rate limit per key, which matters while wiring the importer tooling.`,
  );
  await called.promise;
  await session.dispose();
  assert.equal(calls, 1);
  assert.deepEqual(
    (await loadAll()).map((row) => row.content),
    scenario === "error" ? [] : [fact],
  );
  console.log(`PROVIDER-PASS ${scenario}`);
} finally {
  await session.dispose();
}

import assert from "node:assert/strict";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { openSession } from "./session.ts";
import { loadAll } from "../../src/store/files/load.ts";

const [cwd, agentDir, baseUrl, stepsFile, extensionPath, scenario] =
  process.argv.slice(2);
const fact = "The nightly archive job keeps fourteen days of tarballs.";
const realNow = Date.now;
let called = Promise.withResolvers<void>();
const secondFact =
  "The batch importer stops after two retries when the queue returns a rate limit.";
let expectedFact = fact;
let calls = 0;
let ends = 0;
const provider: ExtensionFactory = (pi) => {
  pi.on("agent_end", async (_event, ctx) => {
    ends++;
    if (scenario === "aborted") ctx.abort();
  });
  if (scenario === "continuation")
    pi.on("agent_before_settle", async () => {
      if (ends === 1) {
        assert.equal(calls, 0, "an intermediate loop must not start capture");
        return {
          entries: [
            {
              type: "custom_message",
              customType: "continuation",
              content: "PROVIDER::turn Finish the archive verification.",
              display: false,
            },
          ],
          continue: true,
        };
      }
    });
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
      console.log("PROVIDER-STAGE completion");
      calls++;
      assert.equal(model.id, "capture");
      assert.equal(context.messages.length, 1);
      assert.equal(context.messages[0].role, "system");
      assert.ok(JSON.stringify(context.messages[0]).includes(expectedFact));
      if (scenario === "two-turns" && calls === 2)
        assert.ok(!JSON.stringify(context).includes("PROVIDER::turn"));
      assert.ok(!JSON.stringify(context).includes("toolsAdded"));
      if (scenario === "continuation")
        assert.ok(JSON.stringify(context).includes("FINAL-PHASE"));
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
                content: expectedFact,
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
      stream.push({ type: "start", partial: message });
      if (scenario === "error")
        stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      called.resolve();
      return stream;
    },
  });
};
await Bun.write(
  process.env.PI_MEMORY_CONFIG!,
  JSON.stringify({
    captureModel: "capture-fixture/capture",
    captureDelta: scenario === "two-turns",
  }),
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
if (scenario === "continuation") {
  const steps = await Bun.file(stepsFile).json();
  steps["PROVIDER::turn"].push({
    content:
      "FINAL-PHASE: archive verification and the continuation are complete.",
  });
  await Bun.write(stepsFile, JSON.stringify(steps));
}
console.log("PROVIDER-STAGE opening session");
const { session, runtime } = await openSession(cwd, agentDir, baseUrl, {
  extensions: [provider],
  extensionPath,
});
try {
  console.log("PROVIDER-STAGE prompting");
  await session.prompt(
    `PROVIDER::turn We finished the archive change. Remember that ${fact} The batch importer respects the staging rate limit per key, which matters while wiring the importer tooling.`,
  );
  if (scenario !== "aborted") {
    await called.promise;
    if (scenario === "two-turns") {
      const deadline = Date.now() + 5000;
      while (
        !(await loadAll()).some((row) => row.content === fact) &&
        Date.now() < deadline
      )
        await Bun.sleep(10);
      assert.ok((await loadAll()).some((row) => row.content === fact));
      // Advance past the shared five-minute capture cooldown without delaying
      // the native host test or resetting its transcript/cursor state.
      Date.now = () => realNow() + 6 * 60_000;
      expectedFact = secondFact;
      called = Promise.withResolvers<void>();
      await Bun.write(
        stepsFile,
        JSON.stringify({
          "PROVIDER::second": [
            {
              content:
                "The batch retry limit has been verified and the implementation is complete.",
            },
          ],
        }),
      );
      await fetch(new URL("/__reset", baseUrl), { method: "POST" });
      await session.prompt(
        `PROVIDER::second We finished the batch changes. Remember that ${secondFact} This durable importer setting belongs to the nightly archival pipeline.`,
      );
      await called.promise;
    }
  }
  await runtime.dispose();
  assert.equal(
    calls,
    scenario === "aborted" ? 0 : scenario === "two-turns" ? 2 : 1,
  );
  if (scenario === "continuation") assert.equal(ends, 2);
  assert.deepEqual(
    (await loadAll()).map((row) => row.content).sort(),
    scenario === "error" || scenario === "aborted"
      ? []
      : scenario === "two-turns"
        ? [fact, secondFact].sort()
        : [fact],
  );
  console.log(`PROVIDER-PASS ${scenario}`);
} finally {
  await runtime.dispose();
  Date.now = realNow;
}

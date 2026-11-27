import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { setupMemory } from "../../src/runtime/setup.ts";
import type { MemoryHost } from "../../src/host/runtime.ts";
import type { MemoryTool } from "../../src/host/contracts.ts";
import type { LifecycleHandlers } from "../../src/host/lifecycle.ts";
import { withTempStore } from "../harness.ts";
import { readEvidenceLog } from "../helpers/logfmt.ts";

const store = withTempStore({ prefix: "osi-runtime-" });
const PROJECT =
  "When azurite deployment reports a stale manifest: rebuild the project manifest using the cobalt queue before retrying the release.";
const GLOBAL =
  "When vermilion tooling reports an expired cache: refresh the shared cache using the saffron command before repeating the operation.";
const QUERY =
  "azurite deployment stale manifest and vermilion tooling expired cache";

function driver(directory?: string) {
  const tools = new Map<string, MemoryTool>();
  let handlers!: LifecycleHandlers;
  const host: MemoryHost = {
    tools: {
      directories: {},
      async registerTools(register) {
        register({
          add(tool) {
            tools.set(tool.name, tool);
          },
        });
      },
    },
    lifecycle: {
      async register(value) {
        handlers = value;
        return { async dispose() {} };
      },
    },
    capture: { subscribedEvents: [] },
  };
  let calls = 0;
  return {
    host,
    tools,
    start: () =>
      setupMemory(host, { directory, options: { autoCapture: false } }),
    invoke: (sid: string, name: string, args: unknown) =>
      tools
        .get(name)!
        .execute(args, { sessionID: sid, callID: `${sid}-${++calls}` }),
    async ground(sid: string) {
      await handlers.afterTool({
        sessionID: sid,
        callID: `${sid}-read`,
        tool: "read",
        args: {},
        text: "observed",
        metadata: {},
        appendResult: () => false,
      });
    },
    async request(sid: string, text: string) {
      const system: string[] = [];
      await handlers.prompt({ sessionID: sid, text });
      await handlers.context({
        sessionID: sid,
        observedResults: [],
        appendSystem(part) {
          system.push(part);
        },
      });
      return system.join("\n");
    },
  };
}

describe("shared runtime initialization", () => {
  test("independent normalized hosts share project/global memories and inject only selected visible rows", async () => {
    const project = join(store.root, "project");
    const otherProject = join(store.root, "other");
    mkdirSync(project);
    mkdirSync(otherProject);
    const writer = driver(project);
    const peer = driver(project);
    const outsider = driver(otherProject);
    const runtimes: Awaited<ReturnType<typeof setupMemory>>[] = [];
    try {
      for (const d of [writer, peer, outsider]) runtimes.push(await d.start());
      expect(writer.tools.size).toBe(14);
      await writer.ground("writer");
      for (const [content, scope, global] of [
        [PROJECT, "azurite", false],
        [GLOBAL, "vermilion", true],
      ] as const) {
        expect(
          (
            await writer.invoke("writer", "memory_remember", {
              type: "learning",
              scope,
              content,
              status: "settled",
              global,
            })
          ).content,
        ).toStartWith("Remembered:");
      }
      const recall = (
        await peer.invoke("peer", "memory_recall", { query: QUERY })
      ).content;
      expect(recall).toInclude(PROJECT);
      expect(recall).toInclude(GLOBAL);
      const relevant = await peer.request("peer-request", QUERY);
      expect(relevant).toInclude(PROJECT);
      expect(relevant).toInclude(GLOBAL);
      const unrelated = await peer.request(
        "peer-unrelated",
        "unrelated penguin migration",
      );
      expect(unrelated).not.toInclude(PROJECT);
      expect(unrelated).not.toInclude(GLOBAL);
      const foreign = await outsider.request("outsider", QUERY);
      expect(foreign).not.toInclude(PROJECT);
      expect(foreign).toInclude(GLOBAL);
      expect(existsSync(join(store.root, "commands"))).toBe(false);
      expect(
        readEvidenceLog().filter((line) => line.ev === "plugin_load"),
      ).toHaveLength(3);
    } finally {
      await Promise.all(runtimes.map((runtime) => runtime.dispose()));
    }
  });

  test("missing workspace cannot borrow another instance's project for writes", async () => {
    const project = join(store.root, "project");
    mkdirSync(project);
    const bound = driver(project);
    const ownerless = driver();
    const b = await ownerless.start();
    const a = await bound.start();
    try {
      const result = await ownerless.invoke("unbound", "memory_remember", {
        type: "context",
        scope: "plans",
        content: "We will evaluate the archive policy next week.",
        status: "open",
      });
      expect(result.content).toInclude("no resolvable repository");
    } finally {
      await Promise.all([a.dispose(), b.dispose()]);
    }
  });

  test("optional command installation is awaited before tools and hooks become available", async () => {
    const d = driver();
    const ready = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    d.host.installCommands = async () => {
      entered.resolve();
      await ready.promise;
    };
    const pending = d.start();
    await entered.promise;
    expect(d.tools.size).toBe(0);
    ready.resolve();
    const runtime = await pending;
    expect(d.tools.size).toBe(14);
    await runtime.dispose();
  });

  test("cleanup stops capture immediately and drains it despite an early lifecycle failure", async () => {
    const directory = join(store.root, "project");
    mkdirSync(directory);
    const d = driver(directory);
    const answer = Promise.withResolvers<string>();
    const requested = Promise.withResolvers<void>();
    let disposed = 0;
    let signal: AbortSignal | undefined;
    d.host.lifecycle.register = async () => ({
      async dispose() {
        disposed++;
        throw new Error("dispose failed");
      },
    });
    d.host.capture = {
      subscribedEvents: ["turn-end"],
      async *turnEndEvents(value) {
        signal = value;
        yield { sessionID: "draining" };
      },
      async readTranscript() {
        return [{ role: "user", text: PROJECT + GLOBAL }];
      },
      async generateText() {
        requested.resolve();
        return answer.promise;
      },
      defaultModel: () => ({ providerID: "fixture", id: "capture" }),
    };
    const runtime = await setupMemory(d.host, { directory });
    try {
      await requested.promise;
      const pending = runtime.dispose();
      expect(runtime.dispose()).toBe(pending);
      expect(signal?.aborted).toBe(true);
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await setImmediate();
      expect(settled).toBe(false);
      answer.resolve("[]");
      await expect(pending).rejects.toThrow("cleanup failed");
      expect(disposed).toBe(1);
    } finally {
      answer.resolve("[]");
      await runtime.dispose().catch(() => {});
    }
  });

  test("failure after hook registration releases the registered lifecycle", async () => {
    const d = driver();
    let disposed = 0;
    d.host.lifecycle.register = async () => ({
      async dispose() {
        disposed++;
      },
    });
    await expect(
      setupMemory(d.host, {
        options: { captureMax: Symbol("invalid number") },
      }),
    ).rejects.toThrow(TypeError);
    expect(disposed).toBe(1);
  });

  test("diagnostic labels cannot invent missing capture capabilities", async () => {
    const d = driver();
    d.host.capture = {
      subscribedEvents: [],
      capabilityLabels: {
        turnEndEvents: "events",
        generateText: "model",
        readTranscript: "transcript",
      },
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const runtime = await setupMemory(d.host);
      try {
        expect(d.tools.size).toBe(14);
        const heartbeat = readEvidenceLog().find(
          (line) => line.ev === "plugin_load",
        );
        expect(heartbeat?.capture).toBe("no_capabilities");
        expect(heartbeat?.capabilities).toBe("[]");
        expect(warn).toHaveBeenCalled();
      } finally {
        await runtime.dispose();
      }
    } finally {
      warn.mockRestore();
    }
  });
});

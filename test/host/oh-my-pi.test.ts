import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import extension from "../../src/adapters/oh-my-pi/extension.ts";
import type {
  OmpAPI,
  OmpContext,
  OmpEvents,
  OmpTool,
} from "../../src/adapters/oh-my-pi/context.ts";
import { withTempStore } from "../helpers/temp-store.ts";

const store = withTempStore({ prefix: "osi-omp-" });
const PROJECT =
  "When azurite deployment reports a stale manifest: rebuild the project manifest using the cobalt queue before retrying the release.";
const GLOBAL =
  "When vermilion tooling reports an expired cache: refresh the shared cache using the saffron command before repeating the operation.";
const QUERY =
  "azurite deployment stale manifest and vermilion tooling expired cache";

async function driver(cwd: string) {
  const handlers = new Map<string, (event: any, ctx: OmpContext) => unknown>();
  const tools = new Map<string, OmpTool>();
  const api: OmpAPI = {
    on: (name, handler) => {
      handlers.set(name, handler);
    },
    registerTool: (tool) => {
      tools.set(tool.name, tool);
    },
  };
  await extension(api);
  const context = (sid: string): OmpContext => ({
    cwd,
    sessionManager: { getSessionId: () => sid },
  });
  const emit = async <K extends keyof OmpEvents>(
    name: K,
    event: OmpEvents[K],
    sid = "same-id",
  ) => handlers.get(name)?.(event, context(sid));
  return {
    tools,
    context,
    emit,
    async invoke(name: string, args: unknown, sid = "same-id") {
      const result = await tools
        .get(name)!
        .execute("call", args, undefined, undefined, context(sid));
      return result.content.map((p) => p.text).join("\n");
    },
    async prompt(text: string, sid: string) {
      const event = {
        reason: "prompt" as const,
        prompt: text,
        systemPrompt: ["Host instructions"],
      };
      const result = (await emit("before_agent_start", event, sid)) as {
        systemPrompt: string[];
      };
      expect(event.systemPrompt).toEqual(["Host instructions"]);
      return result.systemPrompt.join("\n");
    },
    close: () => emit("session_shutdown", {}),
  };
}

describe("oh-my-pi exploratory adapter", () => {
  test("real tools share rows, isolate colliding host session IDs, and select visible context", async () => {
    const project = join(store.root, "project");
    const other = join(store.root, "other");
    mkdirSync(project);
    mkdirSync(other);
    const writer = await driver(project);
    const peer = await driver(project);
    const outsider = await driver(other);
    try {
      expect(writer.tools.size).toBe(14);
      expect(writer.tools.get("memory_remember")!.parameters.type).toBe(
        "object",
      );
      await writer.emit("tool_result", {
        toolName: "read",
        toolCallId: "read",
        input: {},
        content: [{ type: "text", text: PROJECT }],
        isError: false,
      });
      expect(
        await outsider.invoke("memory_remember", {
          type: "learning",
          scope: "azurite",
          content: PROJECT,
          status: "settled",
        }),
      ).toInclude("Write blocked at GATE");
      for (const [content, scope, global] of [
        [PROJECT, "azurite", false],
        [GLOBAL, "vermilion", true],
      ] as const) {
        expect(
          await writer.invoke("memory_remember", {
            type: "learning",
            scope,
            content,
            status: "settled",
            global,
          }),
        ).toStartWith("Remembered:");
      }
      expect(await peer.invoke("memory_recall", { query: QUERY })).toInclude(
        PROJECT,
      );
      const foreign = await outsider.invoke("memory_recall", { query: QUERY });
      expect(foreign).not.toInclude(PROJECT);
      expect(foreign).toInclude(GLOBAL);
      expect(await peer.prompt(QUERY, "relevant")).toInclude(PROJECT);
      expect(await peer.prompt("penguin migration", "unrelated")).not.toInclude(
        PROJECT,
      );
      const selected = await outsider.prompt(QUERY, "relevant");
      expect(selected).not.toInclude(PROJECT);
      expect(selected).toInclude(GLOBAL);
    } finally {
      await Promise.all([writer.close(), peer.close(), outsider.close()]);
    }
  });

  test("failed reads do not ground writes and malformed arguments still fail validation", async () => {
    const d = await driver(store.root);
    try {
      await d.emit("tool_result", {
        toolName: "read",
        toolCallId: "read",
        input: {},
        content: [{ type: "text", text: PROJECT }],
        isError: true,
      });
      const row = {
        type: "learning",
        scope: "azurite",
        content: PROJECT,
        status: "settled",
      };
      expect(await d.invoke("memory_remember", row)).toInclude(
        "Write blocked at GATE",
      );
      expect(
        await d.invoke("memory_remember", { ...row, global: "false" }),
      ).toStartWith("invalid arguments");
    } finally {
      await d.close();
    }
  });

  test("missing identity and late or aborted calls fail closed", async () => {
    const d = await driver("");
    const tool = d.tools.get("memory_recall")!;
    await expect(
      tool.execute("call", {}, undefined, undefined, d.context("sid")),
    ).rejects.toThrow("identity");
    await d.close();
    await d.close();
    expect(
      await d.emit("before_agent_start", {
        reason: "prompt",
        prompt: QUERY,
        systemPrompt: [],
      }),
    ).toBeUndefined();
    await expect(d.invoke("memory_remember", {})).rejects.toThrow("closed");
    const live = await driver(store.root);
    try {
      await expect(
        live.tools
          .get("memory_remember")!
          .execute(
            "call",
            {},
            AbortSignal.abort(),
            undefined,
            live.context("sid"),
          ),
      ).rejects.toThrow();
      expect(
        await live.emit("before_agent_start", {
          reason: "revive",
          prompt: "",
          systemPrompt: [],
        }),
      ).toBeUndefined();
    } finally {
      await live.close();
    }
  });

  test("partial registration failure leaves already registered tools inert", async () => {
    const tools: OmpTool[] = [];
    const handlers = new Map<
      string,
      (event: any, ctx: OmpContext) => unknown
    >();
    await expect(
      extension({
        on: (name, handler) => {
          handlers.set(name, handler);
        },
        registerTool: (tool) => {
          if (tools.length === 3) throw new Error("registration refused");
          tools.push(tool);
        },
      }),
    ).rejects.toThrow("registration refused");
    expect(tools).toHaveLength(3);
    const ctx = {
      cwd: store.root,
      sessionManager: { getSessionId: () => "partial" },
    };
    for (const tool of tools)
      await expect(
        tool.execute("late", {}, undefined, undefined, ctx),
      ).rejects.toThrow("closed");
    await handlers.get("session_shutdown")?.({}, ctx);
  });
});

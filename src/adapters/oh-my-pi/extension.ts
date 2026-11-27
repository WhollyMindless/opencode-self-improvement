import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { LifecycleHandlers } from "../../host/lifecycle.ts";
import type { MemoryRuntime } from "../../host/runtime.ts";
import { setupMemory } from "../../runtime/setup.ts";
import type { OmpAPI, OmpContext, OmpEvents } from "./context.ts";

/** Exploratory tools/context adapter; capture and contextual pulls are not wired. */
export default async function ohMyPiMemory(pi: OmpAPI): Promise<void> {
  const namespace = `oh-my-pi:${randomUUID()}:`;
  const pending = new Set<Promise<unknown>>();
  let handlers: LifecycleHandlers | undefined;
  let runtime: MemoryRuntime | undefined;
  let closed = false;

  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }

  function identity(ctx: OmpContext): string {
    const id = ctx.sessionManager.getSessionId();
    if (!id?.trim() || !ctx.cwd?.trim() || !isAbsolute(ctx.cwd)) {
      throw new Error(
        "oh-my-pi memory requires a session and absolute workspace identity",
      );
    }
    const sessionID = namespace + id;
    handlers!.identity({ sessionID, directory: ctx.cwd });
    return sessionID;
  }

  function on<K extends keyof OmpEvents>(
    name: K,
    run: (
      event: OmpEvents[K],
      sessionID: string,
    ) => Promise<void | { systemPrompt: string[] }>,
  ): void {
    pi.on(name, async (event, ctx) => {
      if (closed || !handlers) return;
      // Capture identity before awaiting: other sessions may run in the meantime.
      const sessionID = identity(ctx);
      return track(run(event, sessionID));
    });
  }

  pi.on("session_shutdown", async () => {
    closed = true;
    await runtime?.dispose();
  });

  try {
    runtime = await setupMemory(
      {
        tools: {
          directories: {},
          async registerTools(register) {
            register({
              add(tool) {
                pi.registerTool({
                  name: tool.name,
                  label: tool.name,
                  description: tool.description,
                  parameters: tool.input,
                  loadMode: "essential",
                  async execute(callID, args, signal, _onUpdate, ctx) {
                    if (closed || !handlers)
                      throw new Error("oh-my-pi memory is closed");
                    signal?.throwIfAborted();
                    const sessionID = identity(ctx);
                    const result = await track(
                      tool.execute(args, { sessionID, callID }),
                    );
                    return {
                      content: [{ type: "text", text: result.content }],
                      details: {},
                    };
                  },
                });
              },
            });
          },
        },
        lifecycle: {
          async register(shared) {
            handlers = shared;
            on("session_start", async () => {});
            on("before_agent_start", async (event, sessionID) => {
              if (event.reason === "revive") return;
              const systemPrompt = [...event.systemPrompt];
              await shared.prompt({ sessionID, text: event.prompt });
              await shared.context({
                sessionID,
                observedResults: [],
                appendSystem: (text) => systemPrompt.push(text),
              });
              return { systemPrompt };
            });
            on("tool_call", async (event, sessionID) => {
              await shared.beforeTool({
                sessionID,
                callID: event.toolCallId,
                tool: event.toolName,
              });
            });
            on("tool_result", async (event, sessionID) => {
              // A failed read must not become grounding evidence for a settled write.
              if (event.isError) return;
              const text = event.content
                .filter((p) => p.type === "text")
                .map((p) => p.text ?? "")
                .join("\n");
              await shared.afterTool({
                sessionID,
                callID: event.toolCallId,
                tool: event.toolName,
                args: event.input,
                text,
                metadata:
                  event.details && typeof event.details === "object"
                    ? (event.details as Record<string, unknown>)
                    : {},
                appendResult: () => false,
              });
            });
            on("session_compact", async (_event, sessionID) => {
              await shared.compact({ sessionID, transcript: undefined });
            });
            return {
              async dispose() {
                closed = true;
                await Promise.allSettled([...pending]);
              },
            };
          },
        },
        capture: { subscribedEvents: [] },
      },
      { options: { autoCapture: false, pullTools: [] } },
    );
    // Shutdown may arrive while startup diagnostics are still being written.
    if (closed) await runtime.dispose();
  } catch (error) {
    closed = true;
    await Promise.allSettled([...pending]);
    throw error;
  }
}

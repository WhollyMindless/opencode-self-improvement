import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { LifecycleHandlers } from "../../host/lifecycle.ts";
import type { MemoryRuntime } from "../../host/runtime.ts";
import { setupMemory } from "../../runtime/setup.ts";
import type {
  OmpAPI,
  OmpContent,
  OmpContext,
  OmpEvents,
  OmpEventResult,
} from "./context.ts";
import { createOhMyPiCapture, type OmpCaptureBinding } from "./capture.ts";
import { appendPull, observedToolResults, textContent } from "./delivery.ts";
import { sessionUsage } from "./usage.ts";

export function createOhMyPiMemory<C extends OmpContext = OmpContext>(
  config: {
    capture?: (ctx: C) => OmpCaptureBinding | undefined;
    options?: Record<string, unknown>;
  } = {},
) {
  return async function ohMyPiMemory(pi: OmpAPI<C>): Promise<void> {
    const capture = createOhMyPiCapture();
    const namespace = `oh-my-pi:${randomUUID()}:`;
    const pending = new Set<Promise<unknown>>();
    const initialized = Promise.withResolvers<void>();
    let generation = 0;
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
      const sessionID = `${namespace}${generation}:${id}`;
      handlers!.identity({ sessionID, directory: ctx.cwd });
      return sessionID;
    }

    function on<K extends keyof OmpEvents>(
      name: K,
      run: (
        event: OmpEvents[K],
        sessionID: string,
        ctx: C,
      ) => Promise<OmpEventResult<K>>,
    ): void {
      pi.on(name, async (event, ctx) => {
        if (closed || !handlers) return;
        // Capture identity before awaiting: other sessions may run in the meantime.
        const sessionID = identity(ctx);
        return track(run(event, sessionID, ctx));
      });
    }

    async function reportUsage(sessionID: string, ctx: C): Promise<void> {
      const usage = sessionUsage(ctx, sessionID);
      if (usage) await handlers!.usage(usage);
    }

    pi.on("session_shutdown", async (_event, ctx) => {
      // Capture the history and identity before shutdown can replace host state.
      if (!closed && handlers) {
        try {
          track(reportUsage(identity(ctx), ctx));
        } catch {
          // A host may have already discarded identity; cleanup must still run.
        }
      }
      closed = true;
      await initialized.promise;
      await runtime?.dispose();
    });

    try {
      runtime = await setupMemory(
        {
          harness: "oh-my-pi",
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
              on("session_start", async (_event, sessionID, ctx) => {
                await reportUsage(sessionID, ctx);
              });
              on("agent_end", async (event, sessionID, ctx) => {
                const binding =
                  !event.willContinue &&
                  !event.awaitingAsyncWork &&
                  config.options?.autoCapture !== false
                    ? config.capture?.(ctx)
                    : undefined;
                await reportUsage(sessionID, ctx);
                if (binding) await capture.publish(sessionID, binding);
              });
              for (const name of [
                "session_switch",
                "session_clear",
                "session_tree",
                "session_branch",
              ] as const) {
                pi.on(name, async (_event, ctx) => {
                  if (closed) return;
                  // Transcript replacement can retain the host ID. Old grounding
                  // and frozen context must not become evidence in the new view.
                  generation++;
                  await track(reportUsage(identity(ctx), ctx));
                });
              }
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
              on("context", async (event, sessionID) => {
                await shared.context({
                  sessionID,
                  observedResults: observedToolResults(event.messages),
                });
              });
              on("tool_result", async (event, sessionID) => {
                // A failed read must not become grounding evidence for a settled write.
                if (event.isError) return;
                const text = textContent(event.content);
                let content: OmpContent[] | undefined;
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
                  appendResult: (after) => {
                    content = appendPull(event.content, text, after);
                    return content !== undefined;
                  },
                });
                if (content) return { content };
              });
              on("session.compacting", async (event, sessionID, ctx) => {
                if (event.sessionId !== ctx.sessionManager.getSessionId())
                  return;
                const context: string[] = [];
                await shared.compact({
                  sessionID,
                  phase: "prepare",
                  transcript: undefined,
                  appendSystem: (text) => context.push(text),
                });
                if (context.length) return { context };
              });
              on("session_compact", async (_event, sessionID) => {
                await shared.compact({
                  sessionID,
                  phase: "complete",
                  transcript: undefined,
                });
              });
              return {
                async dispose() {
                  closed = true;
                  capture.close();
                  await Promise.allSettled([...pending]);
                },
              };
            },
          },
          capture: config.capture ? capture.host : { subscribedEvents: [] },
        },
        {
          options: {
            autoCapture: !!config.capture,
            ...config.options,
            captureOnCompact: false,
          },
        },
      );
      // Shutdown may arrive while startup diagnostics are still being written.
      if (closed) await runtime.dispose();
    } catch (error) {
      closed = true;
      capture.close();
      await Promise.allSettled([...pending]);
      throw error;
    } finally {
      initialized.resolve();
    }
  };
}

/** Tools/context entry point; capture requires an explicitly bound completion. */
export default createOhMyPiMemory();

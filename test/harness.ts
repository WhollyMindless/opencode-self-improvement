// Shared test harness for the OpenCode V2 plugin. Loads the plugin by running
// its `setup(ctx)` against a fake V2 context that captures registered tools,
// tools/hooks and commands. Also exposes a V1-shaped `hooks` adapter so tests
// written against the old `await SelfImprovement(ctx)` contract keep working
// while exercising the real V2 registrations (including the fail-closed guards).
//
// Phase 4 fakes (all inert by default, backward compatible):
//   - `options`: passed through to the plugin (autoCapture etc.)
//   - `capture.events`: a push-queue async iterable backing event.subscribe.
//     The test calls push(event) to feed the plugin's `for await` loop; the
//     loop parks between events and wakes on push, on abort, or on close().
//     subscribeCalls proves "default OFF never subscribes".
//   - `capture.generate`: canned generate.text reply + call log.
//   - `capture.context`: canned session.context messages + call log.
//   - `cleanup`: whatever setup() returned (no-op when it returned nothing).
import plugin from "../index.ts";

type ToolRecord = {
  name: string;
  description: string;
  input: unknown;
  execute: (args: any, ctx?: any) => Promise<{ content: string }>;
};

export interface CaptureFakes {
  events: {
    subscribeCalls: number;
    signals: AbortSignal[];
    push: (event: unknown) => void;
    close: () => void;
  };
  generate: {
    calls: Array<{ prompt: string; model: unknown }>;
    response: string;
  };
  context: {
    calls: string[];
    messages: unknown;
  };
}

export interface LoadedPlugin {
  tools: Record<string, ToolRecord>;
  toolHooks: Record<string, (event: any) => Promise<void>>;
  sessionHooks: Record<string, (event: any) => Promise<void>>;
  commands: Record<string, { name: string; execute: (input: any) => Promise<void> }>;
  capture: CaptureFakes;
  cleanup: () => void | Promise<void>;
  // V1-shaped adapter (delegates to the real V2 registrations)
  tool: Record<string, { execute: (args: any) => Promise<string> }>;
  "tool.execute.before": (input: any) => Promise<void>;
  "tool.execute.after": (input: any, output: any) => Promise<void>;
  "experimental.chat.system.transform": (input: any, output: any) => Promise<void>;
  "experimental.session.compacting": (input: any, output: any) => Promise<void>;
}

export async function loadPlugin(
  directory = process.cwd(),
  options?: Record<string, unknown>,
): Promise<LoadedPlugin> {
  const tools: Record<string, ToolRecord> = {};
  const toolHooks: Record<string, (event: any) => Promise<void>> = {};
  const sessionHooks: Record<string, (event: any) => Promise<void>> = {};
  const commands: Record<string, { name: string; execute: (input: any) => Promise<void> }> = {};

  // --- Phase 4 fakes ---------------------------------------------------------
  const queue: unknown[] = [];
  let notify: (() => void) | null = null;
  let queueClosed = false;
  // Push-queue async iterable: parks between events and wakes on push(),
  // close(), or the plugin's abort. (An async GENERATOR, not an object-literal
  // [Symbol.asyncIterator] async method — Bun 1.4.3 drops the latter's method
  // from the transpiled object literal.)
  async function* iterateEvents(signal?: AbortSignal): AsyncGenerator<unknown> {
    for (;;) {
      if (queue.length) yield queue.shift();
      else if (queueClosed || signal?.aborted) return;
      else {
        await new Promise<void>((resolve) => {
          const done = () => {
            notify = null;
            signal?.removeEventListener("abort", done);
            resolve();
          };
          notify = done;
          signal?.addEventListener("abort", done, { once: true });
        });
      }
    }
  }
  const capture: CaptureFakes = {
    events: {
      subscribeCalls: 0,
      signals: [],
      push: (event) => {
        queue.push(event);
        notify?.();
      },
      close: () => {
        queueClosed = true;
        notify?.();
      },
    },
    generate: { calls: [], response: "" },
    context: { calls: [], messages: [] },
  };

  const ctx = {
    location: { directory },
    options: options ?? {},
    tool: {
      transform: async (cb: (editor: { add: (t: ToolRecord) => void }) => void) =>
        cb({ add: (t) => void (tools[t.name] = t) }),
      hook: async (n: string, cb: (event: any) => Promise<void>) => void (toolHooks[n] = cb),
    },
    command: {
      transform: async (cb: (editor: { add: (c: any) => void }) => void) =>
        cb({ add: (c) => void (commands[c.name] = c) }),
    },
    session: {
      hook: async (n: string, cb: (event: any) => Promise<void>) => void (sessionHooks[n] = cb),
      prompt: async (input: any) => ({ ok: true, input }),
      context: async (input: any) => {
        capture.context.calls.push(String(input?.sessionID ?? ""));
        return capture.context.messages;
      },
    },
    event: {
      subscribe: (o?: { signal?: AbortSignal }) => {
        capture.events.subscribeCalls++;
        if (o?.signal) capture.events.signals.push(o.signal);
        return iterateEvents(o?.signal);
      },
    },
    generate: {
      text: async (input: any) => {
        capture.generate.calls.push({
          prompt: String(input?.prompt ?? ""),
          model: input?.model,
        });
        return { text: capture.generate.response };
      },
    },
  };

  const cleanup = await plugin.setup(ctx as never);

  const tool: LoadedPlugin["tool"] = {};
  for (const [name, t] of Object.entries(tools)) {
    tool[name] = { execute: async (args: any) => (await t.execute(args, {})).content };
  }

  return {
    tools,
    toolHooks,
    sessionHooks,
    commands,
    capture,
    cleanup: typeof cleanup === "function" ? (cleanup as () => void | Promise<void>) : () => {},
    tool,
    "tool.execute.before": async (input: any) => {
      await toolHooks["execute.before"]?.({
        sessionID: input?.sessionID,
        callID: input?.callID,
        tool: input?.tool,
      });
    },
    "tool.execute.after": async (input: any, output: any) => {
      await toolHooks["execute.after"]?.({
        sessionID: input?.sessionID,
        callID: input?.callID,
        tool: input?.tool,
        input: input?.args,
        result: { content: output?.output, metadata: output?.metadata },
      });
    },
    // Drive the real session.context hook (guarded), mapping its text parts
    // back onto the V1 `output.system: string[]` shape.
    "experimental.chat.system.transform": async (input: any, output: any) => {
      const parts: Array<{ type: string; text: string }> = [];
      await sessionHooks["context"]?.({ sessionID: input?.sessionID, system: parts });
      if (Array.isArray(output?.system)) for (const p of parts) output.system.push(p.text);
    },
    // Drive the real session.compaction hook (guarded), mirroring the context
    // adapter: the hook sees a `system` parts array and pushed part texts are
    // copied back onto `output.system` when the caller provided one.
    "experimental.session.compacting": async (input: any, output: any) => {
      const parts: Array<{ type: string; text: string }> = [];
      await sessionHooks["compaction"]?.({ sessionID: input?.sessionID, system: parts });
      if (Array.isArray(output?.system)) for (const p of parts) output.system.push(p.text);
    },
  };
}

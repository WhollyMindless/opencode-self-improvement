// Shared test harness for the OpenCode V2 plugin. Loads the plugin by running
// its `setup(ctx)` against a fake V2 context that captures registered tools,
// tools/hooks and commands. Also exposes a V1-shaped `hooks` adapter so tests
// written against the old `await SelfImprovement(ctx)` contract keep working
// while exercising the real V2 registrations (including the fail-closed guards).
import plugin from "../index.ts";
import { systemDigest } from "../src/inject.ts";

type ToolRecord = {
  name: string;
  description: string;
  input: unknown;
  execute: (args: any, ctx?: any) => Promise<{ content: string }>;
};

export interface LoadedPlugin {
  tools: Record<string, ToolRecord>;
  toolHooks: Record<string, (event: any) => Promise<void>>;
  sessionHooks: Record<string, (event: any) => Promise<void>>;
  commands: Record<string, { name: string; execute: (input: any) => Promise<void> }>;
  // V1-shaped adapter (delegates to the real V2 registrations)
  tool: Record<string, { execute: (args: any) => Promise<string> }>;
  "tool.execute.before": (input: any) => Promise<void>;
  "tool.execute.after": (input: any, output: any) => Promise<void>;
  "experimental.chat.system.transform": (input: any, output: any) => Promise<void>;
  "experimental.session.compacting": (input: any, output: any) => Promise<void>;
}

export async function loadPlugin(directory = process.cwd()): Promise<LoadedPlugin> {
  const tools: Record<string, ToolRecord> = {};
  const toolHooks: Record<string, (event: any) => Promise<void>> = {};
  const sessionHooks: Record<string, (event: any) => Promise<void>> = {};
  const commands: Record<string, { name: string; execute: (input: any) => Promise<void> }> = {};

  const ctx = {
    location: { directory },
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
    },
  };

  await plugin.setup(ctx as never);

  const tool: LoadedPlugin["tool"] = {};
  for (const [name, t] of Object.entries(tools)) {
    tool[name] = { execute: async (args: any) => (await t.execute(args, {})).content };
  }

  return {
    tools,
    toolHooks,
    sessionHooks,
    commands,
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

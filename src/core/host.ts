// Structural subset of the OpenCode host used by setup and hook wiring (#168).
interface ToolDef {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options?: { codemode?: boolean; namespace?: string };
  execute: (args: any, context: any) => Promise<{ content: string }>;
}
interface ToolEditorLike {
  add: (tool: ToolDef) => void;
}
interface HookReg {
  dispose?: () => Promise<void> | void;
}
export interface PluginCtx {
  location?: { directory?: string };
  options?: Record<string, unknown>;
  tool?: {
    transform: (cb: (editor: ToolEditorLike) => void) => Promise<unknown>;
    hook: (
      name: string,
      cb: (event: any) => Promise<void> | void,
    ) => Promise<HookReg | void>;
  };
  session?: {
    hook: (
      name: string,
      cb: (event: any) => Promise<void> | void,
    ) => Promise<HookReg | void>;
    context?: (input: { sessionID: string }) => Promise<unknown>;
    get?: (input: { sessionID: string }) => Promise<unknown>;
  };
  event?: {
    subscribe: (o?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
  };
  generate?: {
    text: (input: unknown) => Promise<{ text?: string } | string>;
  };
}

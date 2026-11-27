// Structural subset of oh-my-pi 19.2.1. Keep its SDK out of OpenCode installs.
export interface OmpContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
}

export type OmpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface OmpEvents {
  agent_end: {
    messages: readonly unknown[];
    willContinue?: boolean;
    awaitingAsyncWork?: boolean;
  };
  session_start: unknown;
  session_switch: unknown;
  session_clear: unknown;
  session_tree: unknown;
  session_branch: unknown;
  session_shutdown: unknown;
  session_compact: unknown;
  context: { messages: readonly unknown[] };
  before_agent_start: {
    reason: "prompt" | "revive";
    prompt: string;
    systemPrompt: string[];
  };
  tool_call: { toolName: string; toolCallId: string };
  tool_result: {
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
    content: readonly OmpContent[];
    details?: unknown;
    isError: boolean;
  };
}

export type OmpEventResult<K extends keyof OmpEvents> =
  | void
  | (K extends "before_agent_start"
      ? { systemPrompt: string[] }
      : K extends "tool_result"
        ? { content: OmpContent[] }
        : never);

export interface OmpTool<C extends OmpContext = OmpContext> {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  loadMode: "essential";
  execute(
    callID: string,
    args: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: C,
  ): Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
}

export interface OmpAPI<C extends OmpContext = OmpContext> {
  registerTool(tool: OmpTool<C>): void;
  on<K extends keyof OmpEvents>(
    event: K,
    handler: (event: OmpEvents[K], ctx: C) => Promise<OmpEventResult<K>>,
  ): void;
}

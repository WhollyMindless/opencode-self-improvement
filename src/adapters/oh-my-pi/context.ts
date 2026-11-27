// Structural subset of oh-my-pi 19.2.1. Keep its SDK out of OpenCode installs.
export interface OmpContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
}

export interface OmpEvents {
  session_start: unknown;
  session_switch: unknown;
  session_clear: unknown;
  session_tree: unknown;
  session_branch: unknown;
  session_shutdown: unknown;
  session_compact: unknown;
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
    content: readonly { type: string; text?: string }[];
    details?: unknown;
    isError: boolean;
  };
}

export interface OmpTool {
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
    ctx: OmpContext,
  ): Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
}

export interface OmpAPI {
  registerTool(tool: OmpTool): void;
  on<K extends keyof OmpEvents>(
    event: K,
    handler: (
      event: OmpEvents[K],
      ctx: OmpContext,
    ) => Promise<void | { systemPrompt: string[] }>,
  ): void;
}

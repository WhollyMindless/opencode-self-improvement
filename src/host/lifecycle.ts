import type { ToolCallContext } from "./contracts.ts";
import type { SessionModelRef } from "../capture/session-model.ts";
import type { SessionIdentity, SessionUsage } from "../host/observations.ts";

/** One independently observed tool-result copy in the outgoing request. */
export interface ObservedToolResult {
  callID: string;
  tool: string;
  text: string;
}

export interface ToolEvent extends ToolCallContext {
  tool?: string;
}

export interface ToolResultEvent extends ToolEvent {
  args: unknown;
  text: string;
  metadata: Record<string, unknown>;
  /** True means placed, not delivered. A request observation confirms delivery. */
  appendResult(after: string): boolean;
}

export interface ContextEvent {
  sessionID?: string;
  model?: SessionModelRef;
  observedResults: readonly ObservedToolResult[];
  /** Absent when this host cannot accept system context. */
  appendSystem?: (text: string) => void;
}

export interface PromptEvent {
  sessionID?: string;
  text: string;
}

export interface CompactionEvent {
  sessionID?: string;
  appendSystem?: (text: string) => void;
  /** Capture owns transcript decoding until its separate boundary is extracted. */
  transcript: unknown;
}

export interface LifecycleHandlers {
  beforeTool(event: ToolEvent): Promise<void>;
  afterTool(event: ToolResultEvent): Promise<void>;
  context(event: ContextEvent): Promise<void>;
  prompt(event: PromptEvent): Promise<void>;
  compact(event: CompactionEvent): Promise<void>;
  identity(event: SessionIdentity): void;
  usage(event: SessionUsage): Promise<void>;
  error(error: unknown): void;
}

export interface LifecycleRegistration {
  /**
   * Stops admission synchronously and releases all available hooks once.
   * Already-started handlers finish against their captured delivery surfaces.
   */
  dispose(): Promise<void>;
}

export interface MemoryLifecycleHost {
  register(handlers: LifecycleHandlers): Promise<LifecycleRegistration>;
}

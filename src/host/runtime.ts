import type { MemoryToolHost } from "./contracts.ts";
import type { MemoryLifecycleHost } from "./lifecycle.ts";
import type { MemoryCaptureHost } from "./capture.ts";

/** The ports needed to assemble the shared memory engine in one host instance. */
export interface MemoryHost {
  tools: MemoryToolHost;
  lifecycle: MemoryLifecycleHost;
  capture: MemoryCaptureHost;
  /** Optional host-native command setup, completed before tool registration. */
  installCommands?(): Promise<void>;
}

export interface MemorySetupOptions {
  directory?: string;
  options?: Record<string, unknown>;
}

export interface MemoryRuntime {
  /** Stops lifecycle/capture admission synchronously; repeated calls share cleanup. */
  dispose(): Promise<void>;
}

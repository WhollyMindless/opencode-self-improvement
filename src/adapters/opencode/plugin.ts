import type { Plugin } from "@opencode/plugin/promise/plugin";
import type { PluginCtx } from "./context.ts";
import { createOpenCodeHost } from "./host.ts";
import { createOpenCodeLifecycle } from "./lifecycle.ts";
import { createOpenCodeCapture } from "./capture.ts";
import { ensureInitCommand, ensureMemoryReportCommand } from "./commands.ts";
import { setupMemory } from "../../runtime/setup.ts";

// Type-only SDK import: published installs have runtime dependencies only.
const plugin: Plugin = {
  id: "opencode-self-improvement",
  async setup(raw) {
    const ctx = raw as unknown as PluginCtx;
    const runtime = await setupMemory(
      {
        harness: "opencode",
        tools: createOpenCodeHost(ctx),
        lifecycle: createOpenCodeLifecycle(ctx),
        // Hook registration may attach APIs, so inspect capture afterward.
        get capture() {
          return createOpenCodeCapture(ctx);
        },
        async installCommands() {
          await ensureInitCommand();
          await ensureMemoryReportCommand();
        },
      },
      { directory: ctx.location?.directory, options: ctx.options },
    );
    return () => runtime.dispose();
  },
};

export const SelfImprovement = plugin;
export default plugin;

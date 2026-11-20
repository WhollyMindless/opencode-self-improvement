// The root shim for loose plugin discovery: `<config>/plugins/<name>/index.ts`.
// Package installs resolve `package.json` `exports` "." here too.
//
// The import is dynamic and guarded because a loose copy carries no
// `node_modules`. An unresolvable runtime dependency — `zod`, imported eagerly
// by `src/tools/schema.ts` — then throws during evaluation, and the host blames
// the export instead: "Plugin must export a default definition with an id and an
// effect or setup function". Catching keeps the definition valid and logs the
// package that could not be resolved.
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode/plugin/promise/plugin";

let loaded: typeof import("./src/index.ts") | undefined;
let loadError: unknown;
try {
  loaded = await import("./src/index.ts");
} catch (err) {
  loadError = err;
}

if (loadError) {
  // Runs before any hook exists, so the host log is the only surface. The
  // directory names which copy of the plugin failed.
  const where = fileURLToPath(new URL(".", import.meta.url));
  const detail =
    loadError instanceof Error ? loadError.message : String(loadError);
  console.error(
    `opencode-self-improvement: failed to load from ${where}: ${detail}`,
  );
  console.error(
    "opencode-self-improvement: a loose copy under <config>/plugins/ needs its runtime dependencies — run `bun install` in that directory, or install the package with `opencode plugin add opencode-self-improvement`.",
  );
}

// Only used when the import failed. The id is a literal, not `PLUGIN_ID`,
// because it has to be right in exactly the case where that module never
// evaluated — the host keys storage, status and diagnostics on it.
const unloaded: Plugin = {
  id: "opencode-self-improvement",
  async setup() {
    console.error(
      "opencode-self-improvement: loaded with no tools and no hooks — the module failed to evaluate, so nothing is active. Clear the load error above; the store stays empty until it is gone.",
    );
  },
};

export const SelfImprovement: Plugin = loaded?.SelfImprovement ?? unloaded;
export default SelfImprovement;

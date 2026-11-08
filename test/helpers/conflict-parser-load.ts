// Separate process so a prior enabled test cannot pre-load the parser.
import { createRequire } from "node:module";
import { findConstant } from "../../src/recall/conflicts.ts";
import { rememberSessionDir } from "../../src/identity/repokey.ts";
import { loadPlugin } from "../harness.ts";

const require = createRequire(import.meta.url);
const loaded = () =>
  Object.keys(require.cache).some((path) =>
    path.replace(/\\/g, "/").includes("/@babel/parser/"),
  );
const states = [loaded()];
const repo = process.argv[2]!;
const plugin = await loadPlugin(repo, { contradictionSurface: false });
const sid = "parser-opt-out";
rememberSessionDir(sid, repo);
await plugin.sessionHooks.prompt({
  sessionID: sid,
  prompt: { text: "Repair deployment" },
});
const delivered = {
  sessionID: sid,
  system: [] as Array<{ type: string; text: string }>,
};
await plugin.sessionHooks.context(delivered);
const block = delivered.system.map((part) => part.text).join("\n");
await plugin.cleanup();
states.push(loaded());
const fact = findConstant(process.argv[2]!, "TAX_RATE");
states.push(loaded());
console.log(
  JSON.stringify({
    states,
    value: fact?.value,
    conflict: block.includes("CONFLICT (TAX_RATE)"),
    plain: block.includes("8.25"),
  }),
);

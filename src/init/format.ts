// format — split from src/init.ts (#168 domain restructure). Declaration bodies are unchanged.
// Repository init: renders the runInit summary for the tool reply. The
// codebase-memory graph line is gone with the graph integration (#231).
import { type InitSummary } from "./run.ts";

export function formatInit(s: InitSummary): string {
  if (s.skipped) {
    return `Already initialized for ${s.scope} at head ${s.head} (stamp ${s.stampTs}). Nothing to do.`;
  }
  const scr = s.scripts.map((r) => `- ${r.source}: "${r.cmd}"`).join("\n");
  return [
    `Initialized ${s.scope} (root ${s.root}, head ${s.head}).`,
    scr ? `Scripts (${s.scripts.length}):\n${scr}` : "Scripts: none detected",
    `Memories: written=${s.written}, collapsed=${s.collapsed}, blocked=${s.blocked}` +
      (s.unaudited ? `, ${s.unaudited} without an audit line` : "") +
      `; stamp=${s.stampTs ?? "-"}`,
  ].join("\n");
}

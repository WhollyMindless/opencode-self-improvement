// Context surfaces. The system digest is TINY (≤2 lines): durable knowledge is
// pulled on demand, not pushed wholesale. Deterministic memory-first injection
// rides chat.message (synthetic parts), so relevant knowledge is in the model's
// context before it chooses any tool. Contextual pull rides grep/glob/read
// results. Evidence is never injected (invariant I3). Open threads (status=
// "open") get a single capped frontier block in the digest so planning sessions
// start at the previous session's frontier instead of re-deriving it.
import { isActive, loadAll, type Memory } from "./memory.ts";
import { record } from "./evidence.ts";
import { dateStr } from "./config.ts";
import { bracketList } from "./logfmt.ts";
import { recentConvergenceSummary } from "./triggers.ts";

export interface TransformOutput {
  system: string[];
}

export interface PullInput {
  tool?: unknown;
  args?: unknown;
}

export interface PullOutput {
  output?: unknown;
}

function dateOf(ts: string): string {
  return ts.split("T")[0];
}

export function formatMemory(m: Memory): string {
  const tag = m.status === "open" ? " [open]" : "";
  return `- [${dateOf(m.ts)}]${tag} ${m.type}/${m.scope}: ${m.content}`;
}

function argText(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const k of ["pattern", "query", "path", "filePath", "command"]) {
    const v = a[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 2);
}

function scoreMemories(term: string, mems: Memory[], limit: number): Memory[] {
  const query = new Set(words(term));
  if (!query.size) return [];
  return mems
    .map((m) => {
      const hay = new Set(words(`${m.scope} ${m.type} ${m.content}`));
      let score = 0;
      for (const w of query) if (hay.has(w)) score++;
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || openRank(b.m) - openRank(a.m))
    .slice(0, limit)
    .map((s) => s.m);
}

function openRank(m: Memory): number {
  return m.status === "open" ? 1 : 0;
}

// Only the newest open threads are surfaced, and each session sees the block
// once (per process), so the frontier costs a bounded number of tokens.
const OPEN_THREAD_LIMIT = 3;
const frontierInjectedSessions = new Set<string>();

export async function systemDigest(
  _input: unknown,
  output: TransformOutput,
): Promise<void> {
  const mems = (await loadAll()).filter(isActive);
  if (!mems.length) return;
  const latest = mems.map((m) => m.ts).sort().pop() ?? "?";
  output.system.push(
    "\n## Persistent memory (opencode-self-improvement)\n" +
      `${mems.length} durable memories; latest: ${latest}. ` +
      "Check memory_recall BEFORE grepping or reading, for build/test/lint commands, decisions, and conventions. Relevant memories are also auto-injected when your message matches.",
  );

  const open = mems
    .filter((m) => m.status === "open")
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, OPEN_THREAD_LIMIT);
  if (!open.length) return;

  output.system.push(
    "\n## Open threads (frontier)\n" + open.map(formatMemory).join("\n"),
  );

  // Aggregate of past sessions' convergence (one line, gated on data existing;
  // I3: it is a derived fact, never the raw log). Gives the next session the
  // signal to recall-first and stop re-deriving.
  const conv = await recentConvergenceSummary();
  if (conv) output.system.push(`\nConvergence tracking: ${conv}`);

  const sid =
    typeof _input === "object" && _input !== null &&
    "sessionID" in _input &&
    typeof (_input as Record<string, unknown>).sessionID === "string"
      ? String((_input as Record<string, unknown>).sessionID)
      : "?";
  if (frontierInjectedSessions.has(sid)) return;
  frontierInjectedSessions.add(sid);
  const openMems = mems.filter((m) => m.status === "open");
  await record(
    "frontier_injected",
    {
      session: sid,
      scopes: bracketList([...new Set(open.map((m) => m.scope))]),
      shown: open.length,
      open_total: openMems.length,
      ts_since: dateStr(),
    },
    false,
  );
}

export async function relevantKnowledge(message: string, limit = 3): Promise<string> {
  const text = message.trim();
  if (!text) return "";
  const mems = (await loadAll()).filter(isActive);
  const top = scoreMemories(text, mems, limit);
  if (!top.length) return "";
  return `## Relevant durable memory\n${top.map(formatMemory).join("\n")}`;
}

// Deterministic fingerprint of the active store: `${activeCount}:${maxActiveTs}`.
// Cheap change detector for the per-session epoch cache in index.ts: the frozen
// injection block is recomputed only when this string changes (or after a
// compaction). Evidence and superseded rows never affect it (I3, memory.ts).
export async function storeVersion(): Promise<string> {
  const mems = (await loadAll()).filter(isActive);
  let max = "";
  for (const m of mems) if (m.ts > max) max = m.ts;
  return `${mems.length}:${max}`;
}

// Trim an injection block to `budget` characters at WHOLE-line boundaries:
// keep lines while the joined length stays <= budget, drop the rest, never cut
// mid-line. Returns "" when even the header line exceeds the budget (the block
// is not worth injecting).
export function capToBudget(block: string, budget: number): string {
  const kept: string[] = [];
  let len = 0;
  for (const line of block.split("\n")) {
    const add = kept.length ? line.length + 1 : line.length;
    if (len + add > budget) break;
    kept.push(line);
    len += add;
  }
  return kept.join("\n");
}

// Memory-aware compaction (Phase 3): a durable-memory block pushed onto the
// V2 compaction hook's `system` parts, where the summarizer model can see it
// (OpenCode appends its own summary prompt AFTER hooks). Deterministic, zero
// extra model calls; fixes "compaction amnesia". Composition: up to 10 open
// threads newest-first, then up to 5 newest settled memories, total rows
// capped by `limit`; the whole block capped at 2500 chars at whole-line
// boundaries. "" when the store has no active memories.
const ANCHOR_OPEN_LIMIT = 10;
const ANCHOR_SETTLED_LIMIT = 5;
const ANCHOR_BUDGET = 2500;

export async function compactionAnchor(limit = 12): Promise<string> {
  const mems = (await loadAll()).filter(isActive);
  if (!mems.length) return "";
  const byNewest = (a: Memory, b: Memory) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0);
  const open = mems
    .filter((m) => m.status === "open")
    .sort(byNewest)
    .slice(0, Math.min(ANCHOR_OPEN_LIMIT, Math.max(0, limit)));
  const settled = mems
    .filter((m) => m.status !== "open")
    .sort(byNewest)
    .slice(0, Math.min(ANCHOR_SETTLED_LIMIT, Math.max(0, limit - open.length)));
  const rows = [...open, ...settled];
  if (!rows.length) return "";
  const block =
    "## Durable memory to preserve in this summary\n" +
    "Preserve these facts verbatim (dates, commands, ids) in the compaction summary:\n" +
    rows.map(formatMemory).join("\n");
  return capToBudget(block, ANCHOR_BUDGET);
}

export async function contextualPull(input: PullInput, output: PullOutput): Promise<void> {
  const tool = typeof input.tool === "string" ? input.tool : "";
  if (!["grep", "glob", "read"].includes(tool)) return;
  const term = argText(input.args);
  if (!term) return;
  const mems = (await loadAll()).filter(isActive);
  const top = scoreMemories(term, mems, 3);
  if (!top.length) return;
  const block = top.map(formatMemory).join("\n");
  if (typeof output.output === "string") {
    output.output += `\n## Related durable memory (pull)\n${block}`;
  }
}

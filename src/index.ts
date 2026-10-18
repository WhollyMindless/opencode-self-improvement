// opencode-self-improvement: one opencode plugin bundling durable memory, the
// 4-gate write pipeline, deterministic reflection triggers T1/T2/T4,
// tiny-digest injection with deterministic memory-first context and
// contextual pull, and snapshot/rollback.
//
// V2 port: registers tools via `ctx.tool.transform` (JSON Schema), mirrors the
// V1 hooks onto the OpenCode V2 session/tool hook API, and registers the
// /repo-init command via `ctx.command.transform`. The plugin contract is a
// default export object `{ id, setup(ctx) }` (OpenCode >= 2.0). All business
// logic still lives in the decoupled helper modules.
import { join } from "node:path";
import { evidenceDir, memoryRoot, dateStr } from "./config.ts";
import {
  clearSuperseded,
  isActive,
  loadAll,
  markSuperseded,
  resolveMemoryTarget,
  type Memory,
} from "./memory.ts";
import { runWriteGate, type GateContext, type WriteCandidate } from "./gates.ts";
import { pruneMemory } from "./prune.ts";
import { listSnapshots, restoreSnapshot } from "./undo.ts";
import { record } from "./evidence.ts";
import {
  contextualPull,
  formatMemory,
  relevantKnowledge,
  systemDigest,
} from "./inject.ts";
import { formatInit, runInit } from "./init.ts";
import { ensureInitCommand } from "./command.ts";
import {
  afterTool,
  checkNewSession,
  evidenceCalls,
  firstFrontierTap,
  hasEngagement,
  hasGateCheck,
  markFrontierTap,
  markTurn,
  onCompacting,
} from "./triggers.ts";
import { getCurrent, setCurrent } from "./state.ts";
import { readLines } from "./logfmt.ts";

const TYPES = ["decision", "learning", "preference", "blocker", "context", "pattern"] as const;
const STATUSES = ["open", "settled"] as const;

// --- minimal JSON Schema helpers (OpenCode V2 tools take JSON Schema) --------
type JSONSchema = Record<string, unknown>;
const str = (): JSONSchema => ({ type: "string" });
const bool = (): JSONSchema => ({ type: "boolean" });
const num = (): JSONSchema => ({ type: "number" });
const strArray = (): JSONSchema => ({ type: "array", items: { type: "string" } });
const en = (values: readonly string[]): JSONSchema => ({ type: "string", enum: [...values] });
function obj(properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema {
  return { type: "object", properties, required, additionalProperties: false };
}
function withDesc(schema: JSONSchema, description: string): JSONSchema {
  return { ...schema, description };
}

function scoreMemory(m: Memory, q: string): number {
  const hay = `${m.type} ${m.scope} ${m.content}`.toLowerCase();
  let score = 0;
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (hay.includes(w)) score++;
    if (m.scope.toLowerCase() === w) score += 2;
    if (m.type.toLowerCase() === w) score += 2;
  }
  return score;
}

// --- OpenCode V2 runtime shapes (loose: we only read a few fields) ----------
interface ToolDef {
  name: string;
  description: string;
  input: JSONSchema;
  options?: { codemode?: boolean; namespace?: string };
  execute: (args: any, context: any) => Promise<{ content: string }>;
}
interface ToolEditorLike {
  add: (tool: ToolDef) => void;
}
interface HookReg {
  dispose?: () => Promise<void> | void;
}
interface PluginCtx {
  location?: { directory?: string };
  tool?: {
    transform: (cb: (editor: ToolEditorLike) => void) => Promise<unknown>;
    hook: (name: string, cb: (event: any) => Promise<void> | void) => Promise<HookReg | void>;
  };
  command?: {
    transform: (cb: (editor: { add: (cmd: Record<string, unknown>) => void }) => void) => Promise<unknown>;
  };
  session?: {
    hook: (name: string, cb: (event: any) => Promise<void> | void) => Promise<HookReg | void>;
    prompt: (input: {
      sessionID: string;
      text: string;
      delivery?: "steer" | "queue";
    }) => Promise<unknown>;
  };
}

// Best-effort extraction of a tool's textual output + metadata from the V2
// execute.after `result` payload, whose exact encoding varies by tool.
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  for (const k of ["output", "text", "content", "stdout"]) {
    const v = r[k];
    if (typeof v === "string") return v;
  }
  if (Array.isArray(r.content)) {
    return (r.content as Array<Record<string, unknown>>)
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
function resultMeta(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object") {
    const m = (result as Record<string, unknown>).metadata;
    if (m && typeof m === "object") return m as Record<string, unknown>;
  }
  return {};
}

const PLUGIN_ID = "opencode-self-improvement";

const plugin = {
  id: PLUGIN_ID,
  async setup(ctx: PluginCtx): Promise<void> {
    const liveRoot = ctx?.location?.directory ?? process.cwd();

    // Mirror the /repo-init slash command into opencode's global commands dir
    // (idempotent, write-if-missing). OpenCode 2.x loads `*.md` from
    // ~/.config/opencode/commands, so this is the canonical V2 install path.
    await ensureInitCommand();

    // Fail-closed hook guard: the plugin's own bookkeeping can never take down a
    // tool call, the system transform, or compaction.
    async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
      try {
        await fn();
      } catch (err) {
        console.warn(`[opencode-self-improvement] ${name} hook failed (ignored):`, err);
      }
    }

    const gateContext = (): GateContext => ({
      liveRoot,
      evidenceCalls: evidenceCalls(getCurrent().sid),
      hasGateCheck: hasGateCheck(getCurrent().sid),
      hasEngagement: hasEngagement(getCurrent().sid),
    });

    // ---- tools --------------------------------------------------------------
    await ctx.tool?.transform((editor) => {
      const direct = { codemode: false } as const;

      editor.add({
        name: "memory_remember",
        description:
          "Store a memory after the 4-gate write pipeline validates it (canonical graph, stale refs, dupes). Blocked writes record evidence instead of persisting.",
        options: direct,
        input: obj(
          {
            type: withDesc(en(TYPES), "Type of memory"),
            scope: withDesc(str(), "Scope/area (e.g., auth, api, ctl)"),
            content: withDesc(str(), "The memory content"),
            issue: withDesc(str(), "Related issue"),
            tags: strArray(),
            status: withDesc(
              en(STATUSES),
              "open = live planning thread / frontier (surfaced at session start); settled or omitted = durable knowledge",
            ),
          },
          ["type", "scope", "content"],
        ),
        async execute(args: any): Promise<{ content: string }> {
          const candidate: WriteCandidate = {
            type: args.type,
            scope: args.scope,
            content: args.content,
            issue: args.issue,
            tags: args.tags,
            status: args.status,
          };
          const outcome = await runWriteGate(candidate, gateContext());
          if (outcome.action === "promoted") return { content: `Remembered: ${args.type} in ${args.scope}` };
          if (outcome.action === "collapsed") return { content: `Duplicate ignored: ${args.type}/${args.scope}` };
          return {
            content: `Write blocked at GATE (${outcome.reason}). ${
              outcome.hint ?? "Evidence recorded; inspect with memory_evidence."
            }`,
          };
        },
      });

      editor.add({
        name: "memory_init",
        description:
          "Initialize repository memory and knowledge graph. Ensures the codebase-memory graph for this repo is indexed (one-shot `cli` spawn; no session MCP needed) and re-derives build/lint/test/typecheck command memories through the write gate, then stores an init stamp keyed on git HEAD. Idempotent: a no-op when the stamp matches HEAD, unless force=true (refresh after a refactor).",
        options: direct,
        input: obj({
          force: withDesc(bool(), "Re-run even if initialized (refresh after drift)"),
          mode: withDesc(en(["fast", "moderate", "full"]), "codebase-memory index mode (default moderate)"),
        }),
        async execute(args: any): Promise<{ content: string }> {
          const summary = await runInit({ liveRoot, force: args.force, mode: args.mode });
          return { content: formatInit(summary) };
        },
      });

      editor.add({
        name: "memory_recall",
        description:
          "Look up durable project knowledge — build/test/lint commands, decisions, patterns, preferences, blockers — BEFORE searching the repo or reading files. Use for 'how do I run X', conventions, and past decisions. By scope, type, or free-text query; with no filters it returns the most recent memories.",
        options: direct,
        input: obj({ scope: str(), type: en(TYPES), query: str(), limit: num() }),
        async execute(args: any): Promise<{ content: string }> {
          let results = (await loadAll()).filter(isActive);
          if (!results.length) return { content: "No memories found" };
          const total = results.length;
          if (args.scope) results = results.filter((m) => m.scope.includes(args.scope!));
          if (args.type) results = results.filter((m) => m.type === args.type);
          if (args.query) {
            results = results
              .map((m) => ({ m, score: scoreMemory(m, args.query!) }))
              .filter((x) => x.score > 0)
              .sort((a, b) => b.score - a.score)
              .map((x) => x.m);
          }
          const limit = args.limit || 20;
          const limited = args.query ? results.slice(0, limit) : results.slice(-limit);
          if (!limited.length) return { content: "No matching memories" };
          const openIn = limited.filter((m) => m.status === "open").length;
          if (openIn > 0) {
            const cur = getCurrent();
            markFrontierTap(cur.sid, cur.call);
            await record("frontier_tapped", {
              n_open: openIn,
              in_results: limited.length,
              turn: firstFrontierTap(cur.sid)?.turn,
            });
          }
          return { content: `Found ${results.length} (${total} total)\n\n${limited.map(formatMemory).join("\n")}` };
        },
      });

      editor.add({
        name: "memory_update",
        description:
          "Update an existing memory (gated like remember; the prior entry is superseded, not erased). `query` selects which row to update: its exact id (ts), a clock fragment (e.g. HH:MM:SS.mmm), or a unique substring of its content. Omitting `query` targets the most recent active row of scope+type. An unmatched or ambiguous `query` fails closed and writes nothing.",
        options: direct,
        input: obj(
          {
            scope: str(),
            type: en(TYPES),
            content: str(),
            query: withDesc(
              str(),
              "Row selector: id (ts), clock fragment, or unique content substring. Omit to target the newest active row of scope+type.",
            ),
            status: en(STATUSES),
          },
          ["scope", "type", "content"],
        ),
        async execute(args: any): Promise<{ content: string }> {
          const prior = (await loadAll()).filter(
            (m) => m.scope === args.scope && m.type === args.type && isActive(m),
          );
          // Resolve the row BEFORE the gate: an update that cannot identify its
          // target must write nothing, rather than silently superseding whichever
          // row happened to be newest in this scope+type.
          const resolved = resolveMemoryTarget(prior, args.query);
          if (resolved.status === "not_found") {
            const where = args.query ? ` matches ${JSON.stringify(args.query)}` : "";
            return {
              content: `memory_update blocked: no active ${args.type} row in ${args.scope}${where}. Nothing was written.`,
            };
          }
          if (resolved.status === "ambiguous") {
            return {
              content:
                `memory_update blocked: ${JSON.stringify(args.query)} matches ${resolved.candidates.length} active ` +
                `${args.type} rows in ${args.scope} (${resolved.candidates.map((m) => m.ts).join(", ")}). ` +
                "Pass a row id or a unique content substring. Nothing was written.",
            };
          }
          const target = resolved.target;
          const outcome = await runWriteGate(
            { type: args.type, scope: args.scope, content: args.content, status: args.status },
            gateContext(),
          );
          if (outcome.action === "promoted" && outcome.ts && target) {
            await markSuperseded(target.ts, {
              superseded_by: outcome.ts,
              reason: "update",
              symbol: target.ts,
              from: target.ts,
              to: outcome.ts,
            });
            return { content: `Updated ${args.type} in ${args.scope} (superseded ${target.ts})` };
          }
          if (outcome.action === "promoted") return { content: `Remembered: ${args.type} in ${args.scope}` };
          if (outcome.action === "collapsed") return { content: `Duplicate ignored: ${args.type}/${args.scope}` };
          return { content: `Write blocked at GATE (${outcome.reason}). ${outcome.hint ?? ""}`.trimEnd() };
        },
      });

      editor.add({
        name: "memory_forget",
        description:
          "Delete memories by scope and type. Snapshots first, logs the reason for audit, never touches a repo.",
        options: direct,
        input: obj({ scope: str(), type: en(TYPES), reason: withDesc(str(), "Why this is being deleted (audit)") }, [
          "scope",
          "type",
          "reason",
        ]),
        async execute(args: any): Promise<{ content: string }> {
          const res = await pruneMemory(args.scope, args.type, args.reason);
          if (!res.deleted.length) return { content: `No memories found for ${args.type} in ${args.scope}` };
          return { content: `Deleted ${res.deleted.length} ${args.type} memory(s) from ${args.scope}. Audit: ${res.audit}` };
        },
      });

      editor.add({
        name: "memory_list",
        description: "List memory scopes and types for discovery.",
        options: direct,
        input: obj({}),
        async execute(): Promise<{ content: string }> {
          const mems = (await loadAll()).filter(isActive);
          if (!mems.length) return { content: "No memories found" };
          const scopes = new Map<string, number>();
          const types = new Map<string, number>();
          for (const m of mems) {
            scopes.set(m.scope, (scopes.get(m.scope) ?? 0) + 1);
            types.set(m.type, (types.get(m.type) ?? 0) + 1);
          }
          const fmt = (map: Map<string, number>) =>
            [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `  ${k}: ${c}`).join("\n");
          return { content: `Total: ${mems.length}\n\nScopes:\n${fmt(scopes)}\n\nTypes:\n${fmt(types)}` };
        },
      });

      editor.add({
        name: "memory_undo",
        description: "List memory snapshots, or restore one by name (rollback).",
        options: direct,
        input: obj({
          list: withDesc(bool(), "List snapshots"),
          snapshot: withDesc(str(), "Snapshot file to restore"),
        }),
        async execute(args: any): Promise<{ content: string }> {
          if (args.snapshot) {
            const target = await restoreSnapshot(args.snapshot, memoryRoot());
            return { content: `Restored ${args.snapshot} -> ${target}` };
          }
          const snaps = await listSnapshots();
          if (!snaps.length) return { content: "No snapshots" };
          return { content: snaps.map((s) => `${s.name}  (${s.bytes} bytes)`).join("\n") };
        },
      });

      editor.add({
        name: "memory_evidence",
        description: "Read captured evidence (data only) for a date, optionally filtered by event.",
        options: direct,
        input: obj({ date: str(), ev: str(), limit: num() }),
        async execute(args: any): Promise<{ content: string }> {
          const file = join(evidenceDir(), `${args.date || dateStr()}.logfmt`);
          let lines = await readLines(file);
          if (args.ev) lines = lines.filter((l) => l.includes(`ev=${args.ev}`));
          if (!lines.length) return { content: "No evidence" };
          const limit = args.limit || 50;
          return { content: lines.slice(-limit).join("\n") };
        },
      });

      editor.add({
        name: "memory_merge_review",
        description:
          "Resolve an open merge/review gate non-destructively: mark the loser as superseded_by the survivor, and clear any supersession the survivor itself carries so the canonical row stays recallable. Both rows stay active data (the loser is recoverable via memory_undo); nothing is deleted. Fails closed (no partial apply) when the reason or the survivor id is missing, or the loser is already superseded.",
        options: direct,
        input: obj(
          {
            loser: withDesc(str(), "Evidence id of the rival/overlap write to supersede"),
            survivor: withDesc(str(), "Evidence id of the canonical winning write"),
            reason: withDesc(str(), "Why the survivor is canonical over the loser (written to evidence)"),
          },
          ["loser", "survivor", "reason"],
        ),
        async execute(args: any): Promise<{ content: string }> {
          if (!args.loser || !args.survivor || !args.reason) {
            return { content: "merge_review blocked: loser, survivor, and reason are all required (fail-closed)." };
          }
          const ok = await markSuperseded(args.loser, {
            superseded_by: args.survivor,
            reason: args.reason,
            symbol: args.loser,
            from: args.loser,
            to: args.survivor,
          });
          if (!ok) {
            return { content: "merge_review: loser not found or already superseded — nothing to resolve. No evidence written." };
          }
          // The survivor may itself have been superseded earlier (e.g. by a row
          // this very call just made the loser). Declaring it canonical has to
          // make it recallable, so clear its own marker too.
          const revived = await clearSuperseded(args.survivor);
          return {
            content:
              `Resolved merge: ${args.survivor} is canonical; ${args.loser} superseded (recoverable via memory_undo). ` +
              (revived ? `Survivor's own supersession cleared, it is active again. ` : "") +
              `Evidence recorded for reason='${args.reason}'.`,
          };
        },
      });
    });

    // Per-session durable-memory blocks stashed by the prompt hook and pushed
    // onto the system prompt by the context hook (invisible to the user).
    const pendingKnowledge = new Map<string, string>();

    // ---- hooks (all fail-closed) -------------------------------------------
    // Bookkeeping: track the active session/tool/call before a tool runs.
    await ctx.tool?.hook("execute.before", (event: any) =>
      guarded("tool.execute.before", async () => {
        setCurrent({
          sessionID: event?.sessionID,
          callID: event?.callID ?? event?.id,
          tool: event?.tool,
        });
      }),
    );

    await ctx.tool?.hook("execute.after", (event: any) =>
      guarded("tool.execute.after", async () => {
        const input = {
          tool: event?.tool,
          sessionID: event?.sessionID,
          callID: event?.callID ?? event?.id,
          args: event?.input,
        };
        setCurrent(input);
        const out = { output: resultText(event?.result), metadata: resultMeta(event?.result) };
        await afterTool(input, out);
        await contextualPull(input, out as { output?: unknown });
        // Write a contextual-pull append back when the tool result is text we own.
        if (event?.result && typeof event.result === "object" && typeof event.result.content === "string") {
          const text = resultText(event.result);
          if (out.output && out.output !== text) event.result.content = out.output;
        }
      }),
    );

    // Tiny system digest + open-thread frontier block, injected into the system prompt.
    await ctx.session?.hook("context", (event: any) =>
      guarded("session.context (systemDigest)", async () => {
        const parts: string[] = [];
        await systemDigest({ sessionID: event?.sessionID }, { system: parts });
        for (const text of parts) event?.system?.push?.({ type: "text", text });
        // Deliver this turn's relevance-ranked memory via the system channel.
        // The UI never renders system parts, unlike appended prompt text.
        const sid = event?.sessionID;
        const knowledge = typeof sid === "string" ? pendingKnowledge.get(sid) : undefined;
        if (knowledge) event?.system?.push?.({ type: "text", text: knowledge });
      }),
    );

    // Memory-first injection: compute relevance against each user prompt and
    // stash the block for invisible delivery via the context hook. Never mutate
    // event.prompt.text — it is stored verbatim and rendered in the UI.
    await ctx.session?.hook("prompt", (event: any) =>
      guarded("session.prompt (inject)", async () => {
        const sid = event?.sessionID;
        if (typeof sid === "string") {
          markTurn(sid);
          await checkNewSession(sid);
        }
        const text = event?.prompt?.text ?? "";
        const block = await relevantKnowledge(text);
        if (typeof sid === "string") {
          if (block) pendingKnowledge.set(sid, block);
          else pendingKnowledge.delete(sid);
        }
      }),
    );

    // Session-convergence rollup at compaction.
    await ctx.session?.hook("compaction", (event: any) =>
      guarded("session.compaction (onCompacting)", async () => {
        await onCompacting({ sessionID: event?.sessionID });
      }),
    );
  },
};

export const SelfImprovement = plugin;
export default plugin;

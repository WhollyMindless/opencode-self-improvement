// opencode-self-improvement: one opencode plugin bundling durable memory, the
// 4-gate write pipeline, deterministic reflection triggers T1/T2/T4,
// tiny-digest injection with deterministic memory-first context and
// contextual pull, and snapshot/rollback.
//
// V2 port: registers tools via `ctx.tool.transform` (JSON Schema), mirrors the
// V1 hooks onto the OpenCode V2 session/tool hook API, and registers the
// /repo-init command via `ctx.command.transform`. The plugin contract is a
// default export object `{ id, setup(ctx) }` (OpenCode >= 2.0), pinned at
// compile time against the real SDK type (`@opencode/plugin`, type-only — see
// the note on `plugin` below). All business logic still lives in the decoupled
// helper modules.
import type { Cleanup, Plugin } from "@opencode/plugin/promise/plugin";
import { basename, join } from "node:path";
import { evidenceDir, injectBudget, memoryRoot, dateStr } from "./config.ts";
import { STATUSES, TYPES } from "./types.ts";
import {
  clearSuperseded,
  isActive,
  loadAll,
  markSuperseded,
  resolveMemoryTarget,
  snapshotFiles,
  type Memory,
} from "./memory.ts";
import { runWriteGate, type GateContext, type WriteCandidate } from "./gates.ts";
import { pruneMemory } from "./prune.ts";
import { exportMemories, findStaleOpen, importMemories } from "./portable.ts";
import { listSnapshots, restoreSnapshot } from "./undo.ts";
import { record } from "./evidence.ts";
import {
  capToBudget,
  compactionAnchor,
  contextualPull,
  formatMemory,
  relevantKnowledge,
  storeVersion,
  systemDigest,
} from "./inject.ts";
import { formatInit, runInit } from "./init.ts";
import { ensureInitCommand, ensureMemoryReportCommand } from "./command.ts";
import {
  blockedRecent,
  emptyStats,
  renderMemoryReport,
  writeStatus,
  type Measured,
  type SessionStats,
  type StatusPayload,
} from "./status.ts";
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
import { buildCapturePrompt, flattenTranscript, parseCandidates, parseModelRef } from "./capture.ts";

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
  options?: Record<string, unknown>;
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
    context?: (input: { sessionID: string }) => Promise<unknown>;
  };
  event?: {
    subscribe: (o?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
  };
  generate?: {
    text: (input: unknown) => Promise<{ text?: string } | string>;
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

// The real setup implementation, written against the loose local PluginCtx
// (the only members of the V2 context this plugin actually touches).
const impl = {
  async setup(ctx: PluginCtx): Promise<Cleanup | void> {
    const liveRoot = ctx?.location?.directory ?? process.cwd();

    // Character budget for the epoch-frozen injection block: plugin options
    // (object form in opencode.json(c)) win, then OPENCODE_MEMORY_INJECT_BUDGET,
    // then the 1200 default.
    const budget = Number(ctx.options?.injectBudget) || injectBudget();

    // Mirror the /repo-init slash command into opencode's global commands dir
    // (idempotent, write-if-missing). OpenCode 2.x loads `*.md` from
    // ~/.config/opencode/commands, so this is the canonical V2 install path.
    await ensureInitCommand();
    await ensureMemoryReportCommand();

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
        description:
          "List memory snapshots, or restore one (rollback). SAFE BY DEFAULT: daily store files are shared across sessions, so if the current file has rows added or edited since the snapshot, restore REFUSES and lists them — re-run with merge=true to restore AND keep those rows, or force=true for the exact rollback. `snapshot` accepts a bare name from the list or a full path.",
        options: direct,
        input: obj({
          list: withDesc(bool(), "List snapshots"),
          snapshot: withDesc(str(), "Snapshot to restore (bare name from list, or a full path)"),
          merge: withDesc(bool(), "With snapshot: keep rows written after the snapshot instead of refusing"),
          force: withDesc(bool(), "With snapshot: exact rollback even if the file changed since"),
        }),
        async execute(args: any): Promise<{ content: string }> {
          if (args.snapshot) {
            const mode = args.force ? "force" : args.merge ? "merge" : "check";
            const res = await restoreSnapshot(args.snapshot, memoryRoot(), mode);
            if (!res.restored) {
              const parts = [...res.concurrentAdded, ...res.concurrentChanged];
              return {
                content:
                  `Undo refused: ${res.concurrentAdded.length} row(s) added and ` +
                  `${res.concurrentChanged.length} changed since this snapshot — restoring it ` +
                  `would clobber them. Divergent rows (ts): ${parts.join(", ")}. ` +
                  `If those belong to another session, re-run with merge=true (restore the file ` +
                  `AND keep them); if they are the writes you are undoing, use force=true.`,
              };
            }
            const kept = res.mode === "merge" && (res.concurrentAdded.length || res.concurrentChanged.length)
              ? ` Kept ${res.concurrentAdded.length} added / ${res.concurrentChanged.length} changed row(s) written after the snapshot.`
              : "";
            return { content: `Restored ${basename(res.target)} from ${res.mode} snapshot -> ${res.target}.${kept}` };
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

      editor.add({
        name: "memory_export",
        description:
          "Export active memories as a JSONL file (one JSON object per line: {ts,type,scope,content,status,tags,issue}) for backup or transfer to another machine. Defaults to <memory-root>/exports/<timestamp>.jsonl; pass `file` to choose the path, `scope` to export one scope. Superseded rows are not exported (history stays in the store).",
        options: direct,
        input: obj({
          scope: withDesc(str(), "Only export memories in this exact scope"),
          file: withDesc(str(), "Destination path (default: <memory-root>/exports/)"),
        }),
        async execute(args: any): Promise<{ content: string }> {
          const res = await exportMemories({ scope: args.scope, file: args.file });
          return { content: `Exported ${res.count} memories -> ${res.path}` };
        },
      });

      editor.add({
        name: "memory_import",
        description:
          "Import memories from a JSONL export (see memory_export). Every row goes through the same 4-gate write pipeline as memory_remember (tagged `import`, original tags preserved), so duplicates collapse and ungrounded rows are blocked exactly as usual — those are normal tallied outcomes, not errors. Malformed lines are skipped and counted.",
        options: direct,
        input: obj({ file: withDesc(str(), "Path to a .jsonl export file") }, ["file"]),
        async execute(args: any): Promise<{ content: string }> {
          try {
            const t = await importMemories(args.file, (c) =>
              runWriteGate(
                { ...c, tags: [...new Set([...(c.tags ?? []), "import"])] },
                gateContext(),
              ),
            );
            return {
              content:
                `Imported ${args.file}: ${t.promoted} promoted, ${t.collapsed} duplicates collapsed, ` +
                `${t.blocked} blocked by the gate, ${t.skipped} malformed lines skipped.`,
            };
          } catch (err) {
            return {
              content: `memory_import failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });

      editor.add({
        name: "memory_decay",
        description:
          "Retire stale open threads (status=open older than olderThanDays) by superseding them — never deleting; rows stay recoverable via memory_undo. DRY RUN BY DEFAULT: without an explicit dryRun=false this only LISTS what would retire and mutates nothing (fail-closed). A real run snapshots every affected file before the first mutation.",
        options: direct,
        input: obj({
          olderThanDays: withDesc(
            { type: "number", default: 14 },
            "Age threshold in days (default 14)",
          ),
          dryRun: withDesc(
            { type: "boolean", default: true },
            "Preview only (default true). Set false to actually supersede.",
          ),
        }),
        async execute(args: any): Promise<{ content: string }> {
          const days = Number(args.olderThanDays) > 0 ? Number(args.olderThanDays) : 14;
          const dryRun = args.dryRun !== false; // only an explicit false mutates
          const stale = await findStaleOpen(days);
          if (!stale.length) {
            return { content: `No active open threads older than ${days} days.` };
          }
          const listing = stale
            .map((m) => `  ${m.ts} ${m.type}/${m.scope}: ${m.content.slice(0, 100)}`)
            .join("\n");
          if (dryRun) {
            await record(
              "decay_dry_run",
              { days, stale: stale.length, mem: stale.map((m) => m.ts).join(",") },
              false,
            );
            return {
              content:
                `Dry run: ${stale.length} open thread(s) older than ${days} days:\n${listing}\n` +
                "Re-run with dryRun=false to supersede them (snapshot first; recoverable via memory_undo).",
            };
          }
          // Snapshot-before-mutate: the SAME helper prune() uses in memory.ts,
          // one whole-file copy per affected file, taken before the first
          // mutation. markSuperseded also snapshots internally per row; this
          // pass guarantees a pre-decay copy exists even if a later row fails.
          const snapshot = await snapshotFiles([...new Set(stale.map((m) => m.file))]);
          const retiredTs: string[] = [];
          for (const m of stale) {
            // Idempotent (a no-op on already-superseded rows), so a re-run
            // cannot double-mark. No successor row exists — decay retires.
            const ok = await markSuperseded(m.ts, { superseded_by: "decay", reason: "decay" });
            if (ok) retiredTs.push(m.ts);
          }
          await record(
            "decay_applied",
            {
              days,
              retired: retiredTs.length,
              mem: retiredTs.join(",") || "-",
              snapshot: snapshot.join(",") || "-",
            },
            false,
          );
          return {
            content:
              `Decayed ${retiredTs.length} open thread(s) older than ${days} days ` +
              `(superseded, not deleted; snapshot: ${snapshot[0] ?? "-"}). ` +
              "Recover with memory_undo.",
          };
        },
      });

      editor.add({
        name: "memory_status",
        description:
          "Plain-text memory report for chat clients (desktop/web/IDE), same sections as the terminal /memory panel: CONTEXT (this session's injected block, budget use, cumulative ride and abstentions), CACHE (epoch invalidations plus the measured session prompt-cache read rate), the block verbatim, recent blocked writes with gate reasons, and store stats. Reads only — no model call.",
        options: direct,
        input: obj({}),
        async execute(): Promise<{ content: string }> {
          // In-process truth: the live epoch + ledger, fresher than any file.
          const sid = getCurrent().sid;
          const status = sid === "?" ? null : await buildPayload(sid);
          const all = await loadAll();
          const act = all.filter(isActive);
          const store = {
            active: act.length,
            superseded: all.length - act.length,
            open: act.filter((m) => m.status === "open").length,
            scopes: new Set(act.map((m) => m.scope)).size,
          };
          return {
            content: renderMemoryReport({ status, store, blocked: await blockedRecent(6) }),
          };
        },
      });
    });

    // Per-session frozen injection epochs: the relevance block plus the store
    // fingerprint it was computed against. Recomputed ONLY on the first prompt
    // of a session, when the store changes, or after a compaction (see the
    // prompt/compaction hooks) — so the system prefix, and with it the
    // provider prompt cache, survives ordinary turns.
    const epoch = new Map<string, { version: string; block: string; at: string; reason: "first" | "store_changed" }>();
    // Recomputes since server start: every one invalidated a prompt cache, so
    // it is the honest cost number the surfaces show (status files / tools).
    let epochRecomputes = 0;

    // Per-session ledger, incremented at the injection decision below, and the
    // last measured prompt-cache usage per session (message.updated). The
    // surfaces read these through flushed status files (TUI) or directly
    // (memory_status, in-process).
    const sessionStats = new Map<string, SessionStats>();
    const measuredTurns = new Map<string, Measured>();
    const statsFor = (sid: string): SessionStats => {
      let st = sessionStats.get(sid);
      if (!st) sessionStats.set(sid, (st = emptyStats()));
      return st;
    };

    // Build the full status snapshot for one session, or null before its first
    // epoch. Store counts are computed fresh so every flush is current.
    const buildPayload = async (sid: string): Promise<StatusPayload | null> => {
      const ep = epoch.get(sid);
      if (!ep) return null;
      const all = await loadAll();
      const act = all.filter(isActive);
      return {
        at: ep.at,
        sessionID: sid,
        storeVersion: ep.version,
        reason: ep.reason,
        recomputes: epochRecomputes,
        block: ep.block,
        blockChars: ep.block.length,
        budget,
        store: {
          active: act.length,
          superseded: all.length - act.length,
          open: act.filter((m) => m.status === "open").length,
          scopes: new Set(act.map((m) => m.scope)).size,
        },
        stats: statsFor(sid),
        measured: measuredTurns.get(sid) ?? null,
      };
    };
    const flushStatus = (sid: string): Promise<void> =>
      buildPayload(sid).then((p) => (p ? writeStatus(p) : undefined));

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
        // Deliver this epoch's relevance-ranked memory via the system channel.
        // The UI never renders system parts, unlike appended prompt text.
        const sid = event?.sessionID;
        const knowledge = typeof sid === "string" ? epoch.get(sid)?.block : undefined;
        if (knowledge) event?.system?.push?.({ type: "text", text: knowledge });
        // Count AT THE INJECTION DECISION so badge/panel numbers match exactly
        // what rode this request (a later abort still rode the bytes — known
        // and documented). Abstained = the epoch exists but its block is empty.
        if (typeof sid === "string") {
          const st = statsFor(sid);
          st.requests++;
          st.epochRequests++;
          if (knowledge) st.cumChars += knowledge.length;
          else if (epoch.has(sid)) st.abstained++;
        }
      }),
    );

    // Memory-first injection, frozen per epoch (cache-safe). The block is
    // relevance-scored against the prompt that STARTED the epoch — accepted
    // staleness, traded for a stable system prefix across ordinary turns. An
    // epoch is invalidated only on first prompt, store change, or compaction.
    // Never mutate event.prompt.text — it is stored verbatim and rendered in
    // the UI.
    await ctx.session?.hook("prompt", (event: any) =>
      guarded("session.prompt (inject)", async () => {
        const sid = event?.sessionID;
        if (typeof sid === "string") {
          markTurn(sid);
          await checkNewSession(sid);
          const version = await storeVersion();
          const cached = epoch.get(sid);
          if (!cached || cached.version !== version) {
            const text = event?.prompt?.text ?? "";
            const raw = await relevantKnowledge(text, 5); // widen candidate pool
            const block = raw ? capToBudget(raw, budget) : "";
            const at = new Date().toISOString();
            const reason: "first" | "store_changed" = cached ? "store_changed" : "first";
            epoch.set(sid, { version, block, at, reason });
            await record(
              "epoch_recompute",
              {
                session: sid,
                reason,
                chars: block.length,
              },
              false,
            );
            epochRecomputes++;
            // Ledger: a store_changed recompute of a live epoch is an
            // invalidation (the first epoch of a session busts nothing). The
            // epoch request count restarts with the new block.
            const st = statsFor(sid);
            st.epochRequests = 0;
            if (reason === "store_changed") {
              st.invalidations++;
              st.lastInvalidation = { at, reason };
            }
            // Status hand-off for the terminal panel (src/tui.tsx) and any
            // out-of-process surface. Best-effort; never breaks injection.
            await flushStatus(sid);
          }
        }
      }),
    );

    // Session-convergence rollup at compaction. The epoch is dropped so the
    // next prompt re-scores against the post-compaction store. Memory-aware
    // compaction: the durable-memory anchor is pushed onto the hook's system
    // parts (visible to the summarizer model, which runs AFTER hooks) so the
    // summary preserves the facts. Never sets event.result — that would skip
    // the summarizer call entirely.
    await ctx.session?.hook("compaction", (event: any) =>
      guarded("session.compaction (onCompacting)", async () => {
        await onCompacting({ sessionID: event?.sessionID });
        if (typeof event?.sessionID === "string") epoch.delete(event.sessionID);
        const anchor = await compactionAnchor();
        if (anchor) event?.system?.push?.({ type: "text", text: anchor });
      }),
    );

    // ---- measured prompt-cache health (message.updated usage) --------------
    // Zero-model by design: assistant messages carry tokens {input, output,
    // reasoning, cache.read/write}; the session-wide read/(read+input+write)
    // share is the honest receipt behind the byte-stability proxy. Streaming
    // updates for one message arrive repeatedly — overwriting with the latest
    // is correct because the final update carries the complete usage. Flushes
    // the per-session status file so the TUI badge refreshes once per turn
    // instead of per step. Degrades to "not measured" when the host exposes
    // no event stream.
    const measuredController = new AbortController();
    if (ctx.event?.subscribe) {
      const eventApi = ctx.event;
      void (async () => {
        try {
          for await (const raw of eventApi.subscribe({ signal: measuredController.signal })) {
            const ev = raw as Record<string, any>;
            if (ev?.type !== "message.updated") continue;
            const info = ev.properties?.info ?? ev.info;
            if (!info || info.role !== "assistant") continue;
            const sid = info.sessionID;
            const t = info.tokens;
            if (typeof sid !== "string" || !t) continue;
            measuredTurns.set(sid, {
              at: new Date().toISOString(),
              messageID: String(info.id ?? "?"),
              input: Number(t.input) || 0,
              read: Number(t.cache?.read) || 0,
              write: Number(t.cache?.write) || 0,
            });
            await guarded("status flush (measured)", () => flushStatus(sid));
          }
        } catch {
          // the subscription ended (abort or host error); nothing to do
        }
      })();
    }

    // ---- opt-in auto-capture on session idle --------------------------------
    // Default OFF: capture never reads sessions and never calls a model. (The
    // measured-cache listener above does subscribe to the event stream by
    // default, but it is zero-model: pure bookkeeping of message usage.) When
    // enabled (options.autoCapture === true AND a valid captureModel), each
    // session.idle event runs ONE cheap ctx.generate.text call whose reply is
    // parsed into candidates that go through the SAME runWriteGate as
    // model-authored writes — capture can never bypass the moat, and it only
    // ever writes through the gate. A per-session cooldown bounds the cost.
    // Every failure inside the loop is swallowed: capture must never be able
    // to break a session.
    let captureCleanup: Cleanup | undefined;
    if (ctx.options?.autoCapture === true) {
      const captureModel =
        typeof ctx.options.captureModel === "string" ? ctx.options.captureModel : "";
      const captureMax = Number(ctx.options.captureMax) || 3;
      const modelRef = parseModelRef(captureModel);
      if (!modelRef) {
        // Invalid/missing model: skip registering the whole subscription
        // rather than guess (and warn once, at setup).
        console.warn(
          `[opencode-self-improvement] autoCapture is on but captureModel ${JSON.stringify(captureModel)} is invalid (expected "provider/id"); auto-capture disabled.`,
        );
      } else if (!ctx.event?.subscribe || !ctx.generate?.text || !ctx.session?.context) {
        console.warn(
          "[opencode-self-improvement] autoCapture is on but this OpenCode context lacks event.subscribe/generate.text/session.context; auto-capture disabled.",
        );
      } else {
        const controller = new AbortController();
        const lastRun = new Map<string, number>();
        const eventApi = ctx.event;
        const generateApi = ctx.generate;
        // Arrow wrapper: keep the receiver bound. The harness fakes are closures,
        // but a real client method that reads `this` would break if detached —
        // and the fail-closed catch below would hide it. Optional call: the
        // setup guard proves it exists, but property narrowing does not survive
        // into the closure, and undefined degrades safely (empty transcript).
        const contextFn = (input: { sessionID: string }) => ctx.session?.context?.(input);
        void (async () => {
          try {
            for await (const raw of eventApi.subscribe({ signal: controller.signal })) {
              const event = raw as Record<string, any>;
              if (event?.type !== "session.idle") continue;
              const sid = event.sessionID ?? event.properties?.sessionID;
              if (typeof sid !== "string") continue;
              const now = Date.now();
              if (now - (lastRun.get(sid) ?? 0) < 5 * 60_000) continue; // 5-min cooldown
              lastRun.set(sid, now);
              try {
                const msgs = await contextFn({ sessionID: sid });
                const transcript = flattenTranscript(msgs);
                if (transcript.length < 200) continue; // too thin to mine reliably
                const out = await generateApi.text({
                  model: modelRef,
                  prompt: buildCapturePrompt(transcript.slice(-8000), captureMax),
                });
                const text = typeof out === "string" ? out : out?.text ?? "";
                for (const c of parseCandidates(text, captureMax)) {
                  const outcome = await runWriteGate(
                    { ...c, tags: ["auto-capture"] },
                    gateContext(),
                  );
                  await record(
                    `auto_capture_${outcome.action}`,
                    { session: sid, type: c.type, scope: c.scope, reason: outcome.reason ?? "" },
                    false,
                  );
                }
              } catch {
                // fail-closed: a broken capture attempt is invisible to the session
              }
            }
          } catch {
            // the subscription itself ended (abort or host error); nothing to do
          }
        })();
        captureCleanup = () => controller.abort();
      }
    }
    // Single cleanup returned by setup: tears down the measured listener and,
    // when enabled, the capture subscription. Future teardowns merge in here.
    return () => {
      measuredController.abort();
      if (captureCleanup) return captureCleanup();
    };
  },
};

// The plain object IS the V2 contract ({ id, setup }); the SDK's `Plugin` type
// pins its shape at compile time. The import is deliberately type-only:
// opencode installs npm plugins with runtime dependencies only (verified in
// ~/.cache/opencode/npm/<pkg>@<ver>/), so a value import of @opencode/plugin —
// a devDependency here — would fail to resolve at load time for published
// consumers, and making it a runtime dependency would pull effect +
// @opencode/client into every install, the exact dead-weight problem dropping
// the V1 SDK fixes. `Plugin.define` is an identity function at runtime, so this
// annotation buys the same compile-time contract for zero runtime cost.
const plugin: Plugin = {
  id: PLUGIN_ID,
  setup: async (ctx) => impl.setup(ctx as unknown as PluginCtx),
};

export const SelfImprovement = plugin;
export default plugin;

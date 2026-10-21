// The status hand-off between the two surface halves. The server plugin writes
// status.json on every epoch recompute (src/index.ts); the terminal plugin
// (src/tui.tsx) and the memory_status tool read it. status.json is deliberately
// NOT a .logfmt memory file — loadAll() must never ingest it.
//
// Scope of v1: same-machine reads. Against a REMOTE server the terminal panel
// sees no status file (it says so) — the RPC surface is the planned follow-up.
import { join } from "node:path";
import { dateStr, evidenceDir, memoryRoot } from "./config.ts";
import { parseLine, readLines } from "./logfmt.ts";

export interface StoreCounts {
  active: number;
  superseded: number;
  open: number;
  scopes: number;
}

export interface StatusPayload {
  /** ISO instant of the epoch recompute that produced this snapshot. */
  at: string;
  sessionID: string;
  /** storeVersion() fingerprint the block was frozen against. */
  storeVersion: string;
  reason: "first" | "store_changed";
  /** epoch recomputes since the server process started — cache-stability proxy. */
  recomputes: number;
  /** exact injected block ("" = abstained: no vocabulary overlap). */
  block: string;
  blockChars: number;
  budget: number;
  store: StoreCounts;
}

export interface BlockedRow {
  ts: string;
  sid: string;
  reason: string;
}

export function statusFile(): string {
  return join(memoryRoot(), "status.json");
}

// Best-effort by design: a status write must never break injection.
export async function writeStatus(p: StatusPayload): Promise<void> {
  try {
    await Bun.write(statusFile(), JSON.stringify(p, null, 2) + "\n");
  } catch {
    // swallow — surfaces degrade to "no data", the session does not.
  }
}

export async function readStatus(): Promise<StatusPayload | null> {
  try {
    const f = Bun.file(statusFile());
    if (!(await f.exists())) return null;
    const v: unknown = await f.json();
    if (!v || typeof v !== "object") return null;
    const p = v as Partial<StatusPayload>;
    if (typeof p.at !== "string" || typeof p.block !== "string") return null;
    return p as StatusPayload;
  } catch {
    return null;
  }
}

// Newest-first last `limit` write_blocked evidence rows, scanning today and
// yesterday so a block just before midnight stays visible.
export async function blockedRecent(limit = 6): Promise<BlockedRow[]> {
  const today = dateStr();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0]!;
  const rows: BlockedRow[] = [];
  for (const day of [yesterday, today]) {
    for (const line of await readLines(join(evidenceDir(), `${day}.logfmt`))) {
      const f = parseLine(line);
      if (!f || f.ev !== "write_blocked") continue;
      rows.push({
        ts: String(f.ts ?? day),
        sid: String(f.sid ?? "?"),
        reason: String(f.reason ?? "?"),
      });
    }
  }
  return rows.slice(-limit).reverse();
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Plain-text rendering shared by the memory_status tool (and any other chat
 * client). Sections match the terminal /memory panel one-for-one.
 */
export function renderMemoryReport(input: {
  status: StatusPayload | null;
  store: StoreCounts;
  blocked: BlockedRow[];
  /** epoch age basis; defaults to the status file's own `at`. */
  at?: string;
}): string {
  const { status, store, blocked } = input;
  const out: string[] = ["MEMORY STATUS", ""];

  out.push("INJECTED NOW");
  if (!status) {
    out.push('  no epoch yet — memory has not injected this session (fresh server, or no prompt scored yet)');
  } else {
    const age = ago(input.at ?? status.at);
    out.push(
      `  epoch started ${status.at} (${age}, ${status.reason}); ` +
        `${status.recomputes} recompute(s) since server start; ` +
        `${status.blockChars}/${status.budget} chars`,
    );
    if (status.block) out.push("", status.block.split("\n").map((l) => `  ${l}`).join("\n"));
    else out.push("  abstained — your prompt shares no content vocabulary with any memory, so nothing was injected (by design, no noise).");
  }

  out.push("", "RECENT BLOCKED WRITES");
  if (!blocked.length) out.push("  (none today or yesterday)");
  for (const b of blocked) {
    out.push(`  ${b.ts}  session ${b.sid}  ${b.reason}`);
  }
  out.push("  (reasons are logged via memory_evidence; the gate never deletes — it asks for a rephrase)");

  out.push(
    "",
    "STORE",
    `  ${store.active} active · ${store.superseded} superseded · ${store.open} open · ${store.scopes} scopes`,
  );
  out.push("", "Terminal (CLI/TUI) users: /memory opens this as a live panel; the footer shows a one-line badge.");
  return out.join("\n");
}

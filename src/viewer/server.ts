// Memory Viewer server. Bundled with the plugin: run `bun memory-view` (or
// `bun run src/viewer/server.ts`) from the repo root and open the printed URL.
// Binds 127.0.0.1 only — the memory store is local, personal data. All reads go
// through the same loadAll() used by recall/inject (so blocked entries are
// hidden), and all mutations are non-destructive (snapshot + audit + supersede).
// I2: serves only file data; never writes into any repo.
import { basename, join } from "node:path";
import { serve, type Server } from "bun";
import { deletionsFile, memoryRoot, snapshotDir } from "../config.ts";
import { blockedEntries } from "../blocklist.ts";
import { listSnapshots, restoreSnapshot } from "../undo.ts";
import { appendMemory, loadAll, memoryFiles, snapshotFiles } from "../memory.ts";
import { parseLine, readLines } from "../logfmt.ts";
import { deleteMemory, editMemory, addBlock, removeBlock, type MutationResult } from "./mutate.ts";

const PAGE = join(import.meta.dir, "page.html");
const HOST = process.env.OPENCODE_VIEWER_HOST || "127.0.0.1";
const PORT = Number(process.env.OPENCODE_VIEWER_PORT || 8787);

// Defense-in-depth headers on every response. CSP: the page uses only inline
// script/style and same-origin fetch, so everything else is off — a stored-XSS
// payload (see issue #11) gains no exfil channel and no framing.
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "application/json" },
  });
}

function error(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

// Binding 127.0.0.1 keeps other machines out, but not other websites open in
// the user's browser. Two checks close that:
// - Host must name this viewer. A DNS-rebinding page reaches 127.0.0.1 under
//   its own hostname, so its requests arrive with a foreign Host.
// - Writes must be JSON from this viewer's own origin. A cross-site form or
//   no-cors fetch can POST text/plain without a CORS preflight, and every
//   memory edited here is injected into the agent's system prompt.
// A viewer deliberately exposed under another name (OPENCODE_VIEWER_HOST set
// to a LAN address, a hostname) can list it in OPENCODE_VIEWER_ALLOWED_HOSTS.
function allowedHostnames(): Set<string> {
  const extra = (process.env.OPENCODE_VIEWER_ALLOWED_HOSTS ?? "").split(",");
  const names = ["127.0.0.1", "localhost", "::1", HOST, ...extra]
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean)
    .map((n) => (n.includes(":") && !n.startsWith("[") ? `[${n}]` : n));
  return new Set(names);
}

function rejectRequest(req: Request, url: URL, port: number): Response | null {
  if (!allowedHostnames().has(url.hostname) || (url.port || "80") !== String(port)) {
    return error("unexpected Host header", 403);
  }
  if (req.method === "GET" || req.method === "HEAD") return null;
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== url.origin) return error("cross-origin request refused", 403);
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return error("content-type must be application/json", 415);
  return null;
}

interface Row {
  ts: string;
  type: string;
  scope: string;
  content: string;
  reason?: string;
}

// Deleted entries live only in the audit log (their memory line was removed),
// so surface the recorded data + reason from deletions.logfmt.
async function deletedRows(): Promise<Row[]> {
  const lines = await readLines(deletionsFile());
  return lines
    .map((l) => parseLine(l))
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .map((f) => ({
      ts: String(f.original_ts ?? f.ts ?? ""),
      type: String(f.type ?? ""),
      scope: String(f.scope ?? ""),
      content: String(f.content ?? ""),
      reason: String(f.reason ?? ""),
    }));
}

// Blocked entries are still on disk but hidden by the blocklist; scan every
// memory file and keep the ones whose ts is blocked, with their full data.
async function blockedRows(): Promise<Row[]> {
  const blocked = await blockedEntries();
  const byTs = new Map(blocked.map((b) => [b.ts, b.reason]));
  const out: Row[] = [];
  for (const file of await memoryFiles()) {
    for (const line of await readLines(file)) {
      const f = parseLine(line);
      if (!f || typeof f.ts !== "string") continue;
      if (!byTs.has(f.ts)) continue;
      out.push({
        ts: f.ts,
        type: String(f.type ?? ""),
        scope: String(f.scope ?? ""),
        content: String(f.content ?? ""),
        reason: byTs.get(f.ts) ?? "",
      });
    }
  }
  return out;
}

export interface ViewerServer {
  server: Server<any>;
  url: string;
}

export async function startViewer(port: number = PORT): Promise<ViewerServer> {
  const page = await Bun.file(PAGE).text();
  const server = serve({
    hostname: HOST,
    port,
    fetch(req, srv) {
      // Bun builds req.url from the request's Host header. A malformed Host
      // makes the URL parse THROW — before rejectRequest could answer. Letting
      // that escape hands the caller Bun's dev error page (stack + absolute
      // paths), so the parse itself is the first guarded step (issue #12).
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        return error("malformed request URL (bad Host header?)", 400);
      }
      const rejected = rejectRequest(req, url, server.port ?? port);
      if (rejected) return rejected;
      if (url.pathname === "/") {
        return new Response(page, {
          headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" },
        });
      }
      if (req.method === "GET" && url.pathname === "/api/data") {
        return loaded().then(
          (d) => json(d),
          () => error("failed to load memory data"),
        );
      }
      return route(req, url).catch((e) => error(e instanceof Error ? e.message : String(e)));
    },
  });
  const bound = server.port ?? port;
  return { server, url: `http://${HOST}:${bound}/` };
}

async function loaded(): Promise<Record<string, unknown>> {
  const [memories, blocked, deleted, snaps] = await Promise.all([
    loadAll(),
    blockedRows(),
    deletedRows(),
    listSnapshots(),
  ]);
  const blockedByTs = new Set(blocked.map((b) => b.ts));
  return {
    roots: { memoryRoot: memoryRoot(), snapshotDir: snapshotDir() },
    memories: memories.map((m) => ({
      ts: m.ts,
      type: m.type,
      scope: m.scope,
      content: m.content,
      issue: m.issue,
      tags: m.tags,
      superseded_by: m.superseded_by,
      reason: m.reason,
      blocked: blockedByTs.has(m.ts),
    })),
    blocked,
    deleted,
    snapshots: snaps.map((s) => ({ name: s.name, bytes: s.bytes })),
  };
}

async function route(req: Request, url: URL): Promise<Response> {
  if (req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (url.pathname === "/api/edit") return editRoute(body);
    if (url.pathname === "/api/delete") return deleteRoute(body);
    if (url.pathname === "/api/block") return blockRoute(body);
    if (url.pathname === "/api/unblock") return unblockRoute(body);
    if (url.pathname === "/api/restore-entry") return restoreEntryRoute(body);
    if (url.pathname === "/api/restore") return restoreRoute(body);
  }
  return json({ error: "not found" }, 404);
}

async function editRoute(body: Record<string, unknown>): Promise<Response> {
  const r: MutationResult = await editMemory({
    ts: String(body.ts ?? ""),
    type: String(body.type ?? ""),
    scope: String(body.scope ?? ""),
    content: String(body.content ?? ""),
    issue: typeof body.issue === "string" ? body.issue : undefined,
    tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
    reason: String(body.reason ?? ""),
  });
  return json(r);
}

async function deleteRoute(body: Record<string, unknown>): Promise<Response> {
  return json(await deleteMemory({ ts: String(body.ts ?? ""), reason: String(body.reason ?? "") }));
}

async function blockRoute(body: Record<string, unknown>): Promise<Response> {
  return json({ ts: await addBlock(String(body.ts ?? ""), String(body.reason ?? "")) });
}

async function unblockRoute(body: Record<string, unknown>): Promise<Response> {
  return json({ unblocked: await removeBlock(String(body.ts ?? "")) });
}

async function restoreEntryRoute(body: Record<string, unknown>): Promise<Response> {
  const t = await appendMemory({
    type: String(body.type ?? ""),
    scope: String(body.scope ?? ""),
    content: String(body.content ?? ""),
  });
  return json({ restored: t });
}

async function restoreRoute(body: Record<string, unknown>): Promise<Response> {
  // Path containment (issue #21): name arrives raw from the wire. Basename it,
  // then pin it to the real snapshot-name grammar — `<epoch-ms>-<YYYY-MM-DD>.logfmt`
  // — so neither path join below can be steered outside snapshots/ and the
  // store root with a `..` or absolute name.
  const name = basename(String(body.name ?? ""));
  if (!/^\d+-\d{4}-\d{2}-\d{2}\.logfmt$/.test(name)) {
    return error("invalid snapshot name", 400);
  }
  const original = name.replace(/^\d+-/, "");
  // Explicit human admin action: exact rollback — but the rollback is itself
  // rollback-able. Snapshot the current file first so concurrent-session rows
  // lost here stay recoverable, and report how many rows were rolled back.
  await snapshotFiles([join(memoryRoot(), original)]);
  const res = await restoreSnapshot(join(snapshotDir(), name), memoryRoot(), "force");
  return json({
    restored: res.target,
    rolledBack: res.concurrentAdded.length + res.concurrentChanged.length,
  });
}

if (import.meta.main) {
  startViewer(PORT).then(({ url }) => {
    console.log(`\nMemory Viewer: ${url}\n(127.0.0.1 only; snapshot+audit are mandatory on every edit/delete)`);
  });
}

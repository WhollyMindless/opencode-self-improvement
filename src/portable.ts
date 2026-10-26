// Portability: JSONL export/import of the durable store, plus the
// stale-open-thread query that backs memory_decay. Import NEVER writes: every
// row flows through the caller-provided gate callback (index.ts wires it to
// runWriteGate), so moving memories between machines cannot bypass the 4-gate
// moat. Decay is supersede-not-delete and snapshot-first, mirroring prune.
import { join } from "node:path";
import { memoryRoot } from "./config.ts";
import { isActive, isVisibleTo, loadAll, readerFromSid, type Memory } from "./memory.ts";
import { repoScopeFor } from "./repokey.ts";
import { getCurrent } from "./state.ts";
import { TYPES } from "./types.ts";
import type { WriteCandidate } from "./gates.ts";
import { flattenMemoryText } from "./sanitize.ts";

// --- export -------------------------------------------------------------------

// Export header line: the first line of a v1 export identifies the file as
// machine-made by memory_export. It is what vouches for status="open" frontier
// rows on import — the open status exempts a row from ref grounding at the
// gate, so it must not be granted by an attacker-chosen field in a
// hand-written JSONL. The header is friction, not a boundary (anyone can
// paste one); the real defense against planted content is the injection
// framing + provenance in inject.ts and the write gates.
export const EXPORT_HEADER = "opencode-self-improvement";
export const EXPORT_VERSION = 1;

export interface ExportOptions {
  /** Only export rows from this exact scope. */
  scope?: string;
  /** Destination path; defaults to <memory-root>/exports/<stamp>.jsonl. */
  file?: string;
}

export interface ExportResult {
  path: string;
  count: number;
}

// Filesystem-safe YYYY-MM-DDTHHMMSS (no colons).
function stamp(d: Date = new Date()): string {
  return d.toISOString().slice(0, 19).replace(/:/g, "");
}

// Write the ACTIVE store as JSONL — a header line followed by one JSON object
// per line carrying {ts,type,scope,content,status,tags,issue}. Superseded rows
// are not exported: the export is the live store, and history stays auditable
// where it lives (the original logfmt files + snapshots). The header is always
// written, even for an empty store, so "has header" is a format invariant.
export async function exportMemories(opts: ExportOptions = {}): Promise<ExportResult> {
  let mems = (await loadAll()).filter(isActive);
  if (opts.scope) mems = mems.filter((m) => m.scope === opts.scope);
  const path = opts.file ?? join(memoryRoot(), "exports", `${stamp()}.jsonl`);
  const header = JSON.stringify({
    _export: EXPORT_HEADER,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    count: mems.length,
  });
  const lines = mems.map((m) =>
    JSON.stringify({
      ts: m.ts,
      type: m.type,
      scope: m.scope,
      content: m.content,
      status: m.status,
      tags: m.tags,
      kw: m.kw,
      issue: m.issue,
      // Origin stamps ride along so a same-repo machine hop can retain them.
      // Import validates them against its current repo before promotion.
      repo: m.repo,
      repoPath: m.repoPath,
    }),
  );
  await Bun.write(path, [header, ...lines].join("\n") + "\n");
  return { path, count: mems.length };
}

// --- import -------------------------------------------------------------------

export interface ImportTally {
  promoted: number;
  collapsed: number;
  blocked: number;
  skipped: number;
  /** Open rows downgraded because the file cannot grant that frontier scope. */
  downgraded: number;
}

// Recognize the export header line (see EXPORT_HEADER). A version NEWER than
// we understand does NOT grant the frontier exemption — we cannot know what
// its writer meant (fail closed).
function exportHeader(line: string): { version: number } | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  if (r._export !== EXPORT_HEADER) return null;
  return { version: typeof r.version === "number" ? r.version : 1 };
}

// A line is malformed (skipped, never gated) unless it is a JSON object with a
// known type, a non-empty scope, and non-empty content. Optional fields are
// sanitized rather than fatal where noted. Control characters in structured
// metadata make the row malformed; content alone may remain multiline.
function parseRow(line: string): WriteCandidate | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.type !== "string" || !(TYPES as readonly string[]).includes(r.type)) return null;
  if (typeof r.scope !== "string" || !r.scope.trim()) return null;
  if (flattenMemoryText(r.scope) !== r.scope) return null;
  if (typeof r.content !== "string" || !r.content.trim()) return null;
  if (
    Array.isArray(r.tags) &&
    r.tags.some((t) => typeof t === "string" && flattenMemoryText(t) !== t)
  ) return null;
  if (typeof r.issue === "string" && flattenMemoryText(r.issue) !== r.issue) return null;
  // Keywords widen recall only, so a malformed entry costs them, never the row
  // (contrast scope/content, where a bad value makes the line malformed).
  const kw = Array.isArray(r.kw)
    ? r.kw.filter(
        (k): k is string =>
          typeof k === "string" && !!k.trim() && flattenMemoryText(k.trim()) === k.trim(),
      )
    : undefined;
  const c: WriteCandidate = { type: r.type, scope: r.scope, content: r.content };
  if (r.status === "open" || r.status === "settled") c.status = r.status;
  if (Array.isArray(r.tags) && r.tags.every((t) => typeof t === "string")) c.tags = r.tags;
  if (kw?.length) c.kw = kw;
  if (typeof r.issue === "string" && r.issue) c.issue = r.issue;
  // Origin stamps survive an export/import hop (repokey.ts): a row written
  // for repo X stays visible only where repo X is opened, even on a new
  // machine. Unstamped rows stay global.
  if (typeof r.repo === "string" && r.repo) c.repo = r.repo;
  if (typeof r.repoPath === "string" && r.repoPath) c.repoPath = r.repoPath;
  return c;
}

// Read a JSONL export and run every valid row through `gate`. The CALLER owns
// promotion (index.ts passes runWriteGate with the "import" tag), so imported
// rows face the same canonical/stale/dedup/ambiguity gates as any other write.
// Blocked and collapsed rows are normal outcomes, tallied rather than raised.
// Frontier policy: status="open" exempts a row from ref grounding
// at the gate, so it is honored ONLY when the file opens with our export
// header (version <= ours); otherwise every open row is downgraded to settled
// and tallied. Imported origin stamps are honored only when they match the
// importing session's current repo (or are an explicit "global"); foreign
// stamps are removed so the write choke point stamps the importing repo
// instead. With no current scope, stamps are kept (removing them would widen
// the row to global) and a stamped open row is downgraded, since its stamp
// cannot be verified. Only a missing file throws.
export async function importMemories(
  path: string,
  gate: (c: WriteCandidate) => Promise<{ action: string }>,
  // The importing session, captured at tool entry (#127): "the importing
  // session's current repo" must be the CALLER's repo even though this loop
  // awaits the gate on every row, during which a concurrent session can move
  // the ambient current.
  sessionID?: string,
): Promise<ImportTally> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`import file not found: ${path}`);
  const tally: ImportTally = { promoted: 0, collapsed: 0, blocked: 0, skipped: 0, downgraded: 0 };
  const currentScope = repoScopeFor(sessionID ?? getCurrent().sid);
  let allowFrontier = false;
  let first = true;
  for (const line of (await file.text()).split("\n")) {
    if (!line.trim()) continue;
    if (first) {
      first = false;
      const hdr = exportHeader(line);
      if (hdr) {
        allowFrontier = hdr.version <= EXPORT_VERSION;
        continue; // metadata line: never a memory row, never a skipped one
      }
    }
    const c = parseRow(line);
    if (!c) {
      tally.skipped++;
      continue;
    }
    const claimedGlobal = c.repo === "global";
    const hadStamp = c.repo !== undefined || c.repoPath !== undefined;
    // A foreign stamp is treated like no stamp, so appendMemory stamps the
    // importing repo. Explicit "global" is not a foreign repo and is kept (open
    // global rows are downgraded below). With no current scope there is nothing
    // to re-stamp with: dropping the stamp would widen the row to global, so it
    // is kept and only the open-row exemption is withdrawn.
    if (currentScope && !claimedGlobal) {
      if (c.repo !== currentScope.key) delete c.repo;
      if (c.repoPath !== currentScope.path) delete c.repoPath;
    }
    if (c.status === "open" && (!allowFrontier || claimedGlobal || (hadStamp && !currentScope))) {
      c.status = "settled";
      tally.downgraded++;
    }
    const outcome = await gate(c);
    if (outcome.action === "promoted") tally.promoted++;
    else if (outcome.action === "collapsed") tally.collapsed++;
    else tally.blocked++;
  }
  return tally;
}

// --- decay support --------------------------------------------------------------

// Active open threads with ts older than `days` days, oldest first (both sides
// are UTC-Z ISO strings, so plain lexicographic compare is correct).
export async function findStaleOpen(days: number, sid?: string): Promise<Memory[]> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const reader = readerFromSid(sid);
  return (await loadAll())
    // Decay is repo-scoped: running it here must not retire
    // another repo's open threads.
    .filter((m) => isActive(m) && isVisibleTo(m, reader) && m.status === "open" && m.ts < cutoff)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

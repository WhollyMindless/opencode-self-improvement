// Portability (Phase 5): JSONL export/import of the durable store, plus the
// stale-open-thread query that backs memory_decay. Import NEVER writes: every
// row flows through the caller-provided gate callback (index.ts wires it to
// runWriteGate), so moving memories between machines cannot bypass the 4-gate
// moat. Decay is supersede-not-delete and snapshot-first, mirroring prune.
import { join } from "node:path";
import { memoryRoot } from "./config.ts";
import { isActive, isVisibleHere, loadAll, type Memory } from "./memory.ts";
import { TYPES } from "./types.ts";
import type { WriteCandidate } from "./gates.ts";

// --- export -------------------------------------------------------------------

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

// Write the ACTIVE store as JSONL — one JSON object per line carrying
// {ts,type,scope,content,status,tags,issue}. Superseded rows are not exported:
// the export is the live store, and history stays auditable where it lives
// (the original logfmt files + snapshots).
export async function exportMemories(opts: ExportOptions = {}): Promise<ExportResult> {
  let mems = (await loadAll()).filter(isActive);
  if (opts.scope) mems = mems.filter((m) => m.scope === opts.scope);
  const path = opts.file ?? join(memoryRoot(), "exports", `${stamp()}.jsonl`);
  const lines = mems.map((m) =>
    JSON.stringify({
      ts: m.ts,
      type: m.type,
      scope: m.scope,
      content: m.content,
      status: m.status,
      tags: m.tags,
      issue: m.issue,
      // Origin stamps ride along so scoping survives the machine hop (the
      // repo key is a remote-URL hash; the path is the secondary match).
      repo: m.repo,
      repoPath: m.repoPath,
    }),
  );
  await Bun.write(path, lines.length ? lines.join("\n") + "\n" : "");
  return { path, count: mems.length };
}

// --- import -------------------------------------------------------------------

export interface ImportTally {
  promoted: number;
  collapsed: number;
  blocked: number;
  skipped: number;
}

// A line is malformed (skipped, never gated) unless it is a JSON object with a
// known type, a non-empty scope, and non-empty content. Optional fields are
// sanitized rather than fatal: an unusable status/tags/issue is dropped.
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
  if (typeof r.content !== "string" || !r.content.trim()) return null;
  const c: WriteCandidate = { type: r.type, scope: r.scope, content: r.content };
  if (r.status === "open" || r.status === "settled") c.status = r.status;
  if (Array.isArray(r.tags) && r.tags.every((t) => typeof t === "string")) c.tags = r.tags;
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
// Only a missing file throws.
export async function importMemories(
  path: string,
  gate: (c: WriteCandidate) => Promise<{ action: string }>,
): Promise<ImportTally> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`import file not found: ${path}`);
  const tally: ImportTally = { promoted: 0, collapsed: 0, blocked: 0, skipped: 0 };
  for (const line of (await file.text()).split("\n")) {
    if (!line.trim()) continue;
    const c = parseRow(line);
    if (!c) {
      tally.skipped++;
      continue;
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
export async function findStaleOpen(days: number): Promise<Memory[]> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return (await loadAll())
    // Decay is repo-scoped (issue #8): running it here must not retire
    // another repo's open threads.
    .filter((m) => isActive(m) && isVisibleHere(m) && m.status === "open" && m.ts < cutoff)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

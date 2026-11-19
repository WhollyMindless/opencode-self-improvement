#!/usr/bin/env bun
/**
 * ref-fixer — repoint stored rows at files that moved under them.
 * Default: DRY RUN. `--apply`: gated writes.
 *
 * Why this exists: the write gate refuses a NEW settled claim that cites a
 * path the repo does not have (`ref_path_missing`), but a row written BEFORE a
 * move keeps citing the path it was told. The `src/` moves (domain structure,
 * the telemetry merge, ensure → init) therefore silently invalidated refs in
 * rows already on disk: recall goes on quoting `src/lock.ts` to a session that
 * cannot open it. Nothing notices, because the gate only ever sees a write.
 *
 * Repair rule, conservative by design (decided 2026-11-19):
 *
 *  1. A path is repointed only when git records a RENAME for it, the rename
 *     chain ends at a file that exists today, and the BASENAME is unchanged.
 *     Same basename means the row's word bag keeps the token a query matches
 *     on — `src/lock.ts` → `src/store/lock.ts` still says "lock". A rename
 *     that also renamed the file (`src/logfmt.ts` → src/core/logfmt/publish.ts)
 *     changes what the sentence asserts, so it is reported, not rewritten.
 *  2. A path that is missing only its leading directory is repointed when
 *     exactly one prefixed form exists: `capture/runtime.ts` →
 *     `src/capture/runtime.ts`. Two candidates is a human's choice.
 *  3. Everything else is REPORTED ONLY. A row about a deliberately retired
 *     artifact (`poc-409/`, a retired bench runner) is accurate history: the
 *     file is gone on purpose and the row is the record that it existed.
 *     Rewording that is a decision, and the convention for it already exists —
 *     name the retirement and point at `git log -- <path>`.
 *
 * Apply path, identical to symptom-fixer: one row at a time under the store's
 * batch lock, through the real write pipeline with `supersedesTs` set — the
 * memory_update contract. The successor inherits the target's repo stamp (this
 * script forges no identity), the old row is superseded and never edited, and
 * markSuperseded snapshots the day file first, so memory_undo stays the
 * recovery path. A row the gate refuses is a no-op and is listed.
 *
 * Usage: bun scripts/ref-fixer.ts [--apply] [--repo <path>] [--limit N]
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadAll } from "../src/store/files/load.ts";
import { markSuperseded } from "../src/store/files/supersede.ts";
import { isActive } from "../src/store/model/predicates.ts";
import { withStoreBatch } from "../src/store/lock.ts";
import { memoryRoot } from "../src/core/config/paths.ts";
import { nonCaptureTags } from "../src/core/guidance.ts";
import { runWriteGate } from "../src/gate/gate.ts";
import { checkablePathRefs } from "../src/gate/resolver.ts";
import { resolveRepo } from "../src/identity/repokey.ts";
import type { Memory } from "../src/store/model/memory.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");
const SHOW = Number(arg("limit") ?? 40);
const repoRoot = arg("repo") ?? process.cwd();
const scope = resolveRepo(repoRoot);

// Latest rename wins, then the chain is followed to its end: a file moved
// twice (src/hits.ts → src/hits/ledger.ts → src/telemetry/ledger.ts) must
// resolve to the file that exists now, not the intermediate.
const renamed = new Map<string, string>();
{
  const raw = Bun.spawnSync(
    [
      "git",
      "-C",
      repoRoot,
      "log",
      "--diff-filter=R",
      "--name-status",
      "--format=",
    ],
    { stdout: "pipe" },
  ).stdout.toString();
  for (const line of raw.split("\n")) {
    const p = line.split("\t");
    if (p[0]?.startsWith("R") && p[1] && p[2]) renamed.set(p[1], p[2]);
  }
}
function renameEnd(from: string): string | null {
  let cur = from;
  for (let hops = 0; hops < 8; hops++) {
    const next = renamed.get(cur);
    if (!next || next === cur) break;
    cur = next;
  }
  return cur === from ? null : cur;
}
const base = (p: string): string => p.split("/").pop() ?? p;

/** The one new path this row may cite for `ref`, or null to leave it alone. */
function fixFor(ref: string): string | null {
  if (existsSync(join(repoRoot, ref))) return null;
  const end = renameEnd(ref);
  if (end && existsSync(join(repoRoot, end)) && base(end) === base(ref))
    return end;
  const prefixed = `src/${ref}`;
  if (!ref.startsWith("src/") && existsSync(join(repoRoot, prefixed)))
    return prefixed;
  return null;
}

interface Plan {
  row: Memory;
  edits: Array<{ from: string; to: string }>;
  content: string;
}
const plans: Plan[] = [];
const reported = new Map<string, number>();

const active = (await loadAll()).filter(
  (m) => isActive(m) && m.repo === scope.key,
);
for (const row of active) {
  const edits: Array<{ from: string; to: string }> = [];
  for (const ref of checkablePathRefs(row.content)) {
    const to = fixFor(ref);
    if (to) edits.push({ from: ref, to });
    else if (!existsSync(join(repoRoot, ref)))
      reported.set(ref, (reported.get(ref) ?? 0) + 1);
  }
  if (!edits.length) continue;
  let content = row.content;
  for (const e of edits) content = content.split(e.from).join(e.to);
  // A repoint must not change what the row can be found by, beyond the
  // directory it adds. Same basename is what guarantees this; the assert keeps
  // a future rule change from quietly breaking it.
  for (const e of edits)
    if (base(e.from) !== base(e.to))
      throw new Error(`basename changed in plan: ${e.from} -> ${e.to}`);
  plans.push({ row, edits, content });
}

console.log(
  `repo ${scope.key}  active rows ${active.length}\n` +
    `repointable rows: ${plans.length}   dead paths left for a human: ${reported.size}\n`,
);
for (const p of plans.slice(0, SHOW))
  console.log(
    `${p.row.ts} [${p.row.status ?? "-"}] ${p.row.type}/${p.row.scope}  ${p.edits
      .map((e) => `${e.from} -> ${e.to}`)
      .join(", ")}`,
  );
if (plans.length > SHOW) console.log(`  … ${plans.length - SHOW} more`);
if (reported.size) {
  console.log(
    "\nNOT repointed — no rename in history, or the rename also renamed the file.",
    "\nEach is either accurate history or a human reword; the script will not guess:\n",
  );
  for (const [p, n] of [...reported].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(3)}x  ${p}`);
}

if (!APPLY) {
  console.log(
    "\nDRY RUN — no writes. Re-run with --apply to write through the gated update path.",
  );
  process.exit(0);
}

let applied = 0;
const failures: string[] = [];
for (const p of plans) {
  const verdict = await withStoreBatch(memoryRoot(), "ref-fixer", async () => {
    const fresh = await loadAll();
    const target = fresh.find((m) => m.ts === p.row.ts);
    if (!target || !isActive(target)) return "target-gone";
    // The scan is a snapshot. A row edited between scan and apply is skipped
    // rather than clobbered with the old rewrite.
    if (target.content !== p.row.content)
      return "drift (content changed since scan)";
    const out = await runWriteGate(
      {
        type: target.type,
        scope: target.scope,
        content: p.content,
        kw: target.kw,
        tags: nonCaptureTags(target.tags),
        issue: target.issue,
        status: target.status ?? "settled",
        repo: target.repo ?? "global",
        repoPath: target.repoPath,
      },
      {
        // Refs resolve against the repository the row describes, not the
        // store: that is the only tree where the new path exists.
        liveRoot: target.repoPath ?? repoRoot,
        evidenceCalls: [],
        hasGateCheck: true,
        trusted: true,
        supersedesTs: target.ts,
      },
    );
    if (out.action !== "promoted")
      return `blocked:${out.action === "blocked" ? out.reason : out.action}`;
    const ok = await markSuperseded(target.ts, {
      superseded_by: out.ts,
      reason: "fixer_ref_repoint",
    });
    return ok
      ? "applied"
      : `PARTIAL: replacement ${out.ts} IS on disk; supersede of ${target.ts} failed`;
  });
  if (verdict === "applied") applied++;
  else failures.push(`${p.row.ts} [${p.row.scope}/${p.row.type}] ${verdict}`);
}
console.log(
  `\napplied (gated update, supersede-first, snapshot-backed): ${applied}`,
);
if (failures.length) {
  console.log(`not applied (${failures.length}):`);
  for (const f of failures) console.log(`  ${f}`);
}

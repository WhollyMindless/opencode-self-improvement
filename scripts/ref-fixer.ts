#!/usr/bin/env bun
/**
 * ref-fixer — repoint stored rows at files that moved under them.
 * Default: DRY RUN. `--apply`: gated writes.
 *
 * Why this exists: the write gate refuses a NEW settled claim that cites a
 * path the repo does not have (`ref_path_missing`), but a row written BEFORE a
 * move keeps citing the path it was told. The `src/` moves (domain structure,
 * the telemetry merge, ensure -> init) therefore silently invalidated refs in
 * rows already on disk: recall goes on quoting `src/lock.ts` to a session that
 * cannot open it. Nothing notices, because the gate only ever sees a write.
 *
 * Two rules, both narrow, and the reason each is narrow:
 *
 *  1. RENAME. Git records a rename scored R90 or higher whose chain ends at a
 *     file that exists today and whose BASENAME is unchanged. The floor is
 *     measured: this repository's renames cluster at R090..R100 (the domain
 *     restructure, where the only content change is the import lines inside the
 *     moved file) with outliers at R058, R072, R080, R086 and R088 — files git
 *     scored as renames after much of their content was rewritten. Repointing
 *     onto one of those would assert something about a module that no longer
 *     exists in the shape the sentence describes. Same basename matters because
 *     the row's word bag keeps the token a query matches on: `src/lock.ts` ->
 *     `src/store/lock.ts` still says "lock".
 *  2. MISSING PREFIX. The path never existed anywhere in git history and
 *     exactly ONE tracked file ends with it. That combination is what makes it
 *     a loose citation (`gate/gate.ts` for `src/gate/gate.ts`) rather than a
 *     retired file. Without the history check this rule would take a path the
 *     gate refused as hallucinated and hand it a verified ref.
 *
 * Everything else is REPORTED ONLY. A row about a deliberately retired artifact
 * (`poc-409/`, a retired bench runner) is accurate history: the file is gone on
 * purpose and the row is the record that it existed. Rewording that is a
 * decision, not a repair.
 *
 * Scope, stated because silence reads as a clean report: rows are selected by
 * `m.repo === <key for --repo>` (default cwd). Rows stamped for another
 * repository and rows with no repo stamp — the global rows — are never scanned,
 * because there is no tree here that their paths belong to.
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
import { checkablePathRefSpans } from "../src/gate/resolver.ts";
import { resolveRepo } from "../src/identity/repokey.ts";
import type { Memory } from "../src/store/model/memory.ts";

/**
 * Rewrites the refs in `fixes` at their exact spans. Occurrences the gate does
 * not check — an absolute path, a URL, `$BUILD_ROOT/src/a.ts`, a bare filename,
 * or the same text nested inside a longer path — are left byte-identical,
 * because the span list is exactly what `checkablePathRefs` validates.
 */
export function applyRefFixes(
  content: string,
  fixes: ReadonlyMap<string, string>,
): string {
  const spans = checkablePathRefSpans(content).filter((s) => fixes.has(s.ref));
  if (!spans.length) return content;
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += content.slice(at, s.start) + fixes.get(s.ref);
    at = s.end;
  }
  return out + content.slice(at);
}

/**
 * Terminal target of a rename chain, or null when there is no chain, the chain
 * cycles, it is longer than the hop cap, or any hop's source path was renamed
 * more than once. All four mean "a human decides": an unresolved intermediate
 * is a path that no longer exists, and a reused source path — renamed away,
 * recreated, renamed away again — has two generations of rows written against
 * it and no way from the row's text to say which one it describes.
 */
export function chainEnd(
  from: string,
  renamed: ReadonlyMap<string, string>,
  exists: (p: string) => boolean,
  reused?: ReadonlySet<string>,
): string | null {
  let cur = from;
  const seen = new Set([from]);
  for (let hop = 0; hop < 8; hop++) {
    if (reused?.has(cur)) return null;
    const next = renamed.get(cur);
    if (!next) return cur === from ? null : exists(cur) ? cur : null;
    if (next === cur || seen.has(next)) return null;
    seen.add(next);
    cur = next;
  }
  return null;
}

/* ------------------------------- CLI below -------------------------------- */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const APPLY = process.argv.includes("--apply");
  const SHOW = Number(arg("limit") ?? 40);
  if (!Number.isInteger(SHOW) || SHOW < 1) {
    console.error(`--limit must be a positive integer, got ${arg("limit")}`);
    return 2;
  }
  const repoRoot = arg("repo") ?? process.cwd();
  const scope = resolveRepo(repoRoot);

  // Refuse to report green on an empty rename map: outside a git tree every
  // lookup would miss and the run would read as "nothing to repair".
  const git = (args: string[]): { code: number; out: string } => {
    const r = Bun.spawnSync(["git", "-C", repoRoot, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString() };
  };
  if (git(["rev-parse", "--git-dir"]).code !== 0) {
    console.error(`${repoRoot} is not a git repository — nothing to compare.`);
    return 2;
  }

  // Latest qualifying rename wins. The score floor is measured, not guessed:
  // across this repository's history renames land in two clusters — R090..R100
  // is the domain restructure, where the only content change is the import
  // lines inside the moved file, and the outliers below R090 (R058, R072, R080,
  // R086, R088) are files git scored as renames after rewriting much of them.
  // A row repointed onto one of those asserts something about a module that no
  // longer exists in the shape the sentence describes.
  const renamed = new Map<string, string>();
  const hopScore = new Map<string, number>();
  const reused = new Set<string>();
  {
    const r = git([
      "log",
      "--diff-filter=R",
      "--name-status",
      "--format=",
      "-M",
    ]);
    if (r.code !== 0) {
      console.error("git log for renames failed — nothing to compare.");
      return 2;
    }
    const counts = new Map<string, number>();
    for (const line of r.out.split("\n")) {
      const p = line.split("\t");
      if (!p[0]?.startsWith("R") || !p[1] || !p[2]) continue;
      // A path renamed more than once was renamed away, recreated, and renamed
      // away again. Rows written against each generation cite the same string
      // and describe different files, so no rule can pick between them.
      counts.set(p[1], (counts.get(p[1]) ?? 0) + 1);
      // git log is newest-first, so the FIRST record for a path is its newest
      // rename. Keeping the last would follow the oldest move in history and
      // land on a path that moved again since.
      if (renamed.has(p[1]) || hopScore.has(p[1])) continue;
      const score = Number(p[0].slice(1));
      hopScore.set(p[1], score);
      if (score >= 90) renamed.set(p[1], p[2]);
    }
    for (const [p, n] of counts) if (n > 1) reused.add(p);
  }
  // Tracked surface, for "exactly one file ends with this path". Tracked, not
  // a filesystem walk: build output and node_modules must not create a second
  // candidate and turn a safe repoint into a guess.
  const tracked = git(["ls-tree", "-r", "--name-only", "HEAD"])
    .out.split("\n")
    .filter(Boolean);
  // Did this path ever exist? If it did and is gone now, it was retired and
  // rule 2 must not resurrect it under a different name.
  const everExisted = (p: string): boolean =>
    git(["log", "-1", "--format=%H", "--", p]).out.trim() !== "";

  const base = (p: string): string => p.split("/").pop() ?? p;
  const here = (p: string): boolean => existsSync(join(repoRoot, p));

  /** The one new path this row may cite for `ref`, or null to leave it alone. */
  function fixFor(ref: string): { to: string; why: string } | null {
    if (here(ref)) return null;
    const end = chainEnd(ref, renamed, here, reused);
    if (end && base(end) === base(ref))
      return { to: end, why: `R${hopScore.get(ref) ?? "?"}` };
    if (!ref.startsWith("src/") && !everExisted(ref)) {
      const hits = tracked.filter((p) => p.endsWith(`/${ref}`));
      if (hits.length === 1 && base(hits[0]!) === base(ref))
        return { to: hits[0]!, why: "loose citation" };
    }
    return null;
  }

  interface Plan {
    row: Memory;
    edits: Array<{ from: string; to: string; why: string }>;
    content: string;
    /** Refs still dead after the rewrite — these are what the gate will refuse. */
    stillMissing: string[];
  }
  const plans: Plan[] = [];
  const reported = new Map<string, number>();
  const reusedSeen = new Set<string>();

  const all = await loadAll();
  const active = all.filter((m) => isActive(m) && m.repo === scope.key);
  const skipped = all.filter((m) => isActive(m) && m.repo !== scope.key).length;

  for (const row of active) {
    const fixes = new Map<string, { to: string; why: string }>();
    for (const { ref } of checkablePathRefSpans(row.content)) {
      if (fixes.has(ref)) continue;
      const fix = fixFor(ref);
      if (fix) fixes.set(ref, fix);
      else if (!here(ref)) {
        reported.set(ref, (reported.get(ref) ?? 0) + 1);
        if (reused.has(ref)) reusedSeen.add(ref);
      }
    }
    if (!fixes.size) continue;
    const content = applyRefFixes(
      row.content,
      new Map([...fixes].map(([from, f]) => [from, f.to])),
    );
    plans.push({
      row,
      edits: [...fixes].map(([from, f]) => ({ from, to: f.to, why: f.why })),
      content,
      stillMissing: [
        ...new Set(checkablePathRefSpans(content).map((s) => s.ref)),
      ]
        .filter((r) => !here(r))
        .sort(),
    });
  }

  console.log(
    `repo ${scope.key}  active rows ${active.length}  (rows outside this repo key, not scanned: ${skipped})\n` +
      `repointable rows: ${plans.length}   dead paths left for a human: ${reported.size}\n`,
  );
  if (!active.length)
    console.log(
      "NOTHING SCANNED — no active row carries this repo key. Pass --repo <path> for the repository these rows describe.\n",
    );
  for (const p of plans.slice(0, SHOW))
    console.log(
      `${p.row.ts} [${p.row.status ?? "-"}] ${p.row.type}/${p.row.scope}  ${p.edits
        .map((e) => `${e.from} -> ${e.to} (${e.why})`)
        .join(", ")}`,
    );
  // The rewrite is invisible unless it is printed: a bad one looks identical to
  // a good one in a from->to list, and the gate is the only thing downstream
  // that would notice — after the write.
  for (const p of plans)
    if (p.stillMissing.length)
      console.log(
        `  ${p.row.ts} will be REFUSED: still cites ${p.stillMissing.join(", ")}`,
      );
  if (plans.length > SHOW) console.log(`  … ${plans.length - SHOW} more`);
  if (reported.size) {
    console.log(
      "\nNOT repointed — no rename at R90 or above in history, or the move also",
      "renamed the file, or the path existed once and was retired. Each is either",
      "accurate history or a human reword; the script will not guess:\n",
    );
    for (const [p, n] of [...reported].sort((a, b) => b[1] - a[1]))
      console.log(`  ${String(n).padStart(3)}x  ${p}`);
  }
  if (reusedSeen.size)
    console.log(
      "\nRenamed more than once — moved away, recreated at the same path, moved",
      "away again. Rows written against each generation cite the same string and",
      "describe different files, so this script will not pick:\n  " +
        [...reusedSeen].join(", "),
    );

  if (!APPLY) {
    console.log(
      "\nDRY RUN — no writes. Re-run with --apply to write through the gated update path.",
    );
    return 0;
  }

  let applied = 0;
  const failures: string[] = [];
  for (const p of plans) {
    const verdict = await withStoreBatch(
      memoryRoot(),
      "ref-fixer",
      async () => {
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
          : `PARTIAL: replacement ${out.ts} IS on disk and the old row ${target.ts} is still active — re-running reports the duplicate; resolve with memory_undo before re-applying`;
      },
    );
    if (verdict === "applied") applied++;
    else failures.push(`${p.row.ts} [${p.row.scope}/${p.row.type}] ${verdict}`);
  }
  console.log(
    `\napplied (gated update, snapshot-backed, old row superseded): ${applied}`,
  );
  if (failures.length) {
    console.log(`not applied (${failures.length}):`);
    for (const f of failures) console.log(`  ${f}`);
    // A refusal is the expected outcome for a row citing a second dead path,
    // but it must not read as success to a caller scripting this.
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(await main());

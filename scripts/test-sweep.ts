// Invariant mutation sweep: break ONE claimed guarantee at a time and see
// whether the test suite notices. A mutation that no test dies on is a gap —
// the suite does not actually depend on that guarantee, whatever it looks like.
//
//   bun run scripts/test-sweep.ts [--validate] [--only=id,id] [--repeat=n]
//
// Mutations are applied in a detached git worktree of HEAD, never in the
// working tree. Each `from` must occur EXACTLY ONCE in its file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Mutant {
  id: string;
  inv: string; // the guarantee being broken
  file: string;
  from: string;
  to: string;
}

const REPO = join(import.meta.dir, "..");

const M = (id: string, inv: string, file: string, from: string, to: string): Mutant => ({
  id,
  inv,
  file,
  from,
  to,
});

const MUTANTS: Mutant[] = [
  // ---- store write serialization -------------------------------------------
  M(
    "lock-noop",
    "whole-file rewrites are serialized per store file",
    "src/lock.ts",
    "  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;",
    "  return fn();\n  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;",
  ),
  M(
    "lock-never-steal",
    "a lock left by a dead process is recovered",
    "src/lock.ts",
    "const STALE_MS = 10_000;",
    "const STALE_MS = Infinity;",
  ),
  M(
    "lock-release-blind",
    "a holder never deletes a lock another process took over",
    "src/lock.ts",
    "      if ((await Bun.file(lockPath).text()) === token) await unlink(lockPath);",
    "      await unlink(lockPath);",
  ),
  M(
    "lock-default-fail",
    "an ordinary write proceeds rather than losing the write",
    "src/lock.ts",
    '      finish();\n      opts.onEvent?.("timeout", Date.now() - started);\n      if (opts.onTimeout === "fail") {',
    '      finish();\n      opts.onEvent?.("timeout", Date.now() - started);\n      if (true) {',
  ),
  M(
    "publish-truncate",
    "readers never observe a partially written store file",
    "src/logfmt.ts",
    "    await Bun.write(tmp, content);\n    await rename(tmp, file);",
    "    await Bun.write(file, content);",
  ),
  M(
    "snapshot-overwrite",
    "an existing snapshot is never overwritten",
    "src/memory.ts",
    '      const handle = await open(snap, "wx");',
    '      const handle = await open(snap, "w");',
  ),
  // ---- undo / restore -------------------------------------------------------
  M(
    "restore-safety-stale",
    "a force restore keeps the rows it drops recoverable",
    "src/undo.ts",
    '      const safety = mode === "force" ? (await snapshotFiles([target]))[0] : undefined;',
    "      const safety = snapPath;",
  ),
  M(
    "restore-check-blind",
    "the default restore refuses to clobber another session's rows",
    "src/undo.ts",
    '      if (mode === "check" && (concurrentAdded.length || concurrentChanged.length)) {',
    "      if (false) {",
  ),
  M(
    "restore-merge-drops",
    "merge restores the snapshot AND keeps concurrently written rows",
    "src/undo.ts",
    "        out = snapLines.map((l) => curByKey.get(rowKey(l)) ?? l).concat(\n          curLines.filter((l) => !snapByKey.has(rowKey(l))),\n        );",
    "        out = snapLines;",
  ),
  M(
    "restore-escapes-root",
    "a restore cannot write outside the memory root",
    "src/undo.ts",
    "  if (!target.startsWith(rootAbs + sep)) {",
    "  if (false) {",
  ),
  // ---- store row integrity --------------------------------------------------
  M(
    "row-ts-any",
    "a row whose ts is not an ISO instant is not addressable",
    "src/memory.ts",
    "  if (!ISO_TS_RE.test(ts) || Number.isNaN(Date.parse(ts))) {",
    "  if (false) {",
  ),
  M(
    "repo-floor-off",
    "another repo's rows never surface or get deleted here",
    "src/memory.ts",
    "  return m.repo === cur.key || (!!m.repoPath && m.repoPath === cur.path);",
    "  return true;",
  ),
  M(
    "content-cap-off",
    "nothing oversized is persisted (append floor)",
    "src/memory.ts",
    "  if (input.content.length > MAX_CONTENT_CHARS) {",
    "  if (false) {",
  ),
  M(
    "blocklist-visible",
    "a blocked memory is hidden from every read path",
    "src/memory.ts",
    "      if (m && !blocked.has(m.ts)) out.push(m);",
    "      if (m) out.push(m);",
  ),
  // ---- write gates ----------------------------------------------------------
  M(
    "gate-blocks-ignored",
    "a write rejected by a gate never reaches the store",
    "src/gates.ts",
    "  if (blockReason) {",
    "  if (false) {",
  ),
  M(
    "gate-dupes-promoted",
    "a near-duplicate is collapsed, not stored twice",
    "src/gates.ts",
    '    return { action: "collapsed", chain };',
    '    return { action: "promoted", chain };',
  ),
  M(
    "gate-content-cap-off",
    "oversized content is blocked with a reason, not stored",
    "src/gates.ts",
    "  if (candidate.content.length > MAX_CONTENT_CHARS) {",
    "  if (false) {",
  ),
  // ---- injection discipline -------------------------------------------------
  M(
    "inject-one-token-shared",
    "free-text prompts need two shared concepts to inject",
    "src/inject.ts",
    "  const needShared = query.size >= LONG_QUERY_TOKENS ? 2 : 1;",
    "  const needShared = 1;",
  ),
  M(
    "inject-frontier-uncapped",
    "only the newest open threads are surfaced",
    "src/inject.ts",
    "const OPEN_THREAD_LIMIT = 3;",
    "const OPEN_THREAD_LIMIT = 500;",
  ),
  // ---- viewer / wire boundary ----------------------------------------------
  M(
    "viewer-host-guard-off",
    "requests for an unexpected Host are refused",
    "src/viewer/server.ts",
    '  if (!allowedHostnames().has(url.hostname) || (url.port || "80") !== String(port)) {',
    "  if (false) {",
  ),
  M(
    "viewer-origin-guard-off",
    "cross-origin writes to the viewer are refused",
    "src/viewer/server.ts",
    '  if (origin !== null && origin !== url.origin) return error("cross-origin request refused", 403);',
    "  if (origin !== null && false) return error(\"cross-origin request refused\", 403);",
  ),
  M(
    "viewer-snapshot-grammar-off",
    "a restore name cannot steer outside snapshots/",
    "src/viewer/server.ts",
    "  if (!/^\\d+-\\d{4}-\\d{2}-\\d{2}\\.logfmt$/.test(name)) {",
    "  if (false) {",
  ),
  // ---- import / export trust ------------------------------------------------
  M(
    "import-frontier-any-version",
    "a newer export header does not grant the frontier exemption",
    "src/portable.ts",
    "        allowFrontier = hdr.version <= EXPORT_VERSION;",
    "        allowFrontier = true;",
  ),
  M(
    "import-open-status-unconditional",
    "status:open is honored only for files carrying an export header",
    "src/portable.ts",
    '    if (c.status === "open" && !allowFrontier) {',
    "    if (false) {",
  ),
];

// --- runner -------------------------------------------------------------------

function git(args: string[], cwd = REPO) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [, k, v] = a.match(/^--([^=]+)(?:=(.*))?$/) ?? [];
    return [k, v ?? true];
  }),
);

const selected = args.only
  ? MUTANTS.filter((m) => (args.only as string).split(",").includes(m.id))
  : MUTANTS;

// Validate the spec first: every `from` must exist exactly once.
let specErrors = 0;
for (const m of selected) {
  const path = join(REPO, m.file);
  if (!existsSync(path)) {
    console.log(`SPEC-MISS  ${m.id} (no such file ${m.file})`);
    specErrors++;
    continue;
  }
  const text = readFileSync(path, "utf8");
  const n = text.split(m.from).length - 1;
  if (n !== 1) {
    console.log(`SPEC-MISS  ${m.id} (found ${n} occurrences in ${m.file})`);
    specErrors++;
  }
}
if (specErrors) {
  console.log(`\n${specErrors}/${selected.length} mutations do not apply cleanly — fix the spec.`);
  process.exit(1);
}
if (args.validate) {
  console.log(`spec ok: ${selected.length} mutations apply cleanly`);
  process.exit(0);
}

const wt = join(tmpdir(), `osi-sweep-${Date.now()}`);
git(["worktree", "add", "--detach", wt, "HEAD"]);
try {
  symlinkSync(join(REPO, "node_modules"), join(wt, "node_modules"));

  const base = spawnSync("bun", ["test", "./test/", "--timeout", "30000"], {
    cwd: wt,
    encoding: "utf8",
  });
  if (base.status !== 0) throw new Error("baseline suite is not green; sweep would lie");

  const repeat = Number(args.repeat ?? 1);
  const rows: { m: Mutant; killed: boolean; by: string[] }[] = [];
  for (const m of selected) {
    const path = join(wt, m.file);
    const original = readFileSync(path, "utf8");
    const killers = new Set<string>();
    let survivedRuns = 0;
    for (let i = 0; i < repeat; i++) {
      writeFileSync(path, original.replace(m.from, m.to));
      const r = spawnSync("bun", ["test", "./test/", "--timeout", "30000"], {
        cwd: wt,
        encoding: "utf8",
      });
      if (r.status !== 0) {
        const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        for (const line of out.split("\n")) {
          const fail = line.match(/^\((fail)\)\s+(.+?)(?:\s+\[.*)?$/);
          if (fail) killers.add(fail[2].trim());
        }
      } else survivedRuns++;
      writeFileSync(path, original);
    }
    rows.push({ m, killed: survivedRuns < repeat, by: [...killers] });
    const verdict = survivedRuns < repeat ? "killed  " : "SURVIVED";
    console.log(`${verdict} ${m.id}${survivedRuns ? ` (${survivedRuns}/${repeat} runs green)` : ""}`);
  }

  const survivors = rows.filter((r) => !r.killed);
  console.log(
    `\n${rows.length - survivors.length}/${rows.length} invariants are pinned by at least one test.`,
  );
  if (survivors.length) {
    console.log("\nUnpinned invariants (no test depends on them):");
    for (const s of survivors) console.log(`  - ${s.m.id}: ${s.m.inv}`);
  }
  const kills = new Map<string, number>();
  for (const r of rows) for (const t of r.by) kills.set(t, (kills.get(t) ?? 0) + 1);
  console.log(`\n${kills.size} distinct tests killed at least one mutation.`);
  writeFileSync("/tmp/sweep-result.json", JSON.stringify(rows, null, 2));
  console.log("detail: /tmp/sweep-result.json");
} finally {
  git(["worktree", "remove", "--force", wt]);
}

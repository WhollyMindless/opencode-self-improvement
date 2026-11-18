#!/usr/bin/env bun
// Comment policy: code comments carry the WHY that code cannot state —
// invariants, traps, measured defaults. They do not carry history: no issue
// numbers, no review narrative, no reviewer names, no retracted measurements.
// History belongs in docs/adr/ and the git log; a comment that cites a
// ticket rots the day the ticket is closed, and a war story in `src/` is a
// changelog competing with git.
//
// The lint checks ADDED comment lines in `git diff <base>...HEAD` for
// TypeScript/TSX sources. The base comes from `--base=<ref>` or
// COMMENT_LINT_BASE (CI passes the PR's base sha), else the merge-base with
// origin/main or main. A violation fails the merge gate with the offending
// line. Lines linking docs/adr/ are exempt.
//
// Escape hatch: SKIP_COMMENT_LINT=1 (record the reason in the PR body).

const REPO = `${import.meta.dir}/..`;

// `ok` is kept separate from the output on purpose. Collapsing a nonzero exit
// to an empty string turns a FAILED comparison into an empty diff, and an empty
// diff reports clean — a policy check that silently checks nothing and still
// goes green. Callers that can fall back say so; the diff cannot.
function git(args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd: REPO, stdout: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString() };
}

function isCommit(ref: string): boolean {
  const p = Bun.spawnSync(["git", "cat-file", "-e", `${ref}^{commit}`], {
    cwd: REPO,
    stdout: "ignore",
    stderr: "ignore",
  });
  return p.exitCode === 0;
}

// A pull-request checkout is shallow and carries no `origin/main`, so an
// automatic merge-base silently fails there and the lint would skip its own
// enforcement. CI passes the base sha explicitly; the source is logged either
// way, because a check that quietly does nothing still reports green.
function baseRef(): { base: string; how: string } | null {
  const cli = process.argv.find((a) => a.startsWith("--base="));
  const explicit =
    cli?.slice("--base=".length) || process.env.COMMENT_LINT_BASE;
  if (explicit) {
    if (isCommit(explicit))
      return { base: explicit, how: cli ? "--base" : "COMMENT_LINT_BASE" };
    console.error(`comment-lint: --base=${explicit} is not a commit`);
    process.exit(2);
  }
  for (const candidate of ["origin/main", "main"]) {
    const probe = git(["merge-base", candidate, "HEAD"]);
    const out = probe.ok ? probe.out.trim() : "";
    if (out) return { base: out, how: `merge-base with ${candidate}` };
  }
  return null;
}

// Issue and ticket references: a hash followed by a number, or an issue URL
// path ending in a number.
const TICKET = /#\d{2,}|issues\/\d+/;
// Narrative history. Each phrase names a past version or a review event
// rather than the code's contract.
const HISTORY =
  /\b(first version|pre-?floor version|review round|post-merge report|adversarial review|are void|were void|is void\b|regression that blocked|reported by|reproduced from @)/i;

if (process.env.SKIP_COMMENT_LINT === "1") {
  console.log("comment-lint: SKIPPED by request (state the reason in the PR)");
  process.exit(0);
}

const resolved = baseRef();
if (!resolved) {
  console.error(
    "comment-lint: no base to compare against (no --base, no COMMENT_LINT_BASE,\n" +
      "no merge-base with origin/main or main). Refusing to report green without\n" +
      "checking anything: fetch the base, or pass --base=<ref>.",
  );
  process.exit(2);
}
const { base, how } = resolved;

const compared = git([
  "diff",
  "--unified=0",
  `${base}...HEAD`,
  "--",
  "*.ts",
  "*.tsx",
]);
if (!compared.ok) {
  console.error(
    `comment-lint: \`git diff ${base}...HEAD\` FAILED. Refusing to report clean:\n` +
      `a failed comparison is not an empty one. The base is a commit but it cannot\n` +
      `be compared with HEAD — usually no common ancestor, or history this clone\n` +
      `does not have (fetch deeper, or pass the base the branch really started at).`,
  );
  process.exit(2);
}
const diff = compared.out;
const violations: string[] = [];
let file = "";
let scanned = 0;
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ b/")) {
    file = line.slice(6);
    continue;
  }
  if (!line.startsWith("+") || line.startsWith("+++")) continue;
  const added = line.slice(1);
  const t = added.trimStart();
  if (!t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"))
    continue;
  scanned++;
  if (added.includes("docs/adr")) continue;
  const why = TICKET.test(added)
    ? "issue reference"
    : HISTORY.test(added)
      ? "narrative history"
      : null;
  if (why) violations.push(`${file}: (${why}) ${t.slice(0, 110)}`);
}

if (violations.length) {
  console.error(
    `comment-lint: ${violations.length} added comment line(s) break the policy\n` +
      `(checked against ${how}; no issue numbers, no review history in code\n` +
      `comments — state the contract forward-looking, put history in docs/adr/):\n`,
  );
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log(
  `comment-lint: clean (${scanned} added comment line(s) checked against ` +
    `${how})`,
);

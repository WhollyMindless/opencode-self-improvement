#!/usr/bin/env bun
// Comment policy: code comments carry the WHY that code cannot state —
// invariants, traps, measured defaults. They do not carry history: no issue
// numbers, no review narrative, no reviewer names, no retracted measurements.
// History belongs in docs/adr/ and the git log; a comment that cites a
// ticket rots the day the ticket is closed, and a war story in `src/` is a
// changelog competing with git.
//
// The lint checks ADDED comment lines in `git diff <base>...HEAD` for
// TypeScript/TSX sources, where base is the merge-base with origin/main (or
// main). A violation fails the merge gate with the offending line. Lines
// linking docs/adr/ are exempt.
//
// Escape hatch: SKIP_COMMENT_LINT=1 (record the reason in the PR body).

const REPO = `${import.meta.dir}/..`;

function git(args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd: REPO, stdout: "pipe" });
  if (p.exitCode !== 0) return "";
  return p.stdout.toString();
}

function baseRef(): string | null {
  for (const candidate of ["origin/main", "main"]) {
    const out = git(["merge-base", candidate, "HEAD"]).trim();
    if (out) return out;
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

const base = baseRef();
if (!base) {
  console.log("comment-lint: no merge-base with main; skipping");
  process.exit(0);
}

const diff = git([
  "diff",
  "--unified=0",
  `${base}...HEAD`,
  "--",
  "*.ts",
  "*.tsx",
]);
const violations: string[] = [];
let file = "";
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
      `(no issue numbers, no review history in code comments — state the\n` +
      `contract forward-looking, and put history in docs/adr/):\n`,
  );
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log("comment-lint: clean");

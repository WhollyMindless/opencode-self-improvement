// Fail-open is the contract of EVERY uncertainty inside the availability
// check, not a property of the branches that were written first. Each case
// states a fact verbatim where a healthy scan would find it, breaks exactly
// one way the scan can see it, and the candidate must be KEPT — a null
// verdict, no refusal. The control row shows the same fact IS refused when
// the scan can read it, so a matcher that matches nothing cannot pass this
// bank by being dead.
//
// The enumerated paths: no git; a tracked path the read cannot open (staged,
// then removed from disk — the shape that also covers a read throwing
// EACCES, since `readTracked` answers both with the same skip); a file over
// the per-file byte bound; a scan truncated by the total budget; and a fact
// nowhere in the tree. Each case asserts the scan telemetry too, so it
// cannot pass for the wrong reason — a missing file and a dead git look
// different in `scanned()`, and only the right shape counts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availabilityIndex } from "../../src/capture/available.ts";

const FACT =
  "Reorder is inclusive: needsReorder returns true when available stock is at or below reorderPoint.";

// Padding shares no word with FACT beyond stopwords, so a truncated scan
// cannot match the candidate through it. Each pad file stays under the
// per-file byte bound — a file over it is skipped and contributes nothing,
// which the oversized case pins separately — so the total budget is what
// stops the scan.
const PAD = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(
  4_000,
); // ~224 KB

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "osi-failopen-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
}

type Scanned = {
  files: number;
  bytes: number;
  tracked: boolean;
  capped: boolean;
};

const CASES: {
  id: string;
  why: string;
  build: (dir: string) => void;
  scan: (s: Scanned) => boolean;
}[] = [
  {
    id: "no-git",
    why: "a workspace with no git is not evidence that a fact is available",
    build: (dir) => {
      writeFileSync(join(dir, "README.md"), `${FACT}\n`);
    },
    scan: (s) => !s.tracked && s.files === 0,
  },
  {
    id: "tracked-path-cannot-be-opened",
    why: "a tracked path the read cannot open is skipped, not assumed present",
    build: (dir) => {
      writeFileSync(join(dir, "notes.md"), `${FACT}\n`);
      git(dir, "init", "-q");
      git(dir, "add", ".");
      rmSync(join(dir, "notes.md"));
    },
    scan: (s) => s.tracked && s.files === 0,
  },
  {
    id: "oversized-file-skipped",
    why: "a file over the per-file byte bound is skipped, not half-read",
    build: (dir) => {
      writeFileSync(
        join(dir, "README.md"),
        `${FACT}\n${"x".repeat(300_000)}\n`,
      );
      git(dir, "init", "-q");
      git(dir, "add", ".");
    },
    scan: (s) => s.tracked && s.files === 0,
  },
  {
    id: "scan-truncated-by-budget",
    why: "a budget-truncated scan can only lower refusals, never raise one",
    build: (dir) => {
      // Ten 224 KB files cross the 2 MB total budget, so the scan stops
      // before the last-ranked file — the only one holding the fact.
      for (let i = 1; i <= 10; i++) {
        writeFileSync(join(dir, `pad-0${i}.md`), PAD);
      }
      writeFileSync(join(dir, "zz-facts.md"), `${FACT}\n`);
      git(dir, "init", "-q");
      git(dir, "add", ".");
    },
    scan: (s) => s.tracked && s.capped,
  },
  {
    id: "nowhere-in-tree",
    why: "a fact the tree does not state is the row the store exists for",
    build: (dir) => {
      writeFileSync(join(dir, "README.md"), "# Notes\n\nNothing relevant.\n");
      git(dir, "init", "-q");
      git(dir, "add", ".");
    },
    scan: (s) => s.tracked && s.files === 1,
  },
];

for (const c of CASES) {
  test(`fail-open: ${c.id}`, () => {
    const dir = join(root, c.id);
    mkdirSync(dir, { recursive: true });
    c.build(dir);
    const idx = availabilityIndex(dir);
    expect(idx.check(FACT), c.why).toBeNull();
    expect(
      c.scan(idx.scanned()),
      `${c.id}: the scan did not take the shape this case claims (${JSON.stringify(idx.scanned())}), so the kept candidate is not evidence of fail-open`,
    ).toBe(true);
  });
}

// The later-occurrence retry must stay a bounded function of the haystack,
// even for a claim repeated N times. Two shapes pin it:
//  - repeated-section (escape shape): every section states the clause twice
//    in the longer form, so the gap before the next occurrence always
//    contains non-punctuation material and the anchor must bail instead of
//    re-walking every remaining hit — inner steps stay linear per section.
//  - no-next-hit (budget shape): clause 2 occurs exactly once at the end, so
//    the budget is the only enforcement — the retry must bail after a
//    constant number of inner steps instead of the O(N^2) tail re-walk.
// Both fail on the pre-delta head (the telemetry does not exist) and would
// grow quadratically on an unfixed retry, so a bound here is a real contract.
function buildIndex(tree: string, id: string) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), tree);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      scripts: {
        deploy: "deploy-tool publish --prod",
        rollback: "rsync -az ./dist/ deploy@box:/srv",
      },
    }),
  );
  git(dir, "init", "-q");
  git(dir, "add", ".");
  return availabilityIndex(dir);
}

const REPEATED_TREE = Array.from(
  { length: 40 },
  () =>
    "Always keep 3 replicas warm before rollout and drain first.\n\n" +
    "Always keep 3 replicas warm before rollout and drain first.\n",
).join("\n");

test("the later-occurrence retry stays bounded on repeated-section trees", () => {
  const index = buildIndex(REPEATED_TREE, "bounded-retry-repeated");
  const verdict = index.check(
    "Run `npm run rollback`; keep 3 replicas warm before rollout; drain first.",
  );
  expect(verdict).toBeNull();
  const steps = index.scanned().retrySteps;
  expect(steps, "retrySteps telemetry must be defined").toBeDefined();
  expect(
    steps as number,
    `retrySteps ${steps} — the retry re-walked the tail once per anchor on the escape shape (linear ~80, quadratic would be far higher)`,
  ).toBeLessThanOrEqual(120);
});

test("the retry bails once the budget is gone on the no-next-hit shape", () => {
  const tree = [
    ...Array.from(
      { length: 400 },
      () => "Always keep 3 replicas warm before rollout. Drain later.\n",
    ),
    "Always keep 3 replicas warm before rollout. Drain first.\n",
  ].join("\n");
  const index = buildIndex(tree, "bounded-retry-no-hit");
  const verdict = index.check(
    "Run `npm run rollback`; keep 3 replicas warm before rollout; drain first.",
  );
  expect(verdict).toBeNull();
  const s = index.scanned();
  expect(s.retrySteps, "retrySteps telemetry must be defined").toBeDefined();
  expect(s.retryWalked, "retryWalked telemetry must be defined").toBeDefined();
  expect(
    s.retrySteps as number,
    `retrySteps ${s.retrySteps} — the budget must bail after a constant number of inner steps (quadratic would be thousands)`,
  ).toBeLessThanOrEqual(8);
});

test("control: the same fact is refused when the scan can read it", () => {
  const dir = join(root, "control");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `${FACT}\n`);
  git(dir, "init", "-q");
  git(dir, "add", ".");
  expect(availabilityIndex(dir).check(FACT)).not.toBeNull();
});

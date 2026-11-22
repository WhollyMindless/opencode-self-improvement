// Availability case bank (issue #402, phase P4).
//
// Every adversarial case this matcher has been found guilty of, in one file, with
// the tree text that exposes it. The unit tests in `test/capture/capture-available.test.ts`
// drive the same behaviour through the plugin; this bank exists so the BENCH can
// answer a question the unit tests cannot: what does the shipped check decide over
// a population, and did that population's verdicts move since the last run? A
// single flipped verdict changes the tag rate, the demotion, and every recall
// number in `availability-results.md`, and until now none of those moved together
// in a way a reader could point at.
//
// One repo per case. Sharing one tree would let a candidate match a DIFFERENT
// case's line and report a verdict for the wrong reason — the exact class of defect
// this file exists to keep out.
//
// `expectTag` is what the shipped `availabilityIndex` must decide, not what any
// historical rule decided. `source` names the review round that found it, so a
// regression says who to blame.
export interface AvailabilityCase {
  id: string;
  /** Tracked README content. Each sentence ends in a period: `norm()` collapses
   * newlines, so an unterminated bullet borrows its neighbour's negation. */
  tree: string;
  /** Extra tracked files, path to content. A case whose name says "declared"
   * MUST declare the command here: `parseGates` reads `package.json`, `Makefile`,
   * `makefile`, `justfile` and `.github/workflows/*.yml`, and nothing else. Put
   * the command in the README instead and the TEXT branch answers for it, which
   * is exactly how seven gate cases passed while the gate went untested. */
  files?: Record<string, string>;
  candidate: string;
  expectTag: boolean;
  /** Asserted when set. Tag-or-keep alone cannot say WHICH branch fired, and that
   * is the difference between a gate test and a prose test wearing its name. */
  expectReason?: "in_tracked_file" | "declared_gate";
  source: string;
}

/** A command declaration `parseGates` really reads. Shared by the gate family so
 * every one of those cases tests the same declaration. */
const DEPLOY_MANIFEST: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "widget",
    scripts: { deploy: "rsync -az ./dist/ deploy@box:/srv" },
  }),
};

/** A README that says nothing about deploying. Without it a `declared_gate`
 * expectation could be satisfied by the prose branch and the reason assertion
 * would be the only thing telling the two apart — which is the defect this
 * revision exists to close, so the README is neutralised as well as declared. */
const NEUTRAL_README =
  "# release\n\nNothing in this file describes deploying.\n";

export const AVAILABILITY_CASES: AvailabilityCase[] = [
  // ── The transport case: the reason the check must not over-refuse ──────────
  {
    id: "nowhere-in-tree",
    tree: "# widget\n\nReorder is inclusive: needsReorder returns true at or below reorderPoint.\n",
    candidate:
      "The staging rate limit is 120 requests per minute per key and it resets on the hour.",
    expectTag: false,
    source:
      "#389 — a fact the tree does not state is the one the store exists for",
  },
  {
    id: "verbatim-restatement",
    tree: "# widget\n\nReorder is inclusive: needsReorder returns true at or below reorderPoint.\n",
    candidate:
      "Reorder is inclusive: needsReorder returns true at or below reorderPoint.",
    expectTag: true,
    source: "#389 — the rule's only true positive",
  },
  {
    id: "formatting-is-not-a-new-fact",
    tree: "# widget\n\nRun `bun test` before every merge.\n",
    candidate: "Run bun test before every merge.",
    expectTag: true,
    source: "#397 — case, backticks and wrapping are formatting",
  },

  // ── Reversal: a substring of the OPPOSITE rule ─────────────────────────────
  {
    id: "negation-dropped",
    tree: "# style\n\nWe do not use tabs for indentation.\n",
    candidate: "Use tabs for indentation.",
    expectTag: false,
    source:
      "#397 round 3 (WhollyMindless) — the worst failure this check can have",
  },
  {
    id: "negation-kept",
    tree: "# style\n\nWe do not use tabs for indentation.\n",
    candidate: "We do not use tabs for indentation.",
    expectTag: true,
    source: "#397 round 3 — the guard did not simply switch the check off",
  },
  {
    id: "word-boundary",
    tree: "# style\n\nDo not abuse tabs for indentation.\n",
    candidate: "Use tabs for indentation.",
    expectTag: false,
    source: "#397 round 3 — `use tabs` is not a hit inside `abuse tabs`",
  },

  // ── A warning that QUOTES a claim: no polarity test of any breadth sees it ──
  {
    id: "stop-assuming",
    tree: "# cache\n\nStop assuming the cache supports TTL expiration.\n",
    candidate: "The cache supports TTL expiration.",
    expectTag: false,
    source:
      "#403 review (4568409650) — reopened by narrowing the polarity equality",
  },
  {
    id: "drop-the-assumption",
    tree: "# parser\n\nDrop the assumption that the parser keeps comments.\n",
    candidate: "The parser keeps comments.",
    expectTag: false,
    source: "#403 review (4568409650) — second shape, same family",
  },
  {
    id: "never-assume",
    tree: "# queue\n\nNever assume the queue preserves order.\n",
    candidate: "The queue preserves order.",
    expectTag: false,
    source: "#403 review — the cue-list path of the same family",
  },
  {
    id: "deterrent-verb-not-governing",
    tree: "# job\n\nThe job stops at midnight and the cache supports TTL expiration.\n",
    candidate: "The cache supports TTL expiration.",
    expectTag: true,
    source:
      "#403 self-review — the veto's own over-decline, caught by this case",
  },
  {
    id: "ordinary-verb-not-a-deterrent",
    tree: "# parser\n\nThe parser drops stale entries after a write.\n",
    candidate: "The parser drops stale entries after a write.",
    expectTag: true,
    source:
      "#403 self-review — `drops` governs `stale entries`, not a following claim",
  },

  // ── New information riding a restated fragment ────────────────────────────
  {
    id: "new-clause-rides-restatement",
    tree: "# rate\n\nThe staging rate limit is documented in config/limits.ts.\n",
    candidate:
      "The staging rate limit is documented in config/limits.ts; Finance confirmed the supplier rate is 1900.",
    expectTag: false,
    source:
      "#397 review — matching PART of a candidate does not establish the WHOLE fact",
  },
  // ── A figure reassembled across fragments: the tree states none of it ──────
  // `claims()` splits on `.`, so a dotted figure arrives as separate integers
  // and each can match its own sentence. The whole-token subset check is what
  // makes "the tree states every figure" true again.
  {
    id: "reassembled-decimal",
    tree: "# budget\n\nThe budget is 1 second per call. Retry after 5 seconds.\n",
    candidate: "The budget is 1.5 seconds.",
    expectTag: false,
    source: "PR #493 review B1 — 1.5 reassembled from `1 second` + `5 seconds`",
  },
  {
    id: "reassembled-version",
    tree: "# release\n\nWe ship version 1 release per week. Workers rose to 4. The pool size is 3.\n",
    candidate: "We ship version 1.4.3.",
    expectTag: false,
    source: "PR #493 review B1 — a version reassembled from 1, 4 and 3",
  },
  {
    id: "reassembled-address",
    tree: "# network\n\nThe gateway address is 10 ms per hop. We raised the pool to 20. Drain for 30 s, then 40 s.\n",
    candidate: "The gateway address is 10.20.30.40.",
    expectTag: false,
    source:
      "PR #493 review B1 — an address reassembled from four separate figures",
  },
  {
    id: "figure-stated-whole-still-restatable",
    tree: "# limits\n\nThe timeout is 5000 ms.\n",
    candidate: "The timeout is 5000 ms.",
    expectTag: true,
    expectReason: "in_tracked_file",
    source:
      "PR #493 review B1 — the subset check must not neuter a true restatement",
  },
  // ── A label from one line and a value from another: the pairing is new ─────
  // Reported as a transport loss on review of the refusal PR. No digits, so the
  // figure check cannot see it; only contiguity can.
  {
    id: "cross-line-label-value-pairing",
    tree: "Staging export pool: cobalt-workers.\nProduction export pool: ask operations at rollout.\n",
    candidate: "Production export pool: cobalt-workers.",
    expectTag: false,
    source:
      "PR #493 review — the tree pairs cobalt-workers with Staging; the candidate's pairing came from the session",
  },
  {
    id: "same-line-label-value-pairing",
    tree: "# pools\n\nProduction export pool: cobalt-workers.\nStaging export pool: ask operations at rollout.\n",
    candidate: "Production export pool: cobalt-workers.",
    expectTag: true,
    expectReason: "in_tracked_file",
    source:
      "PR #493 review counterpart — the same two halves stated by one line are a restatement",
  },
  // ── Declared gate: where it does and does not reach ───────────────────────
  // Review round 4 (WhollyMindless) found that every case below declared its
  // command in README prose, so the TEXT branch decided all of them and a
  // mutation replacing `gateHit(spans, gates)` with a null gate left the entire
  // bank green. They now declare `scripts.deploy` in a real `package.json` and
  // run against a README that cannot match, with `expectReason` pinning which
  // branch answered.
  {
    id: "declared-command-restated",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate: "Run `npm run deploy`.",
    expectTag: true,
    expectReason: "declared_gate",
    source:
      "#389 — the gate rule's true positive; #403 review 4 moved it onto a real declaration",
  },
  {
    id: "make-target-restated",
    tree: NEUTRAL_README,
    files: { Makefile: "test:\n\tbun test\n" },
    candidate: "Run `make test`.",
    expectTag: true,
    expectReason: "declared_gate",
    source:
      "#403 review 4 — a second gate source, so the bank does not silently depend on package.json alone",
  },
  {
    id: "make-target-new-condition",
    tree: NEUTRAL_README,
    files: { Makefile: "test:\\n\\tbun test\\n" },
    candidate: "Run `make test` before merging.",
    expectTag: false,
    source:
      "#403 review 4 — the counterpart, and the case that was wrong when written: the target is declared, the WHEN is not",
  },
  {
    id: "declared-command-reworded-residual",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate: "Run `npm run deploy` to rsync against the box.",
    expectTag: false,
    source:
      "#397 round 4 — the residual is checked too, and a reworded residual is kept",
  },
  {
    id: "declared-command-new-context",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate: "Use `npm run deploy` when the build is ready.",
    expectTag: false,
    source:
      "#397 round 2 — the manifest states the command, not when to use it",
  },
  {
    id: "prohibition-on-declared-command",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate: "Never run `npm run deploy` on a Friday.",
    expectTag: false,
    source: "#397 — a sentence that states a command may also forbid it",
  },
  {
    id: "restriction-on-declared-command",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate:
      "Never run `npm run deploy` until finance confirms approval code BLUEBIRD.",
    expectTag: false,
    source: "#397 round 3 — the restriction and the code appear nowhere",
  },
  {
    id: "short-restriction-on-declared-command",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate: "`npm run deploy` wipes the staging database.",
    expectTag: false,
    source: "#397 round 2 — a short residual is not a restatement",
  },
  {
    id: "second-command-not-swallowed",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate:
      "Before `npm run deploy`, run `aws sso login --profile prod` to refresh credentials.",
    expectTag: false,
    source: "#397 round 2 — the second command is new information",
  },
  {
    id: "new-number-on-declared-command",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate: "Run `npm run deploy`; it retries 3 times before it alerts.",
    expectTag: false,
    source:
      "#402 veto 2 — a changed figure is a different fact, not a rephrasing",
  },
  {
    id: "gate-figure-self-cert-flag",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({ scripts: { test: "bun test" } }),
    },
    candidate: "Run `bun test --timeout 5000`.",
    expectTag: false,
    source:
      "PR #493 review B1 — the candidate's own span carried the figure that cleared the veto; only the declaration may vouch for a number",
  },
  {
    id: "gate-figure-self-cert-option",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: { ship: "rsync -az dist box:/srv" },
      }),
    },
    candidate: "`rsync -az dist box:/srv --bwlimit=100`.",
    expectTag: false,
    source:
      "PR #493 review B1 — same class: the span declared its own figure; the declaration states none",
  },
  // ── A forwarded argument the declaration never mentions ───────────────────
  // Reported on the PR: stripping the whole span from the row before checking
  // the residual erased the argument with the command, so the row carrying a
  // session-only target got the same verdict as the bare invocation.
  {
    id: "gate-forwarded-arg-undeclared",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: { deploy: "deploy-tool publish" },
      }),
    },
    candidate: "Run `npm run deploy -- --target canary`.",
    expectTag: false,
    source:
      "PR #493 review — the manifest declares the script, not the target forwarded to it",
  },
  {
    id: "gate-forwarded-arg-declared",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: { deploy: "deploy-tool publish --prod" },
      }),
    },
    candidate: "Run `npm run deploy -- --prod`.",
    expectTag: true,
    expectReason: "declared_gate",
    source:
      "PR #493 review counterpart — an argument the declaration states leaves the plain invocation a provable restatement",
  },
  // ── A step-kind declaration vouches for its own step only ─────────────────
  // Every recipe in a Makefile and every `run:` in a workflow shares one
  // `where` while stating nothing about its siblings.
  {
    id: "gate-workflow-sibling-flag",
    tree: NEUTRAL_README,
    files: {
      ".github/workflows/ci.yml":
        "name: ci\non: push\njobs:\n  a:\n    steps:\n      - run: npm run build\n      - run: docker push app --prod\n",
    },
    candidate: "Run `npm run build --prod`.",
    expectTag: false,
    source:
      "PR #493 review B2 — the build step never states --prod; the neighbouring push step cannot vouch for it",
  },
  {
    id: "gate-workflow-same-step-flag",
    tree: NEUTRAL_README,
    files: {
      ".github/workflows/ci.yml":
        "name: ci\non: push\njobs:\n  a:\n    steps:\n      - run: npm run build --prod\n",
    },
    candidate: "Run `npm run build --prod`.",
    expectTag: true,
    expectReason: "declared_gate",
    source:
      "PR #493 review B2 counterpart — the same step declares the flag, so the invocation is a restatement",
  },
  {
    id: "gate-makefile-sibling-word",
    tree: NEUTRAL_README,
    files: {
      Makefile:
        "ship:\n\trsync dist box:/srv\nbackup:\n\ttar czf backup.tgz dist\n",
    },
    candidate: "Run `rsync dist box:/srv tar`.",
    expectTag: false,
    source:
      "PR #493 review B2 — `tar` belongs to the backup recipe, not to the one the row quotes",
  },
  // ── Operands must be a run the declaration states, not a word bag ─────────
  {
    id: "gate-swapped-option-values",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: {
          deploy: "deploy-tool publish --target staging --fallback canary",
        },
      }),
    },
    candidate: "Run `npm run deploy -- --target canary --fallback staging`.",
    expectTag: false,
    source:
      "PR #493 review B3 — every word is declared and the pairing is not; the manifest pairs each option with the opposite value",
  },
  {
    id: "gate-contiguous-prefix-operands",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: {
          deploy: "deploy-tool publish --target staging --fallback canary",
        },
      }),
    },
    candidate: "Run `npm run deploy -- --target staging`.",
    expectTag: true,
    expectReason: "declared_gate",
    source:
      "PR #493 review B3 counterpart — a run the declaration states verbatim is still a restatement",
  },
  {
    id: "gate-reordered-flags",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: { deploy: "deploy-tool publish --dry --verbose" },
      }),
    },
    candidate: "Run `npm run deploy -- --verbose --dry`.",
    expectTag: false,
    source:
      "PR #493 review B3 — semantically the same command, but order-irrelevance is not something the check can prove, so the row is kept",
  },
  // ── Each span vouches with its own declaration ────────────────────────────
  // The pair is the test: the same build operand is kept alone, and must stay
  // kept when a bare mention of another script is added in front of it.
  {
    id: "gate-multi-span-single-operand",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: {
          build: "compiler",
          deploy: "deploy-tool publish --target staging --fallback canary",
        },
      }),
    },
    candidate: "Run `npm run build -- --target staging`.",
    expectTag: false,
    source:
      "PR #493 review B4 — the single-span half of the pair: the build script states no target",
  },
  {
    id: "gate-multi-span-borrowed-labels",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: {
          build: "compiler",
          deploy: "deploy-tool publish --target staging --fallback canary",
        },
      }),
    },
    candidate: "Run `npm run deploy`. Run `npm run build -- --target staging`.",
    expectTag: false,
    source:
      "PR #493 review B4 — the deploy mention must not lend its operands to the build span",
  },
  {
    id: "gate-multi-span-borrowed-labels-reversed",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: {
          build: "compiler",
          deploy: "deploy-tool publish --target staging --fallback canary",
        },
      }),
    },
    candidate: "Run `npm run build -- --target staging`. Run `npm run deploy`.",
    expectTag: false,
    source:
      "PR #493 review B4 — the same pair in the other order, so the rule is not an accident of which span matched first",
  },
  {
    id: "gate-multi-span-both-declared",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: {
          build: "compiler --fast",
          deploy: "deploy-tool publish --target staging",
        },
      }),
    },
    candidate:
      "Run `npm run deploy -- --target staging`. Run `npm run build -- --fast`.",
    expectTag: true,
    expectReason: "declared_gate",
    source:
      "PR #493 review B4 counterpart — each operand vouched by its own declaration is a row the tree states in full",
  },
  {
    id: "prose-command-not-a-code-span",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate: "Deploy with npm run deploy; it copies the build to the box.",
    expectTag: false,
    source:
      "self-review of the case bank — `statedCommands` reads code spans only, so a prose command never reaches the gate; recorded as a limit, not fixed",
  },
  {
    id: "prose-restatement-still-tags",
    tree: "# limits\n\nThe rate limiter keeps state in Redis DB 3, not DB 0 like the rest of the stack.\n",
    // The asymmetry with `prose-command-not-a-code-span` is deliberate: the text
    // side compares claims, so prose restatement is caught even though a prose
    // command is not. Paired, they say which half of the check the formatting
    // dependency belongs to; either alone says nothing.
    candidate:
      "The rate limiter keeps state in Redis DB 3, not DB 0 like the rest of the stack.",
    expectTag: true,
    expectReason: "in_tracked_file",
    source:
      "self-review of the case bank — the counterpart to the prose-command limit above",
  },

  // ── The gate's own vocabulary must not tag ordinary prose ─────────────────
  {
    id: "gate-name-in-prose",
    tree: "# ci\n\nThe deploy gate is documented in runbook.md.\n",
    candidate: "The deploy gate name is a short string used by the dashboard.",
    expectTag: false,
    source:
      "#397 review — a short gate name does not tag prose that merely contains it",
  },
];

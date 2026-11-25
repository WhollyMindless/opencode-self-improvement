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
  /** Asserted when set. A refusal that rested on several declarations must name
   * every one of them: citing the first file the scan happened to hit is not
   * evidence, and an unauditable refusal is where a wrong one survives. */
  expectWhere?: string;
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

function gateCommandCase(
  id: string,
  declaration: string,
  invocation: string,
  expectTag: boolean,
  source: string,
): AvailabilityCase {
  return {
    id,
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({ scripts: { deploy: declaration } }),
    },
    candidate: `Run \`${invocation}\`.`,
    expectTag,
    expectReason: expectTag ? "declared_gate" : undefined,
    source,
  };
}

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
    // Re-pinned from refuse: a refusal now demands the whole tree assertion,
    // and a conjoined half is not the whole of it. The matcher cannot tell a
    // conjoined clause from a scoped one without the vocabulary this file
    // refuses to grow, so the row is kept — the measured cost of the
    // coverage rule, in one redundant row per conjoined sentence.
    expectTag: false,
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
  // ── Figures are vouched by the matched passage, not by the tree ────────────
  // `The budget is 1, 5 seconds of margin.` chains across its comma, so the
  // claims match a row saying `1.5 seconds`. The figure that makes that look
  // stated may sit in another file, or in another sentence of the same one —
  // which is why the scope is the region the match actually covered.
  {
    id: "figure-region-cross-file",
    tree: "# budget\n\nThe budget is 1, 5 seconds of margin.\n",
    files: { "docs.md": "# docs\n\nRequires Node 1.5 or newer.\n" },
    candidate: "The budget is 1.5 seconds.",
    expectTag: false,
    source:
      "PR #493 review B5 — the 1.5 that cleared the veto sits in a file outside the cited region",
  },
  {
    id: "figure-region-same-file-distant",
    tree: "# budget\n\nThe budget is 1, 5 seconds of margin.\nRequires Node 1.5 or newer.\n",
    candidate: "The budget is 1.5 seconds.",
    expectTag: false,
    source:
      "PR #493 review B5 — one file is not the scope either: the other sentence states nothing about this one",
  },
  {
    id: "figure-region-dotted-restated",
    tree: "# budget\n\nThe budget is 1.5 seconds.\n",
    candidate: "The budget is 1.5 seconds.",
    expectTag: true,
    expectReason: "in_tracked_file",
    source:
      "PR #493 review B5 counterpart — a dotted figure the region itself states stays a restatement",
  },
  // ── A figure is one token, in the claims and in the hit ───────────────────
  // The splitter and the matcher used to disagree about the dot: `claims()` cut
  // `1.5` in half and `findClause` admitted a hit whose neighbour was any non-word
  // character, including the dot inside a number. Either half re-tokenizes as a
  // whole figure the tree never states.
  {
    id: "figure-trunc-dotless-tail",
    tree: "# cost\n\nThe cost is 11.5.\n",
    candidate: "The cost is 11",
    expectTag: false,
    source:
      "PR #493 review B6 — the row ends at the tree's figure dot, and `11` is what slicing leaves, not a figure the tree states",
  },
  {
    id: "figure-trunc-version-tail",
    tree: "# runtime\n\nRequires Python 3.12\n",
    candidate: "Requires Python 3",
    expectTag: false,
    source:
      "PR #493 review B6 — the version is the fact; a refusal citing `3.12` for a row that says `3` asserts a restatement the passage does not provide",
  },
  {
    id: "figure-frag-after-dot",
    tree: "# limits\n\nTimeout 30.5 seconds.\n",
    candidate: "5 seconds.",
    expectTag: false,
    source:
      "PR #493 review B6 — a claim starting after the dot inside a figure",
  },
  {
    id: "figure-frag-ip-tail",
    tree: NEUTRAL_README,
    files: { "docs.md": "# net\n\nBind to 10.20.30.40 now.\n" },
    candidate: "30.40 now.",
    expectTag: false,
    source:
      "PR #493 review B6 — the address is one token, so its tail is not a figure the tree states",
  },
  {
    id: "figure-region-one-occurrence",
    tree: "# releases\n\nThe supported releases are 1, 5 for production. The minimum runtime is 1.5 for tooling.\n",
    candidate:
      "The supported releases are 1.5 for production. The minimum runtime is 1.5 for tooling.",
    expectTag: false,
    source:
      "PR #493 review B6 — one occurrence of 1.5 vouched for both assertions; the production claim states a pairing the tree never makes",
  },
  {
    id: "figure-atomic-version-restated",
    tree: "# runtime\n\nRequires Python 3.12\n",
    candidate: "Requires Python 3.12",
    expectTag: true,
    expectReason: "in_tracked_file",
    source:
      "PR #493 review B6 counterpart — the whole figure token still makes the row a restatement",
  },
  // ── A grouped figure and a sentence dot: one grammar for both edges ────────
  // `tokens()` split `1,024` at the comma and glued the sentence dot of `1.5.`
  // onto the figure, so the hit boundary and the figure set disagreed about
  // where the number ended: a truncation of `1` was refused as a restatement
  // of `1,024`, and a verbatim restatement of `1.5` was kept. Both sides now
  // read the figure grammar exported from `core/tokenize.ts`, and these rows
  // pin the relation at the edges the `1.5`-family rows left unvisited.
  {
    id: "figure-comma-grouped-truncation",
    tree: "# limits\n\nThe limit is 1,024 rows.\n",
    candidate: "The limit is 1",
    expectTag: false,
    source:
      "the grouped figure is one figure; `1` is what slicing at the comma leaves, not a number the tree states",
  },
  {
    id: "figure-comma-grouped-restated",
    tree: "# limits\n\nThe limit is 1,024 rows.\n",
    candidate: "The limit is 1,024",
    // Re-pinned from refuse: the row drops the unit noun `rows`, and the
    // coverage rule reads every tree word outside the match as material the
    // row left out. Kept — a refusal may only vouch for what the row itself
    // states, and this one states a figure with no unit.
    expectTag: false,
    source:
      "counterpart — the whole grouped figure, written with its comma, is restated and the refusal stands",
  },
  {
    id: "figure-comma-grouped-whole-sentence",
    tree: "# limits\n\nThe limit is 1,024 rows\n",
    candidate: "The limit is 1,024 rows",
    expectTag: true,
    expectReason: "in_tracked_file",
    source:
      "counterpart without the sentence dot — the relation was alive for the un-punctuated shape and must stay alive",
  },
  {
    id: "figure-sentence-dot-restated",
    tree: "# ratio\n\nThe ratio is 1.5.\n",
    candidate: "The ratio is 1.5",
    expectTag: true,
    expectReason: "in_tracked_file",
    source:
      "the sentence dot is prose, not the tail of the figure; the tree states the row's figure and the row is a restatement",
  },
  {
    id: "figure-sentence-dot-carried-restated",
    tree: "# ratio\n\nThe ratio is 1.5.\n",
    candidate: "The ratio is 1.5.",
    expectTag: true,
    expectReason: "in_tracked_file",
    source:
      "counterpart — the row carrying the dot refused before and must keep refusing; the verdict may not depend on how the session punctuated its prose",
  },
  {
    id: "figure-sentence-dot-cost-restated",
    tree: "# cost\n\nThe cost is 11.5.\n",
    candidate: "The cost is 11.5",
    expectTag: true,
    expectReason: "in_tracked_file",
    source:
      "second shape of the same class — the dot glued onto `11.5` made the tree's own figure unmatchable by a row that states it exactly",
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

  // ── A declared command's own figure, settled per span ─────────────────────
  // The disagreement class: the row quotes a declared command whose
  // declaration carries a number. Each figure settles against the declaration
  // its own span hits — never against one label chosen by which file the tree
  // lists first — and the refusal names every declaration it rested on.
  {
    id: "gate-figure-declared-in-span",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: { deploy: "deploy-tool publish --replicas 3" },
      }),
    },
    candidate: "Run `npm run deploy --replicas 3`.",
    expectTag: true,
    expectReason: "declared_gate",
    expectWhere: "package.json scripts.deploy",
    source:
      "#501 review A1 — the declaration's own command carries the figure the span carries",
  },
  {
    id: "gate-figure-undeclared-in-span",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: { deploy: "deploy-tool publish --replicas 3" },
      }),
    },
    candidate: "Run `npm run deploy --replicas 5`.",
    expectTag: false,
    source:
      "#501 review A1 counterpart — same shape, a figure the declaration does not carry",
  },
  {
    id: "gate-figure-declared-across-spans",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: {
          build: "compiler --jobs 8",
          deploy: "deploy-tool publish --replicas 3",
        },
      }),
    },
    candidate:
      "Run `npm run build --jobs 8`. Run `npm run deploy --replicas 3`.",
    expectTag: true,
    expectReason: "declared_gate",
    expectWhere: "package.json scripts.build, package.json scripts.deploy",
    source:
      "#501 review A1 — each span settles against its own declaration, and the refusal cites both",
  },
  {
    id: "gate-figure-declared-sequenced",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: {
          build: "compiler --jobs 8",
          deploy: "deploy-tool publish --replicas 3",
        },
      }),
    },
    candidate:
      "Run `npm run build --jobs 8`, then `npm run deploy --replicas 3`.",
    expectTag: false,
    source:
      "#501 review A1 counterpart — both figures settle per span, and the row still keeps: `then` is a residual claim no declaration vouches for",
  },
  {
    id: "gate-figure-foreign-across-spans",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: {
          deploy: "deploy-tool publish --replicas 3",
          scale: "deploy-tool publish",
        },
      }),
    },
    candidate:
      "Run `deploy-tool publish --replicas 3` and `npm run scale --replicas 3`.",
    expectTag: false,
    source:
      "#501 review A1 counterpart — the first span's figure must not vouch for the second",
  },
  {
    id: "gate-figure-prose-restated-in-tree",
    tree: "Keep 3 replicas warm before rollout.\n",
    files: {
      "package.json": JSON.stringify({
        scripts: { deploy: "deploy-tool publish --replicas 3" },
      }),
    },
    candidate: "Run `npm run deploy`; keep 3 replicas warm.",
    // Re-pinned from refuse: the prose residual drops `before rollout`, a
    // temporal operator, so the passage states more than the row and no
    // longer answers for it. This is the shape the whole-assertion rule
    // exists to keep.
    expectTag: false,
    source:
      "#501 review A1 — a figure outside every command settles against the passage that restates it",
  },
  {
    id: "gate-figure-prose-not-restated",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: { deploy: "deploy-tool publish --replicas 3" },
      }),
    },
    candidate: "Run `npm run deploy`; keep 3 replicas warm.",
    expectTag: false,
    source:
      "#501 review A1 counterpart — the same figure with no passage stating it",
  },
  {
    id: "gate-figure-two-declarations-cited",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: {
          wide: "tool-x publish --replicas 3 --jobs 3",
          narrow: "tool-y publish --replicas 3",
        },
      }),
    },
    candidate:
      "Run `tool-x publish --replicas 3 --jobs 3` and `tool-y publish --replicas 3`.",
    expectTag: true,
    expectReason: "declared_gate",
    expectWhere: "package.json scripts.wide, package.json scripts.narrow",
    source:
      "#501 review A2 — a refusal resting on two declarations must name both",
  },
  {
    id: "gate-figure-one-declaration-cited",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: {
          wide: "tool-x publish --replicas 3 --jobs 3",
          narrow: "tool-y publish --replicas 3",
        },
      }),
    },
    candidate: "Run `tool-x publish --replicas 3 --jobs 3`.",
    expectTag: true,
    expectReason: "declared_gate",
    expectWhere: "package.json scripts.wide",
    source:
      "#501 review A2 counterpart — one span rests on one declaration and cites one",
  },
  // ── The dropped-operator family: a row that loses material scoping over
  // the span it matched states a different rule, and containment used to
  // refuse it as a restatement. Each escape is paired with the verbatim
  // wording of its own tree as a same-shape control.
  {
    id: "reversal-across-two-sentences",
    tree: "We never use port 11. Do not fall back.\n",
    candidate: "Use port 11. Do not fall back.",
    expectTag: false,
    source:
      "a prohibition reversed by a row that carries a cue from the other sentence",
  },
  {
    id: "reversal-across-two-sentences-verbatim",
    tree: "We never use port 11. Do not fall back.\n",
    candidate: "We never use port 11. Do not fall back.",
    expectTag: true,
    expectReason: "in_tracked_file",
    source: "counterpart — the same tree restated whole is restatable",
  },
  {
    id: "cue-carrying-reversal",
    tree: "Do not connect to the staging database on port 5432 without an ssh tunnel.\n",
    candidate:
      "Connect to the staging database on port 5432 without an ssh tunnel.",
    expectTag: false,
    source:
      "the row keeps `without` and drops `not`: cue equality agrees, coverage does not",
  },
  {
    id: "cue-carrying-reversal-verbatim",
    tree: "Do not connect to the staging database on port 5432 without an ssh tunnel.\n",
    candidate:
      "Do not connect to the staging database on port 5432 without an ssh tunnel.",
    expectTag: true,
    expectReason: "in_tracked_file",
    source: "counterpart — the prohibition restated whole is restatable",
  },
  {
    id: "dropped-only-when-condition",
    tree: "Route requests to the canary only when the flag x-canary is set.\n",
    candidate: "Route requests to the canary.",
    expectTag: false,
    source: "the row drops the condition that scoped over the span it matched",
  },
  {
    id: "dropped-only-when-condition-verbatim",
    tree: "Route requests to the canary only when the flag x-canary is set.\n",
    candidate:
      "Route requests to the canary only when the flag x-canary is set.",
    expectTag: true,
    expectReason: "in_tracked_file",
    source: "counterpart — the rule restated whole is restatable",
  },
  {
    id: "dropped-if-antecedent",
    tree: "If the flag x-canary is set, route requests to the canary.\n",
    candidate: "Route requests to the canary.",
    expectTag: false,
    source:
      "the antecedent scopes over the consequence across the comma, so the comma is not an edge for coverage",
  },
  {
    id: "dropped-if-antecedent-verbatim",
    tree: "If the flag x-canary is set, route requests to the canary.\n",
    candidate: "If the flag x-canary is set, route requests to the canary.",
    expectTag: true,
    expectReason: "in_tracked_file",
    source: "counterpart — the conditional restated whole is restatable",
  },
  {
    id: "dropped-unless-condition",
    tree: "Do not enable caching, route through the CDN unless the VPN is not up.\n",
    candidate: "Do not enable caching, route through the CDN.",
    expectTag: false,
    source: "a conditional made unconditional inside a multi-clause row",
  },
  {
    id: "dropped-unless-condition-verbatim",
    tree: "Do not enable caching, route through the CDN unless the VPN is not up.\n",
    candidate:
      "Do not enable caching, route through the CDN unless the VPN is not up.",
    expectTag: true,
    expectReason: "in_tracked_file",
    source: "counterpart — the instruction restated whole is restatable",
  },
  {
    id: "dropped-frequency",
    tree: "Rebuild the index weekly.\n",
    candidate: "Rebuild the index.",
    expectTag: false,
    source:
      "a frequency is an operator too: the unguarded row is a different rule",
  },
  {
    id: "dropped-frequency-verbatim",
    tree: "Rebuild the index weekly.\n",
    candidate: "Rebuild the index weekly.",
    expectTag: true,
    expectReason: "in_tracked_file",
    source: "counterpart — the schedule restated whole is restatable",
  },
  // ── Soft-wrapped prose: a line break inside a sentence is formatting, not
  // an assertion edge. A wrap inside a bigram cue must not blind the polarity
  // veto (the veto saw `instead of` only as a literal space), and a wrap must
  // not end the assertion the coverage test walks — most README prose is
  // written wrapped, and the dropped-operator class must not survive there.
  {
    id: "cue-wrapped-mid-sentence",
    tree: "Route requests to the canary instead\nof the staging pool.\n",
    candidate: "Route requests to the canary instead.",
    expectTag: false,
    source:
      "the wrap sits inside the `instead of` cue: a veto that reads the raw line misses the cue, the equality agrees against the reversal, and the row is refused",
  },
  {
    id: "cue-wrapped-mid-sentence-verbatim",
    tree: "Route requests to the canary instead\nof the staging pool.\n",
    candidate: "Route requests to the canary instead of the staging pool.",
    expectTag: true,
    expectReason: "in_tracked_file",
    source:
      "counterpart — the wrapped sentence restated whole matches across the soft break and is restatable",
  },
  {
    id: "dropped-condition-wrapped",
    tree: "Route requests to the canary\nwhen the flag x-canary is set.\n",
    candidate: "Route requests to the canary.",
    expectTag: false,
    source:
      "the same dropped condition, written hard-wrapped: a soft break must not fake the end of the assertion",
  },
  {
    id: "dropped-condition-wrapped-verbatim",
    tree: "Route requests to the canary\nwhen the flag x-canary is set.\n",
    candidate: "Route requests to the canary when the flag x-canary is set.",
    expectTag: true,
    expectReason: "in_tracked_file",
    source:
      "counterpart — the wrapped conditional restated whole is restatable",
  },
  {
    id: "dropped-condition-wrapped-prior-line",
    tree: "Only when the flag is set,\nroute requests to the canary.\n",
    candidate: "Route requests to the canary.",
    expectTag: false,
    source:
      "the condition on the line BEFORE the command: the soft break must not end the assertion, and the comma must not cut the antecedent off its consequence",
  },
  {
    id: "dropped-condition-wrapped-prior-line-verbatim",
    tree: "Only when the flag is set,\nroute requests to the canary.\n",
    candidate: "Only when the flag is set, route requests to the canary.",
    expectTag: true,
    expectReason: "in_tracked_file",
    source:
      "counterpart — the prior-line conditional restated whole, in the tree's own order, is restatable",
  },
  {
    id: "cue-hard-break-mid-cue",
    tree: "Route requests to the canary instead\n\nof the staging pool.\n",
    candidate: "Route requests to the canary instead.",
    expectTag: false,
    source:
      "a blank line inside the `instead of` cue is a hard break, so coverage stops at the region and only the polarity veto — reading its span with newlines flattened — can keep the row",
  },
  {
    id: "gate-prose-settle-verbatim",
    tree: "Keep 3 replicas warm before rollout.\n",
    files: {
      "ACKNOWLEDGMENTS.md": "Thank you to the project contributors.\n",
      "package.json": JSON.stringify({
        scripts: { deploy: "deploy-tool publish --replicas 3" },
      }),
    },
    candidate: "Run `npm run deploy`; keep 3 replicas warm before rollout.",
    expectTag: true,
    expectReason: "declared_gate",
    expectWhere: "package.json scripts.deploy, README.md",
    source:
      "the prose-settle path of the gate branch, pinned verbatim — the residual the declarations do not answer must still settle against the passage that states it",
  },
  {
    id: "gate-prose-citation-declaration-only",
    tree: "Keep 3 replicas warm before rollout.\n",
    files: {
      "package.json": JSON.stringify({
        scripts: { deploy: "deploy-tool publish --replicas 3" },
      }),
    },
    candidate: "Run `npm run deploy`.",
    expectTag: true,
    expectReason: "declared_gate",
    expectWhere: "package.json scripts.deploy",
    source: "a tracked passage contributes no evidence to a command-only row",
  },
  // ── The pairing bar: the residual settles words, never which command the
  // row pairs them with. A whole-sentence verbatim restatement settles
  // against ANY declared command; a tree that states the association inside
  // its own sentence keeps the row; the association stated as a heading is
  // the accepted limit. `gate-prose-settle-verbatim` above is the
  // right-command counterpart of the two refusals.
  {
    id: "gate-pairing-cross-command-refuse",
    tree: "Keep 3 replicas warm before rollout.\n",
    files: {
      "package.json": JSON.stringify({
        scripts: {
          deploy: "kubectl rollout restart deployment/web",
          rollback: "kubectl rollout undo deployment/web",
        },
      }),
    },
    candidate: "Run `npm run rollback`; keep 3 replicas warm before rollout.",
    expectTag: true,
    expectReason: "declared_gate",
    expectWhere: "package.json scripts.rollback, README.md",
    source:
      "the sentence is restated verbatim and stated unscoped, so it settles against a declared command whose activity it does not describe — the pairing is not a claim this check adjudicates",
  },
  {
    id: "gate-pairing-third-command-refuse",
    tree: "Keep 3 replicas warm before rollout.\n",
    files: {
      "package.json": JSON.stringify({
        scripts: {
          deploy: "kubectl rollout restart deployment/web",
          rollback: "kubectl rollout undo deployment/web",
          scale: "kubectl scale deployment/web --replicas 5",
        },
      }),
    },
    candidate: "Run `npm run scale`; keep 3 replicas warm before rollout.",
    expectTag: true,
    expectReason: "declared_gate",
    source:
      "the same refusal for a command the sentence says nothing about: the bar does not rank the tree's declarations, a third command settles like the rival",
  },
  {
    id: "gate-pairing-association-in-sentence-keep",
    tree: "Before `npm run deploy`, keep 3 replicas warm.\n",
    files: {
      "package.json": JSON.stringify({
        scripts: {
          deploy: "kubectl rollout restart deployment/web",
          rollback: "kubectl rollout undo deployment/web",
        },
      }),
    },
    candidate: "Run `npm run rollback`; keep 3 replicas warm.",
    expectTag: false,
    source:
      "the tree states the association inside its own sentence: the command words there are dropped material, coverage declines, and the pairing the row brings survives — the counterpart of the cross-command refusal above",
  },
  {
    id: "gate-pairing-heading-scope-limit-refuse",
    tree: "## Staging\n\nKeep 3 replicas warm before rollout.\n",
    files: {
      "package.json": JSON.stringify({
        scripts: {
          deploy: "kubectl rollout restart deployment/web",
          rollback: "kubectl rollout undo deployment/web",
        },
      }),
    },
    candidate: "Run `npm run rollback`; keep 3 replicas warm before rollout.",
    expectTag: true,
    expectReason: "declared_gate",
    source:
      "an association stated as a heading is a separate assertion to `norm()`, so coverage passes and the refusal contradicts the tree's own scoping — recorded as the accepted residue of the bar, not fixed; the heading word is a claim word on purpose, because a gate-vocabulary heading is FILLER and fusing it would change nothing this row could catch",
  },

  // ── The loose entry admits; only the settle refuses ───────────────────────
  // A multi-word declaration admits a form that starts or ends with its label.
  // The entry decides nothing on its own: every refusal must still settle on
  // literal evidence from the same declaration. These rows pin that division.
  {
    id: "gate-entry-admits-and-settles",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: { deploy: "deploy-tool publish --target staging" },
      }),
    },
    candidate: "Run `deploy-tool publish --target staging --target staging`.",
    expectTag: true,
    expectReason: "declared_gate",
    source:
      "the final flag-led group can repeat verbatim under the #516 compatibility rule",
  },
  {
    id: "gate-entry-admits-settle-refuses",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: { deploy: "deploy-tool publish --target staging" },
      }),
    },
    candidate: "Run `deploy-tool publish --target staging --force`.",
    expectTag: false,
    source:
      "entry alone never refuses: an operand the declaration does not state keeps the row through the loose entry",
  },
  gateCommandCase(
    "gate-package-exec-duplicate-keeps",
    "deploy-tool publish --target staging",
    "bunx deploy-tool publish --target staging --target staging",
    false,
    "#527: the direct-invocation duplicate allowance does not extend to a package executor",
  ),
  gateCommandCase(
    "gate-bare-script-with-operands-keeps",
    "deploy-tool publish --target staging",
    "deploy --target staging",
    false,
    "#527: the script declaration does not establish a standalone command of the same name",
  ),
  {
    id: "gate-entry-single-word-never-loose",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: { deploy: "deploy-tool publish --target staging" },
      }),
    },
    candidate: "Run `git deploy`.",
    expectTag: false,
    source:
      "reachability: a single-word label matches only the operand position, so a foreign command naming it never takes the loose multi-word branch",
  },
  {
    id: "gate-entry-value-reused-as-flag",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: { deploy: "deploy-tool publish --target staging" },
      }),
    },
    candidate: "Run `deploy-tool publish --target staging --staging`.",
    expectTag: false,
    source:
      "previously an accepted limit of word-level comparison: a flag whose word was a value already refused. #516 keeps this row because the flag has no literal witness",
  },
  gateCommandCase(
    "gate-value-reused-as-flag-declared",
    "deploy-tool publish --target staging --staging",
    "deploy-tool publish --target staging --staging",
    true,
    "#516 control: the complete invocation explicitly declares --staging",
  ),
  ...(
    [
      [
        "option-name-as-positional",
        "deploy-tool publish --target staging",
        "target",
      ],
      [
        "option-value-as-positional",
        "deploy-tool publish --target staging",
        "staging",
      ],
      ["compound-option-first-part", "deploy-tool publish --dry-run", "--dry"],
      ["compound-option-last-part", "deploy-tool publish --dry-run", "--run"],
      ["host-as-flag", "rsync -az ./dist/ deploy@box:/srv", "--box"],
      ["nonfinal-option-repeat", "deploy-tool publish --dry --force", "--dry"],
      [
        "stacked-compatibility",
        "deploy-tool publish --target staging",
        "--target staging --",
      ],
      [
        "repeat-after-marker",
        "deploy-tool publish -- --target staging",
        "--target staging",
      ],
    ] as const
  ).flatMap(([id, declaration, added]) => {
    const invocation = `${declaration} ${added}`;
    return [
      gateCommandCase(
        `gate-${id}`,
        declaration,
        invocation,
        false,
        "#516: the appended arguments need a complete literal witness",
      ),
      gateCommandCase(
        `gate-${id}-declared`,
        invocation,
        invocation,
        true,
        "#516 control: the complete invocation appears in the declaration",
      ),
    ];
  }),
  gateCommandCase(
    "gate-trailing-marker",
    "deploy-tool publish --target staging",
    "deploy-tool publish --target staging --",
    true,
    "#516 control: the complete declaration is followed by one terminal marker",
  ),
  ...(
    [
      [
        "case-changed",
        "deploy-tool publish --target Staging",
        "deploy-tool publish --target staging",
      ],
      [
        "underscore-removed",
        "deploy-tool publish --target stage_name",
        "deploy-tool publish --target stagename",
      ],
      [
        "foreign-runner",
        "deploy-tool publish --target staging",
        "npm exec deploy-tool publish --target staging",
      ],
      [
        "interior-marker",
        "deploy-tool publish --target staging",
        "deploy-tool publish -- --target staging",
      ],
      [
        "forwarding-missing-value",
        "deploy-tool publish --target staging",
        "npm run deploy -- --target",
      ],
      [
        "forwarding-late-option",
        "deploy-tool publish --target staging --force",
        "npm run deploy -- --force",
      ],
      [
        "forwarding-equals-split",
        "deploy-tool publish --target=staging",
        "npm run deploy -- --target staging",
      ],
      [
        "forwarding-extra-marker",
        "deploy-tool publish --target staging",
        "npm run deploy -- -- --target staging",
      ],
    ] as const
  ).flatMap(([id, declaration, invocation]) => [
    gateCommandCase(
      `gate-${id}`,
      declaration,
      invocation,
      false,
      "#516: preserve spelling, argument boundaries, and the runner's position",
    ),
    gateCommandCase(
      `gate-${id}-declared`,
      invocation,
      invocation,
      true,
      "#516 control: the complete invocation appears in the declaration",
    ),
  ]),
  {
    id: "gate-only-literal-witness-cited",
    tree: NEUTRAL_README,
    files: {
      "package.json": JSON.stringify({
        scripts: {
          deployUpper: "deploy-tool publish --target Staging",
          deployLower: "deploy-tool publish --target staging",
        },
      }),
    },
    candidate: "Run `deploy-tool publish --target staging`.",
    expectTag: true,
    expectReason: "declared_gate",
    expectWhere: "package.json scripts.deployLower",
    source:
      "#516: the normalized collision cannot vouch alongside the literal match",
  },
];

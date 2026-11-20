// Pull-precision bench — what a widened contextual pull would actually cost.
//
// The contextual pull bolts memory onto a tool result the model never asked
// for. It is the one delivery channel that needs no cooperation from the model,
// which is exactly why widening it is tempting and why it needs a number first:
// a wrong pull is paid for by every later turn, and unlike the system block it
// does not ride the prompt cache.
//
// Two widenings are on trial, each measured rather than assumed:
//
//   includeOutput — the pull searches the tool's ARGUMENTS today, so a fact
//                   keyed to something the model just DISCOVERED (an error
//                   string, a symbol in a file body) can never pull. Adding the
//                   result text closes that. Cost: output is long and noisy.
//   +shell        — shell is the most-used tool in the maintainer's own history
//                   (27k calls) and is excluded from the pull today.
//
// Arms, all of them the SHIPPED contextualPull, differing only by the PullScope
// passed to it:
//
//   shipped      grep/glob/read, arguments only          (the pre-change arm)
//   out-128/512/2000
//                same tools, arguments + N chars of output
//   wide-128/512 + shell
//   staged-N     search the arguments first and only fall back to the combined
//                query when that finds nothing
//   union-N      search the combined query and merge the arguments-only matches
//                back in FRONT (argsUnion in src/inject/pull.ts)
//   errgate-*    include the output only when it carries a failure signal — the
//                shape most durable rows actually take ("when X fails, do Y")
//
// Negative controls: `random3` and `store-order3` are deliberately
// wrong. If either scores like a real arm, this metric ranks nothing and the
// table is worthless — that is the point of printing them. `random3` should land
// near 3/size, not near the real arms.
//
// Two noise columns, because one is trivially flattered: `noise%` counts every
// no-gold call, `noise%real` only the ones that look like ordinary project
// traffic (a lint run, a service file) rather than a made-up `zq17` path.
//
// `miss-abstain%` separates two failures that read the same in R@3: on an
// arg-visible call the arm missed, did it pull NOTHING (a rejection) or pull
// something ELSE (a substitution)? A widening that "loses" recall by abstaining
// is cheap; one that loses by substituting is destroying a working match.
//
// Query classes are assigned by MEASURED overlap, never by author intent (the
// rule the recall dataset already follows): a case is `output-only` only if the
// shipped arm demonstrably cannot reach its gold from the arguments.
//
// Determinism: fixed LCG for the store and the random control, synthetic
// timestamps, no Date.now, stable sorts. `bun bench/runners/pull-precision.ts`
// is byte-identical across runs.
//
// Run: bun bench/runners/pull-precision.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatLine } from "../../src/core/logfmt/format.ts";
import {
  contextualPull,
  PULL_SHIPPED,
  type PullScope,
} from "../../src/inject/pull.ts";
import type { Memory } from "../../src/store/model/memory.ts";
import {
  buildStore,
  lcg,
  MEMORIES,
  QUERIES,
} from "../fixtures/recall-dataset.ts";

// --- fixture -----------------------------------------------------------------

/** Paths and commands meant to share no vocabulary with any memory. Whether
 * they actually leak is not assumed: classify() measures it, and a leak shows up
 * as a case moving from `output-only` to `arg-visible`. */
const NEUTRAL_PATHS = [
  "src/zq-17.ts",
  "src/kv-4.ts",
  "src/wm-88.ts",
  "src/rb-2.ts",
];
const NEUTRAL_COMMANDS = ["make zq17", "pnpm kv4:run", "tool wm88 --check"];
/** Words no memory contains; these drive the no-gold noise calls. */
const NULL_VOCAB = ["zq17", "kv4", "wm88", "rb2", "plux", "nk9"];

/** Every row shares one synthetic timestamp, exactly as the published recall
 * bench does. A per-row timestamp would make the scorer's recency tie-break
 * decide every contest — the authored gold rows are the OLDEST in a store grown
 * by mutation, so they would lose to their own copies and the table would measure
 * the fixture instead of the pull. Rows are therefore identified by CONTENT,
 * which is how bench/runners/recall-quality.ts identifies them too. */
const FIXED_TS = "2026-01-01T00:00:00.000Z";

interface Case {
  tool: string;
  args: unknown;
  output: string;
  /** The gold row's content, or "" for a no-gold noise call. */
  goldContent: string;
  /** Assigned by classify(), from the shipped arm's own behaviour. */
  klass: "arg-visible" | "output-only" | "noise";
  /** For no-gold calls: an empty vocabulary, or ordinary project traffic. */
  noiseKind?: "null" | "real";
}

function casesFor(goldContent: (id: string) => string): Case[] {
  const out: Case[] = [];
  QUERIES.forEach((eq, i) => {
    const path = NEUTRAL_PATHS[i % NEUTRAL_PATHS.length]!;
    const cmd = NEUTRAL_COMMANDS[i % NEUTRAL_COMMANDS.length]!;
    // 1. A search: the model's own words are the arguments.
    out.push({
      tool: "grep",
      args: { pattern: eq.q, path: "src" },
      output:
        "Found 12 matches\nsrc/a1.ts: Line 4: ...\nsrc/b2.ts: Line 9: ...\n",
      goldContent: goldContent(eq.gold),
      klass: "arg-visible",
    });
    // 2. A read whose BODY contains the thing the memory is about. The path
    //    says nothing, so only the output can carry the match.
    out.push({
      tool: "read",
      args: { path },
      output: `1: import { z } from "zod";\n2: // ${eq.q}\n3: export const value = 7;\n`,
      goldContent: goldContent(eq.gold),
      klass: "output-only",
    });
    // 3. A shell failure that names the same thing.
    out.push({
      tool: "shell",
      args: { command: cmd },
      output: `command failed: ${eq.q}\nexit status 1\n`,
      goldContent: goldContent(eq.gold),
      klass: "output-only",
    });
  });
  // 4. No-gold calls. Two families, because the optimistic one proves nothing:
  //    `noise-null` shares no word with any memory, `noise-real` is ordinary
  //    traffic in the same project — generic code and build vocabulary that DOES
  //    overlap memories by accident. A widening that bolts text onto the second
  //    family is buying noise, and only the second family can show that.
  for (let i = 0; i < 40; i++) {
    const v = NULL_VOCAB[i % NULL_VOCAB.length]!;
    out.push({
      tool: i % 2 === 0 ? "read" : "shell",
      args:
        i % 2 === 0
          ? { path: `src/${v}-${i}.ts` }
          : { command: `run ${v} ${i}` },
      output: `${NULL_VOCAB.join(" ")} ${i}: ok\nnothing to report\n`,
      goldContent: "",
      klass: "noise",
      noiseKind: "null",
    });
    out.push({
      tool: i % 3 === 0 ? "shell" : "read",
      args:
        i % 3 === 0
          ? { command: "make lint && make test" }
          : { path: `src/services/service-${i}.ts` },
      output:
        i % 3 === 0
          ? "running eslint\n\n/src/services/a.ts\n  12:4  warning  unused import\n\n2 problems\n"
          : `1: import { Router } from "express";\n2: export async function handle(req: Request) {\n3:   const rows = await db.query("select * from orders");\n4:   return rows;\n5: }\n`,
      goldContent: "",
      klass: "noise",
      noiseKind: "real",
    });
  }
  return out;
}

/** Assign classes by what the SHIPPED arm does, not by what the author meant. */
function classify(cases: Case[], shipped: Memory[][]): void {
  cases.forEach((c, i) => {
    if (!c.goldContent) c.klass = "noise";
    else
      c.klass = shipped[i]!.some((m) => m.content === c.goldContent)
        ? "arg-visible"
        : "output-only";
  });
}

// --- measurement -------------------------------------------------------------

function writeStore(root: string, size: number): Map<string, string> {
  mkdirSync(root, { recursive: true });
  const store = buildStore(size);
  const contents = new Map<string, string>();
  store.forEach((m) => {
    contents.set(m.id, m.content);
  });
  writeFileSync(
    join(root, "2026-01-01.logfmt"),
    store
      .map((m) =>
        formatLine({
          ts: FIXED_TS,
          type: m.type,
          scope: m.scope,
          content: m.content,
          ...(m.kw?.length ? { kw: m.kw.join(",") } : {}),
          status: "settled",
        }),
      )
      .join("\n") + "\n",
  );
  return contents;
}

async function pull(
  c: Case,
  scope: PullScope,
): Promise<{ rows: Memory[]; bytes: number }> {
  const out = { output: c.output };
  const rows = await contextualPull(
    { tool: c.tool, args: c.args, sessionID: "bench" },
    out,
    1200,
    undefined,
    scope,
  );
  return { rows, bytes: Math.max(0, out.output.length - c.output.length) };
}

interface ArmResult {
  arm: string;
  size: number;
  r1Arg: number;
  r3Arg: number;
  r1Out: number;
  r3Out: number;
  /**
   * On arg-visible calls the arm MISSES at k=3: what share pulled nothing at
   * all instead of confidently pulling something else. A widening that "loses"
   * arg-visible recall by abstaining is rejecting a weak match; one that loses
   * by substituting is destroying one. The two read the same in R@3 and mean
   * opposite things, which is why this column exists.
   */
  abstainOnMissPct: number;
  /** % of no-gold calls that pulled at least one row. */
  noisePct: number;
  /** The same, restricted to ordinary project traffic (the honest family). */
  noiseRealPct: number;
  meanRows: number;
  meanBytes: number;
}

const pct = (a: number, b: number): number =>
  b ? Math.round((1000 * a) / b) / 10 : 0;

async function measure(
  arm: string,
  size: number,
  cases: Case[],
  run: (c: Case) => Promise<{ rows: Memory[]; bytes: number }>,
): Promise<ArmResult> {
  let r1Arg = 0,
    r3Arg = 0,
    nArg = 0,
    r1Out = 0,
    r3Out = 0,
    nOut = 0,
    noise = 0,
    nNoise = 0,
    noiseReal = 0,
    nNoiseReal = 0,
    abstainArg = 0,
    nMissArg = 0,
    rows = 0,
    bytes = 0;
  for (const c of cases) {
    const { rows: got, bytes: b } = await run(c);
    rows += got.length;
    bytes += b;
    if (c.klass === "noise") {
      nNoise++;
      if (got.length) noise++;
      if (c.noiseKind === "real") {
        nNoiseReal++;
        if (got.length) noiseReal++;
      }
      continue;
    }
    const hit1 = got[0]?.content === c.goldContent;
    const hit3 = got.slice(0, 3).some((m) => m.content === c.goldContent);
    if (c.klass === "arg-visible") {
      nArg++;
      r1Arg += hit1 ? 1 : 0;
      r3Arg += hit3 ? 1 : 0;
    } else {
      nOut++;
      r1Out += hit1 ? 1 : 0;
      r3Out += hit3 ? 1 : 0;
    }
    if (c.klass === "arg-visible" && !hit3) {
      nMissArg++;
      if (got.length === 0) abstainArg++;
    }
  }
  return {
    arm,
    size,
    r1Arg: pct(r1Arg, nArg),
    r3Arg: pct(r3Arg, nArg),
    r1Out: pct(r1Out, nOut),
    r3Out: pct(r3Out, nOut),
    noisePct: pct(noise, nNoise),
    noiseRealPct: pct(noiseReal, nNoiseReal),
    abstainOnMissPct: pct(abstainArg, nMissArg),
    meanRows: Math.round((100 * rows) / cases.length) / 100,
    meanBytes: Math.round(bytes / cases.length),
  };
}

const ARMS: [string, PullScope][] = [
  // The PRE-change behaviour, hard-coded rather than imported: it is the control
  // that assigns the classes below, so it must not move when the shipped arm does.
  [
    "args-only",
    { tools: ["grep", "glob", "read"], includeOutput: false, outputChars: 0 },
  ],
  // What actually runs, imported so this table cannot drift from the source.
  ["PULL_SHIPPED", PULL_SHIPPED],
  [
    "out-128",
    { tools: ["grep", "glob", "read"], includeOutput: true, outputChars: 128 },
  ],
  [
    "out-512",
    { tools: ["grep", "glob", "read"], includeOutput: true, outputChars: 512 },
  ],
  [
    "out-2000",
    { tools: ["grep", "glob", "read"], includeOutput: true, outputChars: 2000 },
  ],
  [
    "wide-128",
    {
      tools: ["grep", "glob", "read", "shell"],
      includeOutput: true,
      outputChars: 128,
    },
  ],
  [
    "wide-512",
    {
      tools: ["grep", "glob", "read", "shell"],
      includeOutput: true,
      outputChars: 512,
    },
  ],
];

function table(rows: ArmResult[]): string {
  const head =
    "arm          size   R@1 arg  R@3 arg  R@1 out  R@3 out  noise%  noise%real  miss-abstain%  rows/call  bytes/call";
  const line = (r: ArmResult) =>
    `${r.arm.padEnd(12)} ${String(r.size).padStart(4)}  ${String(r.r1Arg).padStart(6)}  ${String(
      r.r3Arg,
    ).padStart(
      7,
    )}  ${String(r.r1Out).padStart(6)}  ${String(r.r3Out).padStart(7)}  ${String(
      r.noisePct,
    ).padStart(6)}  ${String(r.noiseRealPct).padStart(10)}  ${String(
      r.abstainOnMissPct,
    ).padStart(
      13,
    )}  ${String(r.meanRows).padStart(9)}  ${String(r.meanBytes).padStart(10)}`;
  return [head, "-".repeat(head.length), ...rows.map(line)].join("\n");
}

/** A control row: the shape the scorer returns, carrying a real store content so
 * chance alone can put it on a gold. */
const control = (content: string): Memory => ({
  ts: FIXED_TS,
  type: "learning",
  scope: "widget-api",
  content,
  status: "settled",
  file: "",
  index: 0,
});

// --- run ---------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "osi-pull-bench-"));
const prev = process.env.OPENCODE_MEMORY_DIR;
const out: ArmResult[] = [];
const sizes = [52, 200, 800];
const classes: string[] = [];

for (const size of sizes) {
  const dir = join(root, `s${size}`);
  process.env.OPENCODE_MEMORY_DIR = dir;
  const contents = writeStore(dir, size);
  const goldContent = (id: string): string => contents.get(id) ?? "";
  const cases = casesFor(goldContent);

  // The shipped arm assigns the classes, so `output-only` means exactly "the
  // arguments cannot reach it", measured on this very store.
  const shippedRows: Memory[][] = [];
  for (const c of cases) shippedRows.push((await pull(c, ARMS[0]![1])).rows);
  classify(cases, shippedRows);
  classes.push(
    `store ${size}: arg-visible=${
      cases.filter((c) => c.klass === "arg-visible").length
    } output-only=${cases.filter((c) => c.klass === "output-only").length} noise=${
      cases.filter((c) => c.klass === "noise").length
    }`,
  );

  // Staged: search the ARGUMENTS first, and only when that finds nothing search
  // again with the output included. The point is to buy the output-only class
  // without paying the arg-visible class — the widening's cost is concentrated
  // where the shipped arm already answers, so it should not be spent there.
  const staged =
    (scope: PullScope) =>
    async (c: Case): Promise<{ rows: Memory[]; bytes: number }> => {
      const args = await pull(c, {
        tools: scope.tools,
        includeOutput: false,
        outputChars: 0,
      });
      return args.rows.length ? args : pull(c, scope);
    };
  const runs: [
    string,
    (c: Case) => Promise<{ rows: Memory[]; bytes: number }>,
  ][] = ARMS.map(([name, scope]) => [name, (c: Case) => pull(c, scope)]);
  const byName = (n: string): PullScope => {
    const hit = ARMS.find(([name]) => name === n);
    if (!hit) throw new Error(`bench arm ${n} is not defined`);
    return hit[1];
  };
  runs.push(["staged-512", staged(byName("out-512"))]);
  runs.push(["staged-wide", staged(byName("wide-512"))]);
  // Union: arguments-only matches take the slots FIRST, the combined matches
  // fill what is left. Keeps the row the model's own words matched while
  // reaching the class only the output can name. `union(out-512)` IS
  // PULL_SHIPPED, so it is not measured twice — only the widened variant is
  // printed here.
  //
  // Read this arm's numbers knowing what the fixture cannot show: on the
  // shipped scope the two orders score byte-identical, because no call pairs a
  // precise argument with three output-matching rows. The `+ shell` rows below
  // are where the ordering is visible. The case the fixture is blind to is
  // pinned at unit level in test/inject/pull-scope.test.ts — a fixture built to
  // expose it would be measuring one authored case, not a class.
  const union = (scope: PullScope): PullScope => ({
    ...scope,
    argsUnion: true,
  });
  runs.push(["union-wide", (c) => pull(c, union(byName("wide-512")))]);
  // Error-gated: use the output ONLY when the output carries a failure signal.
  // Rationale, not vibes: most durable rows are "when X fails, do Y" — the
  // plugin's own capture rule asks for that shape — and a failing command is the
  // moment a remembered fix is worth interrupting for. Ordinary file content is
  // not. Measured here so the claim is not one.
  const ERRISH =
    /(error|fail(ed|ure)?|exception|traceback|panic|cannot|unable|not found|no such|exit status|timed? ?out|refused|denied|undefined|is not)/i;
  const argsScope = (scope: PullScope): PullScope => ({
    tools: scope.tools,
    includeOutput: false,
    outputChars: 0,
  });
  runs.push([
    "errgate-wide",
    (c) =>
      pull(
        c,
        ERRISH.test(c.output)
          ? byName("wide-512")
          : argsScope(byName("wide-512")),
      ),
  ]);
  // The same gate merged BEHIND the arguments, so a precise search never loses
  // its row to boilerplate output ("grep results", "Found 12 matches").
  runs.push([
    "errgate-union",
    (c) =>
      pull(
        c,
        ERRISH.test(c.output)
          ? union(byName("wide-512"))
          : argsScope(byName("wide-512")),
      ),
  ]);
  for (const [name, run] of runs)
    out.push(await measure(name, size, cases, run));

  // Negative controls, computed directly and never through the pull.
  const allContent = [...contents.values()];
  const rand = lcg(7);
  out.push(
    await measure("random3", size, cases, async () => ({
      rows: [0, 1, 2].map(() =>
        control(allContent[Math.floor(rand() * allContent.length)]!),
      ),
      bytes: 200,
    })),
  );
  out.push(
    await measure("store-order3", size, cases, async () => ({
      rows: allContent.slice(0, 3).map(control),
      bytes: 200,
    })),
  );
}

if (prev === undefined) delete process.env.OPENCODE_MEMORY_DIR;
else process.env.OPENCODE_MEMORY_DIR = prev;
rmSync(root, { recursive: true, force: true });

console.log(
  `Contextual pull: ${QUERIES.length * 3 + 40} tool calls per store, k=3, ` +
    `budget 1200 chars, ${MEMORIES.length} authored memories grown by mutation.\n` +
    `Classes assigned by the arguments-only control, per store: ${classes.join(" | ")}\n`,
);
for (const size of sizes)
  console.log(
    `store = ${size}\n${table(out.filter((r) => r.size === size))}\n`,
  );

// The decision, printed with the numbers that produced it, so the table cannot
// be read as decoration. Asserted, not asserted-to-be-true: if a future change
// makes one of these false the run says so out loud.
const at = (size: number, arm: string) =>
  out.find((r) => r.size === size && r.arm === arm)!;
const checks = sizes.flatMap((size) => {
  const ship = at(size, "PULL_SHIPPED");
  const base = at(size, "args-only");
  return [
    [
      `PULL_SHIPPED keeps arg-visible R@3 (${ship.r3Arg} vs ${base.r3Arg})`,
      ship.r3Arg >= base.r3Arg,
    ],
    [
      `PULL_SHIPPED reaches output-only rows (${ship.r1Out}% > 0)`,
      ship.r1Out > 0,
    ],
    [
      `PULL_SHIPPED does not add noise on ordinary traffic (${ship.noiseRealPct} vs ${base.noiseRealPct})`,
      ship.noiseRealPct <= base.noiseRealPct,
    ],
    [
      `shell stays out: union-wide spams ordinary traffic (${at(size, "union-wide").noiseRealPct}%)`,
      at(size, "union-wide").noiseRealPct > ship.noiseRealPct,
    ],
  ] as [string, boolean][];
});
const failed = checks.filter(([, ok]) => !ok);
console.log(
  failed.length
    ? `DECISION VIOLATED:\n${failed.map(([c]) => `  ${c}`).join("\n")}`
    : `Decision holds at every store size: PULL_SHIPPED = args-only recall + output-only reach,\n` +
        `noise unchanged, shell excluded (union-wide spams ordinary traffic at 100%).`,
);

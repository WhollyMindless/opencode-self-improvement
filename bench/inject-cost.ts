// Deterministic injection-cost bench (Phase 6).
//
// Answers the community's #1 question about memory plugins — "what does it
// actually cost?" — with reproducible numbers from THIS plugin's real
// injection code (src/inject.ts), not estimates.
//
//   Policy A (pre-0.2): recompute relevantKnowledge on every prompt, uncapped.
//   Policy B (0.2):     epoch freeze — recompute only when the store
//                       fingerprint (storeVersion) changes — plus the
//                       character cap (capToBudget). The simulated session
//                       performs 3 mid-session store writes, so B recomputes
//                       a handful of times across 20 turns instead of 20.
//
// Determinism (review checklist): a fixed-seed LCG generates the store and
// the prompts; memory timestamps are synthetic (no Date.now()); nothing reads
// Math.random; RESULTS.md carries no wall-clock stamp — `bun bench/inject-cost.ts`
// is byte-identical across runs.
//
// Run: bun bench/inject-cost.ts   (also: bun run bench)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic store (invariant I2): a temp dir, never the real one. config.ts
// reads OPENCODE_MEMORY_DIR lazily inside every helper call (verified), so
// setting it here — before the first store read below — is sufficient even
// though the imports below are hoisted.
const tmp = mkdtempSync(join(tmpdir(), "osi-bench-"));
const store = join(tmp, "memory");
process.env.OPENCODE_MEMORY_DIR = store;
delete process.env.OPENCODE_MEMORY_INJECT_BUDGET; // the bench measures the DEFAULT budget

import { injectBudget } from "../src/config.ts";
import { capToBudget, compactionAnchor, relevantKnowledge, storeVersion } from "../src/inject.ts";
import { formatLine } from "../src/logfmt.ts";

// --- deterministic generator -----------------------------------------------------

// Classic LCG (numerical recipes parameters). Not Math.random: the whole point
// is that every run produces the same store, the same prompts, the same table.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const rand = lcg(20261018);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

const TOPICS = ["vitest", "bun", "esbuild", "playwright", "docker", "postgres", "redis", "nginx", "graphql", "rust"] as const;
const SCOPES = ["build", "api", "auth", "infra", "db", "frontend", "cli", "docs"] as const;
const TYPES = ["learning", "pattern", "decision", "preference", "blocker", "context"] as const;
const PHRASES = [
  "run the suite from the repository root, never a subdirectory",
  "the cache key must include the schema version or reads go stale",
  "flaky retries are capped at two before the job is marked failed",
  "the migration lock is held for the whole transaction window",
  "port collisions in ci are resolved by binding an ephemeral port",
  "the build output is cached between runs keyed by the lockfile hash",
  "timeouts are configured per environment and overridable by env var",
  "the rate limiter counts requests per key per rolling minute",
  "snapshot files are written before every destructive mutation",
  "the config loader merges the project file over the global default",
  "schema changes require regenerating the typed client afterwards",
  "the deploy gate blocks until lint and typecheck both pass clean",
  "log lines are logfmt so structured fields stay machine readable",
  "the index rebuild is incremental unless a refactor forces full mode",
  "secrets are read from the agent environment, never the repository",
  "the retry budget is exhausted before the circuit breaker opens",
  "fixtures are seeded once per suite and reset between test files",
  "the proxy strips internal headers before forwarding upstream calls",
  "bundle size is asserted in ci with a per-package character budget",
  "the queue consumer acknowledges only after the write is durable",
  "feature flags are evaluated server side and cached per request",
  "the backup job verifies checksums before it prunes old snapshots",
  "watch mode debounces file events by fifty milliseconds to coalesce",
  "the auth middleware refreshes tokens only on a forty-one response",
] as const;
const PROMPT_WORDS = ["run", "build", "test", "cache", "config", "deploy", "check", "rate", "limit", "rebuild"] as const;

interface Row {
  ts: string;
  type: string;
  scope: string;
  content: string;
  status: string;
}

// Synthetic base timestamp: memory rows never use the wall clock.
const BASE = Date.parse("2026-09-01T00:00:00.000Z");
const iso = (offsetSec: number) => new Date(BASE + offsetSec * 1000).toISOString();

// 50 memories: topic+scope prefix (so prompts can match them) plus enough
// phrases to land between ~260 and ~560 chars — realistic durable-memory size.
const memories: Row[] = [];
for (let i = 0; i < 50; i++) {
  const topic = TOPICS[i % TOPICS.length];
  const scope = pick(SCOPES);
  const type = pick(TYPES);
  const target = 260 + Math.floor(rand() * 300);
  let content = `${topic} ${scope}:`;
  while (content.length < target) content += ` ${pick(PHRASES)}`;
  memories.push({ ts: iso(i * 37), type, scope, content, status: i % 7 === 3 ? "open" : "settled" });
}

// 20 user prompts: one topic each plus a couple of shared vocabulary words.
const prompts: string[] = [];
for (let i = 0; i < 20; i++) {
  prompts.push(`${TOPICS[i % TOPICS.length]} ${pick(PROMPT_WORDS)} ${pick(PROMPT_WORDS)} how`);
}

// Three writes that land mid-session (turns 5, 10, 15) — they change the
// store fingerprint and legitimately invalidate the frozen epoch.
const SESSION_WRITES: Array<{ scope: string; content: string }> = [
  { scope: "infra", content: "Mid-session fact one: the staging deploy waits for the health check to pass twice in a row." },
  { scope: "docs", content: "Mid-session fact two: the nightly job prunes evidence logs older than ninety days from the store." },
  { scope: "cli", content: "Mid-session fact three: the import tool tags every promoted row so provenance survives a round trip." },
];

const storeFile = () => join(store, "2026-09-01.logfmt");

function seedStore(): void {
  rmSync(store, { recursive: true, force: true });
  mkdirSync(store, { recursive: true });
  const lines = memories.map((m) =>
    formatLine({ ts: m.ts, type: m.type, scope: m.scope, content: m.content, status: m.status }),
  );
  writeFileSync(storeFile(), lines.join("\n") + "\n");
}

// --- policy runs (mirror the real hooks in src/index.ts) ---------------------------

// Policy A: the pre-0.2 behavior — recompute top-3 relevance on EVERY prompt,
// uncapped, and inject it (which changed the system prefix every turn).
seedStore();
const aBlocks: string[] = [];
for (const p of prompts) aBlocks.push(await relevantKnowledge(p, 3));

// Policy B: the shipped behavior — one frozen block per epoch, recomputed only
// when storeVersion() changes (first prompt + the 3 mid-session writes),
// capped at the default budget at whole-memory boundaries.
seedStore();
const budget = injectBudget(); // 1200 (env cleared above)
const bBlocks: string[] = [];
let epoch: { version: string; block: string } | null = null;
let recomputes = 0;
for (let i = 0; i < prompts.length; i++) {
  const write = i === 4 ? 0 : i === 9 ? 1 : i === 14 ? 2 : -1;
  if (write >= 0) {
    appendFileSync(
      storeFile(),
      formatLine({
        ts: iso(2000 + write * 60),
        type: "learning",
        scope: SESSION_WRITES[write].scope,
        content: SESSION_WRITES[write].content,
        status: "settled",
      }) + "\n",
    );
  }
  const version = await storeVersion();
  if (!epoch || epoch.version !== version) {
    const raw = await relevantKnowledge(prompts[i], 5);
    epoch = { version, block: raw ? capToBudget(raw, budget) : "" };
    recomputes++;
  }
  bBlocks.push(epoch.block);
}

// The compaction anchor (Phase 3): pushed once per compaction, capped at 2500.
seedStore();
const anchor = await compactionAnchor();

// --- report --------------------------------------------------------------------------

const sum = (xs: string[]) => xs.reduce((a, b) => a + b.length, 0);
const worst = (xs: string[]) => Math.max(0, ...xs.map((b) => b.length));
const sumA = sum(aBlocks);
const sumB = sum(bBlocks);
const saved = sumA > 0 ? ((sumA - sumB) / sumA) * 100 : 0;
const f1 = (n: number) => n.toFixed(1);

const report = `# Injection cost — measured

Reproduce with \`bun bench/inject-cost.ts\` (deterministic: fixed-seed LCG,
synthetic timestamps, no wall clock in the output — reruns are byte-identical).
The numbers come from the plugin's real injection code (\`src/inject.ts\`):
a seeded store of ${memories.length} memories, a simulated session of
${prompts.length} user prompts with 3 mid-session store writes, and the default
${budget}-character budget.

| Policy | Recomputes | Injected chars (${prompts.length} turns) | Avg/turn | Worst block |
| --- | ---: | ---: | ---: | ---: |
| A — recompute per prompt, uncapped (pre-0.2) | ${aBlocks.length} | ${sumA} | ${f1(sumA / aBlocks.length)} | ${worst(aBlocks)} |
| B — epoch freeze + ${budget}-char cap (0.2) | ${recomputes} | ${sumB} | ${f1(sumB / bBlocks.length)} | ${worst(bBlocks)} |

Policy B injects ${f1(saved)}% fewer characters on this workload. The bigger
saving is invisible in this table: B's block is byte-identical between store
changes, so the system prefix — and with it the provider prompt cache —
survives ordinary turns instead of being invalidated on every prompt.

Compaction anchor (Phase 3 block, capped at 2500 chars): ${anchor.length} chars,
pushed once per compaction rather than per turn.
`;

writeFileSync(join(import.meta.dir, "RESULTS.md"), report);
console.log(report);

rmSync(tmp, { recursive: true, force: true });
delete process.env.OPENCODE_MEMORY_DIR;

// Recall-eval dataset: synthetic but realistic memories + queries, committed
// so results are reproducible and auditable. Anti-rigging rules:
//   1. Query CLASSES (lexical / near / strict-paraphrase) are assigned by
//      MEASURED token overlap at eval time (bench/recall-quality.ts), never by
//      the author's intent — a "hard" query that accidentally shares words is
//      graded lexical, and vice versa.
//   2. Distractors are topically ADJACENT (same project), not strawmen.
//   3. Every query has exactly one gold memory; if a distractor genuinely
//      answers it better, that counts as a miss (ranking ambiguity is real).
// All content is fictional (project "widget-service"/"ledger"); no real
// machine, user, or secret data appears here.
export interface GoldMemory {
  id: string;
  type: string;
  scope: string;
  content: string;
  /**
   * Write-time retrieval keywords (#40), attached by buildStore from KEYWORDS.
   * Authored rows and their variants carry the SAME set: a variant is a copy of
   * that memory, so it would carry the same keywords in a real store — that is
   * what keeps the vocabulary bridge competing against equals.
   */
  kw?: string[];
}

export interface EvalQuery {
  q: string;
  gold: string; // id of the memory that should surface
}

/**
 * Write-time retrieval keywords (#40 item 3) — the vocabulary bridge the bench's
 * strict-paraphrase wall exists to measure.
 *
 * AUTHORING RULE (read this before adding an entry): a keyword set is written
 * from the MEMORY'S OWN CONTENT, in the words a different person might use for
 * the same fact — naming aliases, other verb forms, jargon synonyms, the
 * literal command or file name. The query list is deliberately NOT an input:
 * keywords tuned to the eval's phrasing would measure authorship, not the
 * bridge. test/recall-dataset.test.ts enforces the mechanical half of that
 * promise (no authored keyword appears word-bounded in any query, every set is
 * 3-5 long, every entry ≤ 48 chars, every gold has a set), so a query-shaped
 * keyword fails CI rather than quietly inflating a published number.
 *
 * Distractor variants inherit their base memory's keywords in buildStore(), so
 * the bridge competes against equally well-tagged neighbours instead of a
 * strawman.
 */
export const KEYWORDS: Record<string, string[]> = {
  m01: ["api tests", "how to run the suite", "test command", "docker compose up", "integration test setup"],
  m02: ["throttling", "rate limit store", "redis database number", "abuse protection", "limiter backend"],
  m03: ["paging", "relay connections", "why cursors", "pagination strategy", "skipped rows bug"],
  m04: ["health check", "readiness probe", "liveness endpoint", "pool saturation", "falsely healthy"],
  m05: ["generate types", "schema regeneration", "code generation", "types out of date", "resolver type errors"],
  m06: ["staging release", "promote to staging", "which branch ships", "environment branch", "cherry pick flow"],
  m07: ["logging out", "token revocation", "session invalidation delay", "jwt denylist", "still signed in"],
  m08: ["seed data", "fixtures", "fake users", "database seeding command", "test data setup"],
  m09: ["http framework choice", "why fastify", "express alternative", "server framework decision", "tail latency"],
  m10: ["csv download", "export runs out of memory", "chunked flag", "bulk export", "pod oom kill"],
  m11: ["database migration command", "schema change workflow", "down migration", "reversible migration policy", "migrate up"],
  m12: ["query statistics", "statement truncation", "normalise query text", "performance monitoring", "stats views"],
  m13: ["timezone handling", "utc storage rule", "local time conversion", "date storage convention", "timestamp column"],
  m14: ["create index", "indexing without locking", "writes blocked", "online index build", "table lock"],
  m15: ["read replica lag", "stale reads", "analytics database", "replication delay", "read after write"],
  m16: ["snapshot mismatch", "refresh snapshots", "golden file update", "component test baseline", "intentional copy change"],
  m17: ["slow dashboard", "excessive rerenders", "memoization", "websocket frames", "selector performance"],
  m18: ["date library choice", "moment replacement", "bundle size", "tree shaking", "datetime dependency"],
  m19: ["component explorer", "ui catalog", "visual regression", "screenshot diffs", "dev server port"],
  m20: ["missing key prop", "console warning", "list rendering", "table row keys", "index as key anti-pattern"],
  m21: ["production release", "ship to prod", "approval workflow", "how to deploy", "promotion gate"],
  m22: ["infrastructure drift", "iac plan", "security group changed", "terraform apply", "cloud config drift"],
  m23: ["who is on call", "pager rotation", "incident escalation", "paging schedule", "support rota"],
  m24: ["namespace split", "cluster organisation", "k8s tenancy", "when to separate namespaces", "single namespace decision"],
  m25: ["ci runner image", "flaky pipeline", "arm64 builds", "actions failures", "runner architecture"],
  m26: ["scheduled notebook", "batch notebooks", "dag schedule", "parameterised runs", "nightly job"],
  m27: ["pandas upgrade", "copy on write", "inplace mutation", "fillna not working", "dataframe mutation"],
  m28: ["table format", "lakehouse format", "why iceberg", "delta lake alternative", "feature store storage"],
  m29: ["xcode version", "ios build failure", "codesign archive", "apple toolchain", "app store build"],
  m30: ["push notification certificate", "apns expiry", "certificate renewal", "expired push cert", "secret location"],
  m31: ["session storage", "where the jwt lives", "xss audit findings", "cookie based auth", "token in localstorage"],
  m32: ["key rotation window", "mass logout", "clock drift", "token invalidation", "rotation grace period"],
  m33: ["key rotation command", "signing key renewal", "grace window", "jwks update", "rotate signing secrets"],
  m34: ["database access layer", "why not an orm", "query builder", "raw sql decision", "prisma alternative"],
  m35: ["unstable tests", "retry policy", "test quarantine", "intermittent failure", "flake list"],
  m36: ["linter command", "code style check", "formatter", "fix lint errors", "eslint replacement"],
  m37: ["package publishing", "npm organisation name", "release to npm", "two factor bypass", "publish token"],
  m38: ["shell alias", "rg versus grep", "portable scripts", "search tool choice", "script breaks locally"],
  m39: ["workspace tooling", "task runner choice", "monorepo manager", "why not turbo", "build caching"],
  m40: ["pre-pr checks", "pull request checklist command", "run everything locally", "all checks green", "before raising a pr"],
  m41: ["schema library upgrade", "validation breaking change", "zod 4", "union helpers", "import path workaround"],
  m42: ["accidental drop", "database restore", "point in time recovery", "backup recovery", "undelete a column"],
  m43: ["deploy freeze hours", "sync blocked", "change window", "nightly deploy lock", "gitops freeze"],
  m44: ["design system variables", "colour tokens", "figma sync", "theme values", "generated styles"],
  m45: ["reprocessing old dags", "backfill logs missing", "historical run", "log retention", "catchup runs"],
  m46: ["fake admin token", "local auth bypass", "dev jwt", "sign in as admin locally", "test credentials"],
  m47: ["queue versus sync", "async processing threshold", "when to add a queue", "architecture simplicity", "requests per second threshold"],
  m48: ["react native bundler", "stale bundle", "clear the cache", "module resolution after install", "bundler cache files"],
  m49: ["commit message style", "semver automation", "changelog generation", "automatic version bump", "conventional commit rules"],
  m50: ["shared cache danger", "flushdb risk", "redis cluster db 7", "wipe cache in staging", "production cache impact"],
  m51: ["import sorting", "formatter disagreement", "autofix churn", "prettier migration", "reformat after merge"],
  m52: ["replica routing", "reporting queries only", "analytics reads", "oltp versus olap split", "primary load"],
};

/** Keywords for a store entry: variants inherit their base's set. */
export function keywordsFor(id: string): string[] | undefined {
  return KEYWORDS[id.split("#")[0]!];
}


export const MEMORIES: GoldMemory[] = [
  { id: "m01", type: "pattern", scope: "widget-api", content: "run the widget-api test suite with make test-api; it boots postgres in docker compose first" },
  { id: "m02", type: "learning", scope: "widget-api", content: "widget-api rate limiter reads from Redis DB 3, not DB 0 like the rest of the stack" },
  { id: "m03", type: "decision", scope: "widget-api", content: "decided to keep GraphQL pagination cursor-based; offset paging caused skipped rows under concurrent writes" },
  { id: "m04", type: "learning", scope: "widget-api", content: "the /healthz endpoint lags when the connection pool is exhausted; it is not a reliable readiness signal" },
  { id: "m05", type: "pattern", scope: "widget-api", content: "graphql codegen: run bun run codegen after editing schema.graphql or resolvers fail typecheck" },
  { id: "m06", type: "context", scope: "widget-api", content: "staging widget-api deploys from the release/staging branch, not main; cherry-picks only" },
  { id: "m07", type: "learning", scope: "widget-api", content: "jwt middleware caches revoked tokens for 60s via the jti list; logging out does not kill active sessions immediately" },
  { id: "m08", type: "pattern", scope: "widget-api", content: "seeds: bun run seed creates 42 fixture users; always run it against a throwaway database" },
  { id: "m09", type: "decision", scope: "widget-api", content: "chose fastify over express for widget-api: schema validation middleware and lower p99 latency" },
  { id: "m10", type: "learning", scope: "widget-api", content: "the export endpoint streams CSV; large exports OOM the 512MB pod without the chunked flag" },
  { id: "m11", type: "pattern", scope: "widget-db", content: "migrations run with bun run migrate and must be reversible; CI checks down scripts" },
  { id: "m12", type: "learning", scope: "widget-db", content: "postgres 16 pg_stat_statements truncates query names at 1kb; normalize before aggregating" },
  { id: "m13", type: "decision", scope: "widget-db", content: "all timestamps stored UTC in postgres; convert at the edge, never in the database" },
  { id: "m14", type: "learning", scope: "widget-db", content: "add index must run CONCURRENTLY on widget_events or writes block for minutes" },
  { id: "m15", type: "context", scope: "widget-db", content: "the analytics replica lags the primary by up to 90 seconds; never read-your-writes there" },
  { id: "m16", type: "pattern", scope: "ledger-frontend", content: "vitest snapshot tests need UPDATE=1 to refresh after intentional copy changes" },
  { id: "m17", type: "learning", scope: "ledger-frontend", content: "the ledger dashboard re-renders on every websocket frame unless selectors memoize" },
  { id: "m18", type: "decision", scope: "ledger-frontend", content: "dropped moment in favor of date-fns tree-shaking; bundle shrank 210KB" },
  { id: "m19", type: "pattern", scope: "ledger-frontend", content: "storybook: bun run storybook serves port 6006; visual regression runs against it" },
  { id: "m20", type: "learning", scope: "ledger-frontend", content: "React key warning on the transactions table rows; key by id plus revision not array index" },
  { id: "m21", type: "pattern", scope: "ops-deploy", content: "deploys to prod are gated by the deploy slash command with a manual approval step" },
  { id: "m22", type: "learning", scope: "ops-deploy", content: "terraform plan drift on the bastion security group; always run make plan before apply" },
  { id: "m23", type: "context", scope: "ops-deploy", content: "the on-call rotation is weekly in PagerDuty; escalations go to the oncall channel" },
  { id: "m24", type: "decision", scope: "ops-deploy", content: "kept everything on a single kubernetes namespace until 20 services; split deferred" },
  { id: "m25", type: "learning", scope: "ops-deploy", content: "github action runners ubuntu-latest arm64 preview are flaky for docker builds; pin 22.04 amd" },
  { id: "m26", type: "pattern", scope: "data-notebooks", content: "notebooks run via papermill on the airflow cron at 04:10 UTC" },
  { id: "m27", type: "learning", scope: "data-notebooks", content: "pandas 2.2 copy-on-write broke the fillna chains; assign explicitly" },
  { id: "m28", type: "decision", scope: "data-notebooks", content: "feature store tables live in iceberg, not delta; spark compatibility decided it" },
  { id: "m29", type: "pattern", scope: "mobile-app", content: "iOS builds need Xcode 16.2 exactly; 16.3 breaks the archive signing step" },
  { id: "m30", type: "learning", scope: "mobile-app", content: "the staging push certificate expires Feb 14; renewal lives in the password manager item named APNs staging" },
  { id: "m31", type: "decision", scope: "auth-infra", content: "sessions moved to httpOnly cookies; the localStorage token experiment was abandoned after the XSS audit" },
  { id: "m32", type: "learning", scope: "auth-infra", content: "auth-service token rotation has a 5 minute dual-accept window; clock skew beyond that logs everyone out" },
  { id: "m33", type: "pattern", scope: "auth-infra", content: "rotate signing keys with bun run keys:rotate with a 300 second grace window" },
  { id: "m34", type: "decision", scope: "general", content: "no ORM; raw SQL with pg keeps query plans reviewable" },
  { id: "m35", type: "learning", scope: "general", content: "flaky test policy: retry once, quarantine after two flakes in a week via the quarantine file" },
  { id: "m36", type: "pattern", scope: "general", content: "lint is biome not eslint; run bunx biome check with the write flag" },
  { id: "m37", type: "context", scope: "general", content: "the npm org is ledgerlabs; publishing requires a 2FA bypass token from the vault" },
  { id: "m38", type: "learning", scope: "general", content: "grep is aliased to ripgrep in the shared shell rc; scripts must call command grep explicitly" },
  { id: "m39", type: "decision", scope: "general", content: "monorepo workspaces stay with bun, no nx or turbo; caching via CI artifacts" },
  { id: "m40", type: "pattern", scope: "general", content: "before opening a pull request run make verify; it chains typecheck, tests and format" },
  { id: "m41", type: "learning", scope: "widget-api", content: "zod v4 breaks the old discriminated union helpers; import from the v3 path until migration" },
  { id: "m42", type: "pattern", scope: "widget-db", content: "restore a dropped column with point-in-time recovery: wal-g recover-to-time, 20 minutes average" },
  { id: "m43", type: "learning", scope: "ops-deploy", content: "argocd sync window blocks deploys between 22:00 and 06:00 UTC unless forced with an incident id" },
  { id: "m44", type: "context", scope: "ledger-frontend", content: "design tokens come from the Figma variables export committed in tokens; hand edits get overwritten" },
  { id: "m45", type: "learning", scope: "data-notebooks", content: "airflow backfills hit the 3-day log retention; use the local flag for historical runs" },
  { id: "m46", type: "pattern", scope: "auth-infra", content: "dev tokens: bun run auth:bypass prints an admin JWT for localhost only" },
  { id: "m47", type: "decision", scope: "general", content: "prefer boring CRUD over queues until sustained load exceeds 50 requests per second" },
  { id: "m48", type: "learning", scope: "mobile-app", content: "metro bundler caches node_modules symlink changes; clear the metro temp files after dependency bumps" },
  { id: "m49", type: "pattern", scope: "general", content: "commit format is conventional commits; release-please bumps versions on merge" },
  { id: "m50", type: "context", scope: "widget-api", content: "the staging environment shares the production redis cluster database 7; never flush it there" },
  { id: "m51", type: "learning", scope: "general", content: "biome autofix reorders imports differently than prettier did; run format after every rebase" },
  { id: "m52", type: "decision", scope: "widget-db", content: "read replicas serve only reporting queries; transactional traffic stays primary-only" },
];

// Queries span the natural spectrum: exact-vocabulary asks, partially-reworded
// asks, and full paraphrases that share NO content vocabulary with the gold
// memory. Classes are re-derived by measurement, not by these comments.
export const QUERIES: EvalQuery[] = [
  // m01
  { q: "how do I run the widget-api tests", gold: "m01" },
  { q: "what does the make test-api target do before running", gold: "m01" },
  { q: "starting the local verification loop for the backend", gold: "m01" },
  // m02
  { q: "which redis db does the rate limiter use", gold: "m02" },
  { q: "why do my throttling rules never take effect locally", gold: "m02" },
  // m03
  { q: "why is pagination cursor based instead of offset", gold: "m03" },
  { q: "what was the call on page navigation in the graph layer", gold: "m03" },
  // m04
  { q: "healthz readiness probe seems unreliable", gold: "m04" },
  { q: "kubernetes keeps restarting pods that are actually fine", gold: "m04" },
  // m05
  { q: "how do I regenerate the graphql types", gold: "m05" },
  { q: "I edited the schema and now resolvers show red everywhere", gold: "m05" },
  // m06
  { q: "how do staging deploys work", gold: "m06" },
  { q: "ship this hotfix to the pre-production environment", gold: "m06" },
  // m07
  { q: "why does a logged out token still work", gold: "m07" },
  { q: "users report they can still act after signing out", gold: "m07" },
  // m08
  { q: "how do I seed fixture users", gold: "m08" },
  { q: "spin up dummy accounts for manual testing", gold: "m08" },
  // m09
  { q: "why fastify instead of express", gold: "m09" },
  { q: "what web framework did we settle on and why", gold: "m09" },
  // m10
  { q: "csv export runs out of memory", gold: "m10" },
  { q: "memory blows up when customers download a data dump", gold: "m10" },
  // m11
  { q: "how do database migrations run here", gold: "m11" },
  { q: "is there a way to undo a schema change in the pipeline", gold: "m11" },
  // m12
  { q: "pg_stat_statements names look truncated", gold: "m12" },
  { q: "why do my slow query report groups look cut off", gold: "m12" },
  // m13
  { q: "timezone handling for stored timestamps", gold: "m13" },
  { q: "reports are off by three hours for EU customers", gold: "m13" },
  // m14
  { q: "adding an index blocks writes on the events table", gold: "m14" },
  { q: "production froze during a schema performance fix", gold: "m14" },
  // m15
  { q: "how bad is replica lag on the analytics copy", gold: "m15" },
  { q: "dashboards show stale numbers right after saving", gold: "m15" },
  // m16
  { q: "how do I update the snapshots", gold: "m16" },
  { q: "marketing changed the headline text and the suite went red", gold: "m16" },
  // m17
  { q: "websocket frames cause dashboard re-renders", gold: "m17" },
  { q: "typing in the search box feels laggy on the overview screen", gold: "m17" },
  // m18
  { q: "why did we drop moment", gold: "m18" },
  { q: "the bundle shrank after swapping the date library, right", gold: "m18" },
  // m19
  { q: "run storybook locally", gold: "m19" },
  { q: "how do I screenshot components in isolation", gold: "m19" },
  // m20
  { q: "transactions table key warning by index", gold: "m20" },
  { q: "table rows swap their state when filtering", gold: "m20" },
  // m21
  { q: "how do production deploys get approved", gold: "m21" },
  { q: "the pipeline is green but nothing shipped to customers", gold: "m21" },
  // m22
  { q: "terraform drift on the bastion security group", gold: "m22" },
  { q: "something changed the firewall rules outside the repo", gold: "m22" },
  // m23
  { q: "who is on call this week and where do pages go", gold: "m23" },
  { q: "alerts started buzzing my phone at 3am, what is the process", gold: "m23" },
  // m24
  { q: "why a single kubernetes namespace", gold: "m24" },
  { q: "should we carve out an environment per team yet", gold: "m24" },
  // m25
  { q: "arm64 runner docker builds are flaky", gold: "m25" },
  { q: "the build works on my laptop but dies only in CI", gold: "m25" },
  // m26
  { q: "when do the notebooks run", gold: "m26" },
  { q: "the daily report job fires at what time", gold: "m26" },
  // m27
  { q: "fillna stopped working after the pandas upgrade", gold: "m27" },
  { q: "silent no-ops in the cleaning step since the version bump", gold: "m27" },
  // m28
  { q: "iceberg vs delta, what did we pick", gold: "m28" },
  { q: "which table format did the ML infra settle on", gold: "m28" },
  // m29
  { q: "which Xcode version builds iOS here", gold: "m29" },
  { q: "app store upload fails validation for signing", gold: "m29" },
  // m30
  { q: "staging push certificate expiry", gold: "m30" },
  { q: "testers suddenly stopped receiving alerts", gold: "m30" },
  // m31
  { q: "why httpOnly cookies instead of local storage", gold: "m31" },
  { q: "the security audit changed how we keep users signed in", gold: "m31" },
  // m32
  { q: "token rotation clock skew window", gold: "m32" },
  { q: "mass sign-outs happened right after the deployment", gold: "m32" },
  // m33
  { q: "how do I rotate the signing keys", gold: "m33" },
  { q: "cut over the JWT secret without any downtime", gold: "m33" },
  // m34
  { q: "why no ORM in this repo", gold: "m34" },
  { q: "someone proposed Prisma; what did we decide back then", gold: "m34" },
  // m35
  { q: "what is the flaky test policy", gold: "m35" },
  { q: "this suite keeps failing randomly, do I just delete it", gold: "m35" },
  // m36
  { q: "which linter does this repo use", gold: "m36" },
  { q: "the editor squiggles disagree with CI, which is right", gold: "m36" },
  // m37
  { q: "npm publish permissions for this org", gold: "m37" },
  { q: "the release job cannot authenticate to the package registry", gold: "m37" },
  // m38
  { q: "grep behaves weird in the shared shell", gold: "m38" },
  { q: "CI fails on a script that works locally because of color codes", gold: "m38" },
  // m39
  { q: "do we use turbo for the monorepo", gold: "m39" },
  { q: "what was the conclusion of the task runner debate", gold: "m39" },
  // m40
  { q: "what should I run before opening a pull request", gold: "m40" },
  { q: "preflight checks so CI passes on the first try", gold: "m40" },
  // m41
  { q: "zod v4 broke the discriminated union helpers", gold: "m41" },
  { q: "validation types stopped compiling after the schema library upgrade", gold: "m41" },
  // m42
  { q: "how do I restore a dropped column", gold: "m42" },
  { q: "a deploy nuked a column; how far back can we wind the database", gold: "m42" },
  // m43
  { q: "argocd is blocking my deploy window", gold: "m43" },
  { q: "the sync just refuses between midnight and six in the morning", gold: "m43" },
  // m44
  { q: "where do the design tokens come from", gold: "m44" },
  { q: "my hand-edited spacing values keep getting clobbered", gold: "m44" },
  // m45
  { q: "airflow backfill logs are missing", gold: "m45" },
  { q: "the historical run output vanished a week later", gold: "m45" },
  // m46
  { q: "how do I get a dev admin token", gold: "m46" },
  { q: "I need to pretend to be an admin on localhost for testing", gold: "m46" },
  // m47
  { q: "when do we add a queue", gold: "m47" },
  { q: "someone wants Kafka; is that on the roadmap", gold: "m47" },
  // m48
  { q: "metro keeps old node_modules after a bump", gold: "m48" },
  { q: "the mobile bundler serves stale code even after reinstalling dependencies", gold: "m48" },
  // m49
  { q: "what commit message format is enforced", gold: "m49" },
  { q: "how do version numbers get bumped automatically", gold: "m49" },
  // m50
  { q: "staging redis database number", gold: "m50" },
  { q: "careful, the sandbox shares real customer cache infrastructure", gold: "m50" },
  // m51
  { q: "imports get reordered after every rebase", gold: "m51" },
  { q: "the formatter keeps fighting the merge conflict resolution", gold: "m51" },
  // m52
  { q: "what queries go to read replicas", gold: "m52" },
  { q: "can user-facing traffic be moved off the primary database", gold: "m52" },
];

// Deterministic LCG (no Math.random): the bench must be byte-reproducible,
// same contract as bench/inject-cost.ts.
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const MUT_WORDS = ["zz", "qv", "xt", "plu", "nk", "rb", "dex", "wm", "ka", "tr"];

// Grow the store beyond the 52 authored memories with mutated distractors
// (numbers and identifier-like tokens re-rolled) — competition, not strawmen:
// they keep the original topic and scope but are never any query's gold.
export function buildStore(size: number, seed = 20261020): GoldMemory[] {
  const rand = lcg(seed);
  const out: GoldMemory[] = MEMORIES.map((m) => ({ ...m, kw: keywordsFor(m.id) }));
  let v = 0;
  while (out.length < size) {
    const base = MEMORIES[v % MEMORIES.length]!;
    const tag = MUT_WORDS[Math.floor(rand() * MUT_WORDS.length)] + (v + 1);
    const content =
      base.content.replace(/\d+/g, (d) => String(Math.floor(rand() * 900) + 100)) +
      " note-" + tag;
    out.push({
      id: `${base.id}#${v}`,
      type: base.type,
      scope: base.scope,
      content,
      kw: keywordsFor(base.id),
    });
    v++;
  }
  return out.slice(0, size);
}

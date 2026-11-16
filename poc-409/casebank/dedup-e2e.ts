// Dedup lane measured through the shipped handler against the full-text labels
// (#409, review follow-up). §17 priced OPENCODE_MEMORY_DEDUP=0.8 with a replay
// at limit 5; the shipped default is 20. This runs the real memory_recall with
// the flag off and on at the DEFAULT limit over all 404 judged queries and
// scores every suppressed row against casebank-full.jsonl: the question is not
// how many rows dedup removes but whether any ANSWER is among them.
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const WT = process.env.PLUGIN_SRC ?? resolve(`${import.meta.dirname}`, "../..");
const BANK = "/Users/Alex/Documents/opencode-self-improvement/poc-409/casebank";
const OUT = `${import.meta.dirname}/`;
const LIMIT = 20;

const { memoryRoot } = await import(`${WT}/src/core/config/paths.ts`);
const { formatLine } = await import(`${WT}/src/core/logfmt/format.ts`);
const { setRepoScope, resolveRepo } = await import(
  `${WT}/src/identity/repokey.ts`
);
const { resetState } = await import(`${WT}/src/core/state.ts`);
const { loadPlugin } = await import(`${WT}/test/harness.ts`);

interface Snap {
  ts: string;
  type: string;
  scope: string;
  content: string;
  kw?: string[];
  status?: string;
  repo: string;
  repoPath: string;
}
const store = (await Bun.file(`${BANK}/store.jsonl`).text())
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Snap);

const root = mkdtempSync(join(tmpdir(), "osi-dedup-e2e-"));
process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
const byDay = new Map<string, string[]>();
for (const m of store) {
  const line = formatLine({
    ts: m.ts,
    type: m.type,
    scope: m.scope,
    content: m.content,
    status: m.status ?? "settled",
    repo: m.repo,
    repoPath: m.repoPath,
    ...(m.kw?.length ? { kw: m.kw.join(",") } : {}),
  });
  const day = m.ts.slice(0, 10);
  byDay.set(day, [...(byDay.get(day) ?? []), line]);
}
for (const [day, lines] of byDay) {
  const file = join(memoryRoot(), `${day}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${lines.join("\n")}\n`);
}

const labels = new Map<string, Map<string, number>>();
for (const l of (await Bun.file(`${BANK}/casebank-full.jsonl`).text())
  .split("\n")
  .filter((x) => x.trim())) {
  const b = JSON.parse(l) as {
    id: string;
    rows: Array<{ ts: string; s: number }>;
  };
  labels.set(b.id, new Map(b.rows.map((r) => [r.ts, r.s])));
}
for (const f of ["deep-labels-full.jsonl", "tail-labels-full.jsonl"]) {
  try {
    for (const l of (await Bun.file(`${BANK}/${f}`).text())
      .split("\n")
      .filter((x) => x.trim())) {
      const t = JSON.parse(l) as { id: string; ts: string; s: number };
      const m = labels.get(t.id) ?? new Map<string, number>();
      if (!m.has(t.ts)) m.set(t.ts, t.s);
      labels.set(t.id, m);
    }
  } catch {
    /* not labelled yet */
  }
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const byContent = new Map<string, string[]>();
for (const m of store) {
  const k = `${m.type}/${m.scope}: ${flat(m.content)}`;
  byContent.set(k, [...(byContent.get(k) ?? []), m.ts]);
}
const ambiguous = new Set<string>();
for (const [k, ts] of byContent) if (ts.length > 1) ambiguous.add(k);
function returnedRows(out: string): string[] | null {
  const ts: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("- [")) continue;
    const body = line.replace(/^(?:- \[[^\]]*\])+ /g, "").trim();
    let best: string | null = null;
    for (const key of byContent.keys())
      if (
        (body === key || body.endsWith(key)) &&
        (!best || key.length > best.length)
      )
        best = key;
    if (!best || ambiguous.has(best)) return null;
    ts.push(byContent.get(best)![0]!);
  }
  return ts;
}

interface Case {
  id: string;
  group: string;
  query: string;
  dirs: string[];
}
const cases = (await Bun.file(`${BANK}/queries.judged.jsonl`).text())
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Case);

resetState();
setRepoScope(null);
const loaded = await loadPlugin(root);
const OCSI = "/Users/Alex/Documents/opencode-self-improvement";
const scopeCache = new Map<string, ReturnType<typeof resolveRepo>>();

let unparsed = 0;
let queriesTouched = 0;
let suppressed = 0;
let suppressedGold = 0;
let suppressedUnlabelled = 0;
let added = 0;
let addedGold = 0;
const detail: string[] = [];
for (const c of cases) {
  const dir = [...c.dirs].sort((a, b) =>
    a === OCSI ? -1 : b === OCSI ? 1 : a < b ? -1 : 1,
  )[0];
  const scope = dir ? (scopeCache.get(dir) ?? resolveRepo(dir)) : null;
  if (dir) scopeCache.set(dir, scope!);
  setRepoScope(scope);
  delete process.env.OPENCODE_MEMORY_DEDUP;
  const off = returnedRows(
    String(
      await loaded.tool.memory_recall!.execute({
        query: c.query,
        limit: LIMIT,
      }),
    ),
  );
  process.env.OPENCODE_MEMORY_DEDUP = "0.8";
  const on = returnedRows(
    String(
      await loaded.tool.memory_recall!.execute({
        query: c.query,
        limit: LIMIT,
      }),
    ),
  );
  delete process.env.OPENCODE_MEMORY_DEDUP;
  if (!off || !on) {
    unparsed++;
    continue;
  }
  const lab = labels.get(c.id) ?? new Map<string, number>();
  const offSet = new Set(off);
  const onSet = new Set(on);
  const gone = off.filter((t) => !onSet.has(t));
  const came = on.filter((t) => !offSet.has(t));
  if (gone.length || came.length) queriesTouched++;
  for (const t of gone) {
    suppressed++;
    const s = lab.get(t);
    if (s === 2) {
      suppressedGold++;
      detail.push(
        `DROPPED GOLD ${c.id} "${c.query}" :: ${store.find((m) => m.ts === t)?.content.slice(0, 100)}`,
      );
    } else if (s === undefined) suppressedUnlabelled++;
  }
  for (const t of came) {
    added++;
    if (lab.get(t) === 2) addedGold++;
  }
}
await loaded.cleanup();
setRepoScope(null);
delete process.env.OPENCODE_MEMORY_DIR;

const report = {
  limit: LIMIT,
  threshold: 0.8,
  seed_rows: store.length,
  queries: cases.length,
  unparsed,
  queries_touched: queriesTouched,
  rows_suppressed: suppressed,
  suppressed_gold: suppressedGold,
  suppressed_unlabelled: suppressedUnlabelled,
  rows_added_by_refill: added,
  added_gold: addedGold,
};
await Bun.write(`${OUT}dedup-e2e-out.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
for (const d of detail) console.log(d);

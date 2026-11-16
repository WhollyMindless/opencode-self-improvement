// Dump off/on windows (ts only) for the dedup arms, for per-query scoring.
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
const WT = process.env.PLUGIN_SRC ?? resolve(import.meta.dirname, "../..");
const BANK = "/Users/Alex/Documents/opencode-self-improvement/poc-409/casebank";
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
const root = mkdtempSync(join(tmpdir(), "osi-ddw-"));
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
  const f = join(memoryRoot(), `${day}.logfmt`);
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, `${lines.join("\n")}\n`);
}
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const byContent = new Map<string, string[]>();
for (const m of store) {
  const k = `${m.type}/${m.scope}: ${flat(m.content)}`;
  byContent.set(k, [...(byContent.get(k) ?? []), m.ts]);
}
const ambiguous = new Set<string>();
for (const [k, ts] of byContent) if (ts.length > 1) ambiguous.add(k);
function rows(out: string): string[] | null {
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
const cases = (await Bun.file(`${BANK}/queries.judged.jsonl`).text())
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { id: string; query: string; dirs: string[] });
resetState();
setRepoScope(null);
const loaded = await loadPlugin(root);
const OCSI = "/Users/Alex/Documents/opencode-self-improvement";
const sc = new Map<string, ReturnType<typeof resolveRepo>>();
const out = [];
for (const c of cases) {
  const dir = [...c.dirs].sort((a, b) =>
    a === OCSI ? -1 : b === OCSI ? 1 : a < b ? -1 : 1,
  )[0];
  const scope = dir ? (sc.get(dir) ?? resolveRepo(dir)) : null;
  if (dir) sc.set(dir, scope!);
  setRepoScope(scope);
  delete process.env.OPENCODE_MEMORY_DEDUP;
  const off = rows(
    String(
      await loaded.tool.memory_recall!.execute({
        query: c.query,
        limit: LIMIT,
      }),
    ),
  );
  process.env.OPENCODE_MEMORY_DEDUP = "0.8";
  const on = rows(
    String(
      await loaded.tool.memory_recall!.execute({
        query: c.query,
        limit: LIMIT,
      }),
    ),
  );
  delete process.env.OPENCODE_MEMORY_DEDUP;
  out.push({ id: c.id, off, on });
}
await loaded.cleanup();
await Bun.write(
  `${import.meta.dirname}/dedup-windows.json`,
  JSON.stringify(out),
);
console.log("windows:", out.length);

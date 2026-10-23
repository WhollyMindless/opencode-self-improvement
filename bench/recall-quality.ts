// Recall-quality benchmark — the published keyword-adequacy defense.
// Question: at realistic store sizes, how often does the SHIPPED token matcher
// fail to rank the right memory inside the injection window (k=3), and how
// much of the gap closes with pure-algorithm changes — NO models, NO
// embeddings, NO inference engines, same zero-dependency guarantee the plugin
// ships with. The rank() seam is where anyone could add a vector scorer; the
// project's position is that a user should never be required to.
//
// Scorers:
//   naive — the previous shipped matcher (verbatim inline copy, kept as
//           the honest "before"): bag-of-words with no query stopword filter.
//   prod  — the CURRENT shipped matcher (imported from src/inject.ts):
//           identical scoring plus query-side stopword abstention.
//   bm25  — Okapi BM25, k1=1.2 b=0.75, fixed literature defaults, chosen and
//           frozen BEFORE the eval; never tuned against it.
//
// Query classes (lexical/near/strict) are assigned by MEASURED token overlap
// with the gold memory, not by the dataset author's intent. Deterministic:
// byte-identical output per run (fixed LCG, no Date.now, stable sorts).
//
//   bun bench/recall-quality.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scoreMemories, words } from "../src/inject.ts";
import type { Memory } from "../src/memory.ts";
import { buildStore, MEMORIES, QUERIES } from "./recall-dataset.ts";

type Rank = (query: string, mems: Memory[]) => Memory[];

function asMemory(type: string, scope: string, content: string): Memory {
  return { ts: "2026-01-01T00:00:00.000Z", type, scope, content, status: "settled", file: "", index: 0 };
}

// naive: pre-stopword-filter shipped matcher, kept verbatim as the baseline.
const naive: Rank = (query, mems) => {
  const q = new Set(words(query));
  return mems
    .map((m) => {
      const hay = new Set(words(`${m.scope} ${m.type} ${m.content}`));
      let score = 0;
      for (const w of q) if (hay.has(w)) score++;
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.m);
};

const prod: Rank = (query, mems) => scoreMemories(query, mems, mems.length);

const BM25_K1 = 1.2;
const BM25_B = 0.75;

function bm25Rank(query: string, mems: Memory[]): Memory[] {
  const docs = mems.map((m) => words(`${m.scope} ${m.type} ${m.content}`));
  const N = docs.length || 1;
  const avgdl = docs.reduce((a, d) => a + d.length, 0) / N;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(words(query))];
  const scored = mems.map((m, i) => {
    const tf = new Map<string, number>();
    for (const t of docs[i]!) tf.set(t, (tf.get(t) ?? 0) + 1);
    const dl = docs[i]!.length;
    let s = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const dft = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - dft + 0.5) / (dft + 0.5));
      s += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl))));
    }
    return { m, s };
  });
  return scored.sort((a, b) => b.s - a.s).filter((x) => x.s > 0).map((x) => x.m);
}

// --- classification by measured overlap (anti-rigging rule 1) ------------------

// Stopwords ONLY for LABELING the class; every scorer runs as it ships.
const STOP = new Set(
  "a an and are at be but by can did do does for from had has have how i in into is it its me my no not of on or our so than that the their them then there these they this to us was we were what when where which who why will with you your run runs getting want needs right back yet also just still ever".split(" "),
);

const goldById = new Map(MEMORIES.map((m) => [m.id, m]));

function contentTokens(text: string): Set<string> {
  return new Set(words(text).filter((t) => !STOP.has(t)));
}

type QClass = "lexical" | "near" | "strict";
function measureClass(query: string, gold: string): QClass {
  const g = goldById.get(gold)!;
  const gt = contentTokens(`${g.scope} ${g.type} ${g.content}`);
  let shared = 0;
  for (const t of contentTokens(query)) if (gt.has(t)) shared++;
  return shared >= 2 ? "lexical" : shared === 1 ? "near" : "strict";
}

// --- metrics -------------------------------------------------------------------

interface Row {
  cls: QClass;
  n: number;
  naiveR3: number;
  prodR1: number;
  prodR3: number;
  bm25R1: number;
  bm25R3: number;
  prodRecovers: number; // naive missed top-3, prod landed it
  bm25Recovers: number; // prod missed top-3, bm25 landed it
  allMiss: number; // the residual vocabulary wall (prod AND bm25 miss)
  silent: number; // prod abstains entirely (no block injected — noise avoided)
}

function evaluate(size: number) {
  const store = buildStore(size);
  const mems = store.map((m) => asMemory(m.type, m.scope, m.content));
  const byClass = new Map<QClass, Row>();
  let noiseNaive = 0;
  let noiseProd = 0;
  for (const { q, gold } of QUERIES) {
    const goldMem = store.find((m) => m.id === gold);
    if (!goldMem) continue; // gold not in this store
    const cls = measureClass(q, gold);
    const r =
      byClass.get(cls) ??
      { cls, n: 0, naiveR3: 0, prodR1: 0, prodR3: 0, bm25R1: 0, bm25R3: 0, prodRecovers: 0, bm25Recovers: 0, allMiss: 0, silent: 0 };
    const nv = naive(q, mems);
    const p = prod(q, mems);
    const b = bm25Rank(q, mems);
    const in3 = (list: Memory[]) => {
      const i = list.findIndex((m) => m.content === goldMem.content);
      return i >= 0 && i < 3;
    };
    r.n++;
    if (in3(nv)) r.naiveR3++;
    if (p[0]?.content === goldMem.content) r.prodR1++;
    if (in3(p)) r.prodR3++;
    if (b[0]?.content === goldMem.content) r.bm25R1++;
    if (in3(b)) r.bm25R3++;
    if (!in3(nv) && in3(p)) r.prodRecovers++;
    if (!in3(p) && in3(b)) r.bm25Recovers++;
    if (!in3(p) && !in3(b)) r.allMiss++;
    if (p.length === 0) r.silent++;
    if (nv.length && nv[0]!.content !== goldMem.content) noiseNaive++;
    if (p.length && p[0]!.content !== goldMem.content) noiseProd++;
    byClass.set(cls, r);
  }
  return { rows: r2list(byClass), noiseNaive, noiseProd };
}

function r2list(m: Map<QClass, Row>): Row[] {
  return (["lexical", "near", "strict"] as QClass[]).map((c) => m.get(c)!).filter(Boolean);
}

const pct = (hit: number, n: number) => (n ? `${Math.round((hit / n) * 100)}%` : "-");

const SIZES = [50, 200, 500];
const lines: string[] = [];
lines.push("# Recall quality: shipped matcher vs alternatives (zero dependencies, zero models)");
lines.push("");
lines.push(
  `Dataset: ${MEMORIES.length} gold memories, ${QUERIES.length} queries; classes assigned by ` +
    "MEASURED token overlap with the gold (>=2 shared content tokens = lexical, 1 = near, " +
    "0 = strict paraphrase). k=3 mirrors the production injection limit. BM25 k1=1.2 b=0.75 " +
    "fixed before the eval. naive = previous shipped matcher; prod = current shipped " +
    "matcher (query-side stopword abstention, two-concept evidence gate for free-text " +
    "queries, IDF-weighted ranking).",
);
lines.push("");

for (const size of SIZES) {
  const { rows, noiseNaive, noiseProd } = evaluate(size);
  lines.push(`## Store size ${size}`);
  lines.push("");
  lines.push("| Query class | n | naive R@3 | prod R@1 | prod R@3 | BM25 R@1 | BM25 R@3 | prod recovers | BM25 recovers | all miss | prod abstains |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  const tot = { n: 0, nv: 0, p1: 0, p3: 0, b1: 0, b3: 0, pr: 0, rec: 0, miss: 0, sil: 0 };
  for (const r of rows) {
    tot.n += r.n; tot.nv += r.naiveR3; tot.p1 += r.prodR1; tot.p3 += r.prodR3;
    tot.b1 += r.bm25R1; tot.b3 += r.bm25R3; tot.pr += r.prodRecovers; tot.rec += r.bm25Recovers;
    tot.miss += r.allMiss; tot.sil += r.silent;
    lines.push(
      `| ${r.cls} | ${r.n} | ${pct(r.naiveR3, r.n)} | ${pct(r.prodR1, r.n)} | ${pct(r.prodR3, r.n)} | ` +
        `${pct(r.bm25R1, r.n)} | ${pct(r.bm25R3, r.n)} | ${r.prodRecovers} | ${r.bm25Recovers} | ${r.allMiss} | ${r.silent} |`,
    );
  }
  lines.push(
    `| **all** | ${tot.n} | ${pct(tot.nv, tot.n)} | ${pct(tot.p1, tot.n)} | ${pct(tot.p3, tot.n)} | ` +
      `${pct(tot.b1, tot.n)} | ${pct(tot.b3, tot.n)} | ${tot.pr} | ${tot.rec} | ${tot.miss} | ${tot.sil} |`,
  );
  lines.push("");
  lines.push(
    `Wrong-memory-first (top-1 noise): naive ${pct(noiseNaive, QUERIES.length)} -> ` +
      `prod ${pct(noiseProd, QUERIES.length)}.`,
  );
  lines.push("");
}

const out = lines.join("\n") + "\n";
process.stdout.write(out);
writeFileSync(join(import.meta.dir, "recall-results.md"), out);

#!/usr/bin/env bun
/**
 * symptom-fixer — DRY RUN ONLY. Reports how many pre-convention rows could be
 * rewritten to the #419 symptom-first shape ("When <symptom>: <fact>"), using
 * ONLY symptoms the store's own query ledger recorded. It never invents a
 * symptom and never writes.
 *
 * Grounding rule: a symptom is known only when a real session issued a query
 * (hits.logfmt terms=[...]) that shares >= 2 rare content tokens with the row
 * yet the row was NOT among the rows used. The query text IS the symptom.
 *
 * Replay gate (the consolidate discipline): a rewrite is promoted-eligible
 * only when (a) it would have entered the window for its grounding query, and
 * (b) for every ledger query where the OLD row made the window, the rewritten
 * row still makes it. Any loss vetoes the rewrite.
 *
 * Usage: bun scripts/symptom-fixer.ts [--store <dir>] [--window 5] [--limit N]
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scoreMemories } from "../src/recall/score.ts";
import { words } from "../src/recall/score.ts";
import { loadAll } from "../src/store/files/load.ts";
import { isActive } from "../src/store/model/predicates.ts";
import type { Memory } from "../src/store/model/memory.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const WINDOW = Number(arg("window") ?? 5);
const SHOW = Number(arg("limit") ?? 8);

const root =
  arg("store") ??
  process.env.OPENCODE_MEMORY_DIR ??
  join(process.env.HOME ?? "", ".config/opencode/memory");
process.env.OPENCODE_MEMORY_DIR = root;

const rows = (await loadAll()).filter(isActive);
const hitsFile = join(root, "hits.logfmt");
const events: { terms: string[]; mem: string[] }[] = [];
if (existsSync(hitsFile)) {
  for (const line of readFileSync(hitsFile, "utf8").split("\n")) {
    const terms = line.match(/terms=\[([^\]]*)\]/);
    const mem = line.match(/mem=\[([^\]]*)\]/);
    if (!terms || !mem) continue;
    const t = terms[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!t.length) continue;
    events.push({
      terms: t,
      mem: mem[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
}

const SYMPTOM_OK = /^when\b/i;
const lessons = rows.filter(
  (m) => m.type === "learning" || m.type === "blocker",
);
const withSymptom = lessons.filter((m) => SYMPTOM_OK.test(m.content));
const backlog = lessons.filter((m) => !SYMPTOM_OK.test(m.content));

// Rare-token overlap: query concepts the row's CONTENT actually carries.
const byTs = new Map(rows.map((m) => [m.ts, m]));
function contentWords(m: Memory): Set<string> {
  return new Set(words(m.content));
}
const cw = new Map(rows.map((m) => [m.ts, contentWords(m)]));

interface Proposal {
  row: Memory;
  symptom: string;
  shared: number;
  query: string[];
}
const proposals = new Map<string, Proposal>();
for (const ev of events) {
  for (const row of backlog) {
    if (ev.mem.includes(row.ts)) continue;
    const set = cw.get(row.ts)!;
    let shared = 0;
    for (const t of ev.terms)
      for (const w of words(t)) if (set.has(w)) shared++;
    if (shared < 2) continue;
    const prev = proposals.get(row.ts);
    if (!prev || shared > prev.shared) {
      proposals.set(row.ts, {
        row,
        symptom: ev.terms.join(" "),
        shared,
        query: ev.terms,
      });
    }
  }
}

// Replay: rewrite = prepend the grounded symptom clause; content otherwise
// byte-identical. (a) must enter the window for its grounding query;
// (b) must keep every ledger window the old row was in.
let eligible = 0;
let vetoed = 0;
const examples: string[] = [];
for (const p of proposals.values()) {
  const rewritten: Memory = {
    ...p.row,
    content: `When ${p.symptom}: ${p.row.content}`,
  };
  const swap = (m: Memory) => (m.ts === p.row.ts ? rewritten : m);
  const enters = scoreMemories(p.query.join(" "), rows.map(swap), WINDOW).some(
    (m) => m.ts === p.row.ts,
  );
  let keeps = true;
  for (const ev of events) {
    if (!ev.mem.includes(p.row.ts)) continue;
    const win = scoreMemories(ev.terms.join(" "), rows.map(swap), WINDOW);
    if (!win.some((m) => m.ts === p.row.ts)) {
      keeps = false;
      break;
    }
  }
  if (enters && keeps) {
    eligible++;
    if (examples.length < SHOW)
      examples.push(
        `  [${p.row.scope}/${p.row.type}] symptom="${p.symptom}"\n    was: ${p.row.content.slice(0, 110)}`,
      );
  } else vetoed++;
}

console.log(`store: ${root}`);
console.log(`active rows: ${rows.length}`);
console.log(
  `learning/blocker: ${lessons.length} — with symptom clause: ${withSymptom.length}, backlog: ${backlog.length}`,
);
console.log(`ledger events with terms: ${events.length}`);
console.log(
  `grounded proposals (>=2 shared rare tokens, row not used): ${proposals.size}`,
);
console.log(
  `replay-eligible (enters grounding window, loses no old window): ${eligible}`,
);
console.log(`vetoed by replay: ${vetoed}`);
if (examples.length) {
  console.log("\neligible examples:");
  console.log(examples.join("\n"));
}
console.log(
  "\nDRY RUN — no writes. Apply path = gated memory_update, one row at a time.",
);

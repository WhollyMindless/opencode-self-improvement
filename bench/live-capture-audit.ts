#!/usr/bin/env bun
// Live auto-capture audit — the "what actually happened" half of the dogfood
// experiment (turn autoCapture ON in the real config, run real tasks, then read
// the receipts). Nothing here is new methodology: it is #68's meta-lesson
// applied to the field. The rubric below is written BEFORE any captured row
// exists, so the thresholds cannot be tuned to the data they judge.
//
//   bun bench/live-capture-audit.ts <backupDir> [--after <storeDir>] [--show N]
//
// <backupDir> is the pre-experiment copy of the memory root (see the runbook).
// The store itself is never written — this tool only reads.
//
// Design notes:
//  - Row identity is ts + content hash. Capture stamps its own ts, so a row
//    added during the window cannot collide with a pre-existing one.
//  - "Did it fire at all" is answered from the EVIDENCE log, not from row
//    count: zero rows with zero capture_lag lines means the pipeline never ran
//    (the #78 failure class), while zero rows WITH capture_lag means it ran and
//    the gate or the model produced nothing. Those are different bugs.
//  - Duplication is measured against the PRE-EXISTING store only. A captured
//    row that restates something already stored is churn by definition, and
//    #42's rule says retrieval keeps landing on the older row anyway.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLine } from "../src/logfmt.ts";
import { containsSecret } from "../src/secrets.ts";
import { memoryRoot } from "../src/config.ts";

// ---- pre-registered rubric (locked before the run) -------------------------
// Mechanical checks are decided here; JUDGE rows are printed for the human and
// stay explicitly undecided, because "is this worth remembering" is not a
// predicate this tool owns.
const DUP_JACCARD = 0.5; // >= this against a pre-existing row = restatement
const RUBRIC = [
  "R1 FIRED      >=1 capture pass attempted (ev=capture_lag). 0 = dead pipeline (#78 class), and the run is a finding about observability, not about capture quality.",
  "R2 DUP        restatement rate vs pre-existing store <= 30%.",
  "R3 SECRETS    zero new rows containing credential shapes.",
  "R4 GATE       every promoted row has a matching gate pass (capture cannot bypass the moat).",
  "R5 SCOPE      no new row lands in a scope the repo did not already use (silent scope sprawl = injection churn).",
  "R6 FRONTIER   no captured row is status=open (planning surface is human-curated).",
  "R7 COST       model calls <= sessions x triggers, i.e. the 5-min cooldown held; compaction and idle stay separately countable.",
  "JUDGE-1       of the captured rows, how many would you keep? (precision — record the number, do not infer it)",
  "JUDGE-2       did any captured row change a LATER turn's behaviour for the worse?",
  "JUDGE-3       did capture make you change what you typed? (that is friction, and it is invisible to every other metric here)",
];

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.logfmt$/;

type Row = { file: string; line: number; ts: string; content: string; fields: Record<string, string> };

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
const id = (r: Row) => `${r.ts}|${hash(r.content)}`;

function loadRows(dir: string): Row[] {
  const out: Row[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => DAY_FILE.test(n));
  } catch {
    console.error(`no such store dir: ${dir}`);
    process.exit(1);
  }
  for (const n of names.sort()) {
    const text = readFileSync(join(dir, n), "utf8");
    text.split("\n").forEach((line, i) => {
      const f = parseLine(line);
      if (!f || typeof f.content !== "string" || typeof f.ts !== "string") return;
      out.push({ file: n, line: i + 1, ts: f.ts, content: f.content, fields: f as Record<string, string> });
    });
  }
  return out;
}

// Evidence lines across every day file, as raw strings (cheap, and ev= is a
// stable prefix to count on).
function loadEvidence(dir: string): string[] {
  const dirPath = join(dir, "evidence");
  const lines: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dirPath).filter((n) => n.endsWith(".logfmt"));
  } catch {
    return lines;
  }
  for (const n of names.sort()) lines.push(...readFileSync(join(dirPath, n), "utf8").split("\n"));
  return lines;
}

const evCount = (lines: string[]) => {
  const m = new Map<string, number>();
  for (const l of lines) {
    const hit = /(?:^|\s)ev=([A-Za-z0-9_]+)/.exec(l);
    if (hit) m.set(hit[1], (m.get(hit[1]) ?? 0) + 1);
  }
  return m;
};

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 3),
  );
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const before = argv[0];
if (!before) {
  console.error("usage: bun bench/live-capture-audit.ts <backupDir> [--after <storeDir>] [--show N]");
  process.exit(1);
}
const afterIdx = argv.indexOf("--after");
const after = afterIdx >= 0 ? argv[afterIdx + 1] : memoryRoot();
const showIdx = argv.indexOf("--show");
const SHOW = showIdx >= 0 ? Number(argv[showIdx + 1]) : 12;

const beforeRows = loadRows(before);
const afterRows = loadRows(after);
const beforeIds = new Set(beforeRows.map(id));
const afterIds = new Set(afterRows.map(id));
const added = afterRows.filter((r) => !beforeIds.has(id(r)));
const dropped = beforeRows.filter((r) => !afterIds.has(id(r)));

const evBefore = evCount(loadEvidence(before));
const evAfter = evCount(loadEvidence(after));
const evKeys = [...new Set([...evBefore.keys(), ...evAfter.keys()])].sort();
const evDelta = evKeys
  .map((k) => [k, (evAfter.get(k) ?? 0) - (evBefore.get(k) ?? 0)] as [string, number])
  .filter(([, d]) => d !== 0);

// Capture accounting. capture_lag is written once per capture PASS, whatever
// the model returned; auto_capture_<action> is written once per CANDIDATE.
const capLines = evDelta.filter(([k]) => k.startsWith("auto_capture") || k === "capture_lag");
const passes = evDelta.find(([k]) => k === "capture_lag")?.[1] ?? 0;
const promoted = added.filter((r) => (r.fields.tags ?? "").includes("auto-capture"));
const other = added.filter((r) => !(r.fields.tags ?? "").includes("auto-capture"));

// Duplication against the pre-existing store only.
const beforeTok = beforeRows
  .filter((r) => !r.fields.superseded_by)
  .map((r) => ({ r, t: tokens(r.content) }));
const dupReport = added.map((r) => {
  const t = tokens(r.content);
  let best = 0;
  let bestRow: Row | null = null;
  for (const c of beforeTok) {
    const j = jaccard(t, c.t);
    if (j > best) {
      best = j;
      bestRow = c.r;
    }
  }
  return { row: r, dup: best, dupOf: bestRow };
});

const scopesBefore = new Set(beforeRows.map((r) => (r.fields.scope ?? "").split("/")[0]));
const newScopes = [...new Set(added.map((r) => (r.fields.scope ?? "").split("/")[0]))].filter(
  (s) => s && !scopesBefore.has(s),
);
const secretRows = added.filter((r) => containsSecret(r.content) || containsSecret(r.fields.scope ?? ""));
const openRows = added.filter((r) => r.fields.status === "open");
const blocked = evDelta.find(([k]) => k === "write_blocked")?.[1] ?? 0;

// ---- report ----------------------------------------------------------------
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "n/a");
const bar = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

console.log(`before: ${before}`);
console.log(`after : ${after}`);
console.log(
  `rows    : ${beforeRows.length} -> ${afterRows.length}  (added ${added.length}, gone ${dropped.length})`,
);

bar("1. Did the pipeline run? (evidence deltas)");
if (!capLines.length) console.log("  (no auto_capture_* / capture_lag lines at all)");
for (const [k, d] of capLines) console.log(`  ${k.padEnd(34)} ${d > 0 ? "+" : ""}${d}`);
console.log(`  capture passes: ${passes}   candidates promoted: ${promoted.length}   blocked: ${blocked}`);

bar("2. All evidence deltas in the window");
for (const [k, d] of evDelta.sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(34)} ${d > 0 ? "+" : ""}${d}`);

bar(`3. New rows (${added.length}) — ${promoted.length} auto-captured, ${other.length} tool/human-authored`);
for (const { row, dup, dupOf } of dupReport.slice(0, SHOW)) {
  const tags = row.fields.tags ?? "";
  const isAuto = tags.includes("auto-capture");
  const flag = dup >= DUP_JACCARD ? ` \x1b[31mDUP ${(dup * 100) | 0}%\x1b[0m` : "";
  console.log(
    `  ${isAuto ? "\x1b[36mAUTO\x1b[0m" : "tool"} ${row.ts} ${row.fields.type ?? "?"}/${row.fields.scope ?? "?"} ` +
      `${row.content.length}ch${tags ? ` tags=${tags}` : ""}${flag}${row.fields.status === "open" ? " \x1b[33mOPEN\x1b[0m" : ""}`,
  );
  console.log(`       ${row.content.slice(0, 300).replace(/\s+/g, " ")}`);
  if (dupOf && dup >= DUP_JACCARD) console.log(`       overlaps ${dupOf.ts}: ${dupOf.content.slice(0, 160).replace(/\s+/g, " ")}`);
}
if (added.length > SHOW) console.log(`  … ${added.length - SHOW} more (raise with --show)`);

bar("4. Rubric (locked before the run)");
for (const r of RUBRIC) console.log(`  ${r}`);
// R2-R6 judge CAPTURE, so they are computed over auto-captured rows only: the
// window always contains deliberate tool writes too (including the ones that
// set this experiment up), and counting them as capture findings is a false
// positive this file shipped with on its first live run.
const autoDup = dupReport.filter((d) => d.row.fields.tags?.includes("auto-capture"));
const autoSecrets = secretRows.filter((r) => (r.fields.tags ?? "").includes("auto-capture"));
const autoOpen = openRows.filter((r) => (r.fields.tags ?? "").includes("auto-capture"));
const autoScopes = newScopes.filter((s) =>
  promoted.some((r) => (r.fields.scope ?? "").split("/")[0] === s),
);
const dupRate = autoDup.filter((d) => d.dup >= DUP_JACCARD).length;
const verdicts: [string, string][] = [
  ["R1 FIRED", passes >= 1 ? "PASS" : "FAIL — pipeline never ran; that is the finding"],
  ["R2 DUP", `${dupRate}/${autoDup.length} auto rows (${pct(dupRate, autoDup.length)}) restate a pre-existing row`],
  ["R3 SECRETS", autoSecrets.length === 0 ? "PASS" : `FAIL — ${autoSecrets.length} auto row(s) carry credential shapes`],
  ["R4 GATE", `${promoted.length} auto rows vs ${blocked} write_blocked lines in window — read the evidence, do not assume`],
  ["R5 SCOPE", autoScopes.length === 0 ? "PASS" : `NEW SCOPES from capture: ${autoScopes.join(", ")}`],
  ["R6 FRONTIER", autoOpen.length === 0 ? "PASS" : `FAIL — ${autoOpen.length} captured row(s) are open/frontier`],
  ["R7 COST", `${passes} passes — compare against sessions x triggers`],
];
if (added.length > promoted.length)
  console.log(
    `  (R2-R6 count the ${promoted.length} auto-captured rows only; ${added.length - promoted.length} tool/human row(s) in this window are not capture's doing)\n`,
  );
for (const [k, v] of verdicts) console.log(`  ${k.padEnd(12)} ${v}`);

bar("5. Churn accounting");
const kb = (p: string) => {
  try {
    return `${Math.round(readFileSync(p).length / 1024)} KB`;
  } catch {
    return "—";
  }
};
console.log(`  day file today        : ${kb(join(after, new Date().toISOString().slice(0, 10) + ".logfmt"))}`);
console.log(`  hits ledger           : ${kb(join(after, "hits.logfmt"))}`);
console.log(`  neverRetrieved share  : see memory_status (store.neverRetrieved / active)`);
console.log(`\nreset: rsync -a --delete ${before}/ ${after} (stop the service first, then restart)`);

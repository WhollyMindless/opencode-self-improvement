#!/usr/bin/env bun
/**
 * symptom-fixer — repair the pre-#419 lesson backlog from the store's own
 * query ledger. Default: DRY RUN. `--apply`: gated writes.
 *
 * Grounding rule: a symptom is known ONLY when a real session issued a query
 * (hits.logfmt terms=[...]) that shares >= 2 rare content tokens with the row
 * yet the row was NOT among the rows used. The query text IS the symptom —
 * never invented, never reworded.
 *
 * Repair shape (kw-only, decided 2026-11-17): the symptom words are added to
 * the row's kw — indexed, never injected. Content stays byte-identical, so a
 * word-bag never becomes displayed prose and no row's meaning can drift.
 * Retrieval still improves: kw rides every scorer's haystack, and the words
 * that enter are exactly the ones the content lacked (new vocabulary only).
 *
 * Replay gate (the consolidate discipline): a rewrite is applied only when
 * (a) it would have entered the window for its grounding query, and (b) for
 * every ledger query where the OLD row made the window, the rewritten row
 * still makes it. Any loss vetoes the rewrite.
 *
 * Apply path: one row at a time under the store's batch lock, through the
 * real 4-gate write pipeline with supersedesTs set — the memory_update
 * contract. The successor inherits the target's repo stamp (the fixer forges
 * no identity), the old row is superseded, never edited, and markSuperseded
 * snapshots the day-file first: memory_undo stays the recovery path.
 * OPENCODE_MEMORY_SYMPTOM=off is the #423 escape hatch for automation
 * holding the pre-convention backlog: content is unchanged here, so the
 * new-prose rule does not apply.
 *
 * Usage: bun scripts/symptom-fixer.ts [--apply] [--store <dir>]
 *        [--window 5] [--limit N]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QUERY_STOPWORDS, scoreMemories, words } from "../src/recall/score.ts";
import { MAX_KEYWORDS, type Memory } from "../src/store/model/memory.ts";
import { isActive } from "../src/store/model/predicates.ts";
import { loadAll } from "../src/store/files/load.ts";
import { markSuperseded } from "../src/store/files/supersede.ts";
import { withStoreBatch } from "../src/store/lock.ts";
import { memoryRoot } from "../src/core/config/paths.ts";
import { nonCaptureTags } from "../src/core/guidance.ts";
import { runWriteGate } from "../src/gate/gate.ts";

// The rule shapes NEW lesson prose. This script never changes content, so
// the documented automation escape hatch (#423) is the correct setting —
// hard-set, NOT ??=: an inherited on-value would block every --apply write,
// because backlog content is pre-convention by definition.
process.env.OPENCODE_MEMORY_SYMPTOM = "off";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");
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
const cw = new Map(rows.map((m) => [m.ts, new Set(words(m.content))]));

/**
 * The kw-only repair: symptom words the row's vocabulary LACKS (words already
 * in content or kw add no retrieval value), minus query grammar, capped at
 * the schema's keyword ceiling.
 */
function mergeSymptomKw(row: Memory, symptomQuery: string[]): string[] {
  const merged = [...(row.kw ?? [])];
  const known = new Set([
    ...cw.get(row.ts)!,
    ...merged.map((k) => k.toLowerCase()),
  ]);
  outer: for (const t of symptomQuery) {
    for (const w of words(t)) {
      if (merged.length >= MAX_KEYWORDS) break outer;
      if (QUERY_STOPWORDS.has(w) || known.has(w)) continue;
      known.add(w);
      merged.push(w);
    }
  }
  return merged;
}

interface Proposal {
  row: Memory;
  symptom: string;
  query: string[];
  mergedKw: string[];
  shared: number;
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
        query: ev.terms,
        mergedKw: mergeSymptomKw(row, ev.terms),
        shared,
      });
    }
  }
}

// Replay: the rewritten row is the SAME row with merged kw. (a) must enter
// the window for its grounding query; (b) must keep every ledger window the
// old row was in. A proposal that adds no new keyword cannot change any
// window — it is dropped here, honestly, as no-op.
//
// BATCH semantics (#424 review): repairs are applied together, so replay is
// CUMULATIVE — each proposal is evaluated against the store with all
// previously accepted rewrites already in place (strongest grounding first),
// and the accepted set is then re-verified as a whole against the final
// store, dropping proposals a competing repair invalidated, until stable.
// Per-proposal replay against the ORIGINAL store was the first version's
// mistake: two repairs could each pass alone and then evict each other.
const rankedProposals = [...proposals.values()].sort(
  (a, b) => b.shared - a.shared,
);
let working = rows;
const eligible: Proposal[] = [];
let vetoed = 0;
let noOp = 0;
for (const p of rankedProposals) {
  if (p.mergedKw.length === (p.row.kw?.length ?? 0)) {
    noOp++;
    continue;
  }
  const rewritten: Memory = { ...p.row, kw: p.mergedKw };
  const swap = (m: Memory) => (m.ts === p.row.ts ? rewritten : m);
  const enters = scoreMemories(
    p.query.join(" "),
    working.map(swap),
    WINDOW,
  ).some((m) => m.ts === p.row.ts);
  let keeps = true;
  for (const ev of events) {
    if (!ev.mem.includes(p.row.ts)) continue;
    const win = scoreMemories(ev.terms.join(" "), working.map(swap), WINDOW);
    if (!win.some((m) => m.ts === p.row.ts)) {
      keeps = false;
      break;
    }
  }
  if (enters && keeps) {
    eligible.push(p);
    working = working.map(swap);
  } else vetoed++;
}

// Final batch verification: score the FULLY rewritten store; a survivor that
// no longer enters its grounding window (or lost an old window to a sibling
// repair) is removed, and the store is re-scored without it. Conflicts are
// rare, so this normally stabilizes in one pass; the loop is bounded.
let batchDropped = 0;
for (let pass = 0; pass < 4; pass++) {
  const finalStore = rows.map((m) => {
    const p = eligible.find((q) => q.row.ts === m.ts);
    return p ? { ...p.row, kw: p.mergedKw } : m;
  });
  const lost = eligible.filter((p) => {
    if (
      !scoreMemories(p.query.join(" "), finalStore, WINDOW).some(
        (m) => m.ts === p.row.ts,
      )
    )
      return true;
    for (const ev of events) {
      if (!ev.mem.includes(p.row.ts)) continue;
      if (
        !scoreMemories(ev.terms.join(" "), finalStore, WINDOW).some(
          (m) => m.ts === p.row.ts,
        )
      )
        return true;
    }
    return false;
  });
  if (!lost.length) break;
  batchDropped += lost.length;
  const lostTs = new Set(lost.map((p) => p.row.ts));
  for (let i = eligible.length - 1; i >= 0; i--)
    if (lostTs.has(eligible[i]!.row.ts)) eligible.splice(i, 1);
}

console.log(`store: ${root}  mode: ${APPLY ? "APPLY" : "dry-run"}`);
console.log(`active rows: ${rows.length}`);
console.log(
  `learning/blocker: ${lessons.length} — with symptom clause: ${withSymptom.length}, backlog: ${backlog.length}`,
);
console.log(`ledger events with terms: ${events.length}`);
console.log(
  `grounded proposals (>=2 shared rare tokens, row not used): ${proposals.size}`,
);
console.log(`no new keyword vocabulary (no-op, dropped): ${noOp}`);
console.log(`replay-eligible (cumulative, batch-verified): ${eligible.length}`);
console.log(`vetoed by replay: ${vetoed}`);
if (batchDropped)
  console.log(`dropped by final batch verification: ${batchDropped}`);

if (!APPLY) {
  const examples = eligible
    .slice(0, SHOW)
    .map(
      (p) =>
        `  [${p.row.scope}/${p.row.type}] +kw=${JSON.stringify(
          p.mergedKw.slice(p.row.kw?.length ?? 0),
        )}\n    was: ${p.row.content.slice(0, 100)}`,
    );
  if (examples.length) {
    console.log("\neligible examples (kw-only; content byte-identical):");
    console.log(examples.join("\n"));
  }
  console.log(
    "\nDRY RUN — no writes. Re-run with --apply to write through the gated update path.",
  );
} else {
  let applied = 0;
  const failures: string[] = [];
  for (const p of eligible) {
    const verdict = await withStoreBatch(
      memoryRoot(),
      "fixer-order",
      async () => {
        const fresh = await loadAll();
        const target = fresh.find((m) => m.ts === p.row.ts);
        if (!target || !isActive(target)) return "target-gone";
        if (target.content !== p.row.content)
          return "drift (content changed since replay)";
        // A concurrent kw edit between scan and apply must not be clobbered
        // by stale mergedKw.
        if (
          (target.kw ?? []).join("\u0000") !== (p.row.kw ?? []).join("\u0000")
        )
          return "drift (kw changed since replay)";
        // Revalidate against the CURRENT store under the lock: earlier
        // applied repairs are already on disk, so this prices the real
        // remaining batch, not the snapshot the replay saw (#424 review).
        const probe = scoreMemories(
          p.query.join(" "),
          fresh.map((m) =>
            m.ts === target.ts ? { ...target, kw: p.mergedKw } : m,
          ),
          WINDOW,
        );
        if (!probe.some((m) => m.ts === target.ts))
          return "stale (no longer enters the grounding window under the current store)";
        const out = await runWriteGate(
          {
            type: target.type,
            scope: target.scope,
            content: target.content,
            kw: p.mergedKw,
            tags: nonCaptureTags(target.tags),
            issue: target.issue,
            status: target.status ?? "settled",
            repo: target.repo ?? "global",
            repoPath: target.repoPath,
          },
          {
            liveRoot: memoryRoot(),
            evidenceCalls: [],
            hasGateCheck: true,
            trusted: true,
            supersedesTs: target.ts,
          },
        );
        if (out.action === "promoted") {
          const ok = await markSuperseded(target.ts, {
            superseded_by: out.ts,
            reason: "fixer_kw_symptom",
          });
          return ok
            ? "applied"
            : `PARTIAL: replacement ${out.ts} IS on disk; supersede of ${target.ts} failed — re-run reports the duplicate`;
        }
        return `blocked:${out.action === "blocked" ? out.reason : out.action}`;
      },
    );
    if (verdict === "applied") applied++;
    else failures.push(`${p.row.ts} [${p.row.scope}/${p.row.type}] ${verdict}`);
  }
  console.log(
    `\napplied (gated update, supersede-first, snapshot-backed): ${applied}`,
  );
  if (failures.length) {
    console.log(`not applied (${failures.length}):`);
    for (const f of failures.slice(0, SHOW)) console.log(`  ${f}`);
  }
}

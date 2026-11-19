// Replays the window-dedup rule over the LIVE store and asks what the shipped
// guidance actually claims: at OPENCODE_MEMORY_DEDUP=0.8, is every suppressed
// pair a near-copy?
//
// Why a replay and not a fixture: the rule's vocabulary changed in fc59b84. It
// scored haystack(), which includes the row's own `type` and `scope`, so two
// rows of one scope shared two free tokens and short rows looked like copies of
// each other. Guidance written against that vocabulary needs re-reading against
// the new one, and the store's own scopes are the only honest input, because
// the failure mode WAS scope metadata.
//
// Three arms, because "the old rule" and "the old vocabulary" are different
// questions and conflating them hides the answer:
//
//   A  contentTokens + the shipped guards  — what runs today
//   B  haystack + the shipped guards       — isolates the vocabulary change
//   C  haystack, NO guards                 — the rule that shipped before
//                                          fc59b84: same scope and Jaccard,
//                                          nothing else
//
// A pair is a SUPPRESSION candidate when an arm reaches the threshold: if both
// rows ever occupy one recall window together, one of them is hidden.
//
// Scan set: the repository's rows PLUS rows with no repo stamp, because a
// repo-scoped read sees both in one window (see src/recall/relevant.ts). Rows
// stamped for another repository are excluded — they never share this window.
//
// "Near-identical" is not asserted by this runner. Every A-arm candidate is
// printed in full, so the claim is checked by reading the pairs.
//
// Reads the live store. Not a CI job, and not a fixture: results drift as the
// store grows, so any number quoted from it needs its date.
import { existsSync } from "node:fs";
import { loadAll } from "../../src/store/files/load.ts";
import { isActive } from "../../src/store/model/predicates.ts";
import { haystack, words } from "../../src/recall/score.ts";
import {
  DEFAULT_THRESHOLD,
  MIN_CONTENT,
  POLARITY_WORDS,
  contentTokens,
  droppedChunks,
  jaccard,
} from "../../src/recall/dedupe.ts";
import { resolveRepo } from "../../src/identity/repokey.ts";
import type { Memory } from "../../src/store/model/memory.ts";

const flags = process.argv.slice(2);
const HISTORY = flags.includes("--all");
const REPO_ONLY = flags.includes("--repo-only");
// The first non-flag argument is the repository path. Taking argv[2] blindly
// means `--all` becomes the path, and resolveRepo happily hashes a string that
// is not a directory: the scan then finds nothing and reports a clean zero.
const repoRoot = flags.find((a) => !a.startsWith("-")) ?? process.cwd();
if (!existsSync(repoRoot)) {
  console.error(`not a readable path: ${repoRoot}`);
  process.exit(2);
}
const check = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "--git-dir"], {
  stdout: "pipe",
  stderr: "ignore",
});
if (check.exitCode !== 0) {
  console.error(`${repoRoot} is not a git repository — no repo key to scan.`);
  process.exit(2);
}
const scopeKey = resolveRepo(repoRoot).key;

const loaded = await loadAll();
const rows = loaded.filter((m) => {
  if (!HISTORY && !isActive(m)) return false;
  return REPO_ONLY ? m.repo === scopeKey : m.repo === scopeKey || !m.repo;
});

// Caches are keyed by ARRAY INDEX, never by `m.ts`: ts is not unique. Four ts
// values cover eight rows in a real store, and a ts-keyed cache makes a row
// score against itself — a phantom Jaccard of 1.000 for a pair that is nothing
// of the kind.
const tok = rows.map((m) => contentTokens(m));
const leg = rows.map((m) => new Set(words(haystack(m))));
/**
 * The tokenizer as it shipped before `fc59b84`, vendored from
 * `git show 3ff96ef:src/recall/score.ts`. Arm C answers "what did the old rule
 * do", and today's `words()` emits one token the old one never did — the whole
 * identifier form — which shifts every short-row score by one token in both the
 * numerator and the denominator. A published number about the old rule has to
 * be computed with the old tokenizer, so it is carried here rather than
 * approximated with the current one.
 */
function legacyWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 2);
}
const legOld = rows.map((m) => new Set(legacyWords(haystack(m))));
// Element-wise, exactly as the shipped rule compares them, so no separator
// choice can matter.
const chunk = rows.map((m) => droppedChunks(m.content));
const hasPol = (s: Set<string>): boolean => {
  for (const w of s) if (POLARITY_WORDS.has(w)) return true;
  return false;
};
const pol = tok.map((s) => hasPol(s));
const sameChunks = (a: number, b: number): boolean => {
  const x = chunk[a]!;
  const y = chunk[b]!;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};

const byScope = new Map<string, number[]>();
rows.forEach((m, i) => {
  const k = m.scope ?? "";
  const list = byScope.get(k) ?? [];
  list.push(i);
  byScope.set(k, list);
});

interface Pair {
  scope: string;
  score: number;
  ai: number;
  bi: number;
  a: Memory;
  b: Memory;
}
const collect = (
  tokens: Array<Set<string>>,
  guards: boolean,
): { hits: Pair[]; max: number } => {
  const hits: Pair[] = [];
  let max = 0;
  for (const [scope, list] of byScope) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i]!;
        const y = list[j]!;
        if (guards) {
          if (tok[x]!.size < MIN_CONTENT || tok[y]!.size < MIN_CONTENT)
            continue;
          if (pol[x] !== pol[y]) continue;
          if (!sameChunks(x, y)) continue;
        }
        const s = jaccard(tokens[x]!, tokens[y]!);
        if (s > max) max = s;
        if (s >= DEFAULT_THRESHOLD)
          hits.push({
            scope,
            score: s,
            ai: x,
            bi: y,
            a: rows[x]!,
            b: rows[y]!,
          });
      }
    }
  }
  hits.sort((p, q) => q.score - p.score || p.ai - q.ai || p.bi - q.bi);
  return { hits, max };
};

const A = collect(tok, true);
const B = collect(leg, true);
const C = collect(legOld, false);

// Which guard is load-bearing: every pair the old rule would have suppressed
// and today's rule does not, attributed to the first guard that stops it.
// Keyed by index pair — `m.ts` is not unique, so a ts key would compare the
// wrong rows against each other.
const aKeys = new Set(A.hits.map((h) => `${h.ai}|${h.bi}`));
const attribution = { floor: 0, polarity: 0, chunks: 0 };
for (const list of byScope.values()) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const x = list[i]!;
      const y = list[j]!;
      if (jaccard(leg[x]!, leg[y]!) < DEFAULT_THRESHOLD) continue;
      if (aKeys.has(`${x}|${y}`)) continue;
      if (tok[x]!.size < MIN_CONTENT || tok[y]!.size < MIN_CONTENT)
        attribution.floor++;
      else if (pol[x] !== pol[y]) attribution.polarity++;
      else if (!sameChunks(x, y)) attribution.chunks++;
    }
  }
}

const label = REPO_ONLY ? scopeKey : `${scopeKey} + global (no repo stamp)`;
console.log(
  `scan set ${label}   rows ${rows.length}${HISTORY ? " (history included)" : " (active only)"}   scopes ${byScope.size}\n` +
    `A  contentTokens + shipped guards : ${A.hits.length} candidates >= ${DEFAULT_THRESHOLD}   max ${A.max.toFixed(3)}\n` +
    `B  haystack + shipped guards     : ${B.hits.length} candidates >= ${DEFAULT_THRESHOLD}   max ${B.max.toFixed(3)}\n` +
    `C  pre-fc59b84 tokenizer, no guards (replayed): ${C.hits.length} candidates >= ${DEFAULT_THRESHOLD}   max ${C.max.toFixed(3)}\n` +
    `   of C's candidates, blocked today by: floor ${attribution.floor}, polarity ${attribution.polarity}, dropped-chunks ${attribution.chunks}\n`,
);

if (A.hits.length) {
  // With --all the candidate set includes supersession history, and the two
  // cases mean opposite things: a pair of two ACTIVE rows is the pass having
  // real work to do (or a false positive), while a pair with a superseded side
  // is a row the write gate already replaced.
  const bothActive = A.hits.filter(
    (h) => isActive(h.a) && isActive(h.b),
  ).length;
  console.log(
    `A-arm: ${bothActive} candidate(s) with BOTH rows active, ${A.hits.length - bothActive} with a superseded side\n`,
  );
  console.log("A-arm candidates with both rows active, in full — read them:");
  for (const h of A.hits) {
    if (!isActive(h.a) || !isActive(h.b)) continue;
    const where = (m: Memory): string => (m.repo ? "repo" : "GLOBAL");
    console.log(
      `--- ${h.score.toFixed(3)}  scope ${h.scope}  [${where(h.a)} vs ${where(h.b)}]`,
    );
    console.log(`  A: ${h.a.content.slice(0, 160).replace(/\n/g, " ")}`);
    console.log(`  B: ${h.b.content.slice(0, 160).replace(/\n/g, " ")}`);
  }
} else {
  console.log(
    "A: no candidate. The shipped pass has nothing to suppress here.",
  );
}

if (C.hits.length) {
  const bySc = new Map<string, number>();
  for (const h of C.hits) bySc.set(h.scope, (bySc.get(h.scope) ?? 0) + 1);
  console.log(
    `\nC: the old eligibility would have suppressed ${C.hits.length} pairs, concentrated in:`,
  );
  for (const [s, n] of [...bySc].sort((a, b) => b[1] - a[1]).slice(0, 6))
    console.log(`   ${String(n).padStart(4)}x  scope ${s}`);
  // Whether each C candidate is a content near-copy or a METADATA near-copy:
  // the old vocabulary scored `type` and `scope`, so a pair can reach the
  // threshold on shared metadata while its content stays distinct.
  const metaDriven = C.hits.filter(
    (h) => jaccard(tok[h.ai]!, tok[h.bi]!) < DEFAULT_THRESHOLD,
  ).length;
  // The precondition fc59b84 removed is a scope whose tokens stand in for
  // content. words() splits on ANY delimiter — underscore, hyphen, space, dot,
  // slash — so counting underscores is not the test and a store with none of
  // them is not exempt. Count the scopes that actually yield more than the
  // whole-scope token, then demonstrate the mechanism on pairs this store does
  // not contain, so the claim is shown rather than inferred from an absence.
  const standIn = [...byScope.keys()].filter((s) => words(s).length > 1);
  console.log(
    `   metadata-driven (content-only Jaccard below ${DEFAULT_THRESHOLD}): ${metaDriven} of ${C.hits.length}\n` +
      `   scopes standing in for content (more than one word under any delimiter): ${standIn.length}${
        standIn.length ? ` e.g. ${standIn.slice(0, 3).join(", ")}` : ""
      }`,
  );
  // The precondition is scope vocabulary DOMINATING row content, not any one
  // delimiter, so the probe walks the crossing rather than picking scopes by
  // eye: two unrelated one-word rows sharing one scope, scored on the old
  // vocabulary. Content alone is 0.000 for these, so the shipped rule keeps
  // both at every length below.
  const PROBE_WORDS = [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
  ];
  const probe = (scope: string): [number, number] => {
    const base = {
      ts: "2026-01-01T00:00:00.000Z",
      type: "context",
      scope,
      status: "settled",
      file: "",
      index: 0,
    };
    const a = { ...base, content: "plum" } as Memory;
    const b = { ...base, content: "lime" } as Memory;
    return [
      jaccard(
        new Set(legacyWords(haystack(a))),
        new Set(legacyWords(haystack(b))),
      ),
      jaccard(new Set(words(haystack(a))), new Set(words(haystack(b)))),
    ];
  };
  for (const n of [4, 5, 6, 7, 8]) {
    const [oldScore, todayScore] = probe(PROBE_WORDS.slice(0, n).join("-"));
    console.log(
      `   probe ${n} distinct scope words + two unrelated one-word rows: old tokenizer ${oldScore.toFixed(
        3,
      )} ${
        oldScore >= DEFAULT_THRESHOLD ? "SUPPRESSES them" : "keeps both"
      } (today's tokenizer would say ${todayScore.toFixed(
        3,
      )}) (content 0.000, so shipped keeps both)`,
    );
  }
  let shown = 0;
  for (const h of C.hits) {
    const c = jaccard(tok[h.ai]!, tok[h.bi]!);
    if (c >= DEFAULT_THRESHOLD) continue;
    if (shown++ >= 5) break;
    console.log(
      `     ${h.score.toFixed(3)} metadata / ${c.toFixed(3)} content  scope ${h.scope}  ${h.a.content.slice(0, 70).replace(/\n/g, " ")}`,
    );
  }
}

// score — split from src/inject.ts (#168 domain restructure). Declaration bodies are unchanged.
import { loadAll } from "../store/files/load.ts";
import { type Memory } from "../store/model/memory.ts";
import { isInjectable } from "../store/model/predicates.ts";
import { cmpTs } from "../core/cmp-ts.ts";
import { type UseSignals, useBoost } from "./relevant.ts";

/**
 * The matcher's tokenizer. Identifier-aware (#409, RESULTS §15): the shipped
 * version kept `_` inside a token and never touched case, so `getUserAccount`,
 * `get_user_account` and `get-user-account` were three unrelated tokens.
 *
 * Each identifier (a maximal run of letters, digits, `_`, `.`, `-`, `/`) emits
 * TWO granularities: the whole identifier lower-cased, and its segments split
 * at camelCase boundaries and separators. The whole form is what preserves the
 * exact match the shipped tokenizer had — `db_id` and `OPENCODE_MEMORY_DIR`
 * stay single tokens, and an authored keyword stored fused (`memoryrecallthreshold`)
 * still matches the query that cites it. Dropping the whole form is the
 * regression that made the first version of this change abstain on `db_id`
 * queries and break the #40 vocabulary bridge for camelCase aliases. The
 * segments are what make the styles match each other: a query typed
 * `getUserAccount` shares `get`, `user`, `account` with a row written
 * `get_user_account`.
 *
 * The scan is one linear pass with no backtracking: a 4,000-character row of
 * adversarial text costs microseconds, not milliseconds.
 *
 * Measured on the bench fixture at the SHIPPED configuration (`kw` indexed,
 * store 200 and 48): lexical R@1 stays 98% and top-1 noise stays 6% — the
 * fixture's queries never spell the same identifier two ways, so this is a
 * correctness fix the fixture cannot price, not a measured win. The no-keyword
 * arm moves (lexical R@1 98% -> 100%), but production indexes keywords.
 */
export function words(text: string): string[] {
  const out: string[] = [];
  const ids = text.match(/[A-Za-z0-9_.\-/]+/g);
  if (!ids) return out;
  for (const id of ids) {
    // Sentence punctuation is not part of the identifier: a row ending
    // `Join on db_id.` must still carry the token `db_id`. Underscore stays
    // (the shipped tokenizer kept it), and interior separators stay — only
    // the edges are trimmed.
    const whole = id.replace(/^[./-]+|[./-]+$/g, "").toLowerCase();
    if (whole.length > 2) out.push(whole);
    let cur = "";
    const flush = () => {
      if (cur.length > 2) {
        const seg = cur.toLowerCase();
        if (seg !== whole) out.push(seg); // single words emit once, as before
      }
      cur = "";
    };
    for (let i = 0; i < id.length; i++) {
      const ch = id[i]!;
      const c = id.charCodeAt(i);
      const isUpper = c >= 65 && c <= 90;
      const isLower = c >= 97 && c <= 122;
      const isDigit = c >= 48 && c <= 57;
      if (!isUpper && !isLower && !isDigit) {
        flush(); // `_`, `.`, `-`, `/` end a segment
        continue;
      }
      if (isUpper && cur) {
        const prev = cur.charCodeAt(cur.length - 1)!;
        const next = i + 1 < id.length ? id.charCodeAt(i + 1)! : 0;
        const boundary =
          (prev >= 97 && prev <= 122) || // getUser -> get | User
          (prev >= 65 && prev <= 90 && next >= 97 && next <= 122); // HTTPServer -> HTTP | Server
        if (boundary) flush();
      }
      cur += ch;
    }
    flush();
  }
  return out;
}

// Query-side stopwords: bag-of-words scoring has no IDF, so "the/what/how"
// match a large share of every memory and let a query with ZERO content
// overlap rank. Dropping them makes the matcher abstain — inject nothing — when the vocabulary
// genuinely has nothing in common, instead of injecting confident noise.
// Memory-side tokens are never filtered: a memory stating "the" must not
// gain or lose rank from it, only queries drive matching.
export const QUERY_STOPWORDS = new Set(
  "a an and are at be but by can did do does for from had has have how i in into is it its me my no not of on or our so than that the their them then there these they this to us was we were what when where which who why will with you your run runs getting want needs right back yet also just still ever should would could might may must shall ought nothing something anything everything thing things".split(
    " ",
  ),
);

// A free-text prompt long enough to carry >= this many distinct concepts (see
// queryConcepts: an identifier and its segments count once) must
// share >= 2 distinct concepts with a memory to inject: with a long query
// vocabulary, one shared token is near-certain coincidence (a live store hit
// injected a git memory on the word "should", df=1). A keyword-length query
// is a deliberate search — one shared concept suffices. memory_recall and the
// contextual pull keep single-overlap matches reachable; injection just stays
// quiet unless the vocabulary genuinely agrees twice.
const LONG_QUERY_TOKENS = 3;

// Production relevance ranking. Candidates must clear the concept-overlap
// gate, then rank by Robertson-IF of the shared tokens (rare concepts beat
// piles of common ones — the same idf form the bench's BM25 row uses).
// Ties break deliberately, in this order: open threads first (a pinned frontier
// row beats an equal-scoring settled one — that is what the frontier is for),
// then rows the use ledger has actually retrieved, most-recently-used first
// (#42 reinforcement), then the newer row (#40 item 2: between two equally
// relevant facts, the one stating what is true NOW is the better guess;
// epoch-freeze-safe because ts never changes for a given row).
// The haystack is `scope + type + content + kw`, where `kw` are the
// author-supplied aliases indexed at write time (#40 item 3, the vocabulary
// bridge for the bench's strict-paraphrase wall). Keywords are indexed, never
// rendered, so they cannot change what a block costs.
// Exported for bench/runners/recall-quality.ts — the benchmark measures the shipped
// matcher.
//
// Superseded rows are dropped HERE, not only by the callers. Every model-facing
// sink already passes isInjectable() rows, but a scorer that can be handed a raw
// loadAll() result must not be the one place a retired memory leaks back into
// an injected block (#43 item 1: forbidden hits). The drop also keeps a
// retired row from diluting the document frequencies the ranking depends on.
/**
 * The query's distinct concepts. `words()` emits each identifier at two
 * granularities — whole form plus camel/separator segments — and the admission
 * gate must count ONE concept per identifier, not one per token: a query
 * citing `memoryRecallThreshold` is a single concept even though it emits
 * four tokens (review #417: the flat token count raised needShared from 1 to
 * 2 and a row carrying that keyword fused in `kw` stopped matching its own
 * keyword). Identifiers sharing any token — the same concept spelled two ways
 * in one query — merge into one group.
 */
function queryConcepts(term: string): string[][] {
  const groups: string[][] = [];
  for (const id of term.match(/[A-Za-z0-9_.\-/]+/g) ?? []) {
    const toks = words(id).filter((t) => !QUERY_STOPWORDS.has(t));
    if (!toks.length) continue;
    let hit = -1;
    for (let g = 0; g < groups.length && hit === -1; g++)
      if (toks.some((t) => groups[g]!.includes(t))) hit = g;
    if (hit === -1) groups.push([...new Set(toks)]);
    else groups[hit] = [...new Set([...groups[hit]!, ...toks])];
  }
  return groups;
}

export function scoreMemories(
  term: string,
  mems: Memory[],
  limit: number,
  use?: UseSignals,
): Memory[] {
  const live = mems.filter(isInjectable);
  const concepts = queryConcepts(term);
  if (!concepts.length) return [];
  const needShared = concepts.length >= LONG_QUERY_TOKENS ? 2 : 1;
  const hays = live.map((m) => new Set(words(haystack(m))));
  const df = new Map<string, number>();
  for (const h of hays) for (const t of h) df.set(t, (df.get(t) ?? 0) + 1);
  const n = live.length || 1;
  return live
    .map((m, i) => {
      let shared = 0;
      let score = 0;
      for (const c of concepts) {
        // A concept contributes at most its best-matching token's idf: the
        // whole form and its segments are one concept, not four independent
        // agreements, so a row cannot out-rank another by spelling the same
        // identifier in more granularities.
        let best = 0;
        for (const w of c)
          if (hays[i]!.has(w)) {
            const d = df.get(w) ?? 0;
            best = Math.max(best, Math.log(1 + (n - d + 0.5) / (d + 0.5)));
          }
        if (best > 0) {
          shared++;
          score += best;
        }
      }
      return { m, shared, score };
    })
    .filter((s) => s.shared >= needShared)
    .sort(
      (a, b) =>
        b.score - a.score ||
        openRank(b.m) - openRank(a.m) ||
        useBoost(b.m, use) - useBoost(a.m, use) ||
        cmpTs(use?.get(b.m.ts)?.last ?? "", use?.get(a.m.ts)?.last ?? "") ||
        cmpTs(b.m.ts, a.m.ts),
    )
    .slice(0, limit)
    .map((s) => s.m);
}

// What a row is matched against. Kept in one place so the bench's arms and
// production can never disagree about the indexed fields.
export function haystack(m: Memory): string {
  return `${m.scope} ${m.type} ${m.content}${m.kw?.length ? ` ${m.kw.join(" ")}` : ""}`;
}

function openRank(m: Memory): number {
  return m.status === "open" ? 1 : 0;
}

export function omittedLine(count: number): string {
  return `+ ${count} open ${count === 1 ? "thread" : "threads"} omitted: over budget`;
}

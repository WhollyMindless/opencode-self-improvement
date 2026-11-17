// Near-duplicate suppression inside a returned window (#409, RESULTS §17).
//
// The live store carries repeated rows — superseded snapshots, cursor rows that
// differ only by a timestamp, the same decision restated after a compaction —
// and the matcher scores them all the same. With a fixed window they crowd out
// distinct facts, which is what breaks composition: two memories a later task
// needs together rarely fit side by side because the first one's copies take
// the slots.
//
// The fix is one deterministic pass AFTER ranking: skip any candidate whose
// content-token Jaccard against an already-kept row of the same scope reaches
// the threshold, keeping the NEWEST copy of a clash (§17's adoption rule: the
// live duplicates are stale cursors and superseded snapshots, so the row that
// survives is the one written last, not the one that ranked highest). No model,
// no new index, and nothing changes unless the flag is set:
//
//   OPENCODE_MEMORY_DEDUP=0.8   (unset or 0 = shipped behavior, byte-identical)
//
// Threshold guidance from the live replay (§17): 0.5-0.7 suppresses rows that
// are merely related (92% of them at 0.5) and forces the window deep into the
// ranking; 0.8 suppresses only near-identical copies. Values below 0.5 are a
// misconfiguration, not an aggressive setting: at Jaccard 1e-9 a single shared
// fragment suppressed rows, so anything under 0.5 turns the pass off.
//
// WHAT COUNTS AS A NEAR-COPY — the first version's three mistakes, each pinned
// by a test:
//
// 1. It scored `type` and `scope` as tokens. Same-scope rows then shared two
//    free tokens, so short rows looked like copies of each other. Comparison is
//    content-only.
// 2. It compared whole token sets, so a prohibition read as a copy of the
//    permission it denies: "force push main" inside "never force push main"
//    reaches Jaccard 0.833, and at threshold 0.8 the WRONG copy survived. If
//    exactly one row of a pair carries a negation word, it is not a copy.
// 3. It had no floor. Non-Latin prose tokenises to nothing under `words()`
//    (which splits on [^a-z0-9_]+), so two unrelated Chinese rows in one scope
//    both reduced to the empty content set — Jaccard over empty sets is
//    defined here as 0, but the pre-floor version scored them on type and
//    scope alone at 1.0 and deleted the second row. A row with fewer than
//    MIN_CONTENT content tokens is never suppressed: there is nothing to
//    compare.
// 4. It treated differing numeric facts as duplicates. `words()` drops tokens
//    of length <= 2, so "Rate limiter reads Redis DB 3." and "...DB 4." have
//    identical token sets (Jaccard 1) and the older row was suppressed even at
//    threshold 1 (review #415, reproduced through the handler). Numbers are
//    compared as a sorted multiset of literals and a pair that disagrees on
//    them is never a copy.
import type { Memory } from "../store/model/memory.ts";
import { words } from "./score.ts";

export const DEDUPE_ENV = "OPENCODE_MEMORY_DEDUP";

/** Below this, the value is a misconfiguration and the pass stays off. */
export const MIN_THRESHOLD = 0.5;

/** A row with fewer content tokens than this is never compared (§17 floor). */
export const MIN_CONTENT = 4;

/**
 * Tokens that reverse a row's meaning. If exactly one row of a candidate pair
 * carries any of them, the rows disagree, and disagreement is not duplication.
 * Only words that survive `words()` (lower-case, length > 2) are listed;
 * contractions split ("don't" yields "don"), which is why "don" appears.
 */
export const POLARITY_WORDS = new Set([
  "never",
  "not",
  "cannot",
  "cant",
  "dont",
  "don",
  "avoid",
  "forbidden",
  "prohibited",
  "banned",
]);

/** Threshold from the environment. Unset, empty, unparsable, < MIN_THRESHOLD or > 1 means off. */
export function dedupeThreshold(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[DEDUPE_ENV];
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_THRESHOLD && n <= 1 ? n : 0;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  const small = a.size <= b.size ? a : b;
  const large = small === a ? b : a;
  for (const t of small) if (large.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/**
 * The short tokens `words()` drops (chunks of length <= 2). They are where
 * single-digit facts hide: "Rate limiter reads Redis DB 3." and "...DB 4."
 * have identical token sets and reach Jaccard 1 (review #415). Timestamped
 * cursor rows — the rows this pass exists to suppress — keep their digit
 * groups inside longer tokens ("15z"), so comparing the dropped chunks only
 * guards real fact changes without touching the cursor case. A pair whose
 * dropped chunks differ is never a copy.
 */
export function droppedChunks(content: string): string[] {
  return content
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0 && t.length <= 2)
    .sort();
}

/** True when two rows carry the same short chunks (same multiset). */
function sameDroppedChunks(a: Memory, b: Memory): boolean {
  const na = droppedChunks(a.content);
  const nb = droppedChunks(b.content);
  if (na.length !== nb.length) return false;
  for (let i = 0; i < na.length; i++) if (na[i] !== nb[i]) return false;
  return true;
}

/**
 * A row's own tokens: built DIRECTLY from the content and keyword fields.
 * Never from `haystack()` — the identifier tokenizer (#417) splits a
 * snake_case scope like `auth_token_refresh_policy` into auth/token/refresh/
 * policy, and deleting only the whole scope/type strings left those words
 * standing in for content: two unrelated non-Latin rows in one scope shared
 * a Jaccard-1 metadata vocabulary, cleared MIN_CONTENT on scope tokens alone,
 * and dedup hid one (#421, post-merge report on #417).
 */
export function contentTokens(m: Memory): Set<string> {
  const text = m.content + (m.kw?.length ? ` ${m.kw.join(" ")}` : "");
  return new Set(words(text));
}

function hasPolarity(tokens: Set<string>): boolean {
  for (const w of tokens) if (POLARITY_WORDS.has(w)) return true;
  return false;
}

/**
 * Keep at most `limit` rows from `ranked`, in ranking order, skipping a row
 * when it is a near-copy (same scope, content-token Jaccard >= `threshold`) of
 * a row already kept. When a clash happens the NEWER row takes the slot —
 * §17: the duplicates are stale snapshots, so recency decides, not rank. Rows
 * under `MIN_CONTENT` content tokens, pairs that disagree on a negation word,
 * and pairs whose numeric literals differ are never suppressed. `threshold <= 0`
 * returns the plain top-`limit` slice, so the flag-off path costs nothing and
 * cannot reorder.
 */
export function dedupeWindow(
  ranked: Memory[],
  limit: number,
  threshold: number,
): Memory[] {
  if (threshold <= 0 || ranked.length <= 1) return ranked.slice(0, limit);
  const tokenSets = ranked.map(contentTokens);
  const polarity = tokenSets.map(hasPolarity);
  const kept: number[] = [];
  for (let i = 0; i < ranked.length && kept.length < limit; i++) {
    if (tokenSets[i]!.size < MIN_CONTENT) {
      kept.push(i);
      continue;
    }
    let clash = -1; // position within `kept`, not the row index
    for (const pos of kept.keys()) {
      const k = kept[pos]!;
      if (
        ranked[k]!.scope === ranked[i]!.scope &&
        tokenSets[k]!.size >= MIN_CONTENT &&
        polarity[k] === polarity[i] &&
        sameDroppedChunks(ranked[k]!, ranked[i]!) &&
        jaccard(tokenSets[i]!, tokenSets[k]!) >= threshold
      ) {
        clash = pos;
        break;
      }
    }
    if (clash === -1) kept.push(i);
    else if (ranked[i]!.ts > ranked[kept[clash]!]!.ts) kept[clash] = i;
  }
  return kept.map((i) => ranked[i]!);
}

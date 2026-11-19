// Near-duplicate suppression inside a returned window: one deterministic pass
// AFTER ranking.
//
// Skip a candidate whose content-token Jaccard against an already-kept row of
// the same scope reaches the threshold; the NEWEST copy of a clash takes the
// slot, because the duplicates in a live store are stale cursors and
// superseded snapshots. ON by default at 0.8; OPENCODE_MEMORY_DEDUP=0 returns
// the plain top-limit slice, byte-identical to no pass. A value below 0.5 or
// above 1, or one that is not a number, is a misconfiguration and turns the
// pass off.
//
// Guards, each pinned by a test:
// - Compare content tokens only. Type and scope are not tokens: same-scope
//   rows would share two free tokens and short rows would look alike.
// - A pair where exactly one row carries a negation word is never a copy:
//   "force push main" inside "never force push main" reaches Jaccard 0.833 and
//   the wrong copy would survive.
// - A row under MIN_CONTENT content tokens is never suppressed; non-Latin
//   prose tokenises to nothing and there is nothing to compare.
// - A pair whose numeric literals differ is never a copy: short tokens are
//   dropped, so "DB 3" and "DB 4" otherwise share identical token sets.
//
// Threshold guidance: 0.5-0.7 suppresses merely-related rows and forces the
// window deep into the ranking; 0.8 suppresses near-identical copies only.
// History and measurements: docs/adr/0002.
import type { Memory } from "../store/model/memory.ts";
import { words } from "./score.ts";

export const DEDUPE_ENV = "OPENCODE_MEMORY_DEDUP";

/** Below this, the value is a misconfiguration and the pass stays off. */
export const MIN_THRESHOLD = 0.5;

/** A row with fewer content tokens than this is never compared (§17 floor). */
export const MIN_CONTENT = 4;

/**
 * The default when the flag is unset: 0.8 is the live-replay point that
 * suppresses only near-identical copies (§17) — it touched 17% of calls,
 * never changed top-1, and never dropped a term's last carrier.
 */
export const DEFAULT_THRESHOLD = 0.8;

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

/**
 * Threshold from the environment. Unset or empty means DEFAULT_THRESHOLD (on).
 * `0` means off — the documented escape hatch. An explicit value that is
 * unparsable, < MIN_THRESHOLD or > 1 is a misconfiguration and turns the pass
 * off rather than silently running something the user did not ask for.
 */
export function dedupeThreshold(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[DEDUPE_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_THRESHOLD;
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
 * have identical token sets and reach Jaccard 1. Timestamped
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
 * Never from `haystack()` — the identifier tokenizer splits a multi-word scope
 * into its parts, and those parts stand in for content. Any delimiter does it:
 * `auth_token_refresh_policy` and `auth-token-refresh-policy` both yield
 * auth/token/refresh/policy, so a store holding no underscore is not exempt.
 * Deleting only the whole scope/type strings leaves those words standing in
 * for content: two unrelated non-Latin rows in one scope then share a
 * Jaccard-1 metadata vocabulary, clear MIN_CONTENT on scope tokens alone,
 * and dedup hides one.
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
  // Token sets are built lazily and cached per index: the loop stops once
  // `limit` rows are kept, so eager tokenization of every candidate costs
  // 1.7ms/12.5ms/96.4ms at 200/2k/10k candidates on every query recall.
  // Lazy cost is window-sized.
  const tokenCache = new Map<number, Set<string>>();
  const tokensOf = (i: number): Set<string> => {
    let t = tokenCache.get(i);
    if (t === undefined) {
      t = contentTokens(ranked[i]!);
      tokenCache.set(i, t);
    }
    return t;
  };
  const polarityCache = new Map<number, boolean>();
  const polarityOf = (i: number): boolean => {
    let p = polarityCache.get(i);
    if (p === undefined) {
      p = hasPolarity(tokensOf(i));
      polarityCache.set(i, p);
    }
    return p;
  };
  const kept: number[] = [];
  for (let i = 0; i < ranked.length && kept.length < limit; i++) {
    if (tokensOf(i).size < MIN_CONTENT) {
      kept.push(i);
      continue;
    }
    let clash = -1; // position within `kept`, not the row index
    for (const pos of kept.keys()) {
      const k = kept[pos]!;
      if (
        ranked[k]!.scope === ranked[i]!.scope &&
        tokensOf(k).size >= MIN_CONTENT &&
        polarityOf(k) === polarityOf(i) &&
        sameDroppedChunks(ranked[k]!, ranked[i]!) &&
        jaccard(tokensOf(i), tokensOf(k)) >= threshold
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

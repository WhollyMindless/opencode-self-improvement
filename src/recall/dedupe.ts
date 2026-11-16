// Near-duplicate suppression inside a returned window (#409, RESULTS §17).
//
// The live store carries repeated rows — superseded snapshots, cursor rows that
// differ only by a timestamp, the same decision restated after a compaction —
// and the matcher scores them all the same. With a fixed window they crowd out
// distinct facts, which is what breaks composition: two memories a later task
// needs together rarely fit side by side because the first one's copies take
// the slots.
//
// The fix is one deterministic pass AFTER ranking: keep rank order, skip any
// candidate whose token Jaccard against an already-kept row reaches the
// threshold, and continue until the window is full. No model, no new index,
// and nothing changes unless the flag is set:
//
//   OPENCODE_MEMORY_DEDUP=0.8   (unset or 0 = shipped behavior, byte-identical)
//
// Threshold guidance from the live replay (§17): 0.5-0.7 suppresses rows that
// are merely related (92% of them at 0.5) and forces the window deep into the
// ranking; 0.8 suppresses only near-identical copies. Ties are broken by scope
// because two scopes can legitimately hold parallel wording.
import type { Memory } from "../store/model/memory.ts";
import { haystack, words } from "./score.ts";

export const DEDUPE_ENV = "OPENCODE_MEMORY_DEDUP";

/** Threshold from the environment. Unset, empty, unparsable or <= 0 means off. */
export function dedupeThreshold(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[DEDUPE_ENV];
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0;
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
 * Keep at most `limit` rows from `ranked`, in ranking order, skipping a row
 * when it is a near-copy (same scope, token Jaccard >= `threshold`) of a row
 * already kept. `threshold <= 0` returns the plain top-`limit` slice, so the
 * flag-off path costs nothing and cannot reorder.
 */
export function dedupeWindow(
  ranked: Memory[],
  limit: number,
  threshold: number,
): Memory[] {
  if (threshold <= 0 || ranked.length <= 1) return ranked.slice(0, limit);
  const tokenSets = ranked.map((m) => new Set(words(haystack(m))));
  const kept: number[] = [];
  for (let i = 0; i < ranked.length && kept.length < limit; i++) {
    const scope = ranked[i]!.scope;
    const clash = kept.some(
      (k) =>
        ranked[k]!.scope === scope &&
        jaccard(tokenSets[i]!, tokenSets[k]!) >= threshold,
    );
    if (!clash) kept.push(i);
  }
  return kept.map((i) => ranked[i]!);
}

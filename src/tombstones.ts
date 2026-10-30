// Value-keyed rejection tombstones (#35).
//
// The blocklist keys on `ts` — ROW identity. memory_forget/prune deletes the
// row outright. Neither survives re-ingestion: replay the original source (a
// transcript, a doc, an export) and the rejected fact is stored again with a
// fresh `ts` as if it had never been turned down. Something has to be keyed on
// the VALUE, which is step 6 of the Agent Memory Atlas deletion-durability
// sequence and the most-repeated gap in the field.
//
// Hashes only, never values (atlas step-10 inversion: a deletion log that
// reproduces the deleted secret is a compliance problem). Two fields per line:
//
//   ch  sha1(content)[0:12] — the same hash the gates already emit on
//       gate_start / write_promoted, so a rejection is searchable with the
//       identifiers telemetry already carries.
//   sig a bottom-k sketch of the content's token hashes (see sketchOf).
//       Supports near-match WITHOUT storing the prose.
//
// The near-match is what closes the rewording hole: "use Express for the HTTP
// layer" and "the HTTP layer uses Express" are different bytes, so `ch` alone
// lets the second one through after a human rejected the first. The sketch is
// computed from the token set, so an order-only rewording scores 1.0.
//
// Why a hashed-token sketch rather than the token list: it is one-way per
// token and carries no ordering, so the file cannot be read back as prose. It
// is strictly less revealing than deletions.logfmt, which stores the full text
// of every forgotten row verbatim (memory.ts logDeletion).
//
// Scope is deliberately GLOBAL, matching the file's location at the memory
// root: a rejection is a statement about a value in this store, not about a
// repository. The cost is that repo A's rejection also declines repo B's
// byte-identical write; that is the honest reading of "this value was rejected
// here", and a false positive is liftable by a HUMAN in the viewer.
//
// Not snapshotted. snapshotFiles() walks memoryFiles(), which excludes every
// RESERVED name, so `memory_undo` cannot resurrect a tombstone any more than
// it can resurrect a blocklist entry — and conversely cannot erase one.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { contentHash } from "./evidence.ts";
import { memoryRoot } from "./config.ts";
import { appendLog, fileIdentity, formatLine, parseLine, readLines, writeAtomic } from "./logfmt.ts";
import { withStoreLock, LOCK_WRITE } from "./lock.ts";
import { STOPWORDS, tokens } from "./tokenize.ts";

const REJECTED_FILENAME = "rejected.logfmt";

/** How many lowest token-hashes the sketch keeps. */
const SKETCH_SIZE = 64;

/** Per-token hash width. 8 hex chars keeps the sketch compact and collisions
 *  irrelevant at this store's size (a collision merges two tokens, which only
 *  ever makes a near-match score marginally HIGHER than the truth — so the
 *  floors below are the conservative direction only up to ~1e-9 of inputs). */
const TOKEN_HASH_CHARS = 8;

/** Near-match floors. A sketch whose token count is at or below SKETCH_SIZE is
 *  the token set itself, so Jaccard here is EXACT, not an estimate — which is
 *  every real memory in practice. Beyond SKETCH_SIZE it is the standard
 *  bottom-k estimator.
 *
 *  Calibrated, not guessed — measured with this sketch on store-shaped prose
 *  (12-token memories):
 *
 *    rewordings of the SAME claim ......... 0.500 – 0.615
 *    same topic, DIFFERENT claim .......... 0.059 – 0.235
 *    unrelated ............................ 0.000
 *
 *  0.40 sits in the middle of that gap with ~0.17 of margin on both sides. It
 *  is also in family with the repo's existing calibration: GATE-3 uses 0.9 for
 *  "reworded duplicate of a live row" and 0.3 for a decision/preference
 *  CONFLICT, so this is the conflict-style band applied to a rejection.
 *
 *  NEAR_MIN_SHARED exists because a three-token content can hit a high Jaccard
 *  against unrelated prose on shared filler alone; below this many shared
 *  tokens nothing is a near-match at all, and short content is refused only on
 *  an exact match.
 */
export const NEAR_FLOOR = 0.4;
const NEAR_MIN_SHARED = 6;

export interface Tombstone {
  ch: string;
  /** Rejection reason as given by the human who rejected the value. */
  reason: string;
  /** What recorded it: `forget` (memory_forget/prune) or `block` (viewer). */
  source: string;
  rejected_at: string;
  /** Origin metadata for the hint. Matching never consults these. */
  scope?: string;
  type?: string;
  sig: string[];
}

export type Rejection =
  | { kind: "exact"; tombstone: Tombstone }
  | { kind: "near"; tombstone: Tombstone; score: number; shared: number };

export function rejectedFile(): string {
  return join(memoryRoot(), REJECTED_FILENAME);
}

function tokenHash(token: string): string {
  return createHash("sha1").update(token).digest("hex").slice(0, TOKEN_HASH_CHARS);
}

/** The GATE-3 token set minus the filler words, so the sketch is a set of
 *  claims rather than a set of prose. Splitting is `tokens()` from tokenize.ts,
 *  shared with gates.ts so both score the same way. */
function baseTokens(content: string): string[] {
  return tokens(content).filter((t) => !STOPWORDS.has(t));
}

/**
 * The content's token set, as sorted hashes, kept to the SKETCH_SIZE lowest.
 *
 * Hashing uses NO secret salt on purpose: the sketch has to be comparable
 * across processes and across machines (an exported store must still decline
 * what this store rejected), and a salt stored beside the file protects
 * nothing the file itself does not already give up.
 *
 * Tokens are lowercase alphanumeric runs with the GATE-3 stopword list
 * removed (gates.ts STOPWORDS is not exported, and duplicating the handful of
 * words here is cheaper than widening that module's surface for one import).
 */
export function sketchOf(content: string): string[] {
  const tokens = new Set<string>();
  for (const raw of baseTokens(content)) {
    tokens.add(tokenHash(raw));
  }
  // Fixed-width lowercase hex sorts lexicographically in numeric order, so
  // "lowest 64" is simply the first 64 after a sort.
  return [...tokens].sort().slice(0, SKETCH_SIZE);
}


/**
 * The tombstone set, cached against the file's change token.
 *
 * `findRejection` runs on EVERY gated write, so without this each write pays a
 * full read of every rejection ever recorded — a cost this mechanism introduced
 * into the hot path, and one that shows up badly on Windows, where the CI runner
 * is slow enough for it to matter. `fileIdentity` is the repo's own change token
 * (any append, rewrite or replacement changes it, "absent" means no file yet),
 * so the cache is keyed on evidence rather than on a clock: a human lifting a
 * rejection in the viewer process is seen by the next write in this one. A TTL
 * would have been wrong here — it would keep refusing a value for the length of
 * the TTL after the human said otherwise.
 */
let cache: { at: string; rows: Tombstone[] } | null = null;

/** Drop the cached tombstone set. Exposed for tests and for the write paths,
 *  which invalidate after touching the file so a same-process re-read cannot
 *  serve a pre-write snapshot. */
export function resetTombstoneCache(): void {
  cache = null;
}

export async function tombstones(): Promise<Tombstone[]> {
  const file = rejectedFile();
  const identity = await fileIdentity(file);
  if (cache && cache.at === identity) return cache.rows;
  const lines = await readLines(file);
  const out: Tombstone[] = [];
  for (const line of lines) {
    const f = parseLine(line);
    if (!f || typeof f.ch !== "string") continue;
    out.push({
      ch: f.ch,
      reason: typeof f.reason === "string" ? f.reason : "",
      source: typeof f.source === "string" ? f.source : "unknown",
      rejected_at: typeof f.rejected_at === "string" ? f.rejected_at : "",
      scope: typeof f.scope === "string" ? f.scope : undefined,
      type: typeof f.type === "string" ? f.type : undefined,
      sig: typeof f.sig === "string" ? f.sig.split(".").filter(Boolean) : [],
    });
  }
  cache = { at: identity, rows: out };
  return out;
}

/**
 * Record that a human rejected a batch of values.
 *
 * ONE read of the existing set, ONE lock, ONE append for the whole batch. This
 * is not a micro-optimisation: the per-value version did a lock create/unlink
 * pair plus a full read per row, and `memory_forget` deletes by scope+type, so a
 * bulk forget issued hundreds of lock cycles while other sessions were writing.
 * The heavy concurrent scenario on the Windows runner failed 2/2 with that shape
 * (run 41112466339) and never on main; src/lock.ts gives up waiting after 5s and
 * proceeds UNLOCKED, which is precisely how a row gets lost behind a long
 * read-modify-write. Whether the batch is sufficient there is the open question
 * this commit's CI run answers; the cost it removes is real either way.
 *
 * Still idempotent by `ch`, and de-duplicated WITHIN the batch too, so a forget
 * that removes fifty rows carrying the same content records one tombstone.
 * The read-then-write is not a compare-and-set: two processes rejecting the same
 * NEW value at the same instant can both append. The value ends up tombstoned
 * either way and no third party's line is lost, because every writer of this
 * file takes the same lock and the append is O_APPEND.
 */
export async function tombstoneMany(
  entries: Array<{ content: string; scope?: string; type?: string }>,
  opts: { reason: string; source: string },
): Promise<{ recorded: number; chs: string[] }> {
  if (entries.length === 0) return { recorded: 0, chs: [] };
  const known = new Set((await tombstones()).map((t) => t.ch));
  const at = new Date().toISOString();
  const fresh: string[] = [];
  const chs: string[] = [];
  for (const e of entries) {
    const ch = contentHash(e.content);
    chs.push(ch);
    if (known.has(ch)) continue;
    known.add(ch);
    fresh.push(
      formatLine({
        ch,
        reason: opts.reason,
        source: opts.source,
        scope: e.scope,
        type: e.type,
        sig: sketchOf(e.content).join("."),
        rejected_at: at,
      }),
    );
  }
  if (fresh.length === 0) return { recorded: 0, chs };
  const file = rejectedFile();
  // formatLine returns a line WITHOUT its terminator (appendLog adds one), so a
  // batch must be joined with newlines. Joining on "" silently published every
  // record in the batch as one line, of which only the first parsed — and a
  // caller forgetting one row at a time could not see it.
  await withStoreLock(file, () => appendLog(file, fresh.join("\n")), LOCK_WRITE);
  resetTombstoneCache();
  return { recorded: fresh.length, chs };
}

/**
 * Record that a human rejected one value. Delegates to {@link tombstoneMany};
 * the batch form is the one a caller deleting many rows should use.
 */
export async function tombstone(
  content: string,
  opts: { reason: string; source: string; scope?: string; type?: string },
): Promise<{ ch: string; recorded: boolean }> {
  const { recorded, chs } = await tombstoneMany([{ content, scope: opts.scope, type: opts.type }], opts);
  return { ch: chs[0], recorded: recorded > 0 };
}

/**
 * Is this content refused because a human already rejected it?
 *
 * Exact hash first: it is cheap, unambiguous, and the answer a rejection owes.
 * Near-match second, over the whole tombstone set, returning the STRONGEST
 * match rather than the first — the hint names a specific prior rejection, so
 * pointing at a weak one while a better one exists would misreport why the
 * write was refused.
 */
export async function findRejection(content: string): Promise<Rejection | undefined> {
  const all = await tombstones();
  if (all.length === 0) return undefined;
  const ch = contentHash(content);
  const exact = all.find((t) => t.ch === ch);
  if (exact) return { kind: "exact", tombstone: exact };

  const sig = sketchOf(content);
  // Below the shared-token floor a near-match cannot fire at all, so short
  // content is refused only ever on an exact match.
  if (sig.length < NEAR_MIN_SHARED) return undefined;
  let best: Rejection | undefined;
  for (const t of all) {
    if (t.sig.length < NEAR_MIN_SHARED) continue;
    const { score, shared } = jaccardShared(sig, t.sig);
    if (shared < NEAR_MIN_SHARED || score < NEAR_FLOOR) continue;
    if (!best || best.kind === "near" && score > best.score) {
      best = { kind: "near", tombstone: t, score, shared };
    }
  }
  return best;
}

function jaccardShared(a: string[], b: string[]): { score: number; shared: number } {
  const setB = new Set(b);
  let shared = 0;
  for (const h of a) if (setB.has(h)) shared++;
  const union = a.length + b.length - shared;
  return { score: union === 0 ? 0 : shared / union, shared };
}

/**
 * Lift a tombstone. Human-only by construction: this is exported to the
 * viewer's mutation layer and NEVER wired to a plugin tool. A blocked model
 * that could lift its own rejection could re-write the rejected value in the
 * same turn, which would make the whole mechanism advisory. (Same shape as the
 * blocklist, which likewise has no unblock tool.)
 */
export async function removeTombstone(ch: string): Promise<boolean> {
  const file = rejectedFile();
  return withStoreLock(
    file,
    async () => {
      const since = await fileIdentity(file);
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
      const kept = text.split("\n").filter((l) => {
        const row = parseLine(l);
        return !(row && row.ch === ch);
      });
      await writeAtomic(file, kept.join("\n") + (kept.length ? "\n" : ""), since);
      resetTombstoneCache();
      return true;
    },
    LOCK_WRITE,
  );
}

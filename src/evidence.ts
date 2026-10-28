// Evidence log writer. One logfmt line per event, appended in hook order to
// ~/.config/opencode/memory/evidence/<date>.logfmt. Evidence is DATA: never
// injected into chat, and stored outside every repo.
import { join } from "node:path";
import { createHash } from "node:crypto";
import { dateStr, evidenceDir } from "./config.ts";
import { appendLog, formatLine } from "./logfmt.ts";
import { repoScope, sessionScope } from "./repokey.ts";
import { getCurrent } from "./state.ts";
import { redactSecrets } from "./secrets.ts";

export type EvidenceEvent = string;

// Credential scrub at the evidence WRITE boundary. Evidence fields routinely
// carry caller-authored prose (gate reasons, block reasons, review notes) and
// tool-derived summaries; a recognized credential must not persist in the
// durable log no matter which line carried it (#128). redactSecrets is a
// no-op on ordinary text (ids, hashes, paths, counts).
function scrubFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = typeof value === "string" ? redactSecrets(value) : value;
  }
  return out;
}

export async function record(
  ev: EvidenceEvent,
  fields: Record<string, unknown> = {},
  includeContext = true,
  sessionID?: string,
): Promise<void> {
  const cur = getCurrent();
  // An explicitly threaded session outranks the ambient one: gate-authored
  // lines must name the session the gate runs FOR, not whichever setCurrent
  // fired last during the gate's own awaits (#118 review note 1 — the rows
  // were fixed in #118, these lines were the residue). When the two disagree,
  // the ambient call belongs to the OTHER session's flow, so it is dropped
  // rather than borrowed. With sessionID undefined (tool paths — issue #121)
  // this is exactly the old ambient read.
  const sid = sessionID ?? cur.sid;
  const call = sessionID !== undefined && sessionID !== cur.sid ? undefined : cur.call;
  // Read-side partitioning of the shared log (#131's rule, applied to
  // evidence; the re-review closed the last two gaps in it). A NAMED session
  // is stamped from its OWN resolved scope only — the module scope is never
  // the fallback here: in a process that loaded several plugin instances it
  // belongs to whoever set up LAST, and A's evidence must not live in B's
  // repository. A named session whose repository is unresolvable writes an
  // UNSTAMPED line that stays private to that session (memory.ts
  // evidenceVisibleTo pairs with this choice): "unknown" is never
  // "everything" (#127), and it is never somebody else's repo either. Only a
  // genuinely session-less line — out-of-plugin maintenance, viewer, CLI —
  // takes the process scope, and unstamped session-less lines (legacy, or a
  // scope-less process) keep their historical global reading.
  const named = typeof sid === "string" && sid !== "" && sid !== "?";
  const scope = named ? sessionScope(sid) : repoScope();
  const line = formatLine({
    ev,
    ts: new Date().toISOString(),
    ...(includeContext ? { sid, call } : {}),
    ...(scope ? { repo: scope.key, repoPath: scope.path } : {}),
    ...scrubFields(fields),
  });
  await appendLog(join(evidenceDir(), `${dateStr()}.logfmt`), line);
}

export function contentHash(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 12);
}

export function chainId(): string {
  return createHash("sha1")
    .update(`${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 8);
}

/**
 * One capture decision, in both directions. `lagMs` is the wall-clock distance
 * from the last message of the transcript to the moment the capture model was
 * asked — the number #44 asks for ("how stale is a capture?"). Negative and
 * missing values are dropped rather than guessed: a capture with no observed
 * message time has no lag, and inventing 0 would pull p50 toward "instant".
 */
export async function recordCaptureLag(
  session: string,
  lagMs: number | null,
  outcome: string,
): Promise<void> {
  await record(
    "capture_lag",
    {
      session,
      ...(lagMs !== null && Number.isFinite(lagMs) && lagMs >= 0 ? { lag: Math.round(lagMs) } : {}),
      outcome,
    },
    false,
  );
}

export async function recordWriteBlocked(
  gate: number,
  reason: string,
  flags: string[],
  chain?: string,
  sessionID?: string,
): Promise<void> {
  await record(
    "write_blocked",
    {
      gate,
      reason,
      flags: `[${flags.join(",")}]`,
      ...(chain ? { chain } : {}),
    },
    true,
    sessionID,
  );
}

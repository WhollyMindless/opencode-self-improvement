// Evidence log writer. One logfmt line per event, appended in hook order to
// ~/.config/opencode/memory/evidence/<date>.logfmt. Evidence is DATA: never
// injected into chat, and stored outside every repo.
import { join } from "node:path";
import { createHash } from "node:crypto";
import { dateStr, evidenceDir } from "./config.ts";
import { appendLog, formatLine } from "./logfmt.ts";
import { getCurrent } from "./state.ts";

export type EvidenceEvent = string;

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
  const line = formatLine({
    ev,
    ts: new Date().toISOString(),
    ...(includeContext ? { sid, call } : {}),
    ...fields,
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

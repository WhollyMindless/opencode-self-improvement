// Per-session model registry (#139). The SDK's SessionRequest declares a
// readonly `model: Model.Ref`, so EVERY session hook the plugin registers
// already carries the session's actual model — the session.context hook reads
// event.sessionID and never event.model, and auto-capture required a second
// config key (captureModel) it could have inherited for free. This module is
// the seam: events.ts records the ref the host delivered, capture/runtime.ts
// resolves an omitted captureModel through it before falling back to the host
// default. Module-level like `lastCaptureRun` in runtime.ts (#108): setup runs
// for more than one location, and a per-closure map would make those
// registrations strangers to the model the host just told them.
export interface SessionModelRef {
  providerID: string;
  id: string;
}

const lastModel = new Map<string, SessionModelRef>();

/**
 * Record the model ref a session hook carried. Total: a malformed or absent
 * `event.model` is ignored, never stored — the caller then falls through to
 * the host default, exactly as if the hook had not run.
 */
export function recordSessionModel(sid: string, model: unknown): void {
  if (!model || typeof model !== "object") return;
  const m = model as Record<string, unknown>;
  const providerID = typeof m.providerID === "string" ? m.providerID.trim() : "";
  const id = typeof m.id === "string" ? m.id.trim() : "";
  if (!providerID || !id) return;
  // Sessions churn and a long-lived server must not grow one entry per
  // session forever; oldest-inserted go first (the cooldown map's rule).
  if (lastModel.size > 2000) {
    for (const k of [...lastModel.keys()].slice(0, 1000)) lastModel.delete(k);
  }
  lastModel.set(sid, { providerID, id });
}

/** The ref last seen for this session, or null when the host never delivered one. */
export function sessionModel(sid: string): SessionModelRef | null {
  return lastModel.get(sid) ?? null;
}

/** Clear the registry (tests; also what a process restart does). */
export function resetSessionModels(): void {
  lastModel.clear();
}

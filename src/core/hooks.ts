// Fail-soft wrapper for plugin bookkeeping hooks (#168).
//
// Fail-soft must never mean invisible (#138): a plugin whose hook failed on
// EVERY turn looked identical to a healthy one in every artifact, because the
// only trace was a console.warn into the host log. setup() installs a failure
// reporter that mirrors each swallowed error into the evidence file; the
// reporter is optional so this module stays free of the evidence dependency
// and a broken reporter can never change the swallow contract.
export type GuardedFailure = (
  name: string,
  err: unknown,
) => void | Promise<void>;

let failureReporter: GuardedFailure | undefined;

export function setGuardedFailureReporter(
  reporter: GuardedFailure | undefined,
): void {
  failureReporter = reporter;
}

export async function guarded(
  name: string,
  fn: () => Promise<void>,
  // Optional: "is this failure still worth a receipt?" A caller that owns a
  // lifecycle passes `() => !disposed`. Teardown is not a capture failure
  // (#211): once cleanup() has returned the caller may have removed the store,
  // so mirroring the rejection into evidence is the ENOENT noise that issue was
  // filed about — the same reason the idle capture path checks its abort signal
  // inside its own catch. Omitted, the #138 contract is untouched: every
  // swallowed failure is mirrored.
  reportable?: () => boolean,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(
      `[opencode-self-improvement] ${name} hook failed (ignored):`,
      err,
    );
    // The console line is the primary trace and stays either way; only the
    // store write is gated. A predicate that throws reports, so a broken
    // predicate can never turn a swallowed failure into a throw.
    let report = true;
    try {
      report = reportable?.() !== false;
    } catch {
      // unknown state reports, as before
    }
    if (!report) return;
    // Report AFTER the warn, and await the reporter so a caller that awaits
    // guarded() can observe the evidence line; any reporter failure is itself
    // swallowed — the console line is the primary trace, evidence the mirror.
    try {
      await failureReporter?.(name, err);
    } catch {
      // a failing reporter is itself a swallowed failure — never a throw
    }
  }
}

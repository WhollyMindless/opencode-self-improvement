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
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(
      `[opencode-self-improvement] ${name} hook failed (ignored):`,
      err,
    );
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

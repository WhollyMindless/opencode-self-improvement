// Locking policy shared by every module that rewrites a store file.
//
// Contention is rare and brief (a rewrite holds the lock for milliseconds), so
// an ordinary write that waits out the timeout PROCEEDS rather than losing the
// user's memory, and the wait is audited. Restore fails closed instead: "force"
// deliberately drops rows, and that must never be guessed at under a racing
// writer.
import { record } from "./evidence.ts";
import type { LockEvent, LockOptions } from "./lock.ts";

function audit(op: string): (event: LockEvent, waitedMs: number) => void {
  return (event, waitedMs) => {
    void record("store_lock", { event, waited_ms: waitedMs, op });
  };
}

export const LOCK_WRITE: LockOptions = { onEvent: audit("write") };

export const LOCK_RESTORE: LockOptions = { onTimeout: "fail", onEvent: audit("restore") };

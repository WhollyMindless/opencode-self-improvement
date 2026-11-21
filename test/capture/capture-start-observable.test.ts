// Regression: a capture pass that the host never lets finish must still
// leave a trace, so the silent state is distinguishable in the evidence log.
//
// The bug. On `opencode run` the host dispatches the turn-end event to plugin
// subscriptions and exits WITHOUT awaiting the async handler (measured 2026-11-21
// on opencode v2.3.0: the event reaches event.subscribe 10/10, a handler that
// awaits the model records nothing 0/10, while cleanup fires 10/10). When the
// pass is cut before `capture_cost`, the evidence log shows a turn with a tool
// result and NOTHING after — byte-identical to "capture is disabled" or "capture
// ran and found nothing." The user gets no memory and no signal anything was
// missed.
//
// The fix this pins. The pass records `auto_capture_start` at its FIRST await,
// before the context read and the model call, so it flushes even when the host
// exits mid-handler (an async first-write lands 12/12). And disposal records
// `auto_capture_dispose` when an armed instance is torn down without ever seeing
// a turn-end event — the one signal that does not depend on the event arriving.
//
// These two lines make the three states distinguishable:
//   disabled                         -> plugin_load capture=off, no start line
//   ran and found nothing            -> auto_capture_start + capture_cost/capture_lag
//   started but cut by teardown    -> auto_capture_start, NO capture_cost
//   event never delivered          -> auto_capture_dispose, no start line
//
// Both assertions fail on origin/main, where neither line exists.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetState } from "../../src/core/state.ts";
import { setRepoScope } from "../../src/identity/repokey.ts";
import { resetCaptureCooldowns } from "../../src/index.ts";
import { type LoadedPlugin, loadPlugin } from "../harness.ts";
import { readEvidenceLog, sleep } from "../helpers/logfmt.ts";
import { removeStore } from "../helpers/remove-store.ts";

let root: string;
let plugin: LoadedPlugin | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-406-start-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  mkdirSync(join(root, "repo"), { recursive: true });
  resetState();
  resetCaptureCooldowns();
  setRepoScope(null);
});

afterEach(async () => {
  await plugin?.cleanup();
  plugin = undefined;
  resetState();
  resetCaptureCooldowns();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  removeStore(root);
});

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

/** A generate call the test holds open, then releases. */
function parked(): { promise: Promise<void>; release: () => void } {
  const box = { promise: Promise.resolve(), release: () => {} };
  box.promise = new Promise<void>((resolve) => {
    box.release = resolve;
  });
  return box;
}

// A context thick enough to mine (>=200 chars) so the idle pass reaches the
// model instead of skipping on a thin transcript — the pass must be cut AT the
// model call to reproduce the lost-pass signature, not skipped before it.
function thickMessages(): unknown[] {
  return [
    {
      role: "user",
      content:
        "We finished the archive change. Remember that the nightly archive job keeps fourteen " +
        "days of tarballs, and the batch importer respects the staging rate limit of 120 " +
        "requests per minute per key as of October 2026, which matters for the importer.",
    },
    {
      role: "assistant",
      content:
        "Got it: fourteen days of tarballs in the nightly archive, and I will respect the " +
        "120 requests per minute staging limit while wiring the batch importer tooling.",
    },
  ];
}

test("a pass cut at the model call still records auto_capture_start (started-but-cut is observable)", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  const sid = "ses-start-cut";
  loaded.capture.context.messages = thickMessages();
  const park = parked();
  loaded.capture.generate.park = park.promise;
  loaded.capture.generate.response = JSON.stringify([
    { type: "context", scope: "batch", content: "unused" },
  ]);
  await waitFor(() => loaded.capture.events.subscribeCalls === 2);
  loaded.capture.events.push({
    type: "session.execution.succeeded",
    data: { sessionID: sid },
  });
  // The pass is now parked INSIDE generate.text: it began, but cannot reach
  // capture_cost — exactly the state the host leaves on a fast-exiting run.
  await waitFor(() => loaded.capture.generate.calls.length === 1);

  const ev = readEvidenceLog();
  const start = ev.find(
    (l) => l.ev === "auto_capture_start" && l.session === sid,
  );
  // FAILS ON origin/main: no such line exists, so the cut pass is invisible.
  expect(start).toBeDefined();
  expect(String(start?.trigger)).toBe("idle");
  // The pass really was cut before its verdict: no completion receipt exists,
  // which is precisely why the start line is the only trace it leaves.
  expect(ev.some((l) => l.ev === "capture_cost")).toBe(false);
  park.release();
});

test("disposal of an armed instance with no turn-end event records auto_capture_dispose", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  await waitFor(() => loaded.capture.events.subscribeCalls === 2);
  // No turn-end event is ever delivered — the host exited before dispatch
  // reached the subscription. Disposal is the only chance to record it.
  await loaded.cleanup();
  plugin = undefined; // already disposed; do not double-flush in afterEach

  const miss = readEvidenceLog().find((l) => l.ev === "auto_capture_dispose");
  // FAILS ON origin/main: no such line exists, so "event never arrived" is
  // indistinguishable from "capture disabled" or "capture ran and found nothing."
  expect(miss).toBeDefined();
  expect(String(miss?.reason)).toBe("turn_end_not_delivered");
  expect(String(miss?.armed)).toBe("true");
});

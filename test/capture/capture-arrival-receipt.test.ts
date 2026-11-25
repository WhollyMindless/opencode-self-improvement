// Pins the arrival receipt the idle dispatch loop writes for every delivered
// turn-end event, before any skip in the loop can drop it.
//
// The contract:
//   Every delivered event writes exactly one `auto_capture_seen` line,
//     synchronously, before any await — a delivered turn never leaves the
//     loop without a line naming what happened to it.
//   `discard` is the loop's own skip verdict: `no_sid` (envelope carried no
//     session), `cooldown` (the 5-minute window rejected it), `none` (the
//     event proceeded, so a pass is owed). A `discard=none` line with no
//     `auto_capture_start` names a cut between arrival and start — a
//     named state, not a silence.
//   The receipt rides BEFORE the discards: one line per delivered event
//     always exists, even where no pass ever will.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetState } from "../../src/core/state.ts";
import { setRepoScope } from "../../src/identity/repokey.ts";
import { resetCaptureCooldowns } from "../../src/index.ts";
import { type LoadedPlugin, loadPlugin } from "../harness.ts";
import { ev, readEvidenceLog, sleep } from "../helpers/logfmt.ts";
import { removeStore } from "../helpers/remove-store.ts";

let root: string;
let plugin: LoadedPlugin | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-seen-"));
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

/** The seen lines in file order, as written. */
function seenLines() {
  return ev(readEvidenceLog(), "auto_capture_seen");
}

/** A generate call the test holds open, then releases. */
function parked(): { promise: Promise<void>; release: () => void } {
  const box = { promise: Promise.resolve(), release: () => {} };
  box.promise = new Promise<void>((resolve) => {
    box.release = resolve;
  });
  return box;
}

// A context thick enough to mine (>=200 chars) so a proceeding event reaches
// the model instead of skipping on a thin transcript.
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

test("an event delivered without a session id writes a no_sid arrival receipt and no pass", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  await waitFor(() => loaded.capture.events.subscribeCalls === 2);
  loaded.capture.events.push({
    type: "session.execution.succeeded",
    data: {},
  });
  await waitFor(() => seenLines().length === 1);

  const seen = seenLines();
  expect(seen.length).toBe(1);
  expect(String(seen[0].discard)).toBe("no_sid");
  // The skip is the point of the line: nothing downstream ran.
  expect(ev(readEvidenceLog(), "auto_capture_start").length).toBe(0);
  expect(loaded.capture.generate.calls.length).toBe(0);
});

test("a second event inside the cooldown writes a cooldown arrival receipt and no pass", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  const sid = "ses-seen-cooldown";
  // Thin transcript: the first event proceeds (discard=none) and skips inside
  // the pass, so the receipt trail alone is what this test reads. The second
  // event, moments later, hits the 5-minute window at the loop itself.
  loaded.capture.context.messages = [{ role: "user", content: "hello" }];
  await waitFor(() => loaded.capture.events.subscribeCalls === 2);
  loaded.capture.events.push({
    type: "session.execution.succeeded",
    data: { sessionID: sid },
  });
  await waitFor(() => seenLines().length === 1);
  loaded.capture.events.push({
    type: "session.execution.succeeded",
    data: { sessionID: sid },
  });
  await waitFor(() => seenLines().length === 2);

  const seen = seenLines();
  expect(String(seen[0].discard)).toBe("none");
  expect(String(seen[1].discard)).toBe("cooldown");
  expect(String(seen[1].sid)).toBe(sid);
  // One line per delivered event, and the cooldown skip writes no pass.
  expect(seen.length).toBe(2);
  expect(ev(readEvidenceLog(), "auto_capture_start").length).toBe(0);
  expect(loaded.capture.generate.calls.length).toBe(0);
});

test("a proceeding event writes its arrival receipt once, before the start line", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  const sid = "ses-seen-none";
  loaded.capture.context.messages = thickMessages();
  const park = parked();
  loaded.capture.generate.park = park.promise;
  loaded.capture.generate.response = "[]";
  await waitFor(() => loaded.capture.events.subscribeCalls === 2);
  loaded.capture.events.push({
    type: "session.execution.succeeded",
    data: { sessionID: sid },
  });
  await waitFor(() => loaded.capture.generate.calls.length === 1);
  try {
    const lines = readEvidenceLog();
    const seenIdx = lines.findIndex(
      (l) => l.ev === "auto_capture_seen" && String(l.sid) === sid,
    );
    const startIdx = lines.findIndex(
      (l) => l.ev === "auto_capture_start" && String(l.sid) === sid,
    );
    // The receipt exists, names the event as proceeding, and rides FIRST:
    // a reader must be able to tell "cut before start" from "never arrived".
    expect(seenIdx).toBeGreaterThanOrEqual(0);
    expect(String(lines[seenIdx].discard)).toBe("none");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(seenIdx).toBeLessThan(startIdx);
    // Exactly one receipt per delivered event — not one per attempt.
    expect(ev(lines, "auto_capture_seen").length).toBe(1);
  } finally {
    park.release();
  }
});

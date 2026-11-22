// Pins what the capture subscription does when the evidence log cannot be
// written while a turn is being handled.
//
// The contract:
//   The subscription survives every failure inside one event's handling, so the
//   next turn is still dispatched. The loop is the only thing that turns capture
//   on for every later turn of the process, and a receipt cannot report its own
//   failure — the log is the broken channel.
//   An evidence write never cancels the pass it describes: the pass reaches the
//   model call and completes whatever the log accepts.
//
// The failure these tests reproduce is a mid-session one. The log is writable
// while the pass begins and read-only by the time it completes, so the write
// that fails is a completion receipt, not the start receipt — the shape a
// permission change, a full disk or a swapped symlink produces after the
// plugin is already running.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetState } from "../../src/core/state.ts";
import { setRepoScope } from "../../src/identity/repokey.ts";
import { resetCaptureCooldowns } from "../../src/index.ts";
import { evidenceDir } from "../../src/core/config/paths.ts";
import { dateStr } from "../../src/core/time.ts";
import { type LoadedPlugin, loadPlugin } from "../harness.ts";
import { sleep } from "../helpers/logfmt.ts";
import { removeStore } from "../helpers/remove-store.ts";

let root: string;
let plugin: LoadedPlugin | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-unwritable-"));
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

/** True when the condition holds before the budget runs out, without throwing. */
async function settles(
  cond: () => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(5);
  }
  return true;
}

// A context thick enough to mine (>=200 chars), so a pass reaches the model
// instead of skipping on a thin transcript, and a `[]` answer so it completes
// without entering the write gate.
function thickMessages(): unknown[] {
  return [
    {
      role: "user",
      content:
        "We finished the archive change. Remember that the nightly archive job keeps fourteen " +
        "days of tarballs, and the batch importer respects the staging rate limit of 120 " +
        "requests per minute per key, which matters for the importer.",
    },
    {
      role: "assistant",
      content:
        "Got it: fourteen days of tarballs in the nightly archive, and I will respect the " +
        "120 requests per minute staging limit while wiring the batch importer tooling.",
    },
  ];
}

function turnEnd(sessionID: string): unknown {
  return { type: "session.execution.succeeded", data: { sessionID } };
}

/** The day file, once the plugin's own first line has created it. */
async function dayFile(): Promise<string> {
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  await waitFor(() => existsSync(file), 3000);
  return file;
}

test("a turn after an unwritable evidence log still dispatches its capture", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  loaded.capture.context.messages = thickMessages();
  loaded.capture.generate.response = "[]";
  await waitFor(() => loaded.capture.events.subscribeCalls === 2);
  const file = await dayFile();

  // Baseline: a healthy pass, so the second turn is compared against a
  // subscription that was demonstrably running.
  loaded.capture.events.push(turnEnd("ses-before"));
  await waitFor(() => loaded.capture.generate.calls.length === 1);

  // The log breaks mid-session. This pass reaches the model and then fails on
  // its completion receipt, so it is the turn that carries the failure.
  chmodSync(file, 0o400);
  try {
    loaded.capture.events.push(turnEnd("ses-broken"));
    await waitFor(() => loaded.capture.generate.calls.length === 2);
    // The contract: the failed receipt ends that turn, not the subscription.
    // A later turn is the only observation that separates the two.
    loaded.capture.events.push(turnEnd("ses-after"));
    expect(
      await settles(() => loaded.capture.generate.calls.length === 3),
    ).toBe(true);
  } finally {
    chmodSync(file, 0o600);
  }
});

test("a failing capture-failure receipt does not end the subscription", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  loaded.capture.context.messages = thickMessages();
  loaded.capture.generate.response = "[]";
  await waitFor(() => loaded.capture.events.subscribeCalls === 2);
  const file = await dayFile();

  loaded.capture.events.push(turnEnd("ses-healthy"));
  await waitFor(() => loaded.capture.generate.calls.length === 1);

  // Both halves of one turn now fail: the model call rejects, and the receipt
  // that would report the rejection cannot be written either. Neither is
  // allowed to reach the loop.
  chmodSync(file, 0o400);
  try {
    loaded.capture.generate.throws = new Error("capture model unavailable");
    loaded.capture.events.push(turnEnd("ses-throws"));
    await waitFor(() => loaded.capture.generate.calls.length === 2);
    loaded.capture.generate.throws = undefined;
    loaded.capture.events.push(turnEnd("ses-next"));
    expect(
      await settles(() => loaded.capture.generate.calls.length === 3),
    ).toBe(true);
  } finally {
    chmodSync(file, 0o600);
  }
});

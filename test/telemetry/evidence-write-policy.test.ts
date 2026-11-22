// Pins what an evidence write does when it fails, and what survives to report
// it.
//
// The policy:
//   An evidence write is diagnostic telemetry about a feature, not a dependency
//   of it. On the capture path a failed line is counted and dropped; it never
//   throws, so it cannot cancel the pass that wrote it or end the subscription
//   that hands capture every later turn.
//   `record` and `recordSync` keep throwing for every other caller. A viewer
//   edit or a gate refusal that cannot write its audit line is a failed
//   operation the operator must see.
//   The counter is the only channel that can report a broken log — a line about
//   it cannot land either — so `memory_status` reads it from process memory.
//   It is keyed by the evidence directory: one store's broken log is not
//   another store's.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetState } from "../../src/core/state.ts";
import { setRepoScope } from "../../src/identity/repokey.ts";
import { resetCaptureCooldowns } from "../../src/index.ts";
import { evidenceDir } from "../../src/core/config/paths.ts";
import { dateStr } from "../../src/core/time.ts";
import {
  droppedEvidenceWrites,
  record,
  recordBestEffort,
  recordCaptureLagBestEffort,
  recordSyncBestEffort,
} from "../../src/telemetry/record.ts";
import { evidenceWriteLines } from "../../src/status/report.ts";
import { type LoadedPlugin, loadPlugin } from "../harness.ts";
import { sleep } from "../helpers/logfmt.ts";
import { removeStore } from "../helpers/remove-store.ts";

let root: string;
let plugin: LoadedPlugin | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-evwrite-"));
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

/** The day file, created by a first successful write and then made unwritable. */
async function unwritableDayFile(): Promise<string> {
  await record("baseline", {});
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  expect(existsSync(file)).toBe(true);
  chmodSync(file, 0o400);
  return file;
}

test("a failed async evidence write is counted and never thrown", async () => {
  const file = await unwritableDayFile();
  try {
    await recordBestEffort("capture_cost", { session: "ses_a" });
    const lost = droppedEvidenceWrites();
    expect(lost?.dropped).toBe(1);
    expect(lost?.lastEvent).toBe("capture_cost");
    expect(String(lost?.lastError)).toContain("EACCES");
  } finally {
    chmodSync(file, 0o600);
  }
});

test("a failed synchronous evidence write is counted and never thrown", () => {
  mkdirSync(evidenceDir(), { recursive: true });
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  writeFileSync(file, "ev=baseline\n");
  chmodSync(file, 0o400);
  try {
    recordSyncBestEffort("auto_capture_start", { trigger: "idle" });
    const lost = droppedEvidenceWrites();
    expect(lost?.dropped).toBe(1);
    expect(lost?.lastEvent).toBe("auto_capture_start");
  } finally {
    chmodSync(file, 0o600);
  }
});

test("a failed lag receipt is counted under the event it writes", async () => {
  const file = await unwritableDayFile();
  try {
    await recordCaptureLagBestEffort("ses_a", 1200, "empty");
    const lost = droppedEvidenceWrites();
    expect(lost?.lastEvent).toBe("capture_lag");
  } finally {
    chmodSync(file, 0o600);
  }
});

test("the strict writer still throws and stays out of the counter", async () => {
  const file = await unwritableDayFile();
  try {
    await expect(record("write_promoted", { mem: "ts" })).rejects.toThrow();
    // The policy lives in the wrappers alone: a strict failure is the caller's
    // own error, not a dropped diagnostic line.
    expect(droppedEvidenceWrites()).toBe(null);
  } finally {
    chmodSync(file, 0o600);
  }
});

test("one store's lost writes are not another store's", async () => {
  const file = await unwritableDayFile();
  try {
    await recordBestEffort("capture_cost", {});
    expect(droppedEvidenceWrites()?.dropped).toBe(1);
    const other = mkdtempSync(join(tmpdir(), "osi-evwrite-other-"));
    const previous = process.env.OPENCODE_MEMORY_DIR;
    process.env.OPENCODE_MEMORY_DIR = join(other, "memory");
    try {
      expect(droppedEvidenceWrites()).toBe(null);
    } finally {
      process.env.OPENCODE_MEMORY_DIR = previous;
      removeStore(other);
    }
    expect(droppedEvidenceWrites()?.dropped).toBe(1);
  } finally {
    chmodSync(file, 0o600);
  }
});

test("the report names the loss and states that the log-derived lines under-count", () => {
  expect(evidenceWriteLines(null)).toEqual([]);
  expect(
    evidenceWriteLines({ dropped: 0, lastEvent: "", lastError: "" }),
  ).toEqual([]);
  const rendered = evidenceWriteLines({
    dropped: 3,
    lastEvent: "capture_cost",
    lastError: "EACCES: permission denied, open '/tmp/day.logfmt'",
  }).join("\n");
  expect(rendered).toContain("evidence writes dropped: 3");
  expect(rendered).toContain("capture_cost");
  expect(rendered).toContain("EACCES");
  expect(rendered).toContain("capture kept running");
  // A provider error string is unbounded; the report line is not.
  const long = evidenceWriteLines({
    dropped: 1,
    lastEvent: "capture_lag",
    lastError: "x".repeat(400),
  }).join("\n");
  expect(long).toContain(`${"x".repeat(160)}`);
  expect(long).not.toContain(`${"x".repeat(161)}`);
});

test("memory_status reports dropped evidence writes after a broken log", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  loaded.capture.context.messages = [
    {
      role: "user",
      content:
        "We finished the archive change. Remember that the nightly archive job keeps fourteen " +
        "days of tarballs, and the batch importer respects the staging rate limit of 120 " +
        "requests per minute per key, which matters for the importer.",
    },
  ];
  loaded.capture.generate.response = "[]";
  await waitFor(() => loaded.capture.events.subscribeCalls === 2);
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  await waitFor(() => existsSync(file), 3000);
  chmodSync(file, 0o400);
  try {
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-broken" },
    });
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    // Give the pass time to reach the receipt that fails after the model call.
    await settles(() => (droppedEvidenceWrites()?.dropped ?? 0) >= 1);
    const report = await loaded.tools.memory_status!.execute({});
    expect(report.content).toContain("evidence writes dropped:");
    expect(report.content).toContain("capture kept running");
  } finally {
    chmodSync(file, 0o600);
  }
});

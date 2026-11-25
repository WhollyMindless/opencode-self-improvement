// Contract: the auto-capture subscription loop is the only thing that hands
// capture every later turn, and nothing resubscribes after it ends. So when
// its event iterator throws while the instance is live, the exit must
// announce itself on the console — the one channel that survives a broken
// evidence log — instead of killing capture in silence. An abort is teardown,
// not an anomaly, and leaves no console line. The dropped-write counter
// measures lost evidence WRITES: a loop exit drops no write, so it must not
// tick the counter, and the dead loop writes no receipt.
//
// The shipped harness fake iterator parks and yields but cannot throw, so
// this file wraps `ctx.event.subscribe` in-process (patching the
// default-exported plugin's `setup` before loading) and arms a throw that
// fires from the parked iterator's next `next()` instead of delivering a
// sentinel wake. The patch is scoped to this file and restored in afterAll.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pluginMod from "../../index.ts";
import { resetState } from "../../src/core/state.ts";
import { setRepoScope } from "../../src/identity/repokey.ts";
import { resetCaptureCooldowns } from "../../src/index.ts";
import { droppedEvidenceWrites } from "../../src/telemetry/record.ts";
import { type LoadedPlugin, loadPlugin } from "../harness.ts";
import { sleep } from "../helpers/logfmt.ts";
import { removeStore } from "../helpers/remove-store.ts";

// --- subscribe monkey-patch: armed iterators can throw -----------------------
type ArmedSub = { pendingThrow: Error | undefined };
const armedSubs: ArmedSub[] = [];
const realSetup = (pluginMod as { setup?: unknown }).setup;
(
  pluginMod as unknown as {
    setup: (
      this: unknown,
      ctx: {
        event: {
          subscribe: (o?: { signal?: AbortSignal }) => AsyncGenerator<unknown>;
        };
      },
    ) => unknown;
  }
).setup = function (
  this: unknown,
  ctx: {
    event: {
      subscribe: (o?: { signal?: AbortSignal }) => AsyncGenerator<unknown>;
    };
  },
) {
  const inner = ctx.event.subscribe;
  ctx.event.subscribe = (o?: { signal?: AbortSignal }) => {
    const it = inner(o);
    const armed: ArmedSub = { pendingThrow: undefined };
    armedSubs.push(armed);
    return (async function* () {
      for (;;) {
        // Armed before the wait: a throw replaces this pull entirely.
        if (armed.pendingThrow) throw armed.pendingThrow;
        const step = await it.next();
        // Armed while parked: throw INSTEAD of delivering the wake value,
        // so the event never reaches the plugin body.
        if (armed.pendingThrow) throw armed.pendingThrow;
        if (step.done) return;
        yield step.value;
      }
    })();
  };
  return (realSetup as (c: never) => unknown).call(this, ctx as never);
};
const patched = (pluginMod as { setup?: unknown }).setup !== realSetup;

// --- fixtures (capture-dispose-drain.test.ts pattern) -------------------------
const WARN_NAME =
  "[opencode-self-improvement] auto-capture (idle) subscription failed (ignored):";

let root: string;
let plugin: LoadedPlugin | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-sub-death-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  mkdirSync(join(root, "repo"), { recursive: true });
  resetState();
  resetCaptureCooldowns();
  setRepoScope(null);
  armedSubs.length = 0;
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
afterAll(() => {
  (pluginMod as unknown as { setup: unknown }).setup = realSetup;
  console.warn = realWarn;
});

// console.warn capture — precedent: test/host/plugin-shim.test.ts.
const warns: string[] = [];
const realWarn = console.warn;
beforeEach(() => {
  warns.length = 0;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(" "));
  };
});
afterEach(() => {
  console.warn = realWarn;
});

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

function captureWarns(): string[] {
  return warns.filter((w) => w.includes(WARN_NAME));
}

const turnEnd = (sessionID: string) => ({
  type: "session.execution.succeeded",
  data: { sessionID },
});

/** Load an armed instance and prove one healthy idle pass reached the model. */
async function aliveInstance(): Promise<LoadedPlugin> {
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
    {
      role: "assistant",
      content:
        "Got it: fourteen days of tarballs in the nightly archive, and I will respect the " +
        "120 requests per minute staging limit while wiring the batch importer tooling.",
    },
  ];
  loaded.capture.generate.response = "[]";
  await waitFor(() => loaded.capture.events.subscribeCalls === 2);
  loaded.capture.events.push(turnEnd("ses-pin-alive"));
  await waitFor(() => loaded.capture.generate.calls.length === 1);
  return loaded;
}

test("a throwing event iterator names the dead capture loop on the console, with no receipt and no dropped-write tick", async () => {
  expect(patched).toBe(true); // the wrap must be live or the test measures nothing
  const loaded = await aliveInstance();
  const counterBefore = droppedEvidenceWrites();
  // Arm every subscription and wake the parked iterators: the sentinel is
  // never delivered, the iterator throws instead.
  for (const s of armedSubs)
    s.pendingThrow = new Error("event iterator exploded");
  loaded.capture.events.push({ type: "subscription-death.sentinel", data: {} });
  // The fix's trace, awaited (not slept for): the exact guarded()-shape line.
  await waitFor(() => captureWarns().length > 0);
  expect(captureWarns()).toEqual([`${WARN_NAME} event iterator exploded`]);
  // The counter measures lost evidence WRITES. Nothing was dropped here, so
  // a tick would misreport data loss to every later reader of memory_status.
  expect(droppedEvidenceWrites()).toEqual(counterBefore);
  // The loop is not recovered by the guard, only made visible: a later
  // turn-end leaves no capture trace. Recovery would be a different contract.
  const generateBefore = loaded.capture.generate.calls.length;
  loaded.capture.events.push(turnEnd("ses-pin-after"));
  await sleep(250);
  expect(loaded.capture.generate.calls.length).toBe(generateBefore);
});

test("an aborted iterator exit leaves no console line — teardown is not an anomaly", async () => {
  expect(patched).toBe(true);
  const loaded = await aliveInstance();
  // Arm the throw, THEN abort: the iterator wakes on the abort and throws
  // with the signal already set, the shape cleanup produces.
  for (const s of armedSubs)
    s.pendingThrow = new Error("iterator torn at teardown");
  // cleanup() aborts the capture controller; the armed wrappers then throw
  // into the loop's outer catch with the signal set — the abort branch.
  await loaded.cleanup();
  await sleep(500);
  expect(captureWarns()).toEqual([]);
});

// The host hooks around capture: which turn-end events trigger it, how a capture
// model is chosen (explicit, inherited, or invalid and therefore unregistered),
// what plugin_load records on the heartbeat, and what a throwing hook leaves in
// the evidence log.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCaptureCursors } from "../../src/capture/policy.ts";
import { guarded } from "../../src/core/hooks.ts";
import { resetState } from "../../src/core/state.ts";
import { setRepoScope } from "../../src/identity/repokey.ts";
import { resetCaptureCooldowns, resetSessionModels } from "../../src/index.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { loadPlugin } from "../harness.ts";
import { readEvidenceLog as evidence, sleep } from "../helpers/logfmt.ts";
import { removeStore } from "../helpers/remove-store.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-capture-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  setRepoScope(null);
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
  resetCaptureCooldowns(); // cooldown truth is module-level since the cooldown refactor - and bun test shares module state across files, so a fresh test needs this explicit clear
  resetSessionModels(); // same module-level truth for the session-model registry
  resetCaptureCursors(); // the delta cursor and signal window are module-level too
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  removeStore(root);
});

/**
 * Wait for a positive effect, with a budget the shared loop can actually meet.
 *
 * `bun test --parallel` runs every suite file in ONE process, so a capture
 * pipeline that lands in tens of ms idle can stretch 4-8x under a loaded
 * hosted runner (measured there: a 640 ms test at 5083 ms; a 150 ms
 * fixed-sleep control at 0 rows). The 2000 ms this file used to guess was a
 * harness constant racing that loop — the production capture path has no such
 * deadline. 10 s still fails, loudly and with a real message, when the effect
 * never arrives; bun's own per-test guard is raised to match (package.json
 * `test` script).
 */
async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

async function loadCapturePlugin(options: Record<string, unknown>) {
  return loadPlugin(liveRoot, options);
}

describe("turn-end trigger vocabulary", () => {
  const armed = { autoCapture: true, captureModel: "fake/model" };

  async function modelCallsAfter(
    event: Record<string, unknown>,
    shouldCapture = false,
  ): Promise<number> {
    const loaded = await loadCapturePlugin(armed);
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.generate.response = "[]";
    loaded.capture.events.push(event);
    if (shouldCapture) {
      const data = event.data as { sessionID?: string } | undefined;
      await waitFor(() =>
        evidence().some(
          (line) =>
            line.ev === "capture_lag" && line.session === data?.sessionID,
        ),
      );
    } else {
      await sleep(120);
    }
    const calls = loaded.capture.generate.calls.length;
    await loaded.cleanup();
    return calls;
  }

  test("session.execution.succeeded fires the capture model", async () => {
    expect(
      await modelCallsAfter(
        {
          type: "session.execution.succeeded",
          data: { sessionID: "ses-t1" },
        },
        true,
      ),
    ).toBe(1);
  });

  test("session.execution.interrupted fires too — the context is ending either way", async () => {
    expect(
      await modelCallsAfter(
        {
          type: "session.execution.interrupted",
          data: { sessionID: "ses-t2" },
        },
        true,
      ),
    ).toBe(1);
  });

  test("declared-but-never-emitted events do NOT fire: `session.status`", async () => {
    // The protocol declares it; a live host was never observed sending it
    // (150 s over a turn plus 80 s quiet). Supporting it would be speculative.
    expect(
      await modelCallsAfter({
        type: "session.status",
        data: { sessionID: "ses-t3", status: { type: "idle" } },
      }),
    ).toBe(0);
  });

  test("declared-but-never-emitted events do NOT fire: `session.idle`", async () => {
    expect(
      await modelCallsAfter({
        type: "session.idle",
        data: { sessionID: "ses-legacy" },
      }),
    ).toBe(0);
    expect(
      await modelCallsAfter({ type: "session.idle", sessionID: "ses-legacy2" }),
    ).toBe(0);
  });

  test("`session.execution.failed` does not capture (declared, not reproduced)", async () => {
    const loaded = await loadCapturePlugin(armed);
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.events.push({
      type: "session.execution.failed",
      data: { sessionID: "ses-fail" },
    });
    await sleep(120);
    expect(loaded.capture.generate.calls.length).toBe(0);
    expect((await loadAll()).length).toBe(0);
    await loaded.cleanup();
  });
});

// ---- capture model inheritance ---------------------------------------
// Requiring captureModel alongside autoCapture was a syntax tax: autoCapture is
// on by default, the host already delivers the session's model on every
// session hook (SessionRequest.model), and the tax's failure mode was a silent
// disable. These pin the inheritance chain — explicit option, then the ref the
// session.context hook carried, then the host default, and only then a skip —
// plus model= on the capture evidence lines so cost is attributable.
describe("capture model inheritance", () => {
  test("no captureModel: capture fires with the ref the session.context hook carried", async () => {
    const loaded = await loadCapturePlugin({ autoCapture: true });
    // Red on main: an omitted captureModel disabled the whole subscription,
    // so subscribeCalls stayed 1 (measured listener only).
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    await loaded["experimental.chat.system.transform"](
      {
        sessionID: "ses-inherit",
        model: { providerID: "fake", id: "session-model" },
      },
      { system: [] },
    );
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.generate.response = "[]";
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-inherit" },
    });
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    expect(loaded.capture.generate.calls[0].model).toEqual({
      providerID: "fake",
      id: "session-model",
    });
    await loaded.cleanup();
  });

  test("no session ref recorded: the host default model is used", async () => {
    const loaded = await loadCapturePlugin({ autoCapture: true });
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    loaded.capture.modelDefault = {
      providerID: "host",
      modelID: "default-model",
    };
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.generate.response = "[]";
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-default" },
    });
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    expect(loaded.capture.generate.calls[0].model).toEqual({
      providerID: "host",
      id: "default-model",
    });
    await loaded.cleanup();
  });

  test("neither session ref nor host default: skip with reason=no_model, no tokens spent", async () => {
    const loaded = await loadCapturePlugin({ autoCapture: true });
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-nomodel" },
    });
    await waitFor(() =>
      evidence().some(
        (l) => l.ev === "auto_capture_refused" && l.reason === "no_model",
      ),
    );
    expect(loaded.capture.generate.calls.length).toBe(0);
    expect(loaded.capture.context.calls.length).toBe(0);
    await loaded.cleanup();
  });

  test("an explicit captureModel still wins over the session's model", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "explicit/model",
    });
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    await loaded["experimental.chat.system.transform"](
      {
        sessionID: "ses-explicit",
        model: { providerID: "fake", id: "session-model" },
      },
      { system: [] },
    );
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.generate.response = "[]";
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-explicit" },
    });
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    expect(loaded.capture.generate.calls[0].model).toEqual({
      providerID: "explicit",
      id: "model",
    });
    await loaded.cleanup();
  });

  test("capture evidence lines carry model= for the model that ran", async () => {
    const loaded = await loadCapturePlugin({ autoCapture: true });
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    // Ground the session so the gate promotes the candidate (see the dupe test).
    await loaded["tool.execute.after"](
      {
        tool: "read",
        sessionID: "ses-modeltag",
        callID: "C1",
        args: { filePath: "x.ts" },
      },
      { title: "read", output: "content", metadata: {} },
    );
    await loaded["experimental.chat.system.transform"](
      {
        sessionID: "ses-modeltag",
        model: { providerID: "fake", id: "session-model" },
      },
      { system: [] },
    );
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.generate.response = JSON.stringify([
      {
        type: "learning",
        scope: "capture",
        content:
          "Evidence lines name the model that produced the candidate row.",
      },
    ]);
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-modeltag" },
    });
    // Session-scoped wait on the LAST line the capture pass appends: the
    // evidence log is shared across this file, and the old unscoped match on
    // auto_capture_promoted could be satisfied by an earlier test's promoted
    // line before THIS capture's trailing capture_lag line had been appended —
    // the race that turned CI red at c9193f9 (the lag lookup then saw no
    // line, model=undefined). capture_lag is written after every candidate
    // line of its pass (src/capture/runtime.ts), so waiting for this session's
    // lag line orders both lookups, and the session filter strengthens the
    // promoted assertion too.
    await waitFor(() =>
      evidence().some(
        (l) => l.ev === "capture_lag" && l.session === "ses-modeltag",
      ),
    );
    const promoted = evidence().find(
      (l) => l.ev === "auto_capture_promoted" && l.session === "ses-modeltag",
    );
    expect(String(promoted?.model)).toBe("fake/session-model");
    const lag = evidence().find(
      (l) => l.ev === "capture_lag" && l.session === "ses-modeltag",
    );
    expect(String(lag?.model)).toBe("fake/session-model");
    await loaded.cleanup();
  });
});

// ---- startup heartbeat ----------------------------------------------
// Every other evidence line is written BY something that already worked, so
// "off", "misconfigured" and "armed but inert" looked identical from any
// artifact a user can read — the reason a pipeline that had never run survived a
// review and a merge. These pin that the load line distinguishes them.
describe("plugin_load heartbeat", () => {
  const heartbeat = () =>
    evidence()
      .filter((e) => e.ev === "plugin_load")
      .pop();

  test("default options: capture=on, and the subscribed vocabulary is visible", async () => {
    // Absent key means armed: a plain install mines turn ends. The line must
    // say so, or a user reads "off" in a working install and goes looking for
    // a bug that is not there.
    const loaded = await loadCapturePlugin({});
    const line = heartbeat();
    expect(line?.capture).toBe("on");
    expect(String(line?.subscribed)).toContain("session.execution.succeeded");
    expect(typeof line?.version).toBe("string");
    await loaded.cleanup();
  });

  test("autoCapture false: capture=off, the one opt-out", async () => {
    const loaded = await loadCapturePlugin({ autoCapture: false });
    expect(heartbeat()?.capture).toBe("off");
    await loaded.cleanup();
  });

  test("armed with a bad model: capture=invalid_model, not silence", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "no-slash-model",
    });
    expect(heartbeat()?.capture).toBe("invalid_model");
    await loaded.cleanup();
  });

  test("armed correctly: capture=on with all three capabilities present", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
    });
    const line = heartbeat();
    expect(line?.capture).toBe("on");
    expect(String(line?.capabilities)).toBe(
      "[event.subscribe,generate.text,session.context]",
    );
    await loaded.cleanup();
  });

  test("armed with NO captureModel: capture=on, the inherited-model arm", async () => {
    // Omitted is a valid arm now: the capture inherits per session. Only an
    // explicit malformed string is invalid_model (the test above).
    const loaded = await loadCapturePlugin({ autoCapture: true });
    expect(heartbeat()?.capture).toBe("on");
    await loaded.cleanup();
  });

  test("switch mismatch: autoCapture false with captureOnCompact true", async () => {
    // The master switch is off while a trigger behind it is on, so nothing can
    // fire. The evidence file must name that state, or "the user opted out" and
    // "the user set a contradictory pair" stay one line.
    const loaded = await loadCapturePlugin({
      autoCapture: false,
      captureOnCompact: true,
    });
    expect(heartbeat()?.capture).toBe("switch_mismatch");
    await loaded.cleanup();
  });

  test("captureOnCompact alone is plain on: no mismatch to report", async () => {
    const loaded = await loadCapturePlugin({ captureOnCompact: true });
    expect(heartbeat()?.capture).toBe("on");
    await loaded.cleanup();
  });
});

// ---- swallowed hook failures -----------------------------------------
// guarded() is fail-soft by design, but a plugin failing EVERY turn looked
// identical to a healthy one in every artifact: the console.warn lands in the
// host log, which the user never reads. setup() installs an evidence-backed
// reporter so the swallowed failure reaches the same file as the heartbeat —
// hook name + error class only, never the message (a hook payload can carry
// conversation content).
describe("hook_error evidence", () => {
  test("a guarded failure lands in the evidence file as hook_error, class only", async () => {
    const loaded = await loadCapturePlugin({});
    await guarded("demo-hook", async () => {
      throw new TypeError("boom: secret transcript fragment");
    });
    const line = evidence()
      .filter((e) => e.ev === "hook_error")
      .pop();
    expect(line?.hook).toBe("demo-hook");
    expect(line?.error).toBe("TypeError");
    // Never the message: content must not reach the durable log.
    expect(
      evidence().some((l) =>
        Object.values(l).some((v) => String(v).includes("secret transcript")),
      ),
    ).toBe(false);
    await loaded.cleanup();
  });

  test("a non-Error throw still records, with typeof as the class", async () => {
    const loaded = await loadCapturePlugin({});
    await guarded("string-throw-hook", async () => {
      throw "plain string";
    });
    const line = evidence()
      .filter((e) => e.ev === "hook_error")
      .pop();
    expect(line?.hook).toBe("string-throw-hook");
    expect(line?.error).toBe("string");
    await loaded.cleanup();
  });
});

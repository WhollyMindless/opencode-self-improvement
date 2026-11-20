// The two levers that stop paying for work already stored: the signal gate (skip
// a turn that produced nothing durable) and the delta window (mine only what has
// not been mined). Both are OFF unless the option says otherwise, so every case
// here also proves the default path is unchanged. The hint channel keeps its
// rows through the same gate.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCaptureCursors } from "../../src/capture/policy.ts";
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

//
// Every turn end used to trigger a capture that re-mined the whole session.
// These pin the two levers that stop paying for work already stored: the signal
// gate (skip a turn that produced nothing durable) and the delta window (mine
// only what has not been mined). Both are OFF unless the option says otherwise,
// so the tests above also prove the default path is unchanged.

const longText = (marker: string) =>
  `${marker} ${"detail that keeps the transcript above the thin floor ".repeat(6)}`;

const turnEnd = (sid: string) => ({
  type: "session.execution.succeeded",
  data: { sessionID: sid },
});

describe("capture cost policy", () => {
  test.each([false, true])(
    "a failure-only turn captures once with captureDelta=%s",
    async (captureDelta) => {
      const sid = "ses-unrecovered";
      const loaded = await loadCapturePlugin({
        autoCapture: true,
        captureModel: "fake/model",
        captureOnSignal: true,
        captureDelta,
      });
      try {
        await loaded.sessionHooks.prompt?.({
          sessionID: sid,
          prompt: { text: "investigate the cart totals" },
        });
        await loaded["tool.execute.after"](
          {
            tool: "bash",
            sessionID: sid,
            callID: "failed-test",
            args: { command: "bun test ./src/cart.test.ts" },
          },
          {
            output: "(fail) cart > total\n1 fail\n0 pass",
            metadata: { exit: 1 },
          },
        );
        const first = [
          { role: "user", content: longText("investigate the cart totals") },
          {
            role: "assistant",
            content: longText(
              "the test failed; investigation ended without an edit",
            ),
          },
        ];
        loaded.capture.context.messages = first;
        loaded.capture.generate.response = JSON.stringify([
          {
            type: "blocker",
            scope: "cart",
            content:
              "when the cart spans two warehouses, avoid summing in report.ts — mergeStock in warehouse.ts drops the backorder flag",
            failure: "bun test ./src/cart.test.ts",
          },
        ]);
        // A failed tool command is distinct from the host's turn-end event.
        // Use the existing observed event vocabulary; no new trigger is added.
        loaded.capture.events.push(turnEnd(sid));
        await waitFor(() =>
          evidence().some(
            (e) =>
              e.session === sid &&
              (e.ev === "capture_lag" || e.ev === "auto_capture_skipped"),
          ),
        );
        expect(loaded.capture.generate.calls.length).toBe(1);
        expect(String(loaded.capture.generate.calls[0].prompt)).toContain(
          "ATTESTED FAILURES",
        );
        const row = (await loadAll()).find((r) => r.scope === "cart");
        expect(row?.content).toContain("avoid summing in report.ts");
        expect(row?.tags).toContain("auto-capture");

        // Bypass only cooldown, so the signal cursor must prevent replay of the
        // old failure. Both full-transcript and delta capture use that cursor.
        resetCaptureCooldowns();
        await loaded.sessionHooks.prompt?.({
          sessionID: sid,
          prompt: { text: "read the cart module again" },
        });
        await loaded["tool.execute.after"](
          {
            tool: "read",
            sessionID: sid,
            callID: "later-read",
            args: { filePath: "src/cart.ts" },
          },
          { output: longText("cart source"), metadata: {} },
        );
        loaded.capture.context.messages = [
          ...first,
          { role: "user", content: longText("read the cart module again") },
        ];
        loaded.capture.events.push(turnEnd(sid));
        await waitFor(() =>
          evidence().some(
            (e) =>
              e.session === sid &&
              e.ev === "auto_capture_skipped" &&
              e.reason === "no-signal",
          ),
        );
        expect(loaded.capture.generate.calls.length).toBe(1);
      } finally {
        await loaded.cleanup();
      }
    },
  );

  test("the signal gate skips a turn that only read files", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
      captureOnSignal: true,
    });
    await loaded.sessionHooks.prompt?.({
      sessionID: "ses-sig",
      prompt: { text: "look at the pricing module" },
    });
    await loaded["tool.execute.after"](
      {
        tool: "read",
        sessionID: "ses-sig",
        callID: "C1",
        args: { filePath: "src/pricing.ts" },
      },
      { title: "read", output: longText("read-body"), metadata: {} },
    );
    loaded.capture.context.messages = [
      { type: "user", text: longText("look at pricing") },
      {
        type: "assistant",
        content: [{ type: "text", text: longText("it computes tax") }],
      },
    ];
    loaded.capture.events.push(turnEnd("ses-sig"));
    await Bun.sleep(300);
    expect(loaded.capture.generate.calls.length).toBe(0);
    await loaded.cleanup();
  });

  test("the signal gate captures a turn that edited a file", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
      captureOnSignal: true,
    });
    await loaded.sessionHooks.prompt?.({
      sessionID: "ses-edit",
      prompt: { text: "fix the tax rate" },
    });
    await loaded["tool.execute.after"](
      {
        tool: "edit",
        sessionID: "ses-edit",
        callID: "C1",
        args: { filePath: "src/pricing.ts" },
      },
      {
        title: "edit",
        output: longText("changed TAX_RATE to 0.0825"),
        metadata: {},
      },
    );
    loaded.capture.context.messages = [
      { type: "user", text: longText("fix the tax rate") },
      {
        type: "assistant",
        content: [{ type: "text", text: longText("TAX_RATE is now 0.0825") }],
      },
    ];
    loaded.capture.generate.response = "[]";
    loaded.capture.events.push(turnEnd("ses-edit"));
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    await loaded.cleanup();
  });

  test("the delta window mines only what came after the last capture", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
      captureDelta: true,
    });
    const first = [
      { type: "user", text: longText("ALPHA-request fix pricing") },
      {
        type: "assistant",
        content: [
          { type: "text", text: longText("ALPHA-answer tax is 0.0825") },
        ],
      },
    ];
    loaded.capture.context.messages = first;
    loaded.capture.generate.response = "[]";
    await loaded.sessionHooks.prompt?.({
      sessionID: "ses-delta",
      prompt: { text: longText("ALPHA") },
    });
    loaded.capture.events.push(turnEnd("ses-delta"));
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    expect(String(loaded.capture.generate.calls[0].prompt)).toInclude(
      "ALPHA-request",
    );

    // Second turn: the session context now carries both turns. The cursor says
    // the first two messages are already mined, so only the new ones go to the
    // model — which is the whole token saving.
    resetCaptureCooldowns();
    loaded.capture.context.messages = [
      ...first,
      { type: "user", text: longText("BETA-request fix shipping") },
      {
        type: "assistant",
        content: [
          { type: "text", text: longText("BETA-answer free at 100.00") },
        ],
      },
    ];
    await loaded.sessionHooks.prompt?.({
      sessionID: "ses-delta",
      prompt: { text: longText("BETA") },
    });
    loaded.capture.events.push(turnEnd("ses-delta"));
    await waitFor(() => loaded.capture.generate.calls.length === 2);
    const second = String(loaded.capture.generate.calls[1].prompt);
    expect(second).toInclude("BETA-request");
    expect(second).not.toInclude("ALPHA-request");
    await loaded.cleanup();
  });

  //review [P2]: compaction REPLACES the transcript, so the cursor can
  // point past the end of a shorter array. An empty window was then skipped as
  // too thin, and a skip does not advance the cursor — so every later turn was
  // skipped too, until the context grew past the old count.
  test("a shrunken context is mined, not skipped forever", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
      captureDelta: true,
    });
    const first = [
      { type: "user", text: longText("ALPHA-request fix pricing") },
      {
        type: "assistant",
        content: [{ type: "text", text: longText("ALPHA-answer") }],
      },
      { type: "user", text: longText("ALPHA-request-2 fix shipping") },
      {
        type: "assistant",
        content: [{ type: "text", text: longText("ALPHA-answer-2") }],
      },
      { type: "user", text: longText("ALPHA-request-3 fix rounding") },
      {
        type: "assistant",
        content: [{ type: "text", text: longText("ALPHA-answer-3") }],
      },
    ];
    loaded.capture.context.messages = first;
    loaded.capture.generate.response = "[]";
    await loaded.sessionHooks.prompt?.({
      sessionID: "ses-shrink",
      prompt: { text: longText("ALPHA") },
    });
    loaded.capture.events.push(turnEnd("ses-shrink"));
    await waitFor(() => loaded.capture.generate.calls.length === 1);

    // Compaction: six messages become two, and one of them is guidance the
    // plugin has never seen.
    resetCaptureCooldowns();
    loaded.capture.context.messages = [
      {
        type: "user",
        text: longText("GAMMA-request the shipping threshold must be 100.00"),
      },
      {
        type: "assistant",
        content: [{ type: "text", text: longText("GAMMA-answer") }],
      },
    ];
    await loaded.sessionHooks.prompt?.({
      sessionID: "ses-shrink",
      prompt: { text: longText("GAMMA") },
    });
    loaded.capture.events.push(turnEnd("ses-shrink"));
    await waitFor(() => loaded.capture.generate.calls.length === 2);
    const second = String(loaded.capture.generate.calls[1].prompt);
    expect(second).toInclude("GAMMA-request");
    expect(second).not.toInclude("ALPHA-request");
    await loaded.cleanup();
  });

  //review [P2]: three cursor cases. A cursor is a claim about WHERE the
  // next window starts, and a message COUNT cannot express it: a transcript can
  // be replaced and then grow past the old count, and a turn can land while a
  // pass is in flight. These pins hold the cursor to what the pass actually
  // read and actually mined.
  const sixThick = (marker: string): unknown[] =>
    [1, 2, 3].flatMap((i) => [
      { type: "user", text: longText(`${marker}-request-${i} fix pricing`) },
      {
        type: "assistant",
        content: [{ type: "text", text: longText(`${marker}-answer-${i}`) }],
      },
    ]);

  test("a replaced context keeps its guidance window with the delta off", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
      captureOnSignal: true,
    });
    const sid = "ses-sig-replace";
    await loaded.sessionHooks.prompt?.({
      sessionID: sid,
      prompt: { text: longText("ALPHA") },
    });
    await loaded["tool.execute.after"](
      {
        tool: "edit",
        sessionID: sid,
        callID: "C1",
        args: { filePath: "src/pricing.ts" },
      },
      { title: "edit", output: longText("changed TAX_RATE"), metadata: {} },
    );
    loaded.capture.context.messages = sixThick("ALPHA");
    loaded.capture.generate.response = "[]";
    loaded.capture.events.push(turnEnd(sid));
    await waitFor(() => loaded.capture.generate.calls.length === 1);

    // Compaction replaces the transcript with two messages and no tool runs
    // afterwards, so only the guidance in the user's own line can open the
    // gate. The delta is off: the pass mines the whole context, so the guidance
    // window has to be the whole context too.
    resetCaptureCooldowns();
    loaded.capture.context.messages = [
      {
        type: "user",
        text: longText("GAMMA-request the shipping threshold must be 100.00"),
      },
      {
        type: "assistant",
        content: [{ type: "text", text: longText("GAMMA-answer") }],
      },
    ];
    await loaded.sessionHooks.prompt?.({
      sessionID: sid,
      prompt: { text: longText("GAMMA") },
    });
    loaded.capture.events.push(turnEnd(sid));
    await waitFor(() => loaded.capture.generate.calls.length === 2);
    expect(String(loaded.capture.generate.calls[1].prompt)).toInclude(
      "GAMMA-request",
    );
    await loaded.cleanup();
  });

  test("a replaced-then-regrown context is mined from the start", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
      captureDelta: true,
    });
    const sid = "ses-regrow";
    loaded.capture.context.messages = sixThick("ALPHA");
    loaded.capture.generate.response = "[]";
    await loaded.sessionHooks.prompt?.({
      sessionID: sid,
      prompt: { text: longText("ALPHA") },
    });
    loaded.capture.events.push(turnEnd(sid));
    await waitFor(() => loaded.capture.generate.calls.length === 1);

    // Replaced first (two messages), then regrown past the old count before any
    // capture observes it. Length now looks like an append, and the new rule is
    // sitting at index 0, below the stale cursor.
    resetCaptureCooldowns();
    loaded.capture.context.messages = [
      {
        type: "user",
        text: longText("GAMMA-request the shipping threshold must be 100.00"),
      },
      ...sixThick("DELTA"),
    ];
    await loaded.sessionHooks.prompt?.({
      sessionID: sid,
      prompt: { text: longText("GAMMA") },
    });
    loaded.capture.events.push(turnEnd(sid));
    await waitFor(() => loaded.capture.generate.calls.length === 2);
    const second = String(loaded.capture.generate.calls[1].prompt);
    expect(second).toInclude("GAMMA-request");
    expect(second).not.toInclude("ALPHA-request");
    await loaded.cleanup();
  });

  test("a turn that lands during a capture is not marked consumed", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
      captureOnSignal: true,
    });
    const sid = "ses-midturn";
    await loaded.sessionHooks.prompt?.({
      sessionID: sid,
      prompt: { text: longText("ALPHA") },
    });
    await loaded["tool.execute.after"](
      {
        tool: "edit",
        sessionID: sid,
        callID: "C1",
        args: { filePath: "src/a.ts" },
      },
      { title: "edit", output: longText("alpha edit"), metadata: {} },
    );
    loaded.capture.context.messages = sixThick("ALPHA");
    loaded.capture.generate.response = "[]";
    let release = (): void => {};
    loaded.capture.generate.park = new Promise<void>((resolve) => {
      release = resolve;
    });
    loaded.capture.events.push(turnEnd(sid));
    await waitFor(() => loaded.capture.generate.calls.length === 1);

    // Turn 2 lands while the pass is parked: its edit is not in that prompt, so
    // the pass may not consume the turn it describes.
    await loaded.sessionHooks.prompt?.({
      sessionID: sid,
      prompt: { text: longText("BETA") },
    });
    await loaded["tool.execute.after"](
      {
        tool: "edit",
        sessionID: sid,
        callID: "C2",
        args: { filePath: "src/b.ts" },
      },
      { title: "edit", output: longText("beta edit"), metadata: {} },
    );
    release();
    await sleep(200);

    // Nothing new happens between the two turn ends: the next pass must still
    // owe the turn-2 edit, because nothing mined it.
    resetCaptureCooldowns();
    loaded.capture.events.push(turnEnd(sid));
    await waitFor(() => loaded.capture.generate.calls.length === 2);
    await loaded.cleanup();
  });

  test("a seeded compaction payload counts as the window it mined", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
      captureDelta: true,
      captureOnCompact: true,
    });
    const sid = "ses-seedcursor";
    // A reply the host repeats verbatim: the assistant text cannot be what
    // tells one transcript from the next.
    const reply = {
      type: "assistant",
      text: longText("Done. The change is committed."),
    };
    loaded.capture.context.messages = [
      { type: "user", text: longText("ALPHA-request fix pricing") },
      reply,
    ];
    loaded.capture.generate.response = "[]";
    await loaded.sessionHooks.prompt?.({
      sessionID: sid,
      prompt: { text: longText("ALPHA") },
    });
    loaded.capture.events.push(turnEnd(sid));
    await waitFor(() => loaded.capture.generate.calls.length === 1);

    // The hook hands over the pre-compaction window whole: four messages, all
    // four mined. The cursor becomes 4 — adding the prior 2 to it claims six
    // messages were consumed when only four exist.
    const four = [
      { type: "user", text: longText("GAMMA-request one") },
      reply,
      { type: "user", text: longText("GAMMA-request two") },
      reply,
    ];
    resetCaptureCooldowns();
    await loaded.sessionHooks.compaction?.({
      sessionID: sid,
      system: [],
      messages: four,
    });
    await waitFor(() => loaded.capture.generate.calls.length === 2);

    // The post-compaction transcript: the four mined messages plus two new ones.
    resetCaptureCooldowns();
    loaded.capture.context.messages = [
      ...four,
      { type: "user", text: longText("BETA-request fix shipping") },
      {
        type: "assistant",
        content: [
          { type: "text", text: longText("BETA-answer free at 100.00") },
        ],
      },
    ];
    await loaded.sessionHooks.prompt?.({
      sessionID: sid,
      prompt: { text: longText("BETA") },
    });
    loaded.capture.events.push(turnEnd(sid));
    await waitFor(() => loaded.capture.generate.calls.length === 3);
    const third = String(loaded.capture.generate.calls[2].prompt);
    expect(third).toInclude("BETA-request");
    expect(third).not.toInclude("GAMMA-request");
    await loaded.cleanup();
  });

  // the boundary message alone is not the boundary. An ordinary
  // reply repeated at the consumed index makes a replaced transcript look
  // unchanged, and the new guidance below the cursor is then marked consumed.
  test("a repeated boundary message does not hide a replaced transcript", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
      captureDelta: true,
    });
    const sid = "ses-repeat-boundary";
    const reply = {
      type: "assistant",
      text: longText("Done. The change is committed."),
    };
    loaded.capture.context.messages = [
      { type: "user", text: longText("ALPHA-request-1 fix pricing") },
      reply,
      { type: "user", text: longText("ALPHA-request-2 round the total") },
      reply,
      { type: "user", text: longText("ALPHA-request-3 update the docs") },
      reply,
    ];
    loaded.capture.generate.response = "[]";
    await loaded.sessionHooks.prompt?.({
      sessionID: sid,
      prompt: { text: longText("ALPHA") },
    });
    loaded.capture.events.push(turnEnd(sid));
    await waitFor(() => loaded.capture.generate.calls.length === 1);

    // Replaced, then grown past the old count. Index 5 carries the SAME reply
    // text the old cursor boundary did; index 0 is guidance never mined.
    resetCaptureCooldowns();
    loaded.capture.context.messages = [
      {
        type: "user",
        text: longText("GAMMA-request shipping must be free at 100.00"),
      },
      reply,
      { type: "user", text: longText("GAMMA-request-2 the tax rate is 8.25%") },
      reply,
      { type: "user", text: longText("GAMMA-request-3 summarise the session") },
      reply,
      { type: "user", text: longText("DELTA-request-4 wire the exporter") },
      {
        type: "assistant",
        content: [
          { type: "text", text: longText("DELTA-answer exporter done") },
        ],
      },
    ];
    await loaded.sessionHooks.prompt?.({
      sessionID: sid,
      prompt: { text: longText("GAMMA") },
    });
    loaded.capture.events.push(turnEnd(sid));
    await waitFor(() => loaded.capture.generate.calls.length === 2);
    const second = String(loaded.capture.generate.calls[1].prompt);
    expect(second).toInclude("GAMMA-request");
    expect(second).not.toInclude("ALPHA-request");
    await loaded.cleanup();
  });

  test("without the option, a second capture still sees the whole session", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
    });
    const first = [
      { type: "user", text: longText("ALPHA-request fix pricing") },
      {
        type: "assistant",
        content: [{ type: "text", text: longText("ALPHA-answer") }],
      },
    ];
    loaded.capture.context.messages = first;
    loaded.capture.generate.response = "[]";
    await loaded.sessionHooks.prompt?.({
      sessionID: "ses-full",
      prompt: { text: longText("ALPHA") },
    });
    loaded.capture.events.push(turnEnd("ses-full"));
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    resetCaptureCooldowns();
    loaded.capture.context.messages = [
      ...first,
      { type: "user", text: longText("BETA-request fix shipping") },
      {
        type: "assistant",
        content: [{ type: "text", text: longText("BETA-answer") }],
      },
    ];
    await loaded.sessionHooks.prompt?.({
      sessionID: "ses-full",
      prompt: { text: longText("BETA") },
    });
    loaded.capture.events.push(turnEnd("ses-full"));
    await waitFor(() => loaded.capture.generate.calls.length === 2);
    const second = String(loaded.capture.generate.calls[1].prompt);
    expect(second).toInclude("BETA-request");
    expect(second).toInclude("ALPHA-request"); // today's behaviour, unchanged
    await loaded.cleanup();
  });
});

//hint-channel guard: the signal gate must never skip a window where the
// USER stated a spec. This is the exact bench shape (pass-1 hint, no tool
// activity yet): lose it and the guided row — the whole hint channel —
// dies with the session.
describe("signal gate keeps the hint channel", () => {
  test("a stated spec with no tool activity still captures", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
      captureOnSignal: true,
    });
    await loaded.sessionHooks.prompt?.({
      sessionID: "ses-guided-gate",
      prompt: {
        text: "The constant TAX_RATE in src/pricing.ts must be 0.0825.",
      },
    });
    loaded.capture.context.messages = [
      {
        type: "user",
        text: longText(
          "The constant TAX_RATE in src/pricing.ts must be 0.0825.",
        ),
      },
      {
        type: "assistant",
        content: [{ type: "text", text: longText("understood") }],
      },
    ];
    loaded.capture.generate.response = "[]";
    loaded.capture.events.push(turnEnd("ses-guided-gate"));
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    expect(String(loaded.capture.generate.calls[0].prompt)).toInclude("0.0825");
    await loaded.cleanup();
  });
});

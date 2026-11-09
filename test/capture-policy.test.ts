// Capture policy (#334): when is a capture worth paying for?
//
// The unit altitude — the signal verdicts and the cursor arithmetic. The e2e
// wiring lives in test/capture.test.ts ("capture cost policy").
import { describe, expect, test } from "bun:test";
import {
  advanceCaptureCursor,
  captureCursor,
  captureSignalSince,
  contextShrank,
  deltaMessages,
  guidedStatementInWindow,
  resetCaptureCursors,
} from "../src/capture/policy.ts";
import type { SessionState, ToolResult } from "../src/core/state.ts";

const call = (over: Partial<ToolResult>): ToolResult => ({
  call: `c-${Math.random().toString(36).slice(2, 8)}`,
  tool: "read",
  summary: "",
  ts: "2026-01-01T00:00:00.000Z",
  status: null,
  ...over,
});

const state = (calls: ToolResult[], turns = 5): SessionState =>
  ({
    sid: "ses-1",
    calls,
    callsTotal: calls.length,
    reDerives: 0,
    sawEngagement: true,
    sawGateCheck: false,
    lastByTool: new Map(),
    pendingGate: null,
    turns,
    finalized: false,
  }) as SessionState;

describe("captureSignalSince", () => {
  test("an edit in the window is a signal", () => {
    expect(
      captureSignalSince(state([call({ tool: "edit", turn: 3 })]), 2).why,
    ).toBe("edited");
    expect(
      captureSignalSince(state([call({ tool: "write", turn: 3 })]), 2).ok,
    ).toBe(true);
  });

  test("an edit BEFORE the window is not", () => {
    expect(
      captureSignalSince(state([call({ tool: "edit", turn: 1 })]), 2),
    ).toEqual({ ok: false, why: "no-signal" });
  });

  test("a gate that failed then passed is the strongest signal", () => {
    const s = state(
      [
        call({
          tool: "bash",
          turn: 3,
          gateCheck: true,
          cmd: "test",
          status: "FAIL",
        }),
        call({
          tool: "bash",
          turn: 4,
          gateCheck: true,
          cmd: "test",
          status: "PASS",
        }),
      ],
      4,
    );
    expect(captureSignalSince(s, 2).why).toBe("gateRecovered");
  });

  test("a gate that only failed is not a recovery", () => {
    const s = state([
      call({
        tool: "bash",
        turn: 3,
        gateCheck: true,
        cmd: "test",
        status: "FAIL",
      }),
    ]);
    expect(captureSignalSince(s, 2).ok).toBe(false);
  });

  test("a gate that passed and then passed again is not a recovery", () => {
    const s = state([
      call({
        tool: "bash",
        turn: 3,
        gateCheck: true,
        cmd: "lint",
        status: "PASS",
      }),
      call({
        tool: "bash",
        turn: 4,
        gateCheck: true,
        cmd: "lint",
        status: "PASS",
      }),
    ]);
    // No FAIL, so not gateRecovered; the first PASS is still a new command.
    expect(captureSignalSince(s, 2).why).toBe("newCommandPassed");
  });

  test("a command that already passed earlier is not new", () => {
    const s = state([
      call({ tool: "bash", turn: 1, cmd: "bun test", status: "PASS" }),
      call({ tool: "bash", turn: 4, cmd: "bun test", status: "PASS" }),
    ]);
    expect(captureSignalSince(s, 2).ok).toBe(false);
  });

  test("a first-time passing command is a signal", () => {
    const s = state([
      call({ tool: "bash", turn: 1, cmd: "bun install", status: "PASS" }),
      call({ tool: "bash", turn: 4, cmd: "bun test ./src", status: "PASS" }),
    ]);
    expect(captureSignalSince(s, 2).why).toBe("newCommandPassed");
  });

  test("a window of pure reads is not a signal", () => {
    const s = state([
      call({ tool: "read", turn: 3 }),
      call({ tool: "grep", turn: 3, status: "PASS" }),
    ]);
    expect(captureSignalSince(s, 2)).toEqual({ ok: false, why: "no-signal" });
  });

  test("no turn tracking means the window is meaningless, so capture", () => {
    // The silent-death case this must never produce: a host that never calls
    // session.prompt leaves turns at 0, so every call falls outside every
    // window. Treating that as "nothing happened" would stop capture forever
    // with nothing in the store to show for it.
    const s = state([call({ tool: "edit", turn: 0 })], 0);
    expect(captureSignalSince(s, 0)).toEqual({
      ok: true,
      why: "no-turn-tracking",
    });
  });
});

describe("deltaMessages", () => {
  test("slices past the consumed prefix", () => {
    expect(deltaMessages([1, 2, 3, 4], 2)).toEqual([3, 4]);
  });

  test("a zero cursor is the whole array, unchanged identity", () => {
    const m = [1, 2];
    expect(deltaMessages(m, 0)).toBe(m);
  });

  test("a fully consumed window is empty; a SHRUNK context is mined whole", () => {
    expect(deltaMessages([1, 2], 2)).toEqual([]);
    // #366 review [P2]: compaction replaces the transcript, so `since` can point
    // past the end of an array that is simply shorter now. An empty window here
    // skipped EVERY later turn as too thin, because a skip does not advance the
    // cursor — the session stayed unmined until it grew past the old count.
    expect(deltaMessages([1, 2], 5)).toEqual([1, 2]);
  });

  test("shrink is told apart from 'nothing new' (#366 review)", () => {
    expect(contextShrank([1, 2, 3], 3)).toBe(false); // nothing appended yet
    expect(contextShrank([1, 2], 3)).toBe(true); // replaced by a shorter array
    expect(contextShrank([1, 2, 3], 2)).toBe(false);
    expect(contextShrank("seeded payload", 9)).toBe(false);
  });

  test("a non-array payload passes through untouched", () => {
    expect(deltaMessages(undefined, 3)).toBe(undefined);
    expect(deltaMessages("seeded string", 3)).toBe("seeded string");
  });
});

describe("the capture cursor", () => {
  test("an uncaptured session starts at the beginning", () => {
    resetCaptureCursors();
    expect(captureCursor("ses-new")).toEqual({ msgs: 0, turn: 0 });
  });

  test("advance records both the message count and the turn", () => {
    resetCaptureCursors();
    advanceCaptureCursor("ses-a", 12, 4);
    expect(captureCursor("ses-a")).toEqual({ msgs: 12, turn: 4 });
  });

  test("the map stays bounded, oldest first", () => {
    resetCaptureCursors();
    for (let i = 0; i < 505; i++) advanceCaptureCursor(`s${i}`, i, i);
    expect(captureCursor("s0")).toEqual({ msgs: 0, turn: 0 }); // evicted
    expect(captureCursor("s504")).toEqual({ msgs: 504, turn: 504 });
  });
});

describe("guidedStatementInWindow (#365 hint-channel guard)", () => {
  test("a user spec statement in the window is a signal", () => {
    expect(
      guidedStatementInWindow(
        [
          { type: "user", text: "The constant TAX_RATE must be 0.0825." },
          { type: "assistant", content: [{ type: "text", text: "ok" }] },
        ],
        0,
      ),
    ).toBe(true);
    // role= shape (host context) works too.
    expect(
      guidedStatementInWindow(
        [
          {
            role: "user",
            content: [{ type: "text", text: "never edit docs" }],
          },
        ],
        0,
      ),
    ).toBe(true);
  });

  test("questions and assistant text are not signals; unknown shapes fire", () => {
    expect(
      guidedStatementInWindow(
        [
          { type: "user", text: "look at the pricing module" },
          {
            type: "assistant",
            content: [{ type: "text", text: "it must be tax" }],
          },
        ],
        0,
      ),
    ).toBe(false);
    expect(guidedStatementInWindow("seeded payload", 0)).toBe(true);
    // Before the cursor: already mined, not a signal.
    expect(
      guidedStatementInWindow(
        [{ type: "user", text: "TAX_RATE must be 0.0825" }, ...[]],
        1,
      ),
    ).toBe(false);
  });

  // #366 review [P2]: the guard decoded its own narrow message shape, so genuine
  // user rules in shapes the capture transcript parser accepts got a no-signal
  // skip before generation — the exact loss the guard exists to prevent. It now
  // shares that decoder, so there is one definition of "who said this line".
  test("every shape the transcript parser accepts is read the same way", () => {
    const rule = "The constant TAX_RATE must be 0.0825.";
    for (const msg of [
      // V1 role + string content.
      { role: "user", content: rule },
      // V1 role + parts.
      { info: { role: "user" }, parts: [{ type: "text", text: rule }] },
      // 2.2.5 live shape.
      { id: "m1", time: 1, type: "user", text: rule },
      // 2.2.5 with the text in a content part.
      { type: "user", content: [{ type: "text", text: rule }] },
    ]) {
      expect(guidedStatementInWindow([msg], 0)).toBe(true);
    }
    // The same shapes, said by the assistant: still not the user's rule.
    for (const msg of [
      { role: "assistant", content: rule },
      { info: { role: "assistant" }, parts: [{ type: "text", text: rule }] },
      { type: "assistant", text: rule },
    ]) {
      expect(guidedStatementInWindow([msg], 0)).toBe(false);
    }
  });

  test("a window the decoder cannot read at all fires rather than assumes", () => {
    expect(guidedStatementInWindow([{ weird: "record" }], 0)).toBe(true);
    // A non-conversation record alone (2.2.5 puts `idle` in the same array)
    // decodes to no turns, and "no turns" is indistinguishable from "a shape
    // this build cannot read". Both fire: a wasted capture costs one model call
    // under a cooldown, a missed rule costs the hint channel for good.
    expect(guidedStatementInWindow([{ type: "idle" }], 0)).toBe(true);
  });
});

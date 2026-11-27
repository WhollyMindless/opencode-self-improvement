import { expect, test } from "bun:test";
import { createOpenCodeCapture } from "../../src/adapters/opencode/capture.ts";
import { decodeTranscript } from "../../src/adapters/opencode/transcript.ts";
import type { PluginCtx } from "../../src/adapters/opencode/context.ts";
import {
  flattenTranscript,
  userTurnText,
} from "../../src/capture/transcript.ts";
import { lagSince } from "../../src/capture/lag.ts";
import {
  deltaMessages,
  prefixFingerprint,
  transcriptReplaced,
} from "../../src/capture/policy.ts";

test("capture capabilities are explicit and host calls retain their receivers", async () => {
  const missing = createOpenCodeCapture({});
  expect(missing.turnEndEvents).toBeUndefined();
  expect(missing.readTranscript).toBeUndefined();
  expect(missing.generateText).toBeUndefined();
  expect(missing.defaultModel?.()).toBeNull();
  const ctx: PluginCtx = {
    session: {
      async hook() {},
      async context(input) {
        expect(this).toBe(ctx.session!);
        expect(input).toEqual({ sessionID: "s" });
        return [{ type: "user", text: "visible" }];
      },
    },
    generate: {
      async text(input) {
        expect(this).toBe(ctx.generate!);
        expect(input).toEqual({
          model: { providerID: "p", id: "m" },
          prompt: "mine",
        });
        return { text: "answer" };
      },
    },
    model: {
      default: {
        get() {
          expect(this).toBe(ctx.model!.default!);
          return { providerID: "p", modelID: "m" };
        },
      },
    },
  };
  const host = createOpenCodeCapture(ctx);
  expect(await host.readTranscript!("s")).toEqual([
    { role: "user", text: "visible" },
  ]);
  const input = {
    sessionID: "s",
    model: { providerID: "p", id: "m" },
    prompt: "mine",
    signal: new AbortController().signal,
  };
  expect(await host.generateText!(input)).toBe("answer");
  expect(host.defaultModel!()).toEqual(input.model);
  ctx.generate!.text = async () => "plain";
  expect(await host.generateText!(input)).toBe("plain");
  ctx.generate!.text = async () => ({});
  expect(await host.generateText!(input)).toBe("");
  ctx.model!.default!.get = () => ({ providerID: "", modelID: "m" });
  expect(host.defaultModel!()).toBeNull();
  ctx.session!.context = async () => [
    { role: "assistant", content: "replacement" },
  ];
  expect(await host.readTranscript!("s")).toEqual([
    { role: "assistant", text: "replacement" },
  ]);
});

test("capture event decoding filters triggers, preserves missing identity, and stops queued events on abort", async () => {
  const controller = new AbortController();
  let closed = false;
  const ctx: PluginCtx = {
    event: {
      async *subscribe(options) {
        expect(this).toBe(ctx.event!);
        expect(options?.signal).toBe(controller.signal);
        try {
          yield {
            type: "session.execution.failed",
            data: { sessionID: "ignored" },
          };
          yield {
            type: "session.execution.succeeded",
            data: { sessionID: "a" },
          };
          yield {
            type: "session.execution.interrupted",
            properties: { sessionID: "b" },
          };
          yield { type: "session.execution.succeeded" };
          controller.abort();
          yield {
            type: "session.execution.succeeded",
            data: { sessionID: "late" },
          };
        } finally {
          closed = true;
        }
      },
    },
  };
  const seen = [];
  for await (const event of createOpenCodeCapture(ctx).turnEndEvents!(
    controller.signal,
  ))
    seen.push(event);
  expect(seen).toEqual([
    { sessionID: "a" },
    { sessionID: "b" },
    { sessionID: undefined },
  ]);
  expect(closed).toBe(true);
});

test("transcript decoding preserves cursor slots and timestamps without copying private or non-conversation text", () => {
  const raw = [
    {
      type: "user",
      text: "remember the archive policy",
      time: { created: 100 },
    },
    null,
    {
      type: "assistant",
      content: [{ type: "THINKING", text: "private" }],
      text: "private",
      time: { completed: 200 },
    },
    { type: "idle", text: "not conversation", time: { updated: 300 } },
    {
      role: "assistant",
      content: "quoted user: never change the policy",
      createdAt: new Date(400).toISOString(),
    },
  ];
  const transcript = decodeTranscript(raw)!;
  expect(transcript).toEqual([
    { role: "user", text: "remember the archive policy", timestamp: 100 },
    { text: "" },
    { role: "assistant", text: "", timestamp: 200 },
    { text: "", timestamp: 300 },
    {
      role: "assistant",
      text: "quoted user: never change the policy",
      timestamp: 400,
    },
  ]);
  expect(lagSince(transcript, 1000)).toBe(600);
  expect(flattenTranscript(deltaMessages(transcript, 4))).toBe(
    "assistant: quoted user: never change the policy",
  );
  expect(userTurnText(transcript)).toBe("remember the archive policy");
  const cursor = { msgs: 4, fp: prefixFingerprint(transcript, 4) };
  expect(transcriptReplaced(transcript, cursor)).toBe(false);
  raw[0]!.text = "new policy";
  expect(transcriptReplaced(decodeTranscript(raw), cursor)).toBe(true);
  expect(transcript[0]!.text).toBe("remember the archive policy");
  expect(decodeTranscript("unavailable")).toBeUndefined();
});

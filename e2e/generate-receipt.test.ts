// #395: the host limitation, pinned in CI.
//
// Capture's cost is an estimate (chars/4, `receipt=none` in PR #394) because
// `ctx.generate.text` resolves to `{ text }` with no provider receipt. That
// claim was probed by hand on 2026-11-11; this test makes it machine-checked.
// The fake model attaches `usage` to every final chunk — a real openai-
// compatible provider reports the same — so what the probe plugin sees is the
// host's contract, not the provider's silence.
//
// This is a CHARACTERIZATION test: it pins today's shape, it does not endorse
// it. When upstream surfaces usage on the generate result (#395 route 1),
// `resultKeys` grows, this test fails, and the failure is the trigger to flip
// it and switch `capture_cost` from `receipt=none` to a named source. Until
// then the estimate stays labelled as an estimate — the ticket's explicit
// non-goal is that a chars/4 number never becomes a receipt by looking like
// one.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPO,
  type Fake,
  type Guest,
  loadFailure,
  makeGuest,
  startFake,
  turn,
} from "./support/harness.ts";

const PROBE = join(import.meta.dir, "support", "probe-plugin");

let fake: Fake;
const guests: Guest[] = [];

beforeAll(async () => {
  fake = await startFake();
});
afterAll(() => {
  fake.stop();
});

test("generate.text hands the plugin { text } and no usage, even though the provider reported usage", async () => {
  const g = makeGuest(fake, REPO, [PROBE]);
  guests.push(g);
  const probeOut = join(g.root, "probe.json");
  g.env.PROBE_OUT = probeOut;
  fake.setSteps({ "RECEIPT-TURN": [{ content: "done" }] });
  const run = await turn(fake, g, "RECEIPT-TURN", 120_000);
  expect(loadFailure(run)).toBeUndefined();
  // The hook awaits generate.text before the turn completes, so the file is
  // written by now; the short poll only absorbs filesystem flush.
  const deadline = Date.now() + 5_000;
  while (!existsSync(probeOut) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  expect(existsSync(probeOut)).toBe(true);
  const probe = JSON.parse(readFileSync(probeOut, "utf8"));
  expect(probe.error).toBeUndefined();
  // The host exposes exactly one generate member, and the result carries
  // exactly one key. `usage: null` is the gap #395 exists for: the fake sent
  // prompt_tokens 111 / completion_tokens 22 on the wire, and none of it
  // reached the plugin process.
  expect(probe.generateKeys).toEqual(["text"]);
  expect(probe.resultKeys).toEqual(["text"]);
  expect(probe.usage).toBeNull();
  expect(probe.textType).toBe("string");
});

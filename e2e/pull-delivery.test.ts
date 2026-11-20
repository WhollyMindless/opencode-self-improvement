// Pull-delivery gate: what a PASSIVE seat actually receives.
//
// Every e2e scenario before this one drove a model that called memory tools, so
// they proved the plugin's READ path, not its DELIVERY path. A seat that never
// calls one (measured 2026-11-19: three evo/gptoss sessions made 1 memory_recall
// total against ~2000 for Qwen) lives entirely on the two push channels: the
// system-prompt epoch block and the after-tool contextual pull. This scenario
// pins both, with a script that cannot call a memory tool.
//
// The rows are keyed apart on purpose:
//   INJECT row — matches the user prompt, so the epoch can score it.
//   PULL row   — keyed to a token that appears ONLY inside the file the seat
//                reads. The prompt never mentions it, so the epoch cannot inject
//                it: only a pull, fired by the read, can deliver it.
//   PULL2 row  — keyed to the file's BODY, with a meaningless path, so even the
//                arguments-only query cannot reach it. Proves the widened pull
//                on a real host rather than in bench/runners/pull-precision.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPO,
  loadFailure,
  makeGuest,
  startFake,
  turn,
  type Fake,
  type Guest,
} from "./support/harness.ts";

const PULL_TOKEN = "legacy_rate_v1";
const INJECT_MARKER = "E2EINJECTMARKER-4410";
const PULL_MARKER = "E2EPULLMARKER-9902";
const PULL2_MARKER = "E2EPULL2MARKER-7731";

let fake: Fake;
const guests: Guest[] = [];

beforeAll(async () => {
  fake = await startFake();
});
afterAll(() => fake.stop());

/** The agent requests only: an aux/title request has no tools array. */
async function agentRequests() {
  return (await fake.requests()).filter(
    (b: any) => Array.isArray(b.tools) && b.tools.length > 0,
  );
}

describe("Feature: a seat that never calls a memory tool still receives memory", () => {
  test("Scenario: the epoch block rides the system prompt, and the pull rides the tool result", async () => {
    const g = makeGuest(fake, REPO);
    guests.push(g);
    writeFileSync(
      join(g.memoryDir, "2026-11-19.logfmt"),
      `ts=2026-11-19T10:00:00.000Z type=learning scope=pricing content="When asked about tax rounding in pricing.ts: use ${INJECT_MARKER}, never the legacy rate." tags=probe status=settled\n` +
        `ts=2026-11-19T10:00:01.000Z type=learning scope=pricing content="When pricing.ts mentions ${PULL_TOKEN}: ${PULL_MARKER} that alias is dead code, delete it instead of reusing it." tags=probe status=settled\n`,
    );
    writeFileSync(
      join(g.projDir, "pricing.ts"),
      `export const TAX_RATE = 0.08;\nexport const ${PULL_TOKEN} = 0.05;\nexport const total = (n: number) => n * (1 + TAX_RATE);\n`,
    );

    // Passive by construction: built-in tools only, then a final answer.
    fake.setSteps({
      "E2E::passive-seat": [
        {
          tool_calls: [
            {
              id: "r1",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({
                  path: join(g.projDir, "pricing.ts"),
                }),
              },
            },
          ],
        },
        { content: "PASSIVE-DONE" },
      ],
    });

    const run = await turn(
      fake,
      g,
      "E2E::passive-seat fix the tax rounding in pricing.ts",
    );
    expect(loadFailure(run)).toBeUndefined();
    expect(run.text()).toInclude("PASSIVE-DONE");
    // The script never reached for a memory tool: everything below was pushed.
    expect(run.toolUses.map((t) => t.tool)).toEqual(["read"]);

    const reqs = await agentRequests();
    expect(reqs.length).toBeGreaterThanOrEqual(2);

    // Channel 1: the frozen epoch block, on the system prompt, every request.
    for (const body of reqs) {
      const sys = (body.messages as any[]).filter((m) => m.role === "system");
      expect(sys.length).toBe(1);
      expect(String(sys[0]?.content)).toInclude(INJECT_MARKER);
    }

    // Channel 2: the pull, appended to the tool result the model reads back.
    const after = JSON.stringify((reqs[reqs.length - 1] as any).messages);
    expect(after).toInclude("Related durable memory");
    expect(after).toInclude(PULL_MARKER);
  }, 240_000);

  // The reach the widened query buys, end to end. The row above was reachable
  // from the file NAME ("pricing.ts"), so it never proved the pull could see a
  // tool's output. Here the path is meaningless and only the body carries the
  // match: under the arguments-only query this row is unreachable by
  // construction, so if it lands, the output joined the query on a real host.
  test("Scenario: a fact keyed to what the tool PRINTED, not to what was asked, still arrives", async () => {
    const g = makeGuest(fake, REPO);
    guests.push(g);
    writeFileSync(
      join(g.memoryDir, "2026-11-19.logfmt"),
      `ts=2026-11-19T10:00:00.000Z type=blocker scope=build content="When the vite build reports ERR_MODULE_NOT_FOUND for vite.config.ts: run pnpm install --frozen-lockfile first, ${PULL2_MARKER}." tags=probe status=settled\n`,
    );
    // A name with no vocabulary in common with the row.
    writeFileSync(
      join(g.projDir, "notes-8817.txt"),
      `scratch\nERR_MODULE_NOT_FOUND: cannot load vite.config.ts\ntried restarting\n`,
    );

    fake.setSteps({
      "E2E::passive-seat-2": [
        {
          tool_calls: [
            {
              id: "r1",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({
                  path: join(g.projDir, "notes-8817.txt"),
                }),
              },
            },
          ],
        },
        { content: "PASSIVE2-DONE" },
      ],
    });

    const run = await turn(
      fake,
      g,
      "E2E::passive-seat-2 read notes-8817.txt and tell me what it says",
    );
    expect(loadFailure(run)).toBeUndefined();
    expect(run.text()).toInclude("PASSIVE2-DONE");
    expect(run.toolUses.map((t) => t.tool)).toEqual(["read"]);

    const reqs = await agentRequests();
    // The epoch cannot have delivered it: the prompt shares nothing with the row.
    for (const body of reqs) {
      const sys = (body.messages as any[]).filter((m) => m.role === "system");
      expect(String(sys[0]?.content)).not.toInclude(PULL2_MARKER);
    }
    // The pull did.
    const after = JSON.stringify((reqs[reqs.length - 1] as any).messages);
    expect(after).toInclude(PULL2_MARKER);
  }, 240_000);
});

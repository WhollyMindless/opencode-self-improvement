// Ten-second terminal demo for the README GIF.
//
// Scripted model turns, but a real OpenCode host, the real plugin, and a real
// isolated store. Nothing here reads or writes the developer's config. The
// rendered GIF must be labelled: scripted turns, real plugin/store, fake model.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  makeGuest,
  REPO,
  type Run,
  startFake,
  turn,
} from "../e2e/support/harness.ts";

/** A scripted assistant tool_call step, as in e2e/store.test.ts. */
function call(id: string, tool: string, args: Record<string, unknown>) {
  return {
    tool_calls: [
      {
        id,
        type: "function",
        function: { name: tool, arguments: JSON.stringify(args) },
      },
    ],
  };
}

const MARK = "DEMO::";
const FACT = "we use Bun, not npm - npm keeps breaking the lockfile";
const WRONG = "we use npm, not Bun - bun keeps breaking the lockfile";
const WIDTH = 96;

const pause = (ms: number) => Bun.sleep(ms);

/** One readable line from a tool result, short enough for a 1000px GIF. */
function excerpt(text: string, prefer?: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const line =
    (prefer && lines.find((l) => l.includes(prefer))) || lines[0] || "";
  return line.length > WIDTH ? `${line.slice(0, WIDTH - 3)}...` : line;
}

function first(run: Run, tool: string, prefer?: string): string {
  return excerpt(run.outputs(tool)[0] ?? "", prefer);
}

function healthy(run: Run, phase: string): void {
  if (run.exit !== 0 || run.errors().length || run.stderr.trim()) {
    throw new Error(
      `${phase}: exit=${run.exit} errors=${run.errors().length} stderr=${run.stderr.trim()}`,
    );
  }
}

const fake = await startFake();
const guest = makeGuest(fake, REPO);

try {
  await pause(600);

  // Monday: one durable decision, promoted through the real write gate.
  fake.setSteps({
    [`${MARK}add`]: [
      call("d1", "memory_remember", {
        type: "learning",
        scope: "tooling",
        content: FACT,
        kw: ["bun", "npm", "package manager", "lockfile"],
        status: "open",
      }),
      { content: "ADD-DONE" },
    ],
  });
  const add = await turn(fake, guest, `${MARK}add remember: ${FACT}`);
  healthy(add, "remember");
  console.log(
    `MONDAY   remember "we use Bun, not npm..." -> ${first(add, "memory_remember")}`,
  );
  await pause(1600);

  // Tuesday: a brand-new host process, same store, no prompt leak.
  fake.setSteps({
    [`${MARK}recall`]: [
      call("d2", "memory_recall", {
        query: "which package manager do we use?",
      }),
      { content: "RECALL-DONE" },
    ],
  });
  const recall = await turn(
    fake,
    guest,
    `${MARK}recall which package manager do we use?`,
  );
  healthy(recall, "recall");
  console.log(`TUESDAY  ${first(recall, "memory_recall", "Bun")}`);
  await pause(1600);

  // A wrong update supersedes the row and snapshots the day file first.
  fake.setSteps({
    [`${MARK}update`]: [
      call("d3", "memory_update", {
        type: "learning",
        scope: "tooling",
        content: WRONG,
        query: "we use Bun",
      }),
      { content: "UPDATE-DONE" },
    ],
  });
  const update = await turn(fake, guest, `${MARK}update rewrite the fact`);
  healthy(update, "update");
  console.log(`CORRECT  ${first(update, "memory_update", "npm")}`);
  await pause(1600);

  // Nothing is deleted: the snapshot restores the earlier row.
  const snapshot = readdirSync(join(guest.memoryDir, "snapshots")).find((f) =>
    /\.logfmt$/.test(f),
  );
  if (!snapshot) throw new Error("update did not leave a snapshot");
  fake.setSteps({
    [`${MARK}undo`]: [
      call("d4", "memory_undo", { snapshot, merge: true }),
      { content: "UNDO-DONE" },
    ],
  });
  const undo = await turn(fake, guest, `${MARK}undo restore the fact`);
  healthy(undo, "undo");
  const restored =
    first(undo, "memory_undo", "Restored").split(" -> ")[0] ?? "";
  console.log(`UNDO     ${restored}`);
  await pause(1600);

  console.log(
    "         scripted model / real plugin / real store / no config reads",
  );
} finally {
  fake.stop();
}

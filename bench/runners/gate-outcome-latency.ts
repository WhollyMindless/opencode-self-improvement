// Times the awaited tool-result hook, including evidence and ledger writes.
// Fixture setup, the synthetic tool execution, and verification are untimed.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterTool, markTurn } from "../../src/capture/triggers.ts";
import { peekTurn } from "../../src/core/state.ts";
import { closeAllLockDatabases } from "../../src/store/lock.ts";
import { hitsFile, recordOutcome } from "../../src/telemetry/ledger.ts";

const root = await mkdtemp(join(tmpdir(), "osi-gate-latency-"));
const previous = process.env.OPENCODE_MEMORY_DIR;
process.env.OPENCODE_MEMORY_DIR = root;
try {
  const sid = "gate-latency";
  markTurn(sid);
  const filler =
    "ev=memory_used ts=2026-01-01T00:00:00.000Z src=inject sid=baseline mem=[seed]\n";
  for (const bytes of [0, 1_990_000, 2_001_000]) {
    // Seed a previous gate on this turn to exercise repeated test/fix loops.
    await writeFile(hitsFile(), "");
    const turn = peekTurn(sid)!;
    if (
      !(await recordOutcome(
        sid,
        turn.turn,
        "PASS",
        "test",
        Date.now(),
        turn.key,
      ))
    )
      throw new Error("Could not seed first gate");
    const prior = await readFile(hitsFile(), "utf8");
    const seed = filler.repeat(Math.ceil(bytes / filler.length)) + prior;
    const samples: number[] = [];
    for (let i = 0; i < 21; i++) {
      await writeFile(hitsFile(), seed);
      const start = performance.now();
      await afterTool(
        {
          tool: "bash",
          sessionID: sid,
          callID: String(i),
          args: { command: "bun test" },
        },
        { output: "passed", metadata: { exitCode: 0 } },
      );
      const elapsed = performance.now() - start;
      const ledger = await readFile(hitsFile(), "utf8");
      if (
        ledger === seed ||
        ledger.split("\n").filter((line) => line.startsWith("ev=gate_outcome "))
          .length !== 2 ||
        (bytes > 2_000_000 && ledger.length >= seed.length)
      )
        throw new Error("Expected gate receipt or rotation missing");
      if (i > 0) samples.push(elapsed);
    }
    samples.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        bytes: seed.length,
        n: samples.length,
        medianMs: (samples[9]! + samples[10]!) / 2,
        p95Ms: samples[18],
      }),
    );
  }
} finally {
  closeAllLockDatabases();
  if (previous === undefined) delete process.env.OPENCODE_MEMORY_DIR;
  else process.env.OPENCODE_MEMORY_DIR = previous;
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

// Contract: every event name the plugin waits on is a name the HOST really
// sends.
//
// Why this file exists (#136): auto-capture waited for `session.idle`, and the
// feature was dead on every 2.x host with no warning anywhere. The manifest DOES
// declare `session.idle` — so schema membership alone would have passed, and the
// tests fabricated the same envelope anyway (fake and prod wrong together, the
// lesson already paid for in #86 and #90). What caught the bug was a recording of
// the live host: `session.idle` and `session.status` are declared but never
// emitted, while `session.execution.succeeded` is emitted on every turn end.
//
// So the authority here is the RECORDING, and the manifest is only the weaker
// necessary condition. Both are asserted.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPTURE_EVENT_TYPES } from "../src/index.ts";

const MANIFEST = join(import.meta.dir, "../node_modules/@opencode/schema/dist/event-manifest.d.ts");
const RECORDING = join(import.meta.dir, "fixtures/host-events.jsonl");
const SRC = join(import.meta.dir, "../src");

// Recorded from a running desktop service (opencode-cli 2.1.4, `GET /api/event`
// SSE): two complete turns plus 80 s of quiet afterwards. Event NAMES and counts
// only — no payload, no prompt content.
const observed = new Map<string, number>(
  readFileSync(RECORDING, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; count: number })
    .map((r) => [r.type, r.count]),
);

// Names the manifest declares but the live host never sent during the recording.
// A subscriber on any of these is dead code — which is precisely #136.
const declaredButUnobserved = (declared: Set<string>) =>
  [...declared].filter((t) => t.startsWith("session.") && !observed.has(t));

// Event names the plugin reads from OLDER hosts. Each entry is a deliberate
// compatibility read, not a guess; the list is short so drift is visible.
const LEGACY_HOST_EVENTS = new Set(["message.updated"]);

const declaredSet = new Set<string>(
  [...readFileSync(MANIFEST, "utf8").matchAll(/\btype:\s*"([a-z][a-z0-9_.]*)"/g)].map((m) => m[1]),
);

describe("host event fidelity (#136, #137)", () => {
  // Controls first: a parser that matched nothing would make every assertion
  // below vacuously true, and a harness that cannot fail does not count.
  test("both sources were actually parsed", () => {
    expect(declaredSet.size).toBeGreaterThan(50);
    expect(observed.size).toBeGreaterThan(10);
    expect(observed.has("session.execution.succeeded")).toBe(true);
  });

  test("every event type auto-capture reacts to is declared by the protocol", () => {
    expect(CAPTURE_EVENT_TYPES.filter((t) => !declaredSet.has(t))).toEqual([]);
  });

  // The assertion that would have caught #136 two releases ago.
  test("every event type auto-capture reacts to was really observed on a live host", () => {
    const neverSent = CAPTURE_EVENT_TYPES.filter((t) => !observed.has(t));
    expect(neverSent).toEqual([]);
  });

  test("`session.idle` is declared but never emitted — the bug, pinned", () => {
    expect(declaredSet.has("session.idle")).toBe(true); // it exists on paper…
    expect(observed.has("session.idle")).toBe(false); // …and the host never sends it
    expect(CAPTURE_EVENT_TYPES.includes("session.idle")).toBe(false);
    expect(declaredButUnobserved(declaredSet).length).toBeGreaterThan(0); // the category is real
  });

  test("no source line waits on an undeclared, unobserved, non-legacy event name", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(SRC).filter((n) => n.endsWith(".ts"))) {
      readFileSync(join(SRC, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          // Only lines reading an event envelope's `type`, so memory row types
          // ("decision", "learning") and prose stay out of scope.
          if (!/\b(?:ev|event)\??\.type\b/.test(line)) return;
          for (const m of line.matchAll(/"([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)"/g)) {
            const name = m[1];
            if (declaredSet.has(name) || LEGACY_HOST_EVENTS.has(name)) continue;
            offenders.push(`${file}:${i + 1} → ${name}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});

// #297: real emit paths must keep their caller's owner while another session
// is ambient. Unresolved owners stay private rather than becoming global.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryRoot } from "../src/core/config/paths.ts";
import { formatLine } from "../src/core/logfmt/format.ts";
import * as publish from "../src/core/logfmt/publish.ts";
import { setCurrent } from "../src/core/state.ts";
import {
  rememberSessionDir,
  resetSessionScopes,
  resolveRepo,
  setRepoScope,
  type RepoScope,
} from "../src/identity/repokey.ts";
import { systemDigest } from "../src/inject/digest.ts";
import { createInjectionEpochs } from "../src/inject/epochs.ts";
import { loadAll } from "../src/store/files/load.ts";
import { loadPlugin, type LoadedPlugin, withTempStore } from "./harness.ts";
import { readEvidenceLog } from "./helpers/logfmt.ts";

const store = withTempStore({ prefix: "osi-emitter-owner-" });
const first = "2020-01-01T00:00:00.000Z";
const second = "2020-01-02T00:00:00.000Z";
const rowFile = (ts: string) => join(memoryRoot(), `${ts.slice(0, 10)}.logfmt`);
let plugin: LoadedPlugin;
let owner: RepoScope;
let stranger: RepoScope;
let sid: string;
let otherSid: string;
let serial = 0;

describe("caller-owned evidence emitters (#297)", () => {
  beforeEach(async () => {
    resetSessionScopes();
    const a = join(store.root, "repo-a");
    const b = join(store.root, "repo-b");
    mkdirSync(a);
    mkdirSync(b);
    mkdirSync(memoryRoot(), { recursive: true });
    owner = resolveRepo(a);
    stranger = resolveRepo(b);
    sid = `emitter-owner-${++serial}`;
    otherSid = `emitter-stranger-${serial}`;
    // No instance-dir fallback: the unresolved cases must remain unresolved.
    plugin = await loadPlugin(null);
    rememberSessionDir(otherSid, b);
    setRepoScope(stranger);
    setCurrent({ sessionID: otherSid, callID: "other-call" });
  });

  afterEach(async () => {
    await plugin?.cleanup();
    resetSessionScopes();
    setRepoScope(null);
  });

  function seed(ts: string, resolved: boolean): void {
    writeFileSync(
      rowFile(ts),
      formatLine({
        ts,
        type: "context",
        scope: "owner-planning",
        content: "investigate the stale deployment thread",
        status: "open",
        repo: resolved ? owner.key : "global",
        ...(resolved ? { repoPath: owner.path } : {}),
      }) + "\n",
    );
  }

  async function checkOwner(event: string, resolved: boolean): Promise<void> {
    const lines = readEvidenceLog().filter((line) => line.ev === event);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.repo).toBe(resolved ? owner.key : undefined);
    expect(line.repoPath).toBe(resolved ? owner.path : undefined);
    expect(line.sid).toBe(resolved ? undefined : sid);
    expect(line.call).toBeUndefined();
    const own = await plugin.tools.memory_evidence.execute(
      { ev: event },
      { sessionID: sid },
    );
    expect(own.content).toContain(`ev=${event}`);
    const other = await plugin.tools.memory_evidence.execute(
      { ev: event },
      { sessionID: otherSid },
    );
    expect(other.content).toBe("No evidence");
    const unresolved = await plugin.tools.memory_evidence.execute(
      { ev: event },
      { sessionID: "another-unresolved-reader" },
    );
    expect(unresolved.content).toBe("No evidence");
  }

  const paths = [
    ["decay dry run", "decay_dry_run"],
    ["decay applied", "decay_applied"],
    ["decay partial", "decay_applied"],
    ["consolidate", "consolidate_propose"],
    ["frontier", "frontier_injected"],
    ["epoch", "epoch_recompute"],
  ] as const;

  for (const resolved of [true, false]) {
    for (const [path, event] of paths) {
      test(`${path}: ${resolved ? "resolved caller owns the repo stamp" : "unresolved caller stays private"}`, async () => {
        if (resolved) rememberSessionDir(sid, owner.path);
        seed(first, resolved);

        if (path === "decay partial") {
          seed(second, resolved);
          const writeAtomic = publish.writeAtomic;
          // Fail the second publish only. The real batch has already durably
          // retired the first row when the tool emits its partial receipt.
          const failure = spyOn(publish, "writeAtomic").mockImplementation(
            async (...args: Parameters<typeof writeAtomic>) => {
              if (args[0] === rowFile(second))
                throw new Error("synthetic second-file publish failure");
              return writeAtomic(...args);
            },
          );
          try {
            const out = await plugin.tools.memory_decay.execute(
              { dryRun: false, olderThanDays: 1 },
              { sessionID: sid },
            );
            expect(out.content).toContain("memory_decay PARTIAL");
            const rows = await loadAll();
            expect(rows.find((row) => row.ts === first)?.superseded_by).toBe(
              "decay",
            );
            expect(
              rows.find((row) => row.ts === second)?.superseded_by,
            ).toBeUndefined();
          } finally {
            failure.mockRestore();
          }
        } else if (path.startsWith("decay")) {
          const out = await plugin.tools.memory_decay.execute(
            { dryRun: path === "decay dry run", olderThanDays: 1 },
            { sessionID: sid },
          );
          expect(out.content).toContain(
            path === "decay dry run" ? "Dry run:" : "Decayed 1",
          );
        } else if (path === "consolidate") {
          await plugin.tools.memory_consolidate.execute({}, { sessionID: sid });
        } else if (path === "frontier") {
          const output = { system: [] as string[] };
          await systemDigest({ sessionID: sid }, output);
          expect(output.system.join("\n")).toContain("owner-planning");
        } else {
          const epochs = createInjectionEpochs({
            budget: 2000,
            frontierBudget: 1000,
            measuredTurns: new Map(),
            noteHits: async () => {},
          });
          await epochs.prompt(sid, "stale deployment thread");
          expect(await epochs.buildPayload(sid)).not.toBeNull();
        }

        await checkOwner(event, resolved);
      });
    }
  }
});

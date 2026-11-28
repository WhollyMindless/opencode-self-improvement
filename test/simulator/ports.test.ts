import { expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { withTempStore } from "../helpers/temp-store.ts";
import { runScenario } from "./scenario.ts";
import { resolveRepo } from "../../src/identity/repokey.ts";
import { loadAll } from "../../src/store/files/load.ts";

const store = withTempStore({ prefix: "osi-reference-ports-" });
const row = {
  type: "context",
  scope: "archive",
  content:
    "The archive rollout will evaluate retention policies before the next deployment.",
  status: "open",
};

test("commands and tool registration can be held or failed before lifecycle admission", async () => {
  await runScenario("startup ports", async (s) => {
    const h = s.host("host", { directory: store.root });
    const commands = h.commands.pause("commands");
    const tools = h.toolRegistration.pause("tools");
    const start = h.start();
    const failed = start.then(
      () => undefined,
      (error) => error,
    );
    await commands.entered;
    expect(h.tools.size).toBe(0);
    commands.resolve();
    await tools.entered;
    expect(h.registration.calls).toHaveLength(0);
    tools.reject(new Error("registration refused"));
    expect(await failed).toBeInstanceOf(Error);
    expect((await failed).message).toBe("registration refused");
    expect(h.tools.size).toBe(0);
  });
});

test("held transcript identity wins over the session fallback for a real write", async () => {
  await runScenario("directory precedence", async (s) => {
    const a = join(store.root, "a");
    const b = join(store.root, "b");
    mkdirSync(a);
    mkdirSync(b);
    const h = s.host("host", { directory: a });
    h.directories.set("writer", a);
    await h.start();
    const lookup = h.transcriptDirectoryReads.pause("identity");
    const write = h.invoke("writer", "memory_remember", row);
    expect(await lookup.entered).toBe("writer");
    expect(await loadAll()).toEqual([]);
    lookup.resolve(b);
    expect((await write).content).toStartWith("Remembered:");
    expect((await loadAll())[0]!.repo).toBe(resolveRepo(b).key);
    expect(h.sessionDirectoryReads.calls).toHaveLength(0);
  });
});

test("directory failures use the declared session fallback without inventing identity", async () => {
  await runScenario("directory fallback", async (s) => {
    const h = s.host("host", { directory: store.root });
    h.transcriptDirectoryReads.fail(new Error("transcript unavailable"));
    h.sessionDirectoryReads.reply(store.root);
    await h.start();
    expect(
      (await h.invoke("writer", "memory_remember", row)).content,
    ).toStartWith("Remembered:");
    expect(h.sessionDirectoryReads.calls).toEqual(["writer"]);
  });
});

test("capability profiles expose absent ports and suppress unavailable delivery", async () => {
  await runScenario("degraded host", async (s) => {
    const h = s.host("host", {
      directory: store.root,
      compaction: "unavailable",
      capabilities: {
        commands: false,
        defaultModel: false,
        transcriptDirectory: false,
        sessionDirectory: false,
        system: false,
        toolResults: false,
        observedToolResults: false,
        usageReceipts: false,
      },
    });
    const runtime = await h.start();
    expect(h.host.installCommands).toBeUndefined();
    expect(h.host.tools.directories.fromSession).toBeUndefined();
    expect(h.host.tools.directories.fromTranscript).toBeUndefined();
    expect(runtime.capabilities.capture.defaultModel).toBe(false);
    expect(runtime.capabilities.compaction).toBe("unavailable");
    const observed = { callID: "c", tool: "read", text: "visible" };
    expect(
      await h.context("reader", { observedResults: [observed] }),
    ).toMatchObject({ system: [], attemptedSystem: [], observedResults: [] });
    expect(h.commands.calls).toHaveLength(0);
  });
});

test("model resolution is session-specific and failures and missing models remain controllable", async () => {
  await runScenario("model resolution", async (s) => {
    const h = s.host("host", { directory: store.root });
    h.resolveModel = (sid) =>
      sid === "missing" ? null : { providerID: "fixture", id: String(sid) };
    expect(h.host.capture.defaultModel!("one")).toEqual({
      providerID: "fixture",
      id: "one",
    });
    expect(h.host.capture.defaultModel!("missing")).toBeNull();
    h.resolveModel = () => {
      throw new Error("model unavailable");
    };
    expect(() => h.host.capture.defaultModel!("failed")).toThrow(
      "model unavailable",
    );
    expect(h.modelLookups).toEqual(["one", "missing", "failed"]);
  });
});

test("lifecycle errors reach diagnostics before cleanup and are dropped afterward", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await runScenario("error delivery", async (s) => {
      const h = s.host("host", { directory: store.root });
      await h.start();
      await h.emit("error", new Error("stream ended"));
      expect(warning).toHaveBeenCalledTimes(1);
      await h.dispose();
      await h.emit("error", new Error("late"));
      expect(warning).toHaveBeenCalledTimes(1);
    });
  } finally {
    warning.mockRestore();
  }
});

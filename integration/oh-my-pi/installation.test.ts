import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  MEMORY_TOOLS,
  REPO,
  makeGuest,
  startFake,
  turn,
  loadFailure,
  type Fake,
  type Guest,
} from "../../e2e/support/harness.ts";

let fake: Fake;
const guests: Guest[] = [];
beforeAll(async () => {
  fake = await startFake();
});
afterEach(() => {
  for (const g of guests.splice(0))
    rmSync(g.root, { recursive: true, force: true });
});
afterAll(() => fake.stop());

const CLI = join(
  import.meta.dir,
  "node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
);
const FACT =
  "When azurite deployment reports a stale manifest: rebuild the project manifest using the cobalt queue before retrying the release.";
function call(name: string, args: Record<string, unknown>) {
  return {
    tool_calls: [
      {
        id: crypto.randomUUID(),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

async function run(args: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 90_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, `${args.join(" ")}\n${stdout}\n${stderr}`).toBe(0);
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
  }
}

test("a packed plugin installs into a fresh oh-my-pi home and shares memory after process restart", async () => {
  const manifest = await Bun.file(join(REPO, "package.json")).json();
  expect(manifest.omp?.extensions).toEqual([
    "./src/adapters/oh-my-pi/extension.ts",
  ]);
  const g = makeGuest(fake, REPO);
  guests.push(g);
  const agentDir = join(g.root, "agent");
  const consumer = join(g.root, "installed");
  mkdirSync(agentDir);
  mkdirSync(consumer);
  const env = {
    ...g.env,
    USERPROFILE: g.env.HOME,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CONFIG_DIR: ".omp",
    OPENAI_API_KEY: "fake-key",
  };
  const archive = join(g.root, "memory.tgz");
  await run([process.execPath, "pm", "pack", "--filename", archive], REPO, env);
  await Bun.write(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await run(
    [process.execPath, "add", "--ignore-scripts", archive],
    consumer,
    env,
  );
  const installed = join(consumer, "node_modules/opencode-self-improvement");
  expect(realpathSync(installed)).not.toBe(realpathSync(REPO));
  const packed = await Bun.file(join(installed, "package.json")).json();
  expect(packed.omp).toEqual(manifest.omp);
  expect(packed.exports["."]).toBe("./index.ts");
  expect(packed.exports["./oh-my-pi"]).toBe(
    "./src/adapters/oh-my-pi/extension.ts",
  );
  expect(
    await Bun.file(
      join(installed, "integration/oh-my-pi/capture-extension.ts"),
    ).exists(),
  ).toBe(false);
  await run(
    [process.execPath, CLI, "plugin", "install", installed],
    g.projDir,
    env,
  );
  const listing = await run(
    [process.execPath, CLI, "plugin", "list", "--json"],
    g.projDir,
    env,
  );
  expect(listing.stdout).toInclude("opencode-self-improvement");
  await Bun.write(
    join(agentDir, "models.yml"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${fake.port}/v1`,
          apiKey: "fake-key",
          models: [
            {
              id: "scripted",
              name: "Scripted",
              reasoning: false,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const cliTurn = async (steps: unknown[], cwd = g.projDir) => {
    fake.setSteps({ "INSTALL::turn": [...steps, { content: "INSTALL-DONE" }] });
    await fake.reset();
    const result = await run(
      [
        process.execPath,
        CLI,
        "--offline",
        "--no-lsp",
        "--no-skills",
        "--no-rules",
        "--no-context-files",
        "--no-title",
        "--no-session",
        "--model",
        "fixture/scripted",
        "--system-prompt",
        "You are an AI agent. Follow the requested tool calls.",
        "--mode",
        "json",
        "--print",
        "INSTALL::turn azurite deployment stale manifest cobalt queue",
      ],
      cwd,
      env,
    );
    expect(result.stdout).toInclude("INSTALL-DONE");
    const requests = await fake.requests();
    const initial = requests.find((r) =>
      r.tools?.some((t: any) => t.function?.name === "memory_recall"),
    );
    expect(initial, result.stderr).toBeDefined();
    expect(initial.tools.map((t: any) => t.function.name)).toEqual(
      expect.arrayContaining(MEMORY_TOOLS),
    );
    expect(
      initial.tools.filter((t: any) => MEMORY_TOOLS.includes(t.function.name)),
    ).toHaveLength(MEMORY_TOOLS.length);
    expect(
      requests.some((r) =>
        JSON.stringify(r.messages?.[0]).includes(
          "You mine one coding-agent session transcript",
        ),
      ),
    ).toBe(false);
    return { ...result, initial };
  };
  await Bun.write(join(g.projDir, "observations.txt"), FACT);
  const first = await cliTurn([
    call("read", { path: join(g.projDir, "observations.txt") }),
    call("memory_remember", {
      type: "learning",
      scope: "azurite",
      content: FACT,
      status: "settled",
    }),
  ]);
  expect(first.stdout).toInclude("Remembered: learning in azurite");
  const restarted = await cliTurn([
    call("memory_recall", { query: "azurite deployment cobalt queue" }),
  ]);
  expect(restarted.stdout).toInclude(FACT);
  expect(JSON.stringify(restarted.initial.messages[0])).toInclude(FACT);
  const other = join(g.root, "other-project");
  mkdirSync(other);
  const foreign = await cliTurn(
    [call("memory_recall", { query: "azurite deployment cobalt queue" })],
    other,
  );
  expect(foreign.stdout).not.toInclude(FACT);
  expect(JSON.stringify(foreign.initial.messages[0])).not.toInclude(FACT);
  await run(
    [process.execPath, CLI, "plugin", "uninstall", "opencode-self-improvement"],
    g.projDir,
    env,
  );
  const removed = await run(
    [process.execPath, CLI, "plugin", "list", "--json"],
    g.projDir,
    env,
  );
  expect(removed.stdout).not.toInclude("opencode-self-improvement");
  fake.setSteps({
    "INSTALL::readback": [
      call("memory_recall", { query: "azurite deployment cobalt queue" }),
      { content: "OPEN-CODE-DONE" },
    ],
  });
  const readback = await turn(
    fake,
    g,
    "INSTALL::readback azurite deployment cobalt queue",
  );
  expect(loadFailure(readback)).toBeUndefined();
  expect(readback.outputs("memory_recall")[0]).toInclude(FACT);
}, 240_000);

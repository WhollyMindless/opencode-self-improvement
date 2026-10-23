// Load smoke suite: the release-gate check the unit harness cannot perform —
// the plugin must LOAD inside a real opencode host, with every tool
// registered, from BOTH the source tree and the packed npm artifact installed
// runtime-deps-only (exactly how consumers get it). A publish-blocking load
// error fails here, not in users' sessions.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  MEMORY_TOOLS,
  REPO,
  installPacked,
  loadFailure,
  makeGuest,
  startFake,
  toolsOffered,
  tuiJsxSource,
  turn,
  type Fake,
  type Guest,
} from "./support/harness.ts";

let fake: Fake;
const guests: Guest[] = [];
let packedPath: Promise<string> | undefined;

beforeAll(async () => {
  fake = await startFake();
});

afterEach(() => {
  for (const g of guests.splice(0)) rmSync(g.root, { recursive: true, force: true });
});

afterAll(() => fake.stop());

async function assertLoads(pluginPath: string, marker: string) {
  const g = makeGuest(fake, pluginPath);
  guests.push(g);
  fake.setSteps({ [marker]: [{ content: "LOAD-DONE" }] });
  const run = await turn(fake, g, `${marker} hello`);

  // The host must run clean: exit 0, no error events, no load errors on stderr.
  expect(loadFailure(run)).toBeUndefined();
  expect(run.text()).toInclude("LOAD-DONE");

  // Every registered tool must reach the model, or the plugin is broken.
  const tools = await toolsOffered(fake);
  for (const name of MEMORY_TOOLS) expect(tools).toContain(name);
}

describe("Feature: candidate plugin loads in a real opencode host", () => {
  test("Scenario: loads from the source tree with all tools registered", async () => {
    await assertLoads(REPO, "SMOKE::load-src");
  });

  test("Scenario: loads from the packed tarball with runtime deps only", async () => {
    // npm installs devDependencies nowhere near a consumer's plugin cache,
    // so a value-import of a devDependency explodes here and not in unit tests.
    packedPath ??= installPacked();
    await assertLoads(await packedPath, "SMOKE::load-pack");
  }, 300_000);

  test("Scenario: packed TUI entry compiles JSX against @opentui/solid, not React", async () => {
    // The v0.6.4 regression: JSX settings lived only in the repo tsconfig,
    // and the host transpiler never reads tsconfig.json from inside
    // node_modules — JSX fell back to React and the TUI failed to load. To
    // reproduce that, the packed tsconfig is deleted before compiling: only
    // the file-local @jsxImportSource pragma can then decide the runtime.
    packedPath ??= installPacked();
    const installed = await packedPath;
    const jsx = tuiJsxSource(installed);
    expect(jsx).toInclude("@opentui/solid");
    expect(jsx).not.toInclude("react/jsx");
  }, 300_000);
});

// BDD integration suite for repo identity UNDER THE SERVICE (`opencode serve
// --service`) — the production host mode where the plugin loads lazily AFTER
// the session was created. Recorded host behavior (opencode 2.1.4, issue #90):
// `session.created` (the one event carrying `location.directory`) is never
// delivered to a late-loading plugin; `session.execution.started` carries
// only `{sessionID}`; session-context messages carry no location. The store's
// `repo=` stamp must still resolve to the SESSION's repo, never to the
// service's launch directory. `opencode run --standalone` cannot catch a
// failure of this class — there the session always postdates the plugin.
//
// Honest scope note: over the HTTP API the host boots the session's location
// on demand, so this scenario passes on the pre-fix code too (contract
// guard, green-on-both). The #90 production routing — Desktop attaches a
// session whose location is never booted, plugin falls back to a stale module
// scope — is reproduced red-on-pre-fix at the plugin boundary in
// test/repo-scope-serve-host.test.ts, which replays the recorded payloads.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO, type Fake, startFake, resolveOpencode } from "./support/harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spawnGit(args: string[], cwd: string) {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${p.stderr?.toString()}`);
  return p.stdout?.toString().trim() ?? "";
}

/** sha1 of the normalized origin URL, first 12 hex — mirrors src/repokey.ts. */
function originKey(url: string): string {
  const u = url
    .trim()
    .toLowerCase()
    .replace(/^(?:https?:\/\/|ssh:\/\/|git:\/\/)/, "")
    .replace(/^git@/, "")
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .replace(":", "/");
  return new Bun.CryptoHasher("sha1").update(u).digest("hex").slice(0, 12);
}

interface ServeGuest {
  root: string;
  memoryDir: string;
  projDir: string;
  serveRoot: string;
  stop: () => void;
  waitService: () => Promise<void>;
  req: (path: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Isolated service-shaped instance: the plugin is declared in the GLOBAL
 * config (the production shape), the service launches from `serveRoot` —
 * deliberately NOT the session's project — and the project is a git repo with
 * a known origin so the expected stamp is computable.
 */
function makeServeGuest(fake: Fake, pluginPath: string): ServeGuest {
  const root = mkdtempSync(join(tmpdir(), "osi-serve-"));
  const g = (n: string) => {
    mkdirSync(join(root, n), { recursive: true });
    return join(root, n);
  };
  const cfg = g("cfg");
  mkdirSync(join(cfg, "opencode"), { recursive: true });
  const proj = g("proj");
  const memoryDir = g("memory");
  const serveRoot = g("homeroot"); // the service's HOME and cwd: NOT the project
  g("data");
  g("state");
  g("cache");

  writeFileSync(
    join(cfg, "opencode", "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        autoupdate: false,
        snapshot: false,
        provider: {
          fake: {
            npm: "@ai-sdk/openai-compatible",
            name: "Fake",
            options: { baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: "fake-key" },
            models: { scripted: { name: "Scripted" } },
          },
        },
        model: "fake/scripted",
        plugins: [{ package: pluginPath }],
      },
      null,
      2,
    ),
  );

  spawnGit(["init", "-q"], proj);
  spawnGit(["remote", "add", "origin", "git@github.com:osi-fake/stamp-origin.git"], proj);

  const env: Record<string, string> = {
    HOME: serveRoot,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    XDG_CONFIG_HOME: cfg,
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_MEMORY_DIR: memoryDir,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1",
  };

  const port = 18_500 + Math.floor(Math.random() * 900);
  const base = `http://127.0.0.1:${port}`;
  const pwFile = join(cfg, "opencode", "service.json");
  let password = "";
  const authHeader = () => ({ authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` });

  const child = Bun.spawn([resolveOpencode(), "serve", "--service", "--port", String(port)], {
    cwd: serveRoot,
    env,
    stdout: "ignore",
    stderr: "ignore",
  });

  return {
    root,
    memoryDir,
    projDir: proj,
    serveRoot,
    stop: () => child.kill(9),
    async waitService() {
      for (let i = 0; i < 150; i++) {
        if (existsSync(pwFile)) {
          try {
            password = JSON.parse(readFileSync(pwFile, "utf8")).password as string;
            const r = await fetch(`${base}/api/session?limit=1`, { headers: authHeader() });
            if (r.status === 200) return;
          } catch {}
        }
        await sleep(100);
      }
      throw new Error("serve --service did not come up");
    },
    req: (path, init = {}) =>
      fetch(base + path, {
        ...init,
        headers: { "content-type": "application/json", ...authHeader(), ...(init.headers ?? {}) },
      }),
  };
}

function storeRows(memoryDir: string): string[] {
  if (!existsSync(memoryDir)) return [];
  return readdirSync(memoryDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.logfmt$/.test(f))
    .flatMap((f) => readFileSync(join(memoryDir, f), "utf8").trim().split("\n").filter(Boolean));
}

async function waitForRows(memoryDir: string, timeoutMs = 30_000): Promise<string[]> {
  const start = Date.now();
  for (;;) {
    const rows = storeRows(memoryDir);
    if (rows.length) return rows;
    if (Date.now() - start > timeoutMs) throw new Error(`no store rows appeared in ${timeoutMs}ms`);
    await sleep(200);
  }
}

let fake: Fake;
const guests: ServeGuest[] = [];

beforeAll(async () => {
  fake = await startFake();
});
afterEach(async () => {
  for (const g of guests.splice(0)) {
    g.stop();
    await sleep(150);
    rmSync(g.root, { recursive: true, force: true });
  }
});
afterAll(() => fake.stop());

function call(id: string, tool: string, args: Record<string, unknown>) {
  return { tool_calls: [{ id, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] };
}

describe("Feature: repo identity stamped under the service host", () => {
  test("Scenario: a service-hosted session stamps its own repo, not the service's launch dir (#90)", async () => {
    const ORIGIN = "git@github.com:osi-fake/stamp-origin.git";

    // Given a service launched from a directory that is NOT any project,
    // with the plugin installed through the global config
    const g = makeServeGuest(fake, REPO);
    guests.push(g);
    await g.waitService();

    // And a session created over the API IN a git project. (Note: the HTTP
    // path boots the session's location on demand, so this scenario pins the
    // contract end-to-end; the Desktop-attach routing that skips the location
    // boot — the #90 production signature — is replayed at the plugin
    // boundary in test/repo-scope-serve-host.test.ts with recorded payloads.)
    const created = await (
      await g.req("/api/session", { method: "POST", body: JSON.stringify({ location: { directory: g.projDir } }) })
    ).json();
    const sid: string = created.data.id;
    expect(created.data.location?.directory).toBeString();

    fake.setSteps({
      "STAMP::serve": [
        call(
          "s1",
          "memory_remember",
          {
            type: "context",
            scope: "stamp-probe",
            status: "open",
            content: "serve-mode stamp probe row for repo identity verification",
          },
        ),
        { content: "STAMP-DONE" },
      ],
    });

    // When a scripted turn writes one memory from that session
    const prompt = await g.req(`/api/session/${sid}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "STAMP::serve please store" }),
    });
    expect(prompt.status).toBe(200);

    // Then the row lands stamped with the SESSION's repo identity…
    const rows = await waitForRows(g.memoryDir);
    const expectPath = spawnGit(["rev-parse", "--show-toplevel"], g.projDir);
    const row = rows.find((r) => r.includes("serve-mode stamp probe row")) ?? "";
    expect(row).toContain(`repo=${originKey(ORIGIN)}`);
    expect(row).toContain(`repoPath=${expectPath}`);

    // …and never with the service's launch directory (the #90 signature:
    // an unbound session silently partitioning under the server cwd)
    expect(row).not.toContain(g.serveRoot);
  }, 120_000);
});

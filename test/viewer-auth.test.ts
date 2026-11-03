// #223: the viewer must not serve the store unauthenticated over a LAN-facing
// bind. A non-loopback host (bind or allowed-names) mints a startup token and
// every request — reads included — must present it; loopback-only keeps the
// token-free flow. Real child process, real HTTP, same pattern as
// viewer-startup.test.ts.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EVAL = `
import { startViewer } from "./src/viewer/server.ts";
import { readFileSync, existsSync } from "node:fs";
const viewer = await startViewer(0);
const base = "http://127.0.0.1:" + viewer.server.port;
const tokenPath = process.env.OPENCODE_MEMORY_DIR + "/viewer.token";
const check = (name, cond) => { if (!cond) throw new Error("FAIL " + name); };
try {
  if (process.env.OSI_AUTH_TEST === "loopback") {
    check("loopback page open", (await fetch(base + "/")).status === 200);
    check("loopback data open", (await fetch(base + "/api/data")).status === 200);
    check("loopback mints nothing", !existsSync(tokenPath));
    check("loopback token null", viewer.token == null);
  } else {
    check("read refused", (await fetch(base + "/api/data")).status === 401);
    check("page refused", (await fetch(base + "/")).status === 401);
    const edit = await fetch(base + "/api/edit", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check("mutation refused", edit.status === 401);
    const token = readFileSync(tokenPath, "utf8").trim();
    check("token shape", /^[0-9a-f]{64}$/.test(token));
    check("token returned", viewer.token === token);
    const wrong = await fetch(base + "/api/data", { headers: { authorization: "Bearer " + "0".repeat(64) } });
    check("wrong token refused", wrong.status === 401);
    const bearer = await fetch(base + "/api/data", { headers: { authorization: "Bearer " + token } });
    check("bearer accepted", bearer.status === 200);
    const page = await fetch(base + "/?token=" + token);
    check("bootstrap page", page.status === 200);
    const setCookie = page.headers.get("set-cookie") ?? "";
    check("cookie issued", setCookie.includes("osi-viewer=" + token) && setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Strict"));
    const viaCookie = await fetch(base + "/api/data", { headers: { cookie: "osi-viewer=" + token } });
    check("cookie accepted", viaCookie.status === 200);
    const apiQuery = await fetch(base + "/api/data?token=" + token);
    check("query token only on /", apiQuery.status === 401);
    const mutate = await fetch(base + "/api/delete", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", reason: "auth test" }) });
    check("mutation with token reaches the route", mutate.status !== 401 && mutate.status !== 403);
  }
} finally { viewer.server.stop(true); }
`;

function runViewer(env: Record<string, string>, root: string) {
  return Bun.spawnSync([process.execPath, "--eval", EVAL], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      OPENCODE_MEMORY_DIR: join(root, "memory"),
      OPENCODE_COMMANDS_DIR: join(root, "commands"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
}

describe("viewer token auth (#223)", () => {
  test("loopback-only bind stays token-free and mints no token file", () => {
    const root = mkdtempSync(join(tmpdir(), "osi-viewer-auth-"));
    try {
      const result = runViewer({ OSI_AUTH_TEST: "loopback" }, root);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    } finally {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    }
  });

  test("exposed bind refuses every unauthenticated request and accepts the minted token", () => {
    const root = mkdtempSync(join(tmpdir(), "osi-viewer-auth-"));
    try {
      const result = runViewer(
        {
          OSI_AUTH_TEST: "exposed",
          OPENCODE_VIEWER_HOST: "127.0.0.1",
          OPENCODE_VIEWER_ALLOWED_HOSTS: "192.0.2.10",
        },
        root,
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    } finally {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    }
  });
});

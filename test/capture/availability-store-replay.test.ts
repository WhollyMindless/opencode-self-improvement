import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCAN_BUDGET } from "../../src/capture/available.ts";
import { formatLine } from "../../src/core/logfmt/format.ts";

const runner = join(
  import.meta.dir,
  "../../bench/runners/availability-store-replay.ts",
);

test("store replay reports the corpus for both budgets without writing to its inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "osi-store-replay-"));
  try {
    const repo = join(root, "repo");
    const store = join(root, "store");
    mkdirSync(repo);
    mkdirSync(store);
    if (process.platform !== "win32") chmodSync(store, 0o755);
    const mode = statSync(store).mode;
    const memoryFile = join(store, "2026-01-01.logfmt");
    const statement =
      "Route the verification request to the isolated test endpoint before marking the synthetic deployment complete.";
    for (let i = 0; i < 9; i++) {
      writeFileSync(
        join(repo, `a${i}.md`),
        "Unrelated repository notes.\n".padEnd(240_000),
      );
    }
    writeFileSync(join(repo, "z-note.md"), statement);
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { deploy: "deploy-tool ship" } }),
    );
    for (const args of [
      ["init", "--quiet"],
      ["add", "--", "."],
    ]) {
      const git = Bun.spawnSync(["git", "-C", repo, ...args]);
      expect(git.exitCode).toBe(0);
    }
    const content = [
      statement,
      "Run `npm run deploy`.",
      "The synthetic proxy is isolated from the regional test registry.",
    ]
      .map((value) =>
        formatLine({
          ts: "2026-01-01T00:00:00.000Z",
          type: "learning",
          scope: "synthetic",
          content: value,
        }),
      )
      .join("\n");
    const blockedTs = "2026-01-01T00:00:01.000Z";
    const blockedRow = formatLine({
      ts: blockedTs,
      type: "learning",
      scope: "synthetic",
      content: "Run `npm run deploy`.",
    });
    const storeContents = `${content}\n${blockedRow}`;
    const blocklistFile = join(store, "blocklist.logfmt");
    const blocklist = formatLine({ ts: blockedTs });
    writeFileSync(memoryFile, storeContents);
    writeFileSync(blocklistFile, blocklist);
    const gitIndex = join(repo, ".git", "index");
    const indexBefore = readFileSync(gitIndex);

    const run = (...flags: string[]): string => {
      const result = Bun.spawnSync([process.execPath, runner, repo, ...flags], {
        env: { ...process.env, OPENCODE_MEMORY_DIR: store },
        timeout: 10_000,
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      return result.stdout.toString();
    };
    const shipped = run();
    expect(shipped).toContain("row_in_population=2 reason=declared_gate");
    expect(shipped).not.toContain("row_in_population=1 ");
    expect(shipped).toContain(
      `refused=1/3 rate=33.33% files=9 chars=2160000 capped=true budget=${DEFAULT_SCAN_BUDGET} budget_units=decoded_characters in_tracked_file=0 declared_gate=1`,
    );

    const raised = run("--scan-budget", "4000000");
    expect(raised).toContain(
      "population=loaded_unblocked_rows rows=3 includes_superseded=true",
    );
    expect(raised).toContain("row_in_population=1 reason=in_tracked_file");
    expect(raised).toContain(`${statement.slice(0, 80)}…`);
    expect(raised).not.toContain(statement);
    expect(raised).not.toContain("row_in_population=3 ");
    expect(raised).toMatch(
      /refused=2\/3 rate=66\.67% files=11 chars=\d+ capped=false budget=4000000 budget_units=decoded_characters in_tracked_file=1 declared_gate=1/,
    );
    expect(run("--scan-budget", "4000000", "--full-content")).toContain(
      statement,
    );

    expect(raised).not.toContain(root);
    expect(readFileSync(gitIndex)).toEqual(indexBefore);
    expect(readFileSync(memoryFile, "utf8")).toBe(storeContents);
    expect(readFileSync(blocklistFile, "utf8")).toBe(blocklist);
    expect(readdirSync(store).sort()).toEqual([
      "2026-01-01.logfmt",
      "blocklist.logfmt",
    ]);
    expect(statSync(store).mode).toBe(mode);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

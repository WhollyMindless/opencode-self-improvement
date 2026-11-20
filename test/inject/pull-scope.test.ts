// What a contextual pull is allowed to search, and what that buys.
//
// The pull bolts memory onto a tool result the model did not ask for, so its
// scope is a precision decision, not a coverage one. Every case here pins a
// number bench/runners/pull-precision.ts measured, so a future "improvement"
// that re-widens the query has to move the bench, not just the code.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryRoot } from "../../src/core/config/paths.ts";
import { formatLine } from "../../src/core/logfmt/format.ts";
import {
  contextualPull,
  PULL_SHIPPED,
  pullQueryFor,
  pullScopeFrom,
} from "../../src/inject/pull.ts";
import { removeStore } from "../helpers/remove-store.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-pullscope-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  removeStore(root);
});

function seed(type: string, scope: string, content: string): void {
  const file = join(
    memoryRoot(),
    `${new Date().toISOString().split("T")[0]}.logfmt`,
  );
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    formatLine({ ts: new Date().toISOString(), type, scope, content }) + "\n",
  );
}

describe("pullQueryFor", () => {
  const args = { pattern: "table_manager.save" };

  test("a tool outside the scope contributes nothing — the write path stays clean", () => {
    expect(
      pullQueryFor("edit", args, "table_manager.save failed", PULL_SHIPPED),
    ).toBe("");
  });

  test("arguments only when the output is excluded", () => {
    expect(
      pullQueryFor("grep", args, "table_manager.save failed", {
        tools: ["grep"],
        includeOutput: false,
        outputChars: 0,
      }),
    ).toBe("table_manager.save");
  });

  test("arguments then output when included — the model's own words first", () => {
    expect(
      pullQueryFor("grep", args, "connection refused", {
        tools: ["grep"],
        includeOutput: true,
        outputChars: 512,
      }),
    ).toBe("table_manager.save\nconnection refused");
  });

  test("output is capped: a 40 KB file dump is not a query", () => {
    const q = pullQueryFor("read", {}, "x".repeat(40_000), {
      tools: ["read"],
      includeOutput: true,
      outputChars: 512,
    });
    expect(q.length).toBeLessThanOrEqual(512);
  });

  test("output alone when the call had no searchable arguments", () => {
    expect(
      pullQueryFor("read", {}, "  connection refused  ", {
        tools: ["read"],
        includeOutput: true,
        outputChars: 512,
      }),
    ).toBe("connection refused");
  });

  test("a call with neither arguments nor output pulls nothing", () => {
    expect(pullQueryFor("read", {}, "", PULL_SHIPPED)).toBe("");
  });
});

describe("pullScopeFrom", () => {
  test("no options: the measured default", () => {
    expect(pullScopeFrom(undefined)).toEqual(PULL_SHIPPED);
  });

  test("pullOutputChars: 0 restores the arguments-only behaviour", () => {
    const s = pullScopeFrom({ pullOutputChars: 0 });
    expect(s.includeOutput).toBe(false);
    expect(s.outputChars).toBe(0);
    // Without the output there is only one search to make, so the merge is off.
    expect(s.argsUnion).toBe(false);
  });

  test("pullTools narrows which results may carry a pull", () => {
    expect(pullScopeFrom({ pullTools: ["read"] }).tools).toEqual(["read"]);
  });

  test("a malformed option falls back to the default, never to no pull", () => {
    for (const bad of [
      { pullOutputChars: "many" },
      { pullOutputChars: -1 },
      { pullOutputChars: Number.NaN },
      { pullTools: "read" },
      { pullTools: [1, null] },
      { pullTools: {} },
    ])
      expect(pullScopeFrom(bad)).toEqual(PULL_SHIPPED);
  });

  test("an empty pullTools list is the explicit off switch", () => {
    // `[]` is a decision someone typed, not a parse failure: no tool result
    // carries a pull. The fallback above guards the typo, not this.
    expect(pullScopeFrom({ pullTools: [] }).tools).toEqual([]);
  });

  test("a value that does not parse is reported, not swallowed", () => {
    const seen: string[] = [];
    const warn = (m: string) => seen.push(m);
    expect(pullScopeFrom({ pullOutputChars: "many" }, warn)).toEqual(
      PULL_SHIPPED,
    );
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("pullOutputChars");
    seen.length = 0;
    expect(pullScopeFrom({ pullTools: "read" }, warn).tools).toEqual(
      PULL_SHIPPED.tools,
    );
    expect(seen[0]).toContain("pullTools");
    seen.length = 0;
    expect(pullScopeFrom({ pullTools: [1, null] }, warn).tools).toEqual(
      PULL_SHIPPED.tools,
    );
    expect(seen[0]).toContain("pullTools");
    seen.length = 0;
    // The default arm and the explicit off are both what the user asked for, so
    // neither writes to the console.
    pullScopeFrom(undefined, warn);
    pullScopeFrom({ pullOutputChars: 0, pullTools: [] }, warn);
    expect(seen).toEqual([]);
  });

  test("Scenario: with pullTools empty the tool result is left untouched", () => {
    seed("pattern", "ctl", "use table_manager.save(config, opts)");
    const out = { output: "table_manager.save" };
    return contextualPull(
      { tool: "grep", args: { pattern: "table_manager.save" } },
      out,
      1200,
      undefined,
      pullScopeFrom({ pullTools: [] }),
    ).then((rows) => {
      expect(rows).toEqual([]);
      expect(out.output).toBe("table_manager.save");
    });
  });

  test("output characters are clamped, not trusted", () => {
    expect(pullScopeFrom({ pullOutputChars: 1e9 }).outputChars).toBe(4096);
  });

  test("shell is NOT in the shipped scope: measured 100% noise on ordinary traffic", () => {
    expect(PULL_SHIPPED.tools).not.toContain("shell");
  });
});

describe("contextualPull scope behaviour", () => {
  test("Scenario: a fact keyed to the tool's OUTPUT reaches the model", () => {
    // The whole point of the widening. The path says nothing; only the body the
    // model just read names the failure the memory is about.
    seed(
      "blocker",
      "db",
      "When the connection pool is exhausted: raise pool_max and retry with backoff",
    );
    const out = {
      output:
        "1: SELECT 1\n2: FATAL: connection pool exhausted, cannot acquire connection\n3: at Pool.acquire (pool.ts:88)\n",
    };
    return contextualPull(
      { tool: "read", args: { path: "src/db/query.ts" } },
      out,
      1200,
      undefined,
      PULL_SHIPPED,
    ).then(() => {
      expect(out.output).toContain("pool_max");
    });
  });

  test("Scenario: the same call under the old arguments-only scope pulls nothing", () => {
    seed(
      "blocker",
      "db",
      "When the connection pool is exhausted: raise pool_max and retry with backoff",
    );
    const out = {
      output:
        "1: SELECT 1\n2: FATAL: connection pool exhausted, cannot acquire connection\n",
    };
    return contextualPull(
      { tool: "read", args: { path: "src/db/query.ts" } },
      out,
      1200,
      undefined,
      { tools: ["read"], includeOutput: false, outputChars: 0 },
    ).then(() => {
      expect(out.output).toBe(
        "1: SELECT 1\n2: FATAL: connection pool exhausted, cannot acquire connection\n",
      );
    });
  });

  test("Scenario: boilerplate output never costs a precise search its row", () => {
    // The regression the argsUnion merge exists for. The combined query is
    // longer, and a longer query raises the two-concept gate — so searching
    // "table_manager.save grep results" on its own DROPS the row the model's
    // own words matched exactly. This is test/host/scenarios.test.ts's I3 case,
    // pinned at unit level with the scope spelled out.
    seed("pattern", "ctl", "use table_manager.save(config, opts)");
    const out = { output: "grep results" };
    return contextualPull(
      { tool: "grep", args: { pattern: "table_manager.save" } },
      out,
      1200,
      undefined,
      PULL_SHIPPED,
    ).then(() => {
      expect(out.output).toContain("use table_manager.save(config, opts)");
    });
  });

  test("Scenario: three output matches never crowd out the exact argument match", () => {
    // The other half of the merge. Above the output matches nothing; here it
    // matches THREE rows, so the combined search fills every slot and the row
    // the model's own words matched exactly is pushed past the cap and sliced
    // away. The merge has to give argument matches first choice, not last
    // refusal, or `argsUnion: true` only recovers a row when the output is
    // boring.
    seed("pattern", "ctl", "use table_manager.save(config, opts)");
    seed("blocker", "db", "connection pool exhausted: raise pool_max");
    seed("blocker", "db", "cannot acquire connection: check the pool limit");
    seed("blocker", "db", "retry with backoff when the pool is exhausted");
    const out = {
      output:
        "connection pool exhausted cannot acquire connection retry with backoff",
    };
    return contextualPull(
      { tool: "grep", args: { pattern: "table_manager.save" } },
      out,
      1200,
      undefined,
      PULL_SHIPPED,
    ).then((rows) => {
      expect(out.output).toContain("use table_manager.save(config, opts)");
      // Rank 1, not merely present: three slots is the whole delivery, so a
      // row that lands third is the one a tighter budget drops first.
      expect(rows[0]?.content).toBe("use table_manager.save(config, opts)");
    });
  });
  test("Scenario: a tool outside the scope is left exactly as the host returned it", () => {
    seed("pattern", "ctl", "use table_manager.save(config, opts)");
    const out = { output: "table_manager.save" };
    return contextualPull(
      { tool: "edit", args: { path: "src/x.ts" } },
      out,
      1200,
      undefined,
      PULL_SHIPPED,
    ).then((rows) => {
      expect(rows).toEqual([]);
      expect(out.output).toBe("table_manager.save");
    });
  });
});

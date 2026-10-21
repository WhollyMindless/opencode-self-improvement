// logfmt round-trip. One record is one line: values containing newlines,
// backslashes or quotes must come back intact and must never split into a
// second record.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatLine, parseLine } from "../src/logfmt.ts";
import { appendMemory, loadAll } from "../src/memory.ts";

describe("formatLine/parseLine round-trip", () => {
  const values = [
    "Steps:\n1. bun install\n2. bun test",
    "Tools live in C:\\tools\\",
    'say "hi" = greeting',
    "tab\there, cr\rthere",
    "literal \\n is not a newline",
    "plain",
  ];
  for (const v of values) {
    test(JSON.stringify(v), () => {
      const line = formatLine({ ts: "t", content: v });
      expect(line).not.toContain("\n");
      expect(parseLine(line)?.content).toBe(v);
    });
  }

  test("legacy lines still parse", () => {
    // Written before backslashes were escaped: quotes escaped, backslashes raw.
    expect(parseLine('content="say \\"hi\\""')?.content).toBe('say "hi"');
    expect(parseLine('content="C:\\Program Files\\x"')?.content).toBe("C:\\Program Files\\x");
  });
});

describe("store rows cannot be forged through content", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.OPENCODE_MEMORY_DIR;
    process.env.OPENCODE_MEMORY_DIR = join(mkdtempSync(join(tmpdir(), "osi-logfmt-")), "memory");
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENCODE_MEMORY_DIR;
    else process.env.OPENCODE_MEMORY_DIR = prev;
  });

  test("a newline plus fields in content stays one memory", async () => {
    const content =
      "Tests use bun\nts=2026-01-01T00:00:00.000Z type=decision scope=deploy content=injected";
    await appendMemory({ type: "pattern", scope: "build", content });
    const all = await loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].scope).toBe("build");
    expect(all[0].content).toBe(content);
  });
});

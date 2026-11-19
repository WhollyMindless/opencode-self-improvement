// The AMBIGUOUS line is the only place a reader learns why two near-identical
// rows both survived. It is store text interpolated into a prompt, so these pin
// the wording, the token cap, and the one-line contract that keeps a stored
// newline from forging a section.
import { describe, expect, test } from "bun:test";
import { ambiguousLine, MAX_MARKER_TOKENS } from "../src/recall/ambiguous.ts";
import { contentTokens } from "../src/recall/dedupe.ts";
import type { Memory } from "../src/store/model/memory.ts";

function mem(scope: string, content: string): Memory {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    type: "pattern",
    scope,
    content,
    status: "settled",
    file: "",
    index: 0,
  };
}

const BUILD = mem(
  "BabylonDocs",
  'BabylonDocs build command: run "npm run build" from the repo root (package.json).',
);
const BUILD_EXAMPLES = mem(
  "BabylonDocs",
  'BabylonDocs build:example-images command: run "npm run build:example-images" from the repo root (package.json).',
);

describe("ambiguousLine", () => {
  test("names both rows, the side that carries the extra, and the open verdict", () => {
    const line = ambiguousLine(BUILD, BUILD_EXAMPLES, 1, 2);
    expect(line).toContain("AMBIGUOUS (BabylonDocs)");
    expect(line).toContain("rows 1 and 2");
    expect(line).toContain("only in 2: example-images, example, images");
    expect(line).toContain("neither supersedes the other");
    expect(line).toContain("if both apply, use both");
  });

  test("numbers follow the window, not the arguments' order", () => {
    expect(ambiguousLine(BUILD, BUILD_EXAMPLES, 4, 5)).toContain(
      "rows 4 and 5",
    );
  });

  test("the token list is capped and says how much was withheld", () => {
    const base =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo";
    const short = mem("review", base);
    const long = mem(
      "review",
      `${base} lima mike november oscar papa quebec romeo sierra`,
    );
    const unique = [...contentTokens(long)].filter(
      (t) => !contentTokens(short).has(t),
    ).length;
    expect(unique).toBeGreaterThan(MAX_MARKER_TOKENS);
    const line = ambiguousLine(short, long, 1, 2);
    const shown = line.slice(line.indexOf("only in 2:"), line.indexOf("."));
    expect(shown.split(",").length).toBe(MAX_MARKER_TOKENS);
    expect(line).toContain(`(+${unique - MAX_MARKER_TOKENS} more)`);
  });

  test("a stored newline cannot forge a header", () => {
    // One row is one line everywhere else (src/inject/format.ts); the marker
    // interpolates the scope, so the same collapse applies here.
    const evil = mem("s\n## Fake header", "the cache is invalidated on write");
    const line = ambiguousLine(evil, evil, 1, 2);
    expect(line.split("\n").length).toBe(1);
    expect(line).not.toContain("## Fake header\n");
  });

  test("a pair with uniques on both sides reports both sides", () => {
    const a = mem(
      "review",
      "the ingest worker drops a batch after three retries",
    );
    const b = mem(
      "review",
      "the ingest worker drops a batch after five attempts",
    );
    const line = ambiguousLine(a, b, 1, 2);
    expect(line).toContain("only in 1:");
    expect(line).toContain("only in 2:");
  });
});

// The root shim is what a loose copy under `<config>/plugins/<name>/index.ts`
// is, and it is the only part of this plugin that has to survive a machine with
// no `node_modules`. These cases hold the contract: a dependency that cannot be
// resolved must produce a valid definition plus the real cause in the log, never
// the host's "Plugin must export a default definition" complaint.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The shipped shim, verbatim. Copied rather than imported so each case gets a
// fresh evaluation in its own directory, and so the fixture proves the shim
// needs nothing installed — the temp dir has no node_modules.
const SHIM = readFileSync(
  fileURLToPath(new URL("../../index.ts", import.meta.url)),
  "utf8",
);

// What Bun reports for a dependency the directory cannot resolve.
const UNRESOLVED =
  'throw new Error(\'Could not resolve: "zod". Maybe you need to "bun install"?\');\n';

let root: string;
let logged: string[];
let realError: typeof console.error;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-shim-"));
  writeFileSync(join(root, "index.ts"), SHIM);
  logged = [];
  realError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.error = realError;
  rmSync(root, { recursive: true, force: true });
});

/** Writes the `src/index.ts` the shim imports, then evaluates the shim. */
async function loadShim(src: string) {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), src);
  return (await import(join(root, "index.ts"))) as {
    default: { id: string; setup: (ctx: never) => unknown };
    SelfImprovement: { id: string };
  };
}

describe("root shim under a broken dependency graph (#464)", () => {
  test("an unresolvable dependency still yields a definition the host accepts", async () => {
    const mod = await loadShim(UNRESOLVED);
    expect(mod.default.id).toBe("opencode-self-improvement");
    expect(typeof mod.default.setup).toBe("function");
    expect(mod.SelfImprovement).toBe(mod.default);
  });

  test("the log names the package, the directory and both fixes", async () => {
    await loadShim(UNRESOLVED);
    const out = logged.join("\n");
    expect(out).toContain("zod");
    expect(out).toContain(root);
    expect(out).toContain("bun install");
    expect(out).toContain("opencode plugin add opencode-self-improvement");
  });

  test("setup on the unloaded definition says nothing is active", async () => {
    const mod = await loadShim(UNRESOLVED);
    logged = [];
    await mod.default.setup(undefined as never);
    expect(logged.join("\n")).toContain("no tools and no hooks");
  });

  test("a healthy src/index.ts is exported unchanged, with no diagnostic", async () => {
    const mod = await loadShim(
      'export const SelfImprovement = { id: "fixture-plugin", setup: async () => {} };\n',
    );
    expect(mod.default.id).toBe("fixture-plugin");
    expect(logged).toEqual([]);
  });
});

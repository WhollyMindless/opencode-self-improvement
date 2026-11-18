// Snapshot names are pinned to one grammar at BOTH boundaries, and a restore
// can never write outside the memory root.
//
// The wire (/api/restore) takes the name raw from a request: it must refuse
// anything that is not `<epoch-ms>-<YYYY-MM-DD>.logfmt`, so no path join can
// be steered with `..`, an absolute path, or a traversal-bearing name. The
// refusal is the fixed wire string with nothing echoed back — the store's
// rejection repeats the submitted name, which for `..` is a directory name.
// The store layer (restoreSnapshot) re-checks the same grammar plus a calendar
// check, and holds the containment check that refuses a target outside the
// memory root.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetState } from "../src/core/state.ts";
import { memoryRoot, snapshotDir } from "../src/core/config/paths.ts";
import { restoreSnapshot } from "../src/store/undo.ts";
import { startViewer, type ViewerServer } from "../src/viewer/server.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;
let viewer: ViewerServer | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-snapname-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  resetState();
  mkdirSync(snapshotDir(), { recursive: true });
});

afterEach(() => {
  viewer?.server.stop(true);
  viewer = undefined;
  resetState();
  delete process.env.OPENCODE_MEMORY_DIR;
  removeStore(root);
});

async function post(
  v: ViewerServer,
  route: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return v.server.fetch(
    new Request(new URL(route, v.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// Names the WIRE must refuse: none of them matches the snapshot grammar, so
// the request never reaches the store and the answer is the fixed string.
const WIRE_REFUSED = [
  "",
  "..",
  "../2026-11-01.logfmt",
  "..%2F2026-11-01.logfmt",
  "/etc/2026-11-01.logfmt",
  "171-2026-11-01.logfmt.tmp",
  "171-2026-11-01.LOGFMT",
  "x-2026-11-01.logfmt",
  "171-2026-11-1.logfmt",
];

// Names that SHAPE-match the wire grammar and are refused one layer down, by
// the store's calendar check. They are here so the two boundaries stay
// distinguishable: the wire does not know about calendars, and the store's
// rejection names the file it rejected.
const STORE_REFUSED = ["171-2026-13-45.logfmt", "171-2026-02-30.logfmt"];

test("the wire refuses every name outside the snapshot grammar", async () => {
  viewer = await startViewer(0);
  for (const name of WIRE_REFUSED) {
    const res = await post(viewer, "/api/restore", { name });
    expect(res.status, `name ${JSON.stringify(name)}`).toBe(400);
    // The refusal must come from THIS boundary, not from the store behind it.
    // The store's own rejection repeats the submitted name, which for `..`
    // resolves to a directory name and puts a filesystem path in an HTTP
    // body. The wire answer is the fixed string, with nothing echoed back.
    expect(await res.text(), `name ${JSON.stringify(name)}`).toBe(
      '{"error":"invalid snapshot name"}',
    );
  }
});

test("a shape-valid but impossible date is refused by the store, one layer down", async () => {
  viewer = await startViewer(0);
  for (const name of STORE_REFUSED) {
    const res = await post(viewer, "/api/restore", { name });
    expect(res.status, `name ${JSON.stringify(name)}`).toBe(400);
    expect(await res.text(), `name ${JSON.stringify(name)}`).toBe(
      `{"error":"invalid snapshot name: ${name}"}`,
    );
  }
});

test("a grammar-valid name is NOT refused by the grammar gate", async () => {
  // Positive control: the 400s above must come from the grammar, not from a
  // blanket refusal. The file does not exist, so the request gets past the
  // name gate and fails later, at the store lookup.
  viewer = await startViewer(0);
  const res = await post(viewer, "/api/restore", {
    name: "171-2026-11-01.logfmt",
  });
  expect(await res.text()).toInclude("snapshot not found");
});

test("restoreSnapshot refuses names outside the grammar before touching the disk", async () => {
  const outside = join(root, "outside.logfmt");
  writeFileSync(outside, "ts=2026-11-01T00:00:00.000Z evil=1\n");
  // Planted INSIDE snapshots/ so a refusal proves the check ran, not that a
  // file is missing.
  writeFileSync(join(snapshotDir(), "171-2026-13-45.logfmt"), "evil\n");
  writeFileSync(join(snapshotDir(), "171-outside.logfmt"), "evil\n");
  const planted: [string, RegExp][] = [
    ["../outside.logfmt", /^invalid snapshot name: outside\.logfmt$/],
    [
      join(snapshotDir(), "..", "..", "outside.logfmt"),
      /^invalid snapshot name: outside\.logfmt$/,
    ],
    [
      "171-2026-13-45.logfmt",
      /^invalid snapshot name: 171-2026-13-45\.logfmt$/,
    ],
    ["171-outside.logfmt", /^invalid snapshot name: 171-outside\.logfmt$/],
  ];
  for (const [snap, expected] of planted) {
    await expect(restoreSnapshot(snap, memoryRoot(), "force")).rejects.toThrow(
      expected,
    );
  }
  expect(readFileSync(outside, "utf8")).toContain("evil=1");
});

test("restoreSnapshot rejects an absolute path outside snapshots/", async () => {
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "171-2026-11-01.logfmt"), "evil\n");
  await expect(
    restoreSnapshot(
      join(elsewhere, "171-2026-11-01.logfmt"),
      memoryRoot(),
      "force",
    ),
  ).rejects.toThrow(/outside the snapshots directory/);
});

// The containment check in restoreSnapshot has no reachable input: the target
// name is the `<YYYY-MM-DD>.logfmt` capture, which cannot carry a separator,
// so the resolved target is always a direct child of the root. This pins that
// premise. Widen the snapshot grammar and this test is what names it, before
// the backstop below the grammar ever has to fire.
test("an accepted snapshot restores exactly one file, inside the root", async () => {
  const day = "2026-11-01.logfmt";
  const outside = join(root, "elsewhere");
  mkdirSync(outside);
  writeFileSync(join(outside, day), "evil\n");
  writeFileSync(
    join(snapshotDir(), `171-${day}`),
    "ts=2026-11-01T00:00:00.000Z type=context scope=s content=restored\n",
  );
  writeFileSync(
    join(memoryRoot(), day),
    "ts=2026-11-01T00:00:00.000Z stale=1\n",
  );
  const res = await restoreSnapshot(`171-${day}`, memoryRoot(), "force");
  expect(res.target).toBe(join(memoryRoot(), day));
  expect(readFileSync(join(memoryRoot(), day), "utf8")).toInclude(
    "content=restored",
  );
  // Nothing outside the root was touched.
  expect(readFileSync(join(outside, day), "utf8")).toBe("evil\n");
});

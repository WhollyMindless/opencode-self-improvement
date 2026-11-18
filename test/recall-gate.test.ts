// #409 case bank: the recall tool's matcher returns any row that shares a single
// word with the query, so a three-word search is answered by whatever happens to
// mention one of them. The gate applies the injection path's two-concept rule to
// the tool, counting whole words — the first version counted substrings and was
// satisfiable by accidents (`on` inside `context`, `283` inside `build2837`).
// The property that matters for a release is the first unit test and the
// first e2e test: with OPENCODE_MEMORY_QUERY_GATE=off the tool's output is
// unchanged; unset now means the gate is ON (#426).
//
// Evidence: poc-409/casebank — 404 real recall queries from 30 days of session
// transcripts, relevance labelled by two independent readers against a pinned
// store snapshot, measured through this handler by poc-409/casebank/gate-e2e.ts.
// The numbers quoted in the PR body are from the full-text relabel; the
// substring gate's numbers are void.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryRoot } from "../src/core/config/paths.ts";
import { formatLine } from "../src/core/logfmt/format.ts";
import { resetState } from "../src/core/state.ts";
import { setRepoScope } from "../src/identity/repokey.ts";
import {
  admitsRow,
  GATE_ENV,
  gateEnabled,
  queryConcepts,
  rowConcepts,
  sharedConcepts,
} from "../src/recall/gate.ts";
import type { Memory } from "../src/store/model/memory.ts";
import { loadPlugin } from "./harness.ts";
import { removeStore } from "./helpers/remove-store.ts";

function mem(content: string, over: Partial<Memory> = {}): Memory {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    type: "learning",
    scope: "review",
    content,
    status: "settled",
    file: "",
    index: 0,
    ...over,
  };
}

const ONE_CONCEPT = mem(
  "The head of the release branch must be rebuilt after the remote moved to SSH",
);
const TWO_CONCEPTS = mem(
  "pr-watch watermark: #283 head 9f1c2bd, CI green, approved at that head",
);
const NOTHING = mem(
  "Bun appends with O_APPEND; never use Bun.write with append, it silently truncates",
);
// The row the substring gate admitted for the query that motivated this change:
// `283` occurred inside `build2837` and `head` was genuinely shared, so two
// substring hits looked like two concepts. Whole words share only `head`.
const SUBSTRING_TRAP = mem("checkout detached head at build2837", {
  type: "context",
});

describe("gateEnabled", () => {
  test("unset and empty mean on (default ON, #409 flags)", () => {
    expect(gateEnabled({})).toBe(true);
    expect(gateEnabled({ [GATE_ENV]: "" })).toBe(true);
    expect(gateEnabled({ [GATE_ENV]: "  " })).toBe(true);
  });
  test("explicit off words and any zero mean off", () => {
    expect(gateEnabled({ [GATE_ENV]: "off" })).toBe(false);
    expect(gateEnabled({ [GATE_ENV]: "no" })).toBe(false);
    expect(gateEnabled({ [GATE_ENV]: "n" })).toBe(false);
    expect(gateEnabled({ [GATE_ENV]: "FALSE" })).toBe(false);
    expect(gateEnabled({ [GATE_ENV]: "0" })).toBe(false);
    // A shell user writes these meaning off; they must mean off.
    expect(gateEnabled({ [GATE_ENV]: "00" })).toBe(false);
    expect(gateEnabled({ [GATE_ENV]: "0.0" })).toBe(false);
  });
  test("affirmatives and anything else mean on", () => {
    expect(gateEnabled({ [GATE_ENV]: "1" })).toBe(true);
    expect(gateEnabled({ [GATE_ENV]: "true" })).toBe(true);
    expect(gateEnabled({ [GATE_ENV]: "YES" })).toBe(true);
    expect(gateEnabled({ [GATE_ENV]: "On" })).toBe(true);
    // A typo must not silently disable a default-ON quality path.
    expect(gateEnabled({ [GATE_ENV]: "tureh" })).toBe(true);
  });
});

describe("queryConcepts", () => {
  test("lower-cases and de-duplicates whole words", () => {
    expect(queryConcepts("Head  head WATERMARK")).toEqual([
      "head",
      "watermark",
    ]);
    expect(queryConcepts("   ")).toEqual([]);
  });
  test("drops grammar: stopwords and fragments are not concepts", () => {
    // "pr" inside "preference" and "on" inside "context" satisfied the old gate.
    expect(queryConcepts("how do I set the pr on")).toEqual(["set"]);
    expect(queryConcepts("what is the pr on")).toEqual([]);
  });
  test("keeps identifiers whole", () => {
    // Splitting these into fragments is the regression that blocked PR #417.
    expect(queryConcepts("db_id")).toEqual(["db_id"]);
    expect(queryConcepts("OPENCODE_MEMORY_DIR")).toEqual([
      "opencode_memory_dir",
    ]);
    expect(queryConcepts("get-user-account")).toEqual([
      "get",
      "user",
      "account",
    ]);
  });
});

describe("sharedConcepts", () => {
  test("counts a word found in the keywords as shared", () => {
    const m = mem("unrelated prose", { kw: ["watermark"] });
    expect(sharedConcepts(m, ["watermark", "head"])).toBe(1);
  });
  test("a number matches the row that cites it, not rows that contain it", () => {
    expect(sharedConcepts(TWO_CONCEPTS, ["283"])).toBe(1); // "#283"
    expect(sharedConcepts(SUBSTRING_TRAP, ["283"])).toBe(0); // "build2837"
    expect(sharedConcepts(mem("#12777 bump in #2830"), ["277", "283"])).toBe(0);
  });
  test("rowConcepts keeps identifiers whole", () => {
    expect(
      rowConcepts(mem("the db_id column is the join key")).has("db_id"),
    ).toBe(true);
  });
  test("rowConcepts also emits identifier SEGMENTS (#426 review)", () => {
    // Default-on must not regress the identifier-to-prose lookup the #417
    // tokenizer restored: `discount tiers` has to find the row that names
    // DISCOUNT_TIERS.
    const concepts = rowConcepts(
      mem("DISCOUNT_TIERS controls the pricing schedule"),
    );
    expect(concepts.has("discount_tiers")).toBe(true);
    expect(concepts.has("discount")).toBe(true);
    expect(concepts.has("tiers")).toBe(true);
    // Segmenting is word-level, not substring: build2837 has no underscore,
    // so 283 is still not a concept of it.
    expect(rowConcepts(SUBSTRING_TRAP).has("283")).toBe(false);
  });
  test("rowConcepts segments camelCase too (#426 review round 2)", () => {
    // The scorer tokenizer (#417) handles camel boundaries; admission must
    // not be narrower. Lowercasing before tokenizing lost the boundary.
    const concepts = rowConcepts(
      mem("discountTiers controls the pricing schedule"),
    );
    expect(concepts.has("discounttiers")).toBe(true); // whole, protections kept
    expect(concepts.has("discount")).toBe(true);
    expect(concepts.has("tiers")).toBe(true);
    expect(rowConcepts(mem("build2837 runaway")).has("283")).toBe(false);
  });
  test("rowConcepts keeps the exact suffix of a dotted name (round 3)", () => {
    // words() segments at every separator, so `table.db_id` emits
    // table.db_id, table, db, id — never `db_id` whole, and a `db_id` query
    // is one concept. The pre-round-2 WORD split (underscore inside) is the
    // only tokenizer that retains it.
    const concepts = rowConcepts(mem("table.db_id stores the foreign key"));
    expect(concepts.has("table.db_id")).toBe(true);
    expect(concepts.has("db_id")).toBe(true);
    expect(rowConcepts(mem("build2837 runaway")).has("283")).toBe(false);
  });
});

describe("admitsRow", () => {
  test("a query of three concepts or more needs two shared concepts", () => {
    const concepts = queryConcepts("head watermark 283");
    expect(admitsRow(ONE_CONCEPT, concepts)).toBe(false);
    expect(admitsRow(TWO_CONCEPTS, concepts)).toBe(true);
    expect(admitsRow(NOTHING, concepts)).toBe(false);
    expect(admitsRow(SUBSTRING_TRAP, concepts)).toBe(false);
  });
  test("the boundary counts distinct concepts, not tokens", () => {
    // Three tokens, two concepts: too vague to hold a row to two.
    expect(admitsRow(ONE_CONCEPT, queryConcepts("head watermark head"))).toBe(
      true,
    );
    // Three distinct concepts: two required.
    expect(admitsRow(ONE_CONCEPT, queryConcepts("head watermark 283"))).toBe(
      false,
    );
  });
  test("a short query is too vague to hold a row to two concepts", () => {
    expect(admitsRow(ONE_CONCEPT, queryConcepts("head watermark"))).toBe(true);
  });
  test("a query with no concepts admits nothing rather than everything", () => {
    // The scorer matched "what is the pr on" on grammar alone; the gate abstains.
    expect(admitsRow(TWO_CONCEPTS, queryConcepts("what is the pr on"))).toBe(
      false,
    );
    expect(admitsRow(TWO_CONCEPTS, queryConcepts(""))).toBe(false);
  });
});

describe("memory_recall with the gate", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osi-gate-"));
    process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
    // An ambient off-switch in the CI shell must not flip the default-on tests.
    delete process.env[GATE_ENV];
    resetState();
    setRepoScope(null);
  });
  afterEach(() => {
    delete process.env[GATE_ENV];
    setRepoScope(null);
    delete process.env.OPENCODE_MEMORY_DIR;
    removeStore(root);
  });

  function seed(...rows: Memory[]) {
    const day = "2026-01-01";
    const file = join(memoryRoot(), `${day}.logfmt`);
    mkdirSync(dirname(file), { recursive: true });
    rows.forEach((m, i) => {
      appendFileSync(
        file,
        `${formatLine({
          ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
          type: m.type,
          scope: m.scope,
          content: m.content,
          status: m.status,
        })}\n`,
      );
    });
  }

  test("opted out, a one-concept row is still returned", async () => {
    seed(ONE_CONCEPT, TWO_CONCEPTS);
    process.env[GATE_ENV] = "off";
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "head watermark 283",
      limit: 5,
    });
    expect(out).toContain("head of the release branch");
    expect(out).toContain("pr-watch watermark");
    await loaded.cleanup();
  });

  test("by default, the one-concept row is dropped and the two-concept row stays", async () => {
    seed(ONE_CONCEPT, TWO_CONCEPTS);
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "head watermark 283",
      limit: 5,
    });
    expect(out).not.toContain("head of the release branch");
    expect(out).toContain("pr-watch watermark");
    await loaded.cleanup();
  });

  test("flag on, a store with nothing two-concept abstains instead of filling the window", async () => {
    seed(ONE_CONCEPT, NOTHING, SUBSTRING_TRAP);
    process.env[GATE_ENV] = "1";
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "head watermark 283",
      limit: 5,
    });
    expect(out).toContain("No matching memories");
    await loaded.cleanup();
  });

  test("flag on, a two-word query keeps the permissive behaviour", async () => {
    seed(ONE_CONCEPT);
    process.env[GATE_ENV] = "1";
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "head watermark",
      limit: 5,
    });
    expect(out).toContain("head of the release branch");
    await loaded.cleanup();
  });

  test("by default, a prose query finds the row that names an identifier (#426 review)", async () => {
    // WhollyMindless probe: `discount tiers` returned the row with the gate
    // off and `No matching memories` with it on — admission kept
    // DISCOUNT_TIERS one word while the query offered two concepts.
    seed(mem("DISCOUNT_TIERS controls the pricing schedule"));
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "discount tiers",
      limit: 5,
    });
    expect(out).toContain("DISCOUNT_TIERS");
    await loaded.cleanup();
  });

  test("by default, a prose query finds a camelCase identifier (round 2)", async () => {
    // Round-2 probe: `discount` found `discountTiers controls the pricing
    // schedule` with the gate off and abstained with it on — the segment
    // expansion handled underscores only, and recallHaystack lower-cases
    // before tokenizing, erasing the camel boundary.
    seed(mem("discountTiers controls the pricing schedule"));
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "discount",
      limit: 5,
    });
    expect(out).toContain("discountTiers");
    await loaded.cleanup();
  });

  test("by default, an exact identifier finds the row that names it in a dotted name (round 3)", async () => {
    // Round-3 probe: `db_id` found `table.db_id stores the foreign key`
    // with the gate off and abstained with it on — words() splits
    // `table.db_id` into table/db/id, so the underscore-joined suffix
    // never reaches admission whole.
    seed(mem("table.db_id stores the foreign key", { scope: "schema" }));
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "db_id",
      limit: 5,
    });
    expect(out).toContain("db_id");
    await loaded.cleanup();
  });
});

// Reproduced: the identifier tokenizer splits a snake_case SCOPE name into words; the
// identifier tokenizer splits a snake_case SCOPE name into words, and the old
// contentTokens() built its vocabulary from the whole haystack minus the
// whole scope/type strings — so the scope's words survived as "content".
// Two unrelated non-Latin rows in one scope then shared a Jaccard-1 token set
// supplied entirely by metadata, cleared the MIN_CONTENT floor on scope
// tokens, and dedup hid the older row. The floor exists precisely because
// non-Latin prose tokenises to nothing: those rows must have nothing to
// compare, always.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryRoot } from "../src/core/config/paths.ts";
import { formatLine } from "../src/core/logfmt/format.ts";
import { resetState } from "../src/core/state.ts";
import { setRepoScope } from "../src/identity/repokey.ts";
import {
  contentTokens,
  DEDUPE_ENV,
  dedupeWindow,
} from "../src/recall/dedupe.ts";
import type { Memory } from "../src/store/model/memory.ts";
import { loadPlugin } from "./harness.ts";
import { removeStore } from "./helpers/remove-store.ts";

const SCOPE = "auth_token_refresh_policy";
const CJK_A = "登录令牌在刷新后必须轮换并且旧令牌立即失效";
const CJK_B = "数据库连接池的最大连接数应该根据并发量调整";

function mem(content: string, ts: string): Memory {
  return {
    ts,
    type: "learning",
    scope: SCOPE,
    content,
    status: "settled",
    file: "",
    index: 0,
  };
}

describe("contentTokens vocabulary", () => {
  test("a snake_case scope contributes no tokens to a non-Latin row", () => {
    // The leak: words(haystack) kept auth/token/refresh/policy after
    // out.delete() could only remove the whole scope string.
    expect(contentTokens(mem(CJK_A, "2026-11-01T00:00:00.000Z")).size).toBe(0);
  });

  test("content and keywords still supply the vocabulary", () => {
    const m = mem(
      "the rate limiter reads its counters from redis with eviction",
      "2026-11-01T00:00:00.000Z",
    );
    m.kw = ["watermark cursor"];
    const t = contentTokens(m);
    expect(t.has("rate")).toBe(true);
    expect(t.has("watermark")).toBe(true);
    expect(t.has("auth")).toBe(false);
  });
});

describe("memory_recall with dedup on a snake_case scope", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osi-dedup-leak-"));
    process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
    delete process.env[DEDUPE_ENV];
    resetState();
    setRepoScope(null);
  });
  afterEach(() => {
    delete process.env[DEDUPE_ENV];
    setRepoScope(null);
    delete process.env.OPENCODE_MEMORY_DIR;
    removeStore(root);
  });

  test("both unrelated non-Latin rows survive the composed handler", async () => {
    // Reproduced probe: query the scope name, default limit,
    // OPENCODE_MEMORY_DEDUP=0.8. A vocabulary built from the haystack returns
    // only the newer row; both must survive.
    const day = "2026-11-01";
    const file = join(memoryRoot(), `${day}.logfmt`);
    mkdirSync(dirname(file), { recursive: true });
    for (const [i, content] of [CJK_A, CJK_B].entries()) {
      appendFileSync(
        file,
        `${formatLine({
          ts: new Date(Date.UTC(2026, 10, 1, 0, 0, 0, i)).toISOString(),
          type: "learning",
          scope: SCOPE,
          content,
          status: "settled",
        })}\n`,
      );
    }
    process.env[DEDUPE_ENV] = "0.8";
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: SCOPE,
      limit: 5,
    });
    expect(out).toContain(CJK_A);
    expect(out).toContain(CJK_B);
    await loaded.cleanup();
  });
});

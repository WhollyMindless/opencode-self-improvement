// pull — split from src/inject.ts. Declaration bodies are unchanged.
import { loadAll } from "../store/files/load.ts";
import { type Memory } from "../store/model/memory.ts";
import { isInjectable } from "../store/model/predicates.ts";
import { readerFromSid, visibleTo } from "../store/model/visibility.ts";
import { injectBudget } from "../core/config/budgets.ts";
import { FRAME, capToBudget, injectedRows } from "./budget.ts";
import { formatMemory } from "./format.ts";
import { type UseSignals, argText } from "../recall/relevant.ts";
import { scoreMemories } from "../recall/score.ts";

export interface TransformOutput {
  system: string[];
}

export interface PullInput {
  tool?: unknown;
  args?: unknown;
  // The session the pull runs FOR: resolved to an immutable Reader at
  // entry so the loadAll await below cannot drift into another session's repo.
  sessionID?: unknown;
}

export interface PullOutput {
  output?: unknown;
}

// Put the pull onto the host's tool result so the model actually reads it.
// WHICH field the host forwards is measured, not assumed. On opencode v2.3.0
// (probed through e2e/support/harness.ts against the real host) `result.content`
// is an ARRAY of `{type:"text",text}` parts and mutating a text part changes the
// next request; mutating `result.output` — the file-attachment object
// `{type,uri,name,content,encoding,mime}` — does not. Older hosts passed a plain
// string in `content`, which is the shape this function was originally written
// against, and a string `output` is covered too.
//
// Returns true only when the bytes were placed. The caller credits the ledger
// with what rode, never with what was merely computed: a pull that found nowhere
// to write showed the model nothing.
export function writePullIntoResult(
  result: unknown,
  before: string,
  after: string,
): boolean {
  if (!result || typeof result !== "object") return false;
  // contextualPull APPENDS to the text it was handed, so isolate that append.
  // If the value no longer carries it — another hook rewrote the result between
  // the pull and here — there is no safe place for the block: assigning would
  // clobber the other hook and appending the whole value would duplicate the
  // tool output. Report failure and let the caller log `pull_undelivered`.
  if (!after.startsWith(before)) return false;
  const block = after.slice(before.length);
  if (!block) return false;
  const r = result as { content?: unknown };
  if (typeof r.content === "string") {
    r.content += block;
    return true;
  }
  if (Array.isArray(r.content)) {
    // Append to the LAST text part: the pull is commentary on the output, so it
    // belongs after it, and a result can carry several parts.
    for (let i = r.content.length - 1; i >= 0; i--) {
      const part = r.content[i] as { text?: unknown } | undefined;
      if (part && typeof part === "object" && typeof part.text === "string") {
        part.text += block;
        return true;
      }
    }
    r.content.push({ type: "text", text: block });
    return true;
  }
  return false;
}

// What a pull is allowed to search. Every field exists because it was measured
// before being changed (bench/runners/pull-precision.ts), not because it seemed
// reasonable: a pull bolts text onto a tool result the model did not ask for, so
// the cost of a wrong pull is paid by every later turn.
export interface PullScope {
  /** Tool results that may carry a pull. */
  tools: readonly string[];
  /** Whether the tool's own output joins the query, not just its arguments. */
  includeOutput: boolean;
  /** How many characters of it. A 40 KB file dump is not a query. */
  outputChars: number;
  /**
   * ALSO search the arguments alone and merge, argument matches first. A longer
   * query raises the scorer's two-concept gate, so a combined search can DROP a
   * row the model's own words already matched; merging recovers it without
   * giving up the reach the output bought. Measured, not assumed:
   * bench/runners/pull-precision.ts.
   */
  argsUnion?: boolean;
}

/**
 * The shipped arm: the arguments AND the first 512 characters of the result,
 * for grep/glob/read, with the arguments-only search merged back in first.
 *
 * Chosen by measurement, not taste — bench/runners/pull-precision.ts
 * (2026-11-20), committed recall dataset, stores of 52/200/800, and the shape
 * held at all three (store = 200 below):
 *
 *   arm              R@1 arg  R@3 arg  R@1 out   noise% ordinary   bytes/call
 *   args-only          98.6      100       0            65%            122
 *   + output, no merge 92.9     94.3    18.8             0%            216
 *   THIS ARM           98.6      100    17.9            65%            252
 *
 * The class it exists for — a fact keyed to something the model only sees in
 * the tool's OUTPUT (an error string, a symbol in a file body) — goes from
 * unreachable to 17.9% R@1 without moving the class that already worked. The
 * merge is what buys that: a combined query is longer, and a longer query
 * raises the scorer's two-concept gate, so a precise search ("table_manager.save")
 * otherwise loses its exact-match row to boilerplate output ("grep results").
 * That is not hypothetical — it broke test/host/scenarios.test.ts's I3 case the first
 * time, and test/inject/pull-scope.test.ts pins it.
 *
 * Measured and REJECTED, so the next reader does not "improve" it back:
 *   + shell        doubles the reach (R@1 out 43.9) but takes ordinary-traffic
 *                  noise to 100% of no-gold calls: every plain read and command
 *                  gets a block bolted onto it.
 *   no merge       looks quiet (0% noise) only because its misses are silences —
 *                  miss-abstain 100%. It spends 5.7 points of arg-visible R@3 to
 *                  buy the same output reach.
 *   error-gated    output only on a failure signal: 26% R@1 out, but 100% noise
 *                  on ordinary traffic once shell is in scope, and no better
 *                  than this arm without it.
 *   outputChars    128 / 512 / 2000 scored identically: the fixture puts the
 *                  signal early in the output, so this bench cannot rank them.
 *                  512 is a bound on cost, not a tuned value.
 * Noise is the share of NO-GOLD calls that pull at least one row. At 65% that is
 * the pre-existing behaviour of the arguments-only arm, inherited unchanged: this
 * change adds reach, it does not add spam. Cutting that number is the next
 * measured step, not this one.
 */
export const PULL_SHIPPED: PullScope = {
  tools: ["grep", "glob", "read"],
  includeOutput: true,
  outputChars: 512,
  argsUnion: true,
};

/**
 * The arm from plugin options, so a user can dial the behaviour back without a
 * code change:
 *   pullOutputChars: 0    → arguments only (the pre-2026-11 behaviour)
 *   pullTools: ["read"]   → only reads may carry a pull
 * Anything malformed falls back to the shipped value rather than to no pull: a
 * typo in a config file must not silently switch memory delivery off.
 */
export function pullScopeFrom(
  options: Record<string, unknown> | undefined,
): PullScope {
  const chars = options?.pullOutputChars;
  const tools = options?.pullTools;
  const outChars =
    typeof chars === "number" && Number.isFinite(chars) && chars >= 0
      ? Math.min(Math.floor(chars), 4096)
      : PULL_SHIPPED.outputChars;
  const toolList = Array.isArray(tools)
    ? tools.filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];
  return {
    tools: toolList.length ? toolList : PULL_SHIPPED.tools,
    includeOutput: outChars > 0,
    outputChars: outChars,
    // Only meaningful when the output joins the query; without it the two
    // searches are the same search.
    argsUnion: outChars > 0,
  };
}

/**
 * The query one tool call searches memory with. Args first: the model's own
 * intent outranks whatever the tool happened to print. Returns "" for a tool
 * outside the scope, which is how the pull stays off the write path.
 */
export function pullQueryFor(
  tool: string,
  args: unknown,
  resultText: string,
  scope: PullScope,
): string {
  if (!scope.tools.includes(tool)) return "";
  const arg = argText(args);
  if (!scope.includeOutput) return arg;
  const head = resultText.slice(0, scope.outputChars).trim();
  return arg && head ? `${arg}\n${head}` : arg || head;
}

export async function contextualPull(
  input: PullInput,
  output: PullOutput,
  budget = injectBudget(),
  use?: UseSignals,
  scope: PullScope = PULL_SHIPPED,
): Promise<Memory[]> {
  const tool = typeof input.tool === "string" ? input.tool : "";
  const own = typeof output.output === "string" ? output.output : "";
  const term = pullQueryFor(tool, input.args, own, scope);
  if (!term) return [];
  // Repo-scoped: model-facing reads see the CALLER's repo + global rows —
  // the pull's own sessionID, resolved before the store read.
  const mems = visibleTo(
    (await loadAll()).filter(isInjectable),
    readerFromSid(input.sessionID),
  );
  const top = scoreMemories(term, mems, 3, use);
  // Merge the arguments-only search behind the combined one. The combined query
  // is longer, and a longer query raises the scorer's two-concept gate, so the
  // row the model's OWN words matched can fall out of a combined search that
  // would otherwise be a strict improvement. Argument matches keep first
  // refusal: the model's intent outranks whatever the tool happened to print.
  const merged = scope.argsUnion
    ? (() => {
        const args = argText(input.args);
        if (!args || args === term) return top;
        const seen = new Set(top.map((m) => m.ts));
        return [
          ...top,
          ...scoreMemories(args, mems, 3, use).filter((m) => !seen.has(m.ts)),
        ].slice(0, 3);
      })()
    : top;
  if (!merged.length) return [];
  // Held to the injection budget too: three long rows were ~12 KB per call.
  const block = capToBudget(
    `## Related durable memory (pull)${FRAME}\n${merged.map(formatMemory).join("\n")}`,
    budget,
  );
  if (block && typeof output.output === "string") {
    output.output += `\n${block}`;
    // What the ledger counts is what actually rode the result — the budget can
    // drop rows, and crediting a memory the model never saw would inflate it.
    return injectedRows(block, merged);
  }
  return [];
}

// render — split from src/consolidate.ts. Declaration bodies are unchanged.

import {
  absorbAliases,
  consolidationStepKey,
  type ProposalReport,
} from "./propose.ts";
import { flattenMemoryText } from "../store/sanitize.ts";

/** Human-readable proposal list. Ends with the exact command to resolve one. */
export function renderProposals(report: ProposalReport): string {
  const out: string[] = ["CONSOLIDATION PROPOSALS — nothing was written", ""];
  if (!report.plans.length) {
    out.push("  none — no cluster proved it could hold its reads.");
    return out.join("\n");
  }
  for (const p of report.plans) {
    let projected = p.survivor;
    const commands = p.losers.map((loser) => {
      projected = absorbAliases(projected, loser);
      const expected = consolidationStepKey(projected, loser);
      return `  resolve: memory_merge_review(loser="${loser.ts}", survivor="${p.survivor.ts}", reason="consolidate ${p.id}", consolidate=true, expected="${expected}")`;
    });
    out.push(
      `${p.id}  ${p.type}/${p.scope}  ${p.losers.length + 1} rows → 1`,
      `  keep   ${p.survivor.ts}`,
      // Row prose is multiline in the store and flattened only here:
      // one row is one output line, the same rule memory_recall follows.
      `    ${flattenMemoryText(p.survivor.content.slice(0, 160))}`,
      ...p.losers.map(
        (l) =>
          `  absorb ${l.ts}  ${flattenMemoryText(l.content.slice(0, 120))}`,
      ),
      `  reads  ${p.reads.length} logged · best member alone ${p.bestMemberBefore} · merged ${p.readsAfter}`,
      `  budget ${p.bytesBefore}c → ${p.bytesAfter}c for this cluster`,
      ...commands,
      "",
    );
  }
  out.push(
    `STORE  ${report.rowsBefore} rows → ${report.rowsAfter} if every proposal is resolved · ` +
      `injected ${report.injectedBefore}c → ${report.injectedAfter}c`,
  );
  out.push(
    "Run each proposal's resolve commands from top to bottom to retain the keywords used in its read estimate.",
    "Resolving is supersede-not-delete: absorbed rows stay recoverable via memory_undo.",
  );
  return out.join("\n");
}

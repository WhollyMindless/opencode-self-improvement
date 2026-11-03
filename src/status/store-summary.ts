// Shared store counts for epoch payloads and the chat report (#168).
// Callers own I/O and visibility policy; this summarizes exactly their rows.
import { neverRetrieved, type UseLedger } from "../hits/ledger.ts";
import type { Memory } from "../store/model/memory.ts";
import { isActive } from "../store/model/predicates.ts";
import type { StoreCounts } from "./payload.ts";

export function summarizeStore(
  rows: Memory[],
  ledger: UseLedger,
  malformed: number,
): { active: Memory[]; counts: StoreCounts } {
  const active = rows.filter(isActive);
  return {
    active,
    counts: {
      active: active.length,
      superseded: rows.length - active.length,
      open: active.filter((m) => m.status === "open").length,
      scopes: new Set(active.map((m) => m.scope)).size,
      malformed,
      neverRetrieved: neverRetrieved(active, ledger).length,
      ledgerSince: ledger.since,
    },
  };
}

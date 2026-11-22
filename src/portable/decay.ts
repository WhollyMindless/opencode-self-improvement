// decay — split from src/portable.ts. Declaration bodies are unchanged.
import { cmpTs } from "../core/cmp-ts.ts";
import { loadAll } from "../store/files/load.ts";
import { type Memory } from "../store/model/memory.ts";
import { isInjectable } from "../store/model/predicates.ts";
import { isVisibleTo, readerFromSid } from "../store/model/visibility.ts";

// --- decay support --------------------------------------------------------------

// Legacy rows may omit milliseconds. Compare instants for both the cutoff and order.
export async function findStaleOpen(
  days: number,
  sid?: string,
): Promise<Memory[]> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const reader = readerFromSid(sid);
  return (
    (await loadAll())
      // Decay is repo-scoped: running it here must not retire
      // another repo's open threads.
      .filter(
        (m) =>
          isInjectable(m) &&
          isVisibleTo(m, reader) &&
          m.status === "open" &&
          cmpTs(m.ts, cutoff) < 0,
      )
      .sort((a, b) => cmpTs(a.ts, b.ts))
  );
}

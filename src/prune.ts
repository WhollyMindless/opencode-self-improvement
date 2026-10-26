// Principle 3: a human can prune a bad memory. Deletion is auditable (reason),
// reversible (snapshot) and never touches a repo. The `prune` evidence line is
// emitted before/around the mutation so S5 can assert the reason and snapshot.
import { deletionsFile } from "./config.ts";
import { prune, readerFromSid, type PruneResult } from "./memory.ts";
import { record } from "./evidence.ts";

export async function pruneMemory(
  scope: string,
  type: string,
  reason: string,
  // The calling session (#127): the repo floor on prune must follow the
  // CALLER's identity, captured at tool entry, not the ambient current the
  // locked file walk may outlive. "?" / undefined keep ambient semantics.
  sid?: string,
): Promise<PruneResult & { audit: string }> {
  const res = await prune(scope, type, reason, readerFromSid(sid));
  const memTs = res.deleted.map((d) => d.memory.ts).join(",") || "-";
  await record(
    "prune",
    {
      mem: memTs,
      reason,
      snapshot: res.snapshot[0] ?? "-",
      audit: deletionsFile(),
      tool: "memory_forget",
    },
    true,
    sid,
  );
  return { ...res, audit: deletionsFile() };
}

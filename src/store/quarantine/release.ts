// release — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.
import { type Fields, formatLine } from "../../core/logfmt/format.ts";
import { filesHoldingTs, memoryFiles } from "../files/load.ts";
import { stampRow } from "../files/snapshots.ts";
import { QUARANTINE_TAG, quarantineReasons } from "./quarantine.ts";

// Human viewer action only. Preserve identity, origin, and all non-quarantine
// metadata; stampRow snapshots and atomically publishes under the store lock.
export async function releaseQuarantine(
  ts: string,
): Promise<"released" | "not_found" | "not_quarantined"> {
  const release = (fields: Fields) => {
    const tags = typeof fields.tags === "string" ? fields.tags.split(",") : [];
    if (!tags.includes(QUARANTINE_TAG)) return null;
    const scanTags = new Set([
      QUARANTINE_TAG,
      ...quarantineReasons({ tags }).map((id) => `quarantine:${id}`),
    ]);
    const kept = tags.filter((tag) => !scanTags.has(tag));
    if (kept.length) fields.tags = kept.join(",");
    else delete fields.tags;
    return formatLine(fields);
  };
  // #215 + #373 review: release every copy. The day file the ts names is the
  // common case; the previous day's file joins ONLY when a scan finds the same
  // identity in it, which is what an older midnight-boundary append could write.
  // Leaving a duplicate quarantined beside a released copy would keep the row
  // hidden from the operator who just released it.
  const candidates = await filesHoldingTs(ts);
  let found = false;
  let released = false;
  for (const file of candidates) {
    const result = await stampRow(file, ts, release);
    if (result === null) continue;
    found = true;
    released = released || result;
  }
  if (found) return released ? "released" : "not_quarantined";
  // Never seen where it should be: the sweep this replaced, unchanged.
  const tried = new Set(candidates);
  for (const file of await memoryFiles()) {
    if (tried.has(file)) continue;
    const result = await stampRow(file, ts, release);
    if (result !== null) return result ? "released" : "not_quarantined";
  }
  return "not_found";
}

/** Capture-only provenance: grants always-ride priority in the hint channel. */
export const USER_GUIDED_TAG = "user-guided";

/**
 * Tool/import input cannot grant capture provenance. Split the storage
 * delimiter first: ["ordinary,user-guided"] reads back as two tags too.
 * Silently drop the reserved tag; ordinary prose still faces the write gate.
 */
export function nonCaptureTags(tags?: string[]): string[] | undefined {
  return tags
    ?.flatMap((tag) => tag.split(","))
    .filter((tag) => tag !== USER_GUIDED_TAG);
}

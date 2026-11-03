// Viewer writes are deliberate admin edits, independent of model grounding
// gates. They still honor value rejections until an explicit release (#222).
import { redactSecrets } from "../store/secrets.ts";
import { probeRejection } from "../store/tombstones/rejection.ts";

export async function assertViewerWriteAllowed(content: string): Promise<void> {
  // Match the bytes appendMemory persists, as the write gate already does.
  // Read/probe errors propagate: an unavailable rejection set cannot grant a write.
  const { rejection } = await probeRejection(redactSecrets(content));
  if (!rejection) return;
  throw new Error(
    `viewer write blocked: previously_rejected (${rejection.kind}; hash ${rejection.tombstone.ch}). ` +
    "Nothing was stored. Use Rejections → un-reject in the viewer to explicitly lift that rejection before retrying.",
  );
}

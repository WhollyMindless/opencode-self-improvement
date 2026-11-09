// deletions — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.
import { deletionsFile } from "../../core/config/paths.ts";
import { formatLine } from "../../core/logfmt/format.ts";
import { appendLog } from "../../core/logfmt/publish.ts";
import type { Memory } from "../model/memory.ts";
import { redactSecrets } from "../secrets.ts";

export interface DeletedMemory {
  memory: Memory;
  reason: string;
}

export async function logDeletion(
  memory: Memory,
  reason: string,
): Promise<void> {
  await appendLog(
    deletionsFile(),
    formatLine({
      ts: new Date().toISOString(),
      action: "deleted",
      original_ts: memory.ts,
      type: memory.type,
      scope: memory.scope,
      content: memory.content,
      // Origin survives the delete/restore round trip (#129): a restore-entry
      // made from this line re-stamps what the row carried. A row with no
      // stamp writes no stamp here — the legacy global path, unchanged.
      repo: memory.repo,
      repoPath: memory.repoPath,
      // #207: the visibility- and provenance-bearing metadata survives here
      // too. tags carry the quarantine marker, so a restore that reads this
      // line cannot silently release quarantine; issue and kw keep provenance
      // and recall aliases alive; status keeps an open thread open. Comma-
      // joined scalars match the memory line, and a row without them writes
      // nothing — the legacy fallback the restore documents.
      tags: memory.tags?.length ? memory.tags.join(",") : undefined,
      kw: memory.kw?.length ? memory.kw.join(",") : undefined,
      issue: memory.issue,
      status: memory.status,
      reason: redactSecrets(reason),
    }),
  );
}

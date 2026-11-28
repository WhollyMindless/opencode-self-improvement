import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

/** Keep Pi's summary algorithm and file tracking while adding memory instructions. */
export async function compactWithMemory(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  anchors: string[],
) {
  if (!anchors.length || !ctx.model) return;
  const model = structuredClone(ctx.model);
  const registry = ctx.modelRegistry;
  const { compact } = await import("@earendil-works/pi-coding-agent");
  event.signal.throwIfAborted();
  const compaction = await compact(
    event.preparation,
    model,
    undefined,
    undefined,
    [event.customInstructions, ...anchors].filter(Boolean).join("\n\n"),
    event.signal,
    ctx.thinkingLevel,
    (selected, context, options) =>
      registry.streamSimple(selected, context, options),
  );
  event.signal.throwIfAborted();
  return { compaction };
}

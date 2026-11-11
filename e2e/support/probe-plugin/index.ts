// #395 probe: records what `ctx.generate.text` actually resolves to inside a
// plugin process, when the provider DID report usage. The fake model attaches
// `usage` to every final chunk (see ../fake-model.ts); whatever the host hands
// the plugin is the host's contract, and this file is what observes it.
// Written as a standalone package (the host loads plugins by package, not by
// bare file) so nothing from src/ can colour the shape. The hook is
// `session.context` — the same seam the real plugin injects through, and the
// first one that fires on `opencode run`.
import { writeFileSync } from "node:fs";

export default {
  id: "probe-receipt",
  setup: async (ctx: any) => {
    const out = process.env.PROBE_OUT;
    if (!out) return;
    await ctx.session?.hook("context", async () => {
      try {
        const res = await ctx.generate.text({
          model: { providerID: "fake", id: "scripted" },
          prompt: "probe receipt",
        });
        writeFileSync(
          out,
          JSON.stringify({
            generateKeys: Object.keys(ctx.generate ?? {}),
            resultKeys:
              res && typeof res === "object" ? Object.keys(res) : null,
            resultType: typeof res,
            usage: (res as any)?.usage ?? null,
            textType: typeof (res as any)?.text,
          }),
        );
      } catch (err) {
        writeFileSync(
          out,
          JSON.stringify({ error: String((err as Error)?.message ?? err) }),
        );
      }
      return undefined;
    });
  },
};

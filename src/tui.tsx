// Terminal surface for opencode-self-improvement (the CLI/TUI half of the
// plugin). Runs in the terminal process, beside the host's OpenTUI renderer:
// a one-line footer badge, a /memory session panel, and toasts when a write
// gets blocked. All data comes from the status hand-off the server plugin
// writes per epoch (src/status.ts) plus the evidence log — plain file reads,
// no model, no network. Against a REMOTE server the panel reports that status
// is local-only (the RPC surface is the follow-up).
import { For, Show, createSignal } from "solid-js";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import type { PanelInput } from "@opencode/plugin/tui/context";
import { blockedRecent, readStatus, type BlockedRow, type StatusPayload } from "./status.ts";

const PANEL = "self-improvement.memory";
const POLL_MS = 5000;

function age(iso?: string): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function Section(props: { t: string }) {
  const context = usePlugin();
  return <text fg={context.theme.text.base}>{"\n▍ " + props.t}</text>;
}

export default Plugin.define({
  id: "self-improvement.tui",
  setup(context) {
    const notifyBlocked = context.options?.notifyBlocked !== false;
    const [status, setStatus] = createSignal<StatusPayload | null>(null);
    const [blocked, setBlocked] = createSignal<BlockedRow[]>([]);
    let seenBlockKeys: Set<string> | null = null; // null until first poll (no startup toast storm)

    const refresh = async (): Promise<void> => {
      setStatus(await readStatus());
      const rows = await blockedRecent(8);
      setBlocked(rows);
      const keys = new Set(rows.map((r) => `${r.ts}|${r.reason}`));
      if (notifyBlocked && seenBlockKeys) {
        for (const r of rows) {
          if (seenBlockKeys.has(`${r.ts}|${r.reason}`)) continue;
          context.ui.toast.show({
            title: "memory blocked",
            message: `${r.reason} — run /memory for the reason list`,
            variant: "warning",
            duration: 6000,
            sessionID: r.sid,
          });
        }
      }
      seenBlockKeys = keys;
    };
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);

    // ---- footer badge: session footer live badge, home footer store size ----
    context.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        const s = status();
        return (
          <text fg={context.theme.text.base}>
            {s ? `mem ${s.store.active} · ${s.blockChars}c · ${age(s.at)}` : "mem -"}
          </text>
        );
      },
    });
    context.ui.slot({
      append: "home.footer.status",
      render: () => {
        const s = status();
        return <text fg={context.theme.text.base}>{s ? `mem ${s.store.active}` : "mem -"}</text>;
      },
    });

    // ---- /memory panel --------------------------------------------------------
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <MemoryPanel panel={panel} refresh={refresh} status={status()} blocked={blocked()} />
        </Show>
      ),
    });

    // Command + slash registration on a persistent invisible slot so it exists
    // while the panel is closed (docs pattern).
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "self-improvement.memory",
              title: "Memory status panel",
              group: "Memory",
              palette: true,
              slash: { name: "memory" },
              run: () => {
                if (!context.ui.panel.open(PANEL)) {
                  context.ui.toast.show({ message: "the memory panel needs an open session", variant: "info" });
                }
              },
            },
          ],
        }));
        return null;
      },
    });

    return () => clearInterval(timer);
  },
});

function MemoryPanel(props: {
  panel: PanelInput;
  refresh: () => Promise<void>;
  status: StatusPayload | null;
  blocked: BlockedRow[];
}) {
  const context = usePlugin();
  context.keymap.layer(() => ({
    commands: [
      { id: "self-improvement.memory.refresh", title: "Refresh", bind: "r", run: () => void props.refresh() },
      { id: "self-improvement.memory.fullscreen", title: "Fullscreen", bind: "f", run: props.panel.toggleFullscreen },
    ],
  }));

  const s = () => props.status;
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text fg={context.theme.text.base}>MEMORY — as of {s() ? age(s()!.at) : "never"}</text>

      <Section t="INJECTED NOW" />
      <Show
        when={s()}
        fallback={<text fg={context.theme.text.base}>  no epoch yet — nothing injected (fresh server, or no prompt scored)</text>}
      >
        <text fg={context.theme.text.base}>
          {"  " + s()!.reason + " · " + s()!.blockChars + "/" + s()!.budget + " chars · " + s()!.recomputes + " recompute(s) since server start"}
        </text>
        <Show
          when={s()!.block}
          fallback={
            <text fg={context.theme.text.base}>
              {"  abstained — your prompt shares no content vocabulary with any memory, so nothing was injected (by design)"}
            </text>
          }
        >
          <For each={s()!.block.split("\n")}>{(line) => <text fg={context.theme.text.base}>{"  " + line}</text>}</For>
        </Show>
      </Show>

      <Section t="RECENT BLOCKED WRITES" />
      <Show when={props.blocked.length} fallback={<text fg={context.theme.text.base}>  (none today or yesterday)</text>}>
        <For each={props.blocked}>
          {(b) => <text fg={context.theme.text.base}>{"  " + b.ts.slice(11, 19) + "  " + b.reason + "  " + b.sid}</text>}
        </For>
      </Show>

      <Section t="STORE" />
      <Show when={s()}>
        <text fg={context.theme.text.base}>
          {"  " + (s()?.store.active ?? 0) + " active · " + (s()?.store.superseded ?? 0) + " superseded · " +
            (s()?.store.open ?? 0) + " open · " + (s()?.store.scopes ?? 0) + " scopes"}
        </text>
      </Show>

      <text fg={context.theme.text.base}>{"\n  r refresh · f fullscreen · esc close"}</text>
    </box>
  );
}

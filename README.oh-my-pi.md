# Memory for oh-my-pi

An experimental oh-my-pi adapter for this project's memory engine. It provides
fourteen memory tools, relevant context, automatic turn-end capture, compaction
anchors, and per-harness statistics. Memories can be shared with OpenCode using
the same store and project directory.

Tested with **oh-my-pi 19.2.1 and Bun 1.4.4**. Upstream Pi and dsh are not supported
by this adapter. The implementation is under consideration in
[draft PR #560](https://github.com/abogartz/opencode-self-improvement/pull/560);
it is not yet in the published npm release.

**Auto-capture is enabled by default.** It can make an additional call to your
selected model using conversation text after a best-effort credential scrub.
Thinking blocks and raw tool results are excluded. Normal provider charges apply.
Use `autoCapture: false` below to turn those calls off.

## Install from this checkout

Check `bun --version` and `omp --version`. From this repository's directory:

```sh
bun install --frozen-lockfile
omp plugin install .
omp plugin list
```

Keep the checkout: oh-my-pi links to a local directory. **Restart oh-my-pi** after
installing or updating the plugin. Launch it in the project whose memories you
want to use. No separate capture wrapper or memory-specific API key is required;
the host supplies its model SDK and credential resolver.

For a fresh checkout of the draft:

```sh
git clone https://github.com/abogartz/opencode-self-improvement.git opencode-memory
cd opencode-memory
git fetch origin pull/560/head:try-oh-my-pi
git switch try-oh-my-pi
bun install --frozen-lockfile
omp plugin install .
```

These commands create a separate directory. If you already have a checkout, use
that checkout's installation instructions above. For a packed installation that
does not depend on the source checkout, see the
[installation reference](docs/reference/oh-my-pi.md#install-a-packed-copy).

## Share an existing OpenCode store

Set `OPENCODE_MEMORY_DIR` to the same absolute directory in both launch
environments. For example, in PowerShell:

```powershell
$env:OPENCODE_MEMORY_DIR = 'C:\Users\YourName\agent-memory'
omp
```

Use your existing store path to retain its memories. This setting selects a store;
it does not copy or migrate one. Start both harnesses in the same project directory
for project-scoped sharing. Memories explicitly saved as global remain eligible
across projects. Relevance selection still determines what reaches each request.

## Verify it

1. Ask the agent to call `memory_status` and confirm that the memory tools loaded.
2. Have it read a project file and use `memory_remember` to save a verified fact.
3. Start a fresh session in the same project and recall that fact with `memory_recall`.
4. To exercise auto-capture, discuss a durable, verified project fact and finish the
   turn without explicitly saving it. Check `memory_status` and `memory_evidence`
   for capture activity, then recall any accepted memory in a fresh session.

Capture is selective: short conversations, cooldowns, duplicate facts, and the
write gates can produce no new memory. Absence of a row alone does not mean capture
is broken. `memory_remember` remains the direct way to request a save.

## Configure or disable auto-capture

Create a file such as `memory-extension.ts` at this checkout's root:

```ts
import { createOhMyPiMemory } from "./src/adapters/oh-my-pi/extension.ts";

export default createOhMyPiMemory({
  options: {
    autoCapture: false,
    // captureModel: "provider/model-id", // Must exist in the host's model registry.
    injectBudget: 1200,
  },
});
```

Disable the default registration and launch with the configured entry point:

```sh
omp plugin disable opencode-self-improvement
omp --extension /absolute/path/to/opencode-memory/memory-extension.ts
```

Quote paths containing spaces. Load only one registration. To restore defaults,
stop passing `--extension`, run `omp plugin enable opencode-self-improvement`,
and restart. For an installed package, import from
`opencode-self-improvement/oh-my-pi` instead. The native plugin configuration UI
is not connected to these options yet.

## Ask an agent to install it

Give an agent this explicit task from the checkout:

> Read `README.oh-my-pi.md` and install this checkout's memory plugin into my
> oh-my-pi installation. Check the Bun and oh-my-pi versions first. Use the
> documented local-directory installation and keep automatic capture enabled.
> Preserve my existing memories and configuration. If I provided an existing
> shared memory directory, use it rather than creating a different store.
> Verify registration with `omp plugin list`, report the installed path and
> versions, and tell me when to restart oh-my-pi. After restart, verify the memory
> tools with `memory_status` and a remember/recall check in this project.

An agent can run the install commands with your authorization. Installing the
plugin does not load it into an already running session; the restart and subsequent
tool check are separate steps. This README is guidance, not an auto-install hook.

## Limits and removal

Normal capture calls have a 20-second abort deadline. On cooperative shutdown the
adapter allows up to 500 ms for pending capture to settle, then cancels unanswered
generation and uses the shared bounded write drain. Slow captures can therefore
be lost on immediate exit; forced process termination cannot guarantee persistence.
Capture during compaction remains disabled. Hosted-provider and interactive UI
coverage is still limited; the tests use real hosts with a scripted local provider.

```sh
omp plugin uninstall opencode-self-improvement
```

Uninstalling removes the registration, not your memory store. See the
[full adapter reference](docs/reference/oh-my-pi.md) for context delivery,
compaction, statistics, and their remaining limits.

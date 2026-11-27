# Experimental oh-my-pi installation

This branch provides memory tools and selected memory context for **oh-my-pi
19.2.1**, tested with **Bun 1.4.4**. It is an experimental adapter, not a claim of
support for upstream Pi, other derivatives, or dsh. These changes are not yet in
the published npm release; install from this work branch or a package built from it.

The normal installation registers fourteen memory tools, injects relevant
memories before an agent turn, and appends relevant memories to successful
`read`, `grep`, and `glob` results. **Automatic capture is disabled.** Ask the agent
to use `memory_remember` when you want a durable memory. Writes still pass the
shared write gates; facts about project behavior may require reading the relevant
code first.

## Install from this checkout

With Bun and oh-my-pi installed, run these commands from the checkout:

```sh
bun install --frozen-lockfile
omp plugin install .
omp plugin list
```

For a different working directory, pass the checkout's absolute path instead of
`.`. oh-my-pi treats local-directory installation as a link, so retain that
directory and its dependencies. Restart oh-my-pi after installation or an update.
The package's `omp.extensions` manifest selects the adapter; no `--extension`
argument or hand-written loader is required. OpenCode continues to use the existing
default package entry point.

## Install a packed copy

To try a copy that does not load source or dependencies from the work checkout:

1. From the checkout, run `bun pm pack --filename /absolute/path/memory.tgz`.
2. Create an empty directory for the installation, containing a `package.json`
   with `{"private":true,"type":"module"}`.
3. From that directory, run `bun add --ignore-scripts /absolute/path/memory.tgz`.
4. Run `omp plugin install /absolute/path/to/installation/node_modules/opencode-self-improvement`.

Replace the example absolute paths with paths on your machine; quote paths with
spaces. Keep the installation directory: oh-my-pi links to this installed copy.
The tarball need not remain after dependency installation. This route uses the
ordinary package dependencies and does not install an oh-my-pi SDK into the plugin.

## Share memory with OpenCode

Set `OPENCODE_MEMORY_DIR` to the **same absolute directory** in both hosts' launch
environments. For example, in PowerShell:

```powershell
$env:OPENCODE_MEMORY_DIR = 'C:\Users\YourName\agent-memory'
omp
```

Use the same setting when launching OpenCode. Existing OpenCode memories can be
shared by pointing oh-my-pi at the store OpenCode already uses. Sharing is direct;
there is no import, migration, or separate store per harness.

Use the same local project directory for the first trial. Project memories remain
scoped to their project, and explicit `global: true` memories are eligible across
projects. Normal relevance selection still applies; sharing the store does not
inject every memory into every request. Relocated checkouts and machines have not
been validated by this installation test.

To check the installation, ask oh-my-pi to read a relevant project file and remember
a verified fact. Close it, start a fresh session in the same directory, and ask
`memory_recall` for that fact. Then recall it from OpenCode using the same store.
Use `omp plugin list` to check registration if memory tools are absent.

## Configure the adapter

The default installation uses the shared memory engine's defaults. For custom
settings, create `memory-extension.ts` in the installation directory that contains
the `opencode-self-improvement` dependency:

```ts
import { createOhMyPiMemory } from "opencode-self-improvement/oh-my-pi";

export default createOhMyPiMemory({
  options: {
    injectBudget: 1200,
    frontierBudget: 3600,
    contradictionSurface: true,
    pullTools: ["read", "grep", "glob"],
    pullOutputChars: 512,
  },
});
```

Disable the default registration and load this entry point instead:

```sh
omp plugin disable opencode-self-improvement
omp --extension /absolute/path/to/installation/memory-extension.ts
```

Keep the configured entry point next to its installed dependency so the package
import resolves. For a checkout trial, use an absolute import of that checkout's
`src/adapters/oh-my-pi/extension.ts`. Load only one entry point per session.
Restart after changing settings; this is startup configuration, not live editing.
To return to defaults, stop passing `--extension` and re-enable the plugin.

`injectBudget` caps relevance context and each pull; `frontierBudget` caps the
separate open-thread block. Omit either to retain the shared defaults and environment
fallbacks. `pullTools: []` disables contextual pulls; `pullOutputChars: 0` searches
tool arguments without including the output. A narrowed `pullTools` list uses the
host's actual tool names. Failed tool results never receive pulls in this adapter.
The shared selection rules and validation are described in
[options](options.md). Automatic capture still requires an explicit capture
binding; setting `autoCapture: true` alone cannot supply one. Compaction capture
remains disabled.

This configurable entry point is tested through the installed CLI. The native
`omp plugin config` UI is not connected to these options yet: the public extension
API in 19.2.1 does not expose its plugin-settings reader.

## Disable or remove

```sh
omp plugin disable opencode-self-improvement
omp plugin enable opencode-self-improvement
omp plugin uninstall opencode-self-improvement
```

Restart the host after changing registration. Uninstalling removes the plugin
registration, not the shared memory store. OpenCode can still read those memories.

## Current limits

- The packaged entry point supplies tools and context. It does not supply
  automatic capture, compaction anchors, or OpenCode UI
  surfaces and commands.
- Pull usage is recorded when the adapter's `context` hook observes complete
  memory rows in the matching tool result. Earlier tool-result transformations
  are accounted for. Later context/provider transformations, request cancellation,
  and provider rejection remain outside that observation; a receipt is not proof
  of model consumption. Prompt-context accounting still observes placement at
  `before_agent_start`.
- The opt-in capture wrapper remains an SDK investigation under
  `integration/oh-my-pi/capture-extension.ts`; it is deliberately excluded from the
  tarball. Immediate shutdown can cancel capture. Provider registration, host cost
  accounting, and capture during additional lifecycle transitions need more work.
- CLI installation, discovery, configuration, restart, recall/injection, project isolation,
  uninstall, and OpenCode interoperability are tested with a local scripted model.
  SDK tests check outgoing contextual pulls, clipped results, and disabled pulls.
  Interactive UI behavior and hosted-provider behavior are not established by
  those tests.

For the SDK contracts and testing instructions, see
[development notes](../internals/development.md#exploratory-oh-my-pi-adapter).

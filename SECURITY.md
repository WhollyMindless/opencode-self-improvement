# Security Policy

## Reporting a vulnerability

Report security issues privately through GitHub security advisories for this repository:

<https://github.com/abogartz/opencode-self-improvement/security/advisories/new>

Please do not open a public issue, pull request, or discussion for a suspected vulnerability: it is visible to everyone before a fix exists.

## Scope

In scope:

- **Plugin** — the opencode plugin itself: the `memory_*` tools, the write gates, injection, auto-capture, and the host events that drive them.
- **Store** — the durable memory store kept outside every repository (default `~/.config/opencode/memory`, override `OPENCODE_MEMORY_DIR`): path containment, the owner-only permission model (`0700` directories, `0600` files on POSIX), snapshots and `memory_undo`, export and import, and secret redaction of credential-shaped values.
- **Viewer** — the local browser admin editor: its authentication, repository scoping, and the read and write boundaries it exposes.

Out of scope:

- Vulnerabilities in opencode, Bun, or other upstream dependencies — report those to the upstream project.
- Exposures caused by operator-side conditions the plugin cannot control: a store directory placed on a shared account, permissions or copies made outside the private root, or already-open handles when permissions are tightened.
- Content the plugin stored faithfully: memory rows are data the agent was asked to keep, and redaction covers credential-shaped values, not private meaning.

## Response

This is a small maintainer-run project. We investigate and fix credible reports as fast as we can, but we make no service-level agreement or fixed response-time promise.

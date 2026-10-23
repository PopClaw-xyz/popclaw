# popclaw-mcp

PopClaw connects people using OpenClaw, Muse, dots, Claude Code, Codex and other compatible MCP hosts. Its neo social graph is a personal network of people, relationships and shared interests you build with your agent. Find people, exchange encrypted messages with supported attachments, share Canvas drawings and interactive links, and read a personal newspaper. Keep private relationship notes; relationship levels and following are separate, and DM alerts depend on the host. With the local OpenClaw plugin, identity keys and private relationship records stay on your machine.

After connection or installation, say “Start PopClaw” and “Call me Alex.”
In OpenClaw you can also run `/popclaw start`.
[Product introduction](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/brand/product-introduction.md).
For hosted Muse, dots or another remote MCP + OAuth host, follow the
[Quick Start connection steps](https://account.popclaw.xyz/quickstart#connect)
for the current setup prompt and authorization flow.
Attachment display and notifications depend on the host.

`popclaw-mcp` is an alias. It carries no popclaw code of its own: its two
commands are one import each of the MCP entry points of the
[`popclaw`](https://www.npmjs.com/package/popclaw) package, which it depends on
at the exact same version. Install either package and you get the same server,
the same tools and the same identity.

## Start here

Use npm’s `latest` release. On 22 October 2026, both `popclaw` and `popclaw-mcp`
resolved to **0.1.8**. That is the verified release record, not a promise that a
later `latest` version has the same acceptance. See the
[support matrix](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/support-matrix.md#current-verification-scope)
for exact checks and limits, and the [host guide](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md)
for installation, identity reuse and upgrades. Inspect the setup plan first:

```sh
npx popclaw@latest setup --host claude --plan
```

`setup` accepts `--host claude`, `--host codex` or `--host both`.
Other MCP clients need manual configuration. `--plan` only inspects; actual
setup writes the host configuration. A missing identity requires explicit
`--create-identity`. Select an existing identity with `--root` and follow the
host guide's reuse conditions; setup is not a migration or restore command.

For DeepSeek Harness, use the [DSH YAML guide](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts-details.md#deepseek-harness-dsh)
([中文步骤](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts-details.md#dsh-中文步骤)).
It covers the current confirmation limits; `--host dsh` is not supported.

The [command reference](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/commands.md)
lists all CLI options, the two MCP entry points and the complete tool index.

## The two equivalent commands

For a hand-written MCP host configuration, these launch the same stdio server:

```sh
npx -y popclaw@latest mcp
npx -y popclaw-mcp@latest
```

Both require `POPCLAW_DATA_ROOT` to be set to an **absolute** path. That
directory is the identity: point several hosts at the same root and they share
one passport, one inbox and one set of policies. A different root is a
different identity.

Reuse must satisfy the [host guide's identity conditions](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md#before-you-start).
Setup can adopt a key-only root or reconnect a valid setup-managed root;
it refuses unmanaged historical data instead of silently migrating it.

```sh
POPCLAW_DATA_ROOT=/Users/you/.popclaw npx -y popclaw-mcp@latest
```

## The session hook

`popclaw-mcp-hook` reads pending notifications out of an existing data root and
prints them as host context. It opens the database read-only and creates
nothing — no identity, no directories.

It needs the same `POPCLAW_DATA_ROOT` as the server, plus
`POPCLAW_NOTIFICATION_CONSUMER` — the id notifications are tracked under. The
two processes must agree on that id: if you leave it unset when starting the
MCP server it defaults to `mcp:<resolved working directory>`, but the hook has
no such default and does nothing without it. Set it explicitly and reuse the
exact same value for the server and every hook entry.

For Claude Code, use `npx popclaw@latest setup --host claude` to install the
matching server and hooks together. It records a stable local runtime and
consistent consumer ID. For an existing installation, follow the
[update guide](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md#updating-an-existing-installation)
and preserve the identity root.

The hook takes its event name as one argument (`SessionStart`,
`UserPromptSubmit` or `PostToolUse`); it does not read the host's stdin payload.
Manual integrations must use the same installed runtime for the server and
hooks, rather than resolving `latest` separately during each hook invocation.

With anything missing, unknown, or nothing pending, the hook prints `{}` and
exits 0 — a broken config and "nothing pending" look identical from the
output alone. Tell them apart from inside the session: call the
`popclaw_notifications` tool and compare its count against what the hook
context showed.

## License

Apache-2.0. See [LICENSE](https://github.com/PopClaw-xyz/popclaw/blob/main/packages/popclaw-mcp/LICENSE) and [NOTICE](https://github.com/PopClaw-xyz/popclaw/blob/main/packages/popclaw-mcp/NOTICE).

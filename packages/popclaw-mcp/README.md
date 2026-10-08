# popclaw-mcp

`popclaw-mcp` is an alias. It carries no popclaw code of its own: its two
commands are one import each of the MCP entry points of the
[`popclaw`](https://www.npmjs.com/package/popclaw) package, which it depends on
at the exact same version. Install either package and you get the same server,
the same tools and the same identity.

## Start here

Install a verified, fixed release. The npm examples below require that exact
version to be available in the registry; a verified release tarball is the
alternative. See the [host guide](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md).

With that fixed build installed, inspect the setup plan first:

```sh
popclaw setup --host claude --plan
```

`setup` accepts `--host claude`, `--host codex` or `--host both`.
Other MCP clients need manual configuration. `--plan` only inspects; actual
setup writes the host configuration. A missing identity requires explicit
`--create-identity`. Select an existing identity with `--root` and follow the
host guide's reuse conditions; setup is not a migration or restore command.

The [command reference](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/commands.md)
lists all CLI options, the two MCP entry points and the complete tool index.

## The two equivalent commands

For a hand-written MCP host configuration, these launch the same stdio server:

```sh
npx -y popclaw@0.1.0 mcp
npx -y popclaw-mcp@0.1.0
```

Both require `POPCLAW_DATA_ROOT` to be set to an **absolute** path. That
directory is the identity: point several hosts at the same root and they share
one passport, one inbox and one set of policies. A different root is a
different identity.

Reuse must satisfy the [host guide's identity conditions](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md#before-you-start).
Setup can adopt a key-only root or reconnect a valid setup-managed root;
it refuses unmanaged historical data instead of silently migrating it.

```sh
POPCLAW_DATA_ROOT=/Users/you/.popclaw npx -y popclaw-mcp@0.1.0
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

The hook never reads the host's stdin payload — it takes the event name only
from its one argument (`SessionStart`, `UserPromptSubmit` or `PostToolUse`),
so each hook entry below needs its own argument naming its own event:

```sh
POPCLAW_DATA_ROOT=/Users/you/.popclaw POPCLAW_NOTIFICATION_CONSUMER=claude:my-project \
  npx -y --package=popclaw-mcp@0.1.0 popclaw-mcp-hook UserPromptSubmit
```

`--package` is required: the command name and the package name differ, so
without it npm looks for a package called `popclaw-mcp-hook`.

A minimal Claude Code `settings.json`, wiring all three events (the same
`POPCLAW_NOTIFICATION_CONSUMER` also belongs in the MCP server's own `env`):

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "POPCLAW_DATA_ROOT=/Users/you/.popclaw POPCLAW_NOTIFICATION_CONSUMER=claude:my-project npx -y --package=popclaw-mcp@0.1.0 popclaw-mcp-hook SessionStart",
        "timeout": 5
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "POPCLAW_DATA_ROOT=/Users/you/.popclaw POPCLAW_NOTIFICATION_CONSUMER=claude:my-project npx -y --package=popclaw-mcp@0.1.0 popclaw-mcp-hook UserPromptSubmit",
        "timeout": 5
      }]
    }],
    "PostToolUse": [{
      "matcher": "Bash|Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "POPCLAW_DATA_ROOT=/Users/you/.popclaw POPCLAW_NOTIFICATION_CONSUMER=claude:my-project npx -y --package=popclaw-mcp@0.1.0 popclaw-mcp-hook PostToolUse",
        "timeout": 5
      }]
    }]
  }
}
```

With anything missing, unknown, or nothing pending, the hook prints `{}` and
exits 0 — a broken config and "nothing pending" look identical from the
output alone. Tell them apart from inside the session: call the
`popclaw_notifications` tool and compare its count against what the hook
context showed.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

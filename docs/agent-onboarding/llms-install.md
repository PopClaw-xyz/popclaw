<a id="llms-installmd"></a>

# Install PopClaw for your user

Read [SKILL.md](SKILL.md). Use the user's chosen host and existing identity.
Do not ask again for installation permission already given in this conversation.

<a id="package-identity"></a>

**npm 0.1.0 is not available yet.** Use these registry commands only after the
release is published and verified. For an official archive, use the
[package installation guide](../../apps/popclaw-plugin/INSTALL.md) and verify
the supplied checksum. Do not substitute a placeholder package.

## Requirements

macOS or Linux; Node.js 24.16+ (24.x) or 26.1+ (26.x).
OpenClaw users also need OpenClaw 2026.9.8. Other hosts do not.

## OpenClaw

```sh
openclaw plugins install popclaw@0.1.0
openclaw config set plugins.entries.popclaw.hooks.allowConversationAccess true
```

Review source and permission prompts. Keep the same profile, configuration and data.
Start or reload the selected OpenClaw instance as its result requires; do not
restart unrelated instances. Docker has [separate restart notes](../hosts-details.md#openclaw).
Check `/popclaw status`, then guide the user through `/popclaw start`.

## Claude Code

Run in the project being connected. Only for an authorized new identity:

```sh
npx popclaw@0.1.0 setup --host claude --create-identity
```

If multiple profiles are found, use `--claude-profile /path/to/config`.

## Codex

Run in the project being connected. Only for an authorized new identity:

```sh
npx popclaw@0.1.0 setup --host codex --create-identity
```

## Existing identity

Omit `--create-identity`; add `--root /absolute/path/to/existing/data`.
Read the [reuse requirements](../hosts-details.md#reusing-one-identity-across-hosts-on-the-same-machine).
If setup refuses the directory, preserve it. Do not delete data, forge a setup
record, extract the key or create another identity to bypass the refusal.
Do not copy one identity to another machine and run both.

<a id="generic-mcp-host"></a>

## Other MCP hosts

Use `npx -y popclaw@0.1.0 mcp`, with `POPCLAW_DATA_ROOT` set to an absolute,
existing data directory. Use stdio and a tool timeout of at least 660 seconds.
This configuration does not make an untested host supported; check the
[support matrix](../support-matrix.md).

## Check the result

Call `popclaw_check_status` and show the returned identity. For reuse, confirm
the full ID is unchanged. Report errors as errors; do not infer success from
an installer exit or a conversational reply.

Installation does not authorize posts, messages or standing permissions.
If an action's result is unknown, check it before retrying. Do not resend automatically.

## Uninstall

Remove the plugin or MCP registration. Leave the identity and data in place.

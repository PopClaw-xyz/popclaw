# Install PopClaw in OpenClaw

This guide installs **PopClaw 0.1.8 Developer Preview** into your usual OpenClaw
profile. Use macOS or Linux, OpenClaw **2026.9.8 or later**, and Node.js
**24.16+ (24.x) or 26.1+ (26.x)**. See the
[tested combinations and limits](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/support-matrix.md).

Already have PopClaw code or data? Keep it and use the
[update guide](INSTALL-DETAILS.md#updating-an-existing-installation).
Claude Code and Codex users should use the [MCP setup guide](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md).

## 1. Install one package

**npm — full package:**

```sh
openclaw plugins install popclaw@0.1.8
```

Review OpenClaw's source and permission prompts before accepting them.

**ClawHub — client package:** review its
[community package and scanner limits](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/support-matrix.md)
and requested capabilities, then install:

```sh
openclaw plugins install clawhub:popclaw-clawhub@0.1.8 --accept-capabilities
```

Both packages are published. The ClawHub client excludes standalone operator
services. Its unresolved scanner findings remain separate from successful
installation and signature verification. Follow any additional host policy prompts.

For an official `.tgz`, follow the [checksum and local-install steps](INSTALL-DETAILS.md#installing-a-release-tarball).
Do not use a first-install overwrite command on an existing installation.

## 2. Allow the conversation hook

In the same OpenClaw instance:

```sh
openclaw config set plugins.entries.popclaw.hooks.allowConversationAccess true
```

This grants PopClaw's required conversation-hook access. Follow the host's application
result: start a stopped instance through its usual launcher, or reload/restart when
required. A restart briefly interrupts chat.

## 3. Check and start

In that OpenClaw chat, run these one at a time:

```text
/popclaw status
/popclaw start
```

Confirm the first returns your identity, then follow the first-use prompts.
A successful installer exit alone does not prove the plugin is running.

You can give this page to your assistant to perform these steps. Tell it which
OpenClaw instance to use and preserve existing settings and data. It should use
approval already given and report any new permission or restart requirement.

[First things to try](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/first-steps.md) ·
[Troubleshooting](INSTALL-DETAILS.md#troubleshooting-table) ·
[Backup and recovery](INSTALL-DETAILS.md#back-up-your-identity--move-to-a-new-machine)

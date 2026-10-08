# Install PopClaw in OpenClaw

You need OpenClaw 2026.9.8 and Node.js 24.16+ (24.x) or 26.1+ (26.x), on macOS or Linux.
Use your usual OpenClaw profile. Already have PopClaw? Keep its data and read the
[existing-installation guide](INSTALL-DETAILS.md#existing-development-installations) first.

## Choose one way to install

### 1. npm — recommended once published

**The npm release is not available yet.** After version 0.1.0 is published and verified:

```sh
openclaw plugins install popclaw@0.1.0
```

Review and accept OpenClaw's source and permission prompts. If installation is blocked,
see the [installation details](INSTALL-DETAILS.md#fresh-install).

### 2. Downloaded package

Use the official `.tgz` package and check its SHA-256 against the supplied release record.
For a first install on OpenClaw 2026.9.8, after reviewing its source and permissions:

```sh
openclaw plugins install /path/to/popclaw-plugin.tgz --accept-capabilities --acknowledge-install-policy-warning --force
```

Replace the path with your downloaded file. `--force` can overwrite an existing plugin;
do not use this example to reinstall over existing PopClaw data.

### 3. Ask your AI assistant

Give it this page and the package you want to install:

> Install PopClaw in my usual OpenClaw using this guide. Keep my existing settings and data. Ask me before accepting permissions or restarting OpenClaw, then check that PopClaw works.

## Finish setup

After either package installation, allow PopClaw's conversation hook:

```sh
openclaw config set plugins.entries.popclaw.hooks.allowConversationAccess true
```

This lets PopClaw use its conversation hook in OpenClaw. Start OpenClaw if it is stopped;
reload or restart only if OpenClaw asks you to. A restart briefly interrupts your chat.

Then send these in your OpenClaw chat, one at a time:

```text
/popclaw status
/popclaw start
```

Check that the first returns your PopClaw identity, then follow the setup prompts.

[What to try next](https://account.popclaw.xyz/quickstart) ·
[FAQ](https://popclaw.xyz/?lang=en#faq) ·
[Troubleshooting](INSTALL-DETAILS.md#troubleshooting-table)

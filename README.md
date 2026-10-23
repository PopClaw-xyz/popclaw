**English** · [简体中文](https://github.com/PopClaw-xyz/popclaw/blob/main/README.zh-CN.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/PopClaw-xyz/popclaw/main/docs/brand/popclaw-horizontal-terminal-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/PopClaw-xyz/popclaw/main/docs/brand/popclaw-horizontal-terminal-primary.svg">
    <img alt="PopClaw — Find your people. Be found." src="https://raw.githubusercontent.com/PopClaw-xyz/popclaw/main/docs/brand/popclaw-horizontal-terminal-primary.svg" width="440">
  </picture>
</p>

<p align="center"><b>Different Agents, One Open Social Network.</b></p>

<p align="center">
  Chat, follow people and share across OpenClaw, Muse, dots, Claude Code, Codex and other compatible AI agents.
</p>

<p align="center">
  <a href="https://popclaw.xyz/?lang=en"><b>PopClaw.xyz</b></a> ·
  <a href="https://x.com/popclaw_xyz">Official X: @popclaw_xyz</a> ·
  <a href="https://x.com/heiyuneo">Founder’s X: @heiyuneo</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/popclaw"><img alt="npm: popclaw version" src="https://img.shields.io/npm/v/popclaw?label=popclaw&amp;style=flat-square&amp;color=167D8D" height="20"></a>
  <a href="https://www.npmjs.com/package/popclaw-mcp"><img alt="npm: popclaw-mcp version" src="https://img.shields.io/npm/v/popclaw-mcp?label=popclaw-mcp&amp;style=flat-square&amp;color=167D8D" height="20"></a>
  <a href="https://github.com/PopClaw-xyz/popclaw/discussions"><img alt="Community discussions" src="https://img.shields.io/badge/Discussions-Join_in-167D8D?style=flat-square" height="20"></a>
  <a href="https://github.com/PopClaw-xyz/popclaw/actions/workflows/ci.yml?query=branch%3Amain"><img alt="CI: main branch status" src="https://github.com/PopClaw-xyz/popclaw/actions/workflows/ci.yml/badge.svg?branch=main" height="20"></a>
  <a href="https://github.com/PopClaw-xyz/popclaw/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/License-Apache--2.0-2563EB?style=flat-square" height="20"></a>
  <a href="https://github.com/PopClaw-xyz/popclaw/releases/latest"><img alt="Release: Developer Preview" src="https://img.shields.io/badge/Status-Developer_Preview-666666?style=flat-square" height="20"></a>
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=-XubfNNahPI">
    <img src="docs/brand/popclaw-introduction-video-cover.jpg" alt="Watch the PopClaw introduction on YouTube" width="640">
  </a>
  <br>
  <a href="https://www.youtube.com/watch?v=-XubfNNahPI"><b>▶ Watch the PopClaw introduction · 3:46</b></a>
</p>

## Meet PopClaw

PopClaw is an open social layer built around a **neo social graph**: your personal
network of people, relationships and shared interests, developed with your agent.
Find friends, exchange encrypted DMs, publish posts and make a personal newspaper.

Your agent drafts outgoing messages; you check the recipient and complete text
before sending. Private relationship notes and public follows are separate.
Local clients hold your keys and data on your machine; hosted providers hold them
for you. [Product introduction](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/brand/product-introduction.md) ·
[Privacy](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/threat-model.md)

*Developer preview. Interfaces may change.* [Compatibility policy](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/compatibility.md) · [Known limitations](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/known-limitations.md)

## Start here

| You want to… | Start with |
| --- | --- |
| Connect Muse, dots or another remote MCP + OAuth assistant | [Hosted Quick Start](https://account.popclaw.xyz/quickstart) |
| Run OpenClaw, Claude Code or Codex locally | [Local installation](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md) |
| Connect DeepSeek Harness (DSH) locally | [DSH installation guide](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts-details.md#deepseek-harness-dsh) |
| Build a game, community or service | [Run and adapt Ranger Map](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/build-a-lorehouse.md) |

### Connect Muse, dots or a remote MCP host

Follow the [Quick Start connection step](https://account.popclaw.xyz/quickstart#connect).
It provides the current setup prompt for **remote MCP (Streamable HTTP) with OAuth**,
including sign-in and identity verification. Reuse an existing connection.
MCP support alone does not guarantee that a host supports this connection method.

### Install locally: OpenClaw, Claude Code or Codex

The npm commands use `latest`; see the [support matrix](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/support-matrix.md#current-verification-scope) for the exact verified version.
Use macOS or Linux with Node 24.16+ (24.x) or 26.1+ (26.x).
For a new OpenClaw installation (host 2026.9.8 or later):

```sh
openclaw plugins install popclaw@latest
```

Then [enable the conversation hook and verify the running plugin](https://github.com/PopClaw-xyz/popclaw/blob/main/apps/popclaw-plugin/INSTALL.md).
Claude Code and Codex use [local MCP setup](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md#claude-code)
and do not need OpenClaw. Already installed? Follow [update and identity-reuse instructions](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md).
Do not create another identity to update.

**DeepSeek Harness (DSH)** uses the [manual configuration guide](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts-details.md#deepseek-harness-dsh). Manual setup does not automatically join a House; the current DSH client lacks the MCP confirmation forms required for World actions and House restore confirmation.

## Have your first conversation

1. Connect your agent and ask it to show your PopClaw identity and joined House.
2. Find your friend by name; add their Sigil if names overlap.
3. Ask for a hello draft, review it, then tell your agent to send.

Both people must join the same House. [First steps](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/first-steps.md)
also cover posts, one-file DMs, private relationship notes and newspapers.
Notifications and attachment display depend on the host; see [tested combinations](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/support-matrix.md).

<a id="what-changes-in-018"></a>

## Latest release

Use the [latest release](https://github.com/PopClaw-xyz/popclaw/releases/latest) for
downloads and release notes. See the [changelog](https://github.com/PopClaw-xyz/popclaw/blob/main/CHANGELOG.md)
for changes and the [support matrix](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/support-matrix.md)
for the exact packages and hosts that have been verified. PopClaw remains a Developer Preview.

---

## Build on PopClaw

Start with **[Ranger Map](https://github.com/PopClaw-xyz/lorehouse-mvp)**, an Apache-2.0
Python/SQLite reference server. Run it locally, try an authorized action, then adapt
its rules. [Builder guide](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/build-a-lorehouse.md).

For another implementation, read the [protocol overview](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/protocol.md)
and the [pinned specification and test vectors](https://github.com/PopClaw-xyz/popclaw/tree/main/protocol).
Optional protocol shapes do not imply every client implements them.

## Docs and community

- [Documentation index](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/README.md): use, build, operate and contribute.
- [Command reference](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/commands.md) · [FAQ](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/faq.md).
- [Discussions](https://github.com/PopClaw-xyz/popclaw/discussions): questions, ideas and projects.
- [Contributing](https://github.com/PopClaw-xyz/popclaw/blob/main/CONTRIBUTING.md): development setup and review.
- [Issues](https://github.com/PopClaw-xyz/popclaw/issues): bugs with host, OS, version and reproduction steps.
- [Security](https://github.com/PopClaw-xyz/popclaw/blob/main/SECURITY.md): private vulnerability reports.

[@popclaw_xyz](https://x.com/popclaw_xyz) · [Creator notes: @heiyuneo](https://x.com/heiyuneo)

---

<a id="license-and-trademarks"></a>

## License

| What | License |
| --- | --- |
| This repository: client, MCP server, setup, public protocol bundle | [Apache-2.0](https://github.com/PopClaw-xyz/popclaw/blob/main/LICENSE) |
| [PopClaw Ranger Map](https://github.com/PopClaw-xyz/lorehouse-mvp) reference server | Apache-2.0 |
| The official Rust/PostgreSQL LoreHouse behind `popclaw.me` and `popclaw.world` | Planned BUSL-1.1 release; not included in this repository |

The official LoreHouse server is planned for a later, separate source-available
release under BUSL-1.1. **The plan is to allow companies with annual revenue of
less than US$10 million to use it free of charge, subject to the license terms published
with that release.** Each version is planned to convert to AGPL-3.0-only four years
after its first public distribution under BUSL.

PopClaw and LoreHouse are trademarks of PopClaw AI Limited; see the [trademark policy](https://github.com/PopClaw-xyz/popclaw/blob/main/TRADEMARK.md) for use of the names.

## Project

Created by **[heiyu (黑羽)](https://github.com/heiyuneo)**, founder of PopClaw.

Copyright © 2026 PopClaw AI Limited.

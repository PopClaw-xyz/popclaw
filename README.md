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

PopClaw is an open social layer built around a **neo social graph**: a personal network of people, relationships and shared interests that you and your agent build together.

- Find people, follow updates, publish posts and join conversations across agents.
- Exchange encrypted private messages with images, audio and supported document attachments. Handle multiple conversations naturally; review the recipient and complete draft before sending.
- Create an interactive Canvas and share its link. Read a personal newspaper built from updates and topics you care about, with sources to explore.
- Choose acquaintances, friends and close friends, and keep private relationship notes. Following is a separate choice; DM alerts depend on the host. With the local OpenClaw plugin, identity keys and private relationship records stay on your machine.
- Use X account verification, explore PopClaw World, or build communities and games on the open protocol.

The client and public protocol are open source. Run locally with OpenClaw or connect a supported host through MCP. Attachment display and notifications depend on the host.

[Full product introduction](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/brand/product-introduction.md) · **Your agent. Your people. Your social world.**

*Developer preview. Interfaces may change.* [Compatibility policy](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/compatibility.md) · [Known limitations](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/known-limitations.md)

---

## Start here

| I want to… | Start here |
| --- | --- |
| Connect [Meta’s Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/), [OpenAI’s dots](https://openai.com/index/introducing-dots/), or a supported remote MCP agent | [Quick Start](https://account.popclaw.xyz/quickstart#connect) · [FAQ](https://popclaw.xyz/?lang=en#faq-choose-entry) |
| Run the client on my computer or server | [OpenClaw FAQ](https://popclaw.xyz/?lang=en#faq-install-openclaw) · [Claude Code FAQ](https://popclaw.xyz/?lang=en#faq-install-claude-code) · [Codex FAQ](https://popclaw.xyz/?lang=en#faq-install-codex) |
| Connect DeepSeek Harness (DSH) locally | [DSH installation guide](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts-details.md#deepseek-harness-dsh) |
| Connect my game, community, or service | [Build on PopClaw FAQ](https://popclaw.xyz/?lang=en&topic=build#faq) |

Hosted clients store your keys and data with the provider; local clients keep them on your machine. [Privacy](https://popclaw.xyz/?lang=en#faq-storage).

## Connect Muse, dots or a remote MCP host

For an agent that supports **remote MCP (Streamable HTTP) with OAuth**, copy this
setup prompt into its chat. This connects to the hosted PopClaw service, with no
local installation. Follow your host's instructions to connect, sign in and
authorize access; the steps vary by host. Supporting MCP alone is not sufficient.

The prompt below is the English prompt from [popclaw.xyz](https://popclaw.xyz/).
[Quick Start](https://account.popclaw.xyz/quickstart) explains the connection steps.

```text
Connect me to PopClaw:

1. Use remote MCP (Streamable HTTP) with OAuth. No API key or local installation.
MCP: https://mcp.popclaw.xyz/mcp
OAuth discovery: https://mcp.popclaw.xyz/.well-known/oauth-protected-resource/mcp
If a resource field is required, use the MCP URL above.

2. Complete the setup wherever possible. Prefer reusing an existing connection; do not reset my identity or erase data. Involve me only for required sign-in or authorization.

3. Make fresh popclaw_show_namecard {} and popclaw_check_status calls to verify my identity and LoreHouse status. Not having joined a House is different from a connection failure. If something fails, report the step and specific error; setup alone does not prove success.
```

After connection or local installation, say **“Start PopClaw”**, then **“Call me
Alex.”** In OpenClaw you can also run `/popclaw start`. Set a name first and
personalize the rest later. [Seven things to try, with prompts](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/brand/product-introduction.md).

## Install locally: OpenClaw, Claude Code or Codex

Install the latest npm release with the commands below.
Use macOS or Linux with Node.js 24.16+ (24.x) or 26.1+ (26.x).
Already have an identity? [Reuse it](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md#reusing-one-identity-across-hosts-on-the-same-machine).

**OpenClaw 2026.9.8**

```sh
openclaw plugins install popclaw@latest
```

Then enable the conversation hook and check the plugin: [finish setup or install a tarball](https://github.com/PopClaw-xyz/popclaw/blob/main/apps/popclaw-plugin/INSTALL.md).

**Claude Code — new identity**

```sh
npx popclaw@latest setup --host claude --create-identity
```

**Codex — new identity**

```sh
npx popclaw@latest setup --host codex --create-identity
```

Follow the prompts, then ask your agent: **“Check my PopClaw status.”**
Standard setup joins PopClaw.me; PopClaw.world is optional.

**DeepSeek Harness (DSH)** uses a manual local MCP configuration. Follow the
[DSH guide](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts-details.md#deepseek-harness-dsh)
to select your identity, add the YAML configuration and check the connection.
Manual DSH setup does not automatically join a House. World actions and House
restore confirmation currently require a host with MCP confirmation forms.

[First conversations](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/first-steps.md) · [Host setup](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md) ·
[Read the public feed](https://popclaw.me/feed)

## Latest release

Use the [latest release](https://github.com/PopClaw-xyz/popclaw/releases/latest) for
downloads and release notes. See the [changelog](https://github.com/PopClaw-xyz/popclaw/blob/main/CHANGELOG.md)
for changes and the [support matrix](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/support-matrix.md)
for the exact packages and hosts that have been verified. PopClaw remains a Developer Preview.

---

## One minute, one new possibility

### Publish your first post

Your agent drafts; you review and confirm. Open the signed post from its
receipt. [Try your first post →](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/first-steps.md#publish-your-first-post)

### Chat and share across terminals

Talk to people using other hosts. Review a message, link or supported small
attachment before your agent sends it.
[Start a conversation →](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/first-steps.md#chat-across-hosts)

### Explore your bond book

Remember who someone is, how you met and what matters to you — from your
point of view. With the local OpenClaw plugin, these records stay on your machine.
[Explore the bond book →](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/first-steps.md#explore-your-bond-book)

### Read your newspaper

Ask for a paper and open the HTML file from its receipt. Sharing and
scheduling are explained in the guide.
[Read your first paper →](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/first-steps.md#read-your-first-newspaper)

Guide and world-summary reads share a ten-second execution budget. Cached results show freshness and recorded times. Initial newspaper gathering retains individual network timeouts and cancellation checks, while valid local verification may take longer. Model work and publication are separate. [Read behavior and cache details](https://github.com/PopClaw-xyz/popclaw/blob/main/apps/popclaw-plugin/README.md).

Your agent shows posts and messages before sending; say “send it” to approve.
Follows are public. Marks are visible to the server carrying them.
[Privacy](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/threat-model.md).

---

## Why PopClaw

- **Your agent learns your interests.** It uses the social context you share to find people, remember conversations and prepare your newspaper. [How it works](https://popclaw.xyz/?lang=en#faq-agent-understanding).
- **Relationships are personal.** Your private bond book records your view of a relationship. The local OpenClaw plugin keeps identity keys and private relationship records on your machine; hosted providers hold them for you. [Privacy](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/threat-model.md).
- **Bring your identity to new communities.** Each community server is a House. Your client connects to the Houses you join; Houses do not forward messages to one another. [The protocol](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/protocol.md).

---

## Build a world. Light a lantern.

Start with **[Ranger Map](https://github.com/PopClaw-xyz/lorehouse-mvp)**:
an Apache-2.0 Python/SQLite reference server where visitors leave footprints on a map.
Run it locally, try an action, then adapt it to your own game or service.
[Setup and hosting limits](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/build-a-lorehouse.md).

Building from scratch? [protocol/](https://github.com/PopClaw-xyz/popclaw/tree/main/protocol) contains the pinned wire format,
reference codecs and test vectors. Optional schema fields are not promises of shipped features.
[Implementers guide](https://github.com/PopClaw-xyz/popclaw/blob/main/protocol/packages/contracts/protocol/public-envelope-02/IMPLEMENTERS.md) ·
[Protocol checks](https://github.com/PopClaw-xyz/popclaw/blob/main/protocol/BUILD.md#checks).

Optional external-platform verification and mirroring use the operator's provider accounts and quotas.
[Fetching and content-use boundaries](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/threat-model.md).

---

## Docs & guides

[Documentation index](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/README.md) · [Full FAQ](https://popclaw.xyz/?lang=en#faq) · [中文 FAQ](https://popclaw.xyz/?lang=zh#faq)

| I want to… | Start here |
| --- | --- |
| Use PopClaw | [Installation and host support](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md) · [First things to try](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/first-steps.md) |
| Find commands or debug an integration | [Command reference](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/commands.md) · [中文命令参考](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/commands.zh-CN.md) |
| Run a house | [Set up the reference server](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/build-a-lorehouse.md) |
| Build an integration | [Protocol and developer docs](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/protocol.md) · [one exchange at a time](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/protocol-walkthrough.md) |
| Understand the boundaries | [Privacy](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/threat-model.md) · [known limitations](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/known-limitations.md) · [compatibility promise](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/compatibility.md) |
| See what's next | [Roadmap](https://github.com/PopClaw-xyz/popclaw/blob/main/ROADMAP.md) |

[Brand and culture](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/brand/README.md) ·
[Glossary](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/glossary.md) ·
[What the project-operated houses keep](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosted-houses.md)

[Tested setups](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/support-matrix.md) · [Known limitations](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/known-limitations.md)

---

## Join the community

Ask questions and share projects in [Discussions](https://github.com/PopClaw-xyz/popclaw/discussions).

- **Something broke?** [Open an issue](https://github.com/PopClaw-xyz/popclaw/issues).
  Include your host, OS, package version and the smallest steps that reproduce it.
- **Built a world?** Show it in
  [Discussions](https://github.com/PopClaw-xyz/popclaw/discussions).
- **Want to help?** [CONTRIBUTING.md](https://github.com/PopClaw-xyz/popclaw/blob/main/CONTRIBUTING.md) and the
  [good first issues](https://github.com/PopClaw-xyz/popclaw/labels/good%20first%20issue).
- **Found a vulnerability?** [SECURITY.md](https://github.com/PopClaw-xyz/popclaw/blob/main/SECURITY.md). Please do not open a
  public issue.

[@popclaw_xyz](https://x.com/popclaw_xyz) — releases, new ways to play, and
community projects.
[@heiyuneo](https://x.com/heiyuneo) — product thinking, philosophy, and notes
from the creator.

### A note from the creator

I built PopClaw as a solo developer. It still has rough edges. Try it, report a bug, or help improve the protocol and the worlds people build with it.

— heiyuneo

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

This project was designed and programmed by its author in extensive collaboration with AI coding tools, including Claude Code, Codex, DeepSeek harness, and GLM models.

[English](https://github.com/PopClaw-xyz/popclaw/blob/main/README.md) · **简体中文**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/PopClaw-xyz/popclaw/main/docs/brand/popclaw-horizontal-terminal-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/PopClaw-xyz/popclaw/main/docs/brand/popclaw-horizontal-terminal-primary.svg">
    <img alt="PopClaw — Find your people. Be found." src="https://raw.githubusercontent.com/PopClaw-xyz/popclaw/main/docs/brand/popclaw-horizontal-terminal-primary.svg" width="440">
  </picture>
</p>

<p align="center"><b>不同的 Agent，同一个开放社交网络。</b></p>

<p align="center">
  你用 OpenClaw，朋友用 Muse、dots、Claude Code 或 Codex。<br>
  接入 PopClaw 后，通过各自熟悉的 Agent 认识彼此、保持联系。
</p>

<p align="center">
  <a href="https://popclaw.xyz/?lang=zh"><b>PopClaw.xyz</b></a> ·
  <a href="https://account.popclaw.xyz/quickstart">快速开始</a> ·
  <a href="https://popclaw.xyz/?lang=zh#faq">常见问题</a> ·
  <a href="https://github.com/PopClaw-xyz/popclaw/blob/main/docs/README.md">文档</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/popclaw"><img alt="npm：popclaw 版本" src="https://img.shields.io/npm/v/popclaw?label=popclaw&amp;style=flat-square&amp;color=167D8D" height="20"></a>
  <a href="https://www.npmjs.com/package/popclaw-mcp"><img alt="npm：popclaw-mcp 版本" src="https://img.shields.io/npm/v/popclaw-mcp?label=popclaw-mcp&amp;style=flat-square&amp;color=167D8D" height="20"></a>
  <a href="https://github.com/PopClaw-xyz/popclaw/discussions"><img alt="社区讨论" src="https://img.shields.io/badge/Discussions-Join_in-167D8D?style=flat-square" height="20"></a>
  <a href="https://github.com/PopClaw-xyz/popclaw/actions/workflows/ci.yml?query=branch%3Amain"><img alt="CI：main 分支状态" src="https://github.com/PopClaw-xyz/popclaw/actions/workflows/ci.yml/badge.svg?branch=main" height="20"></a>
  <a href="https://github.com/PopClaw-xyz/popclaw/blob/main/LICENSE"><img alt="许可证：Apache-2.0" src="https://img.shields.io/badge/License-Apache--2.0-2563EB?style=flat-square" height="20"></a>
  <a href="https://github.com/PopClaw-xyz/popclaw/releases/tag/v0.1.8"><img alt="版本：开发者预览" src="https://img.shields.io/badge/Status-Developer_Preview-666666?style=flat-square" height="20"></a>
</p>

> **开发者预览。** 仍有粗糙之处，接口会遵循[兼容政策（英文）](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/compatibility.md)继续演进。
> 欢迎试用插件、运行灯坊，一起决定它接下来成为怎样的东西。
>
> [已知限制（英文）](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/known-limitations.md)

## 认识 PopClaw

PopClaw 围绕 **neo social graph** 构建：你和 Agent 一起建立的人、关系和共同兴趣网络。
找到朋友、收发加密私信、分享帖子，再把关心的动态做成个人报纸。

Agent 起草对外消息；你核对收件人和完整内容后再发送。私人关系笔记与公开关注是两件事。
本地客户端在你的机器上保存密钥和数据，托管服务则由服务方保管。
[完整介绍](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/brand/product-introduction.md#中文介绍) ·
[隐私说明](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/threat-model.md)

## 从这里开始

| 你想做什么 | 从这里开始 |
| --- | --- |
| 连接 Muse、dots 或其他远程 MCP + OAuth 助手 | [托管 Quick Start](https://account.popclaw.xyz/quickstart) |
| 在本地使用 OpenClaw、Claude Code 或 Codex | [本地安装指南](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md) |
| 搭建游戏、社区或服务 | [运行并改造 Ranger Map](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/build-a-lorehouse.md) |

### 连接 Muse、dots 或远程 MCP 宿主

按 [Quick Start 的连接步骤](https://account.popclaw.xyz/quickstart#connect)操作。
该页提供当前的 setup prompt，用 **远程 MCP（Streamable HTTP）与 OAuth** 完成连接、登录和身份核验。
优先复用已有连接；支持 MCP 本身，不代表宿主支持这种连接方式。

### 本地安装：OpenClaw、Claude Code 或 Codex

当前版本为 **0.1.8**。使用 macOS 或 Linux，Node 24.16+（24.x）或 26.1+（26.x）。
在 OpenClaw 2026.9.8 或更高版本首次安装：

```sh
openclaw plugins install popclaw@0.1.8
```

然后[开启会话 hook 并确认插件实际加载](https://github.com/PopClaw-xyz/popclaw/blob/main/apps/popclaw-plugin/INSTALL.md)。
Claude Code 和 Codex 使用[本地 MCP 安装](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md#claude-code)，无需安装 OpenClaw。
已有安装请看[更新和身份复用步骤](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md)，不要为更新创建新身份。

## 开始第一段对话

1. 连接 Agent，让它显示实际 PopClaw 身份和已加入的 House。
2. 按名字找到朋友；有同名时补上 Sigil（身份短指纹）。
3. 请 Agent 起草一句招呼，核对后告诉它发送。

双方需要加入同一个 House（社区服务器）。[首次使用指南](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/first-steps.md)
也介绍帖子、单文件私信、私人关系笔记和报纸。
通知与附件显示依赖宿主，详见[已验证的组合](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/support-matrix.md)。

## 0.1.8 有哪些改进

报纸默认选择最近 **72 小时**的材料。用 `--today` 选择本地日历日，也可指定 1–168 小时的滚动范围。
本地日志读取可以更高效地复用已核验材料；这不代表整份报纸有固定完成时限。

[发布说明](https://github.com/PopClaw-xyz/popclaw/releases/tag/v0.1.8) ·
[变更记录](https://github.com/PopClaw-xyz/popclaw/blob/main/CHANGELOG.md#018) ·
[验证结果与剩余限制](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/support-matrix.md)

## 在 PopClaw 上开发

从 **[Ranger Map](https://github.com/PopClaw-xyz/lorehouse-mvp)** 开始：这是 Apache-2.0 许可的
Python/SQLite 参考服务器。先本地运行，试一次经授权的动作，再修改规则。
[开发指南](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/build-a-lorehouse.md)。

实现其他客户端或服务器，请读[协议概览](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/protocol.md)
和[固定协议规格与测试向量](https://github.com/PopClaw-xyz/popclaw/tree/main/protocol)。
协议中的可选结构，不代表每个客户端都已实现。

## 文档与社区

- [文档入口](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/README.md)：使用、开发、运维和贡献。
- [命令参考](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/commands.zh-CN.md) · [常见问题](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/faq.zh-CN.md)。
- [社区讨论](https://github.com/PopClaw-xyz/popclaw/discussions)：提问、建议和作品。
- [贡献指南](https://github.com/PopClaw-xyz/popclaw/blob/main/CONTRIBUTING.md)：开发环境与审查。
- [问题反馈](https://github.com/PopClaw-xyz/popclaw/issues)：附宿主、系统、版本和复现步骤。
- [安全报告](https://github.com/PopClaw-xyz/popclaw/blob/main/SECURITY.md)：漏洞请私下报告。

[@popclaw_xyz](https://x.com/popclaw_xyz) · [创作者笔记：@heiyuneo](https://x.com/heiyuneo)

---

## 许可证

| 内容 | 许可 |
| --- | --- |
| 本仓库：客户端、MCP 服务器、setup、公开协议 bundle | [Apache-2.0](https://github.com/PopClaw-xyz/popclaw/blob/main/LICENSE) |
| [PopClaw 游侠足迹图](https://github.com/PopClaw-xyz/lorehouse-mvp) 参考服务器 | Apache-2.0 |
| `popclaw.me` 与 `popclaw.world` 背后的官方 Rust/PostgreSQL LoreHouse | 计划采用 BUSL-1.1 单独发布；不包含在本仓库中 |

官方 LoreHouse 服务端计划之后以源码可见的 BUSL-1.1 许可单独发布。
**计划允许年营收低于 1,000 万美元的企业免费使用，具体以届时公开的许可条款为准。**
每个版本计划在首次按 BUSL 公开分发四年后转为 AGPL-3.0-only。

PopClaw 与 LoreHouse 为 PopClaw AI Limited 的商标，名称使用见[商标说明](https://github.com/PopClaw-xyz/popclaw/blob/main/TRADEMARK.zh-CN.md)。

## 项目

由 PopClaw 创始人 **[黑羽（heiyu）](https://github.com/heiyuneo)** 创作并主导。

Copyright © 2026 PopClaw AI Limited.

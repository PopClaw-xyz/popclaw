# PopClaw — Different Agents, One Open Social Network.

PopClaw connects people through the AI assistants they already use. Find a
friend, exchange private messages, share a post and keep the conversation going
across compatible agents.

It is built around a **neo social graph**: your personal network of people,
relationships and shared interests, developed with your agent. Your private
relationship notes are separate from public follows.

## Start with one conversation

1. **Connect your agent.** Follow [Quick Start](https://account.popclaw.xyz/quickstart)
   for a hosted remote MCP + OAuth connection, or [install locally](../hosts.md).
2. **Find your friend.** Ask for their PopClaw name. Add their Sigil, a short
   identity fingerprint, if several people share that name.
3. **Say hello.** Ask your agent to draft a message. Check the recipient and
   complete draft, then tell it to send.

> Find [friend's name] on PopClaw.> Draft a hello: “I'm on PopClaw too.” Let me read it before sending.

Both people need to join the same House—the community server carrying the
conversation. The [first-steps guide](../first-steps.md) walks through this.

## What you can do next

| You want to… | Ask your agent to… |
| --- | --- |
| Keep in touch | Follow someone, check new messages, or draft a reply. |
| Share something | Draft a public post, or attach one supported small file to a DM. |
| Remember a relationship | Keep a private note about how you met and what matters to you. |
| Catch up | Make a newspaper from your interests and recent community activity. |
| Create together | Make a Canvas page and share its link. |
| Explore or build a community | Read a House's guide, or [build your own service](../build-a-lorehouse.md). |

These are requests to try, not proof that every host supports every feature.
Attachment display, notifications and background work depend on the host.
See [current support and limits](../support-matrix.md).

## Choose where your client runs

- **Local:** OpenClaw plugin or local MCP. Keys and private relationship records
  live in your client data directory. Agents and model providers may process
  the content you let them access.
- **Hosted:** a remote MCP provider runs the client and holds its keys and data.
  Use a service you trust.

The client, MCP server and public protocol are open source. Houses relay signed
public events and encrypted DMs; they do not receive your entire private Bond Book.
[Privacy](../threat-model.md) · [License](../../README.md#license)

**Your agent. Your people. Your social world.**

## 中文介绍

**PopClaw — 不同的 Agent，同一个开放社交网络。**

PopClaw 让人们通过各自熟悉的 AI 助手联系彼此。找到朋友、互发私信、分享帖子，
在兼容的 Agent 之间继续同一段社交关系。

它围绕 **neo social graph** 构建：你和 Agent 一起建立的个人社交网络，包含人、关系和共同兴趣。
私人关系笔记与公开关注是两件事。

### 从一段对话开始

1. **连接 Agent。** 托管远程 MCP + OAuth 接入请看 [Quick Start](https://account.popclaw.xyz/quickstart)；
   在自己的电脑运行请看[本地安装](../hosts.md)。
2. **找到朋友。** 问朋友在 PopClaw 用什么名字；有同名时，补上身份短指纹 Sigil。
3. **打个招呼。** 请 Agent 起草私信，核对收件人和完整内容后，再告诉它发送。

> 在 PopClaw 上找到［朋友的名字］。> 起草一句招呼：“我也来 PopClaw 了。”先给我看，再发送。

双方需要加入承载对话的同一个 House（社区服务器）。[首次使用指南](../first-steps.md)有完整步骤。

### 接下来可以做什么

| 你想做什么 | 可以请 Agent 做什么 |
| --- | --- |
| 保持联系 | 关注朋友、查看新消息、起草回复。 |
| 分享内容 | 起草公开帖子，或给一条私信添加一个支持的小文件。 |
| 记住关系 | 私下记录你们如何认识、哪些事对你重要。 |
| 了解近况 | 按你的兴趣和社区近期动态制作一份报纸。 |
| 一起创作 | 制作 Canvas 页面，再分享链接。 |
| 探索或建设社区 | 阅读 House 指南，或[搭建自己的服务](../build-a-lorehouse.md)。 |

这些是可以尝试的请求，不代表所有宿主都已通过全部功能验收。附件显示、通知和后台任务依赖宿主。
查看[当前支持情况](../support-matrix.md)。

### 选择客户端运行位置

- **本地运行：** OpenClaw 插件或本地 MCP 将密钥和私人关系记录保存在客户端数据目录。
  你授权访问的内容仍可能由 Agent 和模型服务处理。
- **托管运行：** 远程 MCP 服务方运行客户端，并持有密钥和数据。请选择你信任的服务。

客户端、MCP 服务器和公开协议均开源。House 转发已签名的公开事件和加密私信，
不会因此收到完整的私人交情簿。[隐私](../threat-model.md) · [许可](../../README.zh-CN.md#许可证)

**你的 Agent，你的朋友，你的社交世界。**

## Maintaining this introduction

Keep English and Chinese in sync. README and package summaries link here instead
of copying the full introduction. Keep **neo social graph** as written; it is
product language, not a new protocol term. Examples are prompts, not executed actions.
[Documentation](../README.md) · [Brand assets](README.md)

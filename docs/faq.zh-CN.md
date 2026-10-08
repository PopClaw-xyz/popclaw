# 常见问题

[English](faq.md) · [简体中文](faq.zh-CN.md) · [官网](https://popclaw.xyz/) · [PopClaw README](../README.zh-CN.md) · [文档与指南](README.md) · [GitHub 讨论](https://github.com/PopClaw-xyz/popclaw/discussions)

**v0.1.0 · 早期开发阶段。** 功能和体验仍在完善，可能遇到问题。欢迎试用、反馈和贡献。公开 npm 安装尚未开放。请按[安装指南](hosts.md)获取对应版本的包。

本 FAQ 与代码一起在这个仓库维护。安装步骤、已支持的组合和技术边界，以对应详细指南为准。

## 按主题查找

- [开始使用](#topic-start)
  - [PopClaw 开源吗？免费吗？](#license)
  - [我该从哪个入口开始？](#choose-entry)
  - [我用 Muse，对方用 dots，也能关注和聊天吗？](#across-agents)
  - [只说名字，怎么找到对的人？](#find-person)
  - [怎样在 OpenClaw 中安装和开始使用？](#install-openclaw)
  - [怎样在 Claude Code 中接入？需要 OpenClaw 吗？](#install-claude-code)
  - [怎样在 Codex 中接入并沿用已有身份？](#install-codex)
- [身份与联系](#topic-connect)
  - [私信可以带照片、语音和文档吗？](#attachments)
  - [进入不同社区，要重新建立身份和关系吗？](#portable-identity)
  - [怎样让别人知道我在其他平台是谁？](#verification)
  - [微信、WhatsApp、Telegram 怎么加入？](#chat-apps)
  - [其他支持 MCP Server 的 Agent 也能接吗？](#mcp-hosts)
- [Agent 日常](#topic-play)
  - [AI Agent 为什么越用越懂我？](#agent-understanding)
  - [社交报纸会挑什么？一定每天自动送吗？](#newspaper)
  - [我不在屏幕前，Agent 也能参与游戏和服务吗？](#away-agent)
- [隐私与权限](#topic-privacy)
  - [私信怎样加密，谁能看到？](#private-messages)
  - [为什么采用私密、单向的关系模型？可以在本地管理吗？](#bond-book)
  - [发一条帖子，谁能看见？](#post-visibility)
  - [身份、交情簿和社交记录放在哪里？](#storage)
  - [Agent 会自己替我发帖或作承诺吗？](#agent-approval)
- [建造服务](#topic-build)
  - [我能创造什么？为什么不必从零搭一套社交？](#build-world)
  - [能否接入我自己的游戏或服务？](#enterprise)
  - [灯坊（House）是什么？我也要搭一个吗？](#what-is-house)

<a name="topic-start"></a>

## 开始使用

<a name="license"></a>

### PopClaw 开源吗？免费吗？

开源且免费。本仓库的客户端、MCP 服务器、安装工具、公开协议包及独立的游侠足迹图参考服务器采用 Apache-2.0。官方 Rust/PostgreSQL LoreHouse 不在本次发布范围内，其计划中的 BUSL 条款不限制本客户端；Agent、模型和托管服务可能另行收费。

[源码与许可](../README.zh-CN.md#许可证)

<a name="choose-entry"></a>

### 我该从哪个入口开始？

使用 [Meta 的 Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) 或 [OpenAI 的 dots](https://openai.com/index/introducing-dots/)，从[托管账户入口](https://account.popclaw.xyz)创建或复用身份，再配置远程 MCP 并单独授权 Agent；服务方保管客户端密钥和数据，详见[数据保存位置](#storage)。

在自己的电脑或服务器运行，可选 [OpenClaw 插件或已有指南的本地 MCP 接入方式](hosts.md)，无需另建社区服务器。接入自己的服务，请从 [Ranger Map 参考服务器](https://github.com/PopClaw-xyz/lorehouse-mvp)和[接入指南](build-a-lorehouse.md)开始。

<a name="across-agents"></a>

### 我用 Muse，对方用 dots，也能关注和聊天吗？

可以，前提是双方支持所需功能，并已加入同一个目标社区。先确认对方和去向，在原聊天中看完整消息，再告诉 Agent 发送。通知和附件能力因宿主而异，详见[宿主指南](hosts.md)和[支持矩阵](support-matrix.md)。

<a name="find-person"></a>

### 只说名字，怎么找到对的人？

说“帮我关注林舟”，再从 Agent 找到的候选中确认。遇到同名，可补上身份的短指纹（印记），例如“林舟 #7k4m2q9v”（虚构示例）。

[开始交流](first-steps.md#chat-across-hosts) · [术语说明](glossary.md)

<a name="install-openclaw"></a>

### 怎样在 OpenClaw 中安装和开始使用？

按 [OpenClaw 插件安装指南](../apps/popclaw-plugin/INSTALL.md)获取包、设置并检查加载状态。保留已有身份数据；与本地 MCP 宿主共用身份前，先读[同机身份复用指南](hosts.md#reusing-one-identity-across-hosts-on-the-same-machine)。连接后按[首次使用指南](first-steps.md)尝试。

<a name="install-claude-code"></a>

### 怎样在 Claude Code 中接入？需要 OpenClaw 吗？

无需 OpenClaw，按 [Claude Code 设置指南](hosts.md#claude-code)接入本地 MCP，在目标项目目录运行设置。按[身份指南](hosts.md#reusing-one-identity-across-hosts-on-the-same-machine)创建或复用身份；复用时保留原数据目录。

设置后，让 Agent 实际调用状态工具并显示当前身份。MCP 随宿主会话运行，通知和定时工作取决于配置；世界动作另有授权要求和已验证范围，不能保证无人值守参与。

<a name="install-codex"></a>

### 怎样在 Codex 中接入并沿用已有身份？

无需 OpenClaw，按 [Codex 设置指南](hosts.md#codex)接入本地 MCP，在目标项目目录运行设置。沿用身份须按[同机身份复用指南](hosts.md#reusing-one-identity-across-hosts-on-the-same-machine)选择数据目录；新建身份不会继承原身份，也不要把目录复制到另一台电脑并同时运行两份。

设置后，让 Codex 实际调用状态工具，核对其报告的完整身份。MCP 随宿主会话运行，通知和定时工作取决于宿主；世界动作另有授权要求和已验证范围，不能保证无人值守参与。

<a name="topic-connect"></a>

## 身份与联系

<a name="attachments"></a>

### 私信可以带照片、语音和文档吗？

受支持的接入方式可发送照片、截图、语音录音和文档，正文与附件发送前加密。在原聊天中确认收件人、完整消息和文件，再告诉 Agent 发送。

格式、大小、预览、播放和分析能力取决于客户端及双方宿主，示例不代表全部支持，详见[附件指南](first-steps.md#share-text-a-link-or-a-small-file)与[支持矩阵](support-matrix.md)。Muse 和 dots 托管接入的图片收发尚未验证。

<a name="portable-identity"></a>

### 进入不同社区，要重新建立身份和关系吗？

不用重新建立：沿用已有身份即可加入不同灯坊，每座灯坊有自己的加入条件和权限。关系记录留在客户端；加入不会上传完整通讯录或私密交情簿，也不会导入其他平台的好友。

[同机复用身份](hosts.md#reusing-one-identity-across-hosts-on-the-same-machine)

<a name="verification"></a>

### 怎样让别人知道我在其他平台是谁？

按支持的验证流程关联你控制的外部账号，别人就能查看关联与验证资料。验证不代表对言论的背书，也不会自动迁移粉丝或历史内容。

[首次使用与支持边界](first-steps.md) · [已知限制](known-limitations.md)

<a name="chat-apps"></a>

### 微信、WhatsApp、Telegram 怎么加入？

若 Agent 支持该聊天工具和所需 PopClaw 功能，先接入 PopClaw，再通过聊天工具与它对话。示意图只说明这条路径，不代表所有配置均已实测。配置、附件和通知能力请查[宿主指南](hosts.md)、Agent 的渠道说明及[支持矩阵](support-matrix.md)。

<a name="mcp-hosts"></a>

### 其他支持 MCP Server 的 Agent 也能接吗？

支持 MCP 不保证兼容：PopClaw 提供本地 stdio MCP，远程 MCP 则采用独立的托管连接与授权流程。其他本地宿主在 v0.1.0 中仍属未验证，除非已有实测记录；通知、附件、超时和工具行为可能不同。详见[其他 MCP 宿主指南](hosts.md#other-mcp-hosts)与[支持矩阵](support-matrix.md)。

<a name="topic-play"></a>

## Agent 日常

<a name="agent-understanding"></a>

### AI Agent 为什么越用越懂我？

Agent 从你授权访问的活动和记录中了解兴趣、关系与沟通习惯；你可以纠正它，并确认它建议的关系调整。这些信息用于筛选动态、整理报纸、归纳往来和起草回复；提醒和定时任务取决于宿主及配置。发帖、回复或私信前，在原聊天中确认去向、完整正文和附件，再告诉它发送；重要决定仍由你作主。

<a name="newspaper"></a>

### 社交报纸会挑什么？一定每天自动送吗？

说“给我出一份 PopClaw 报纸”，Agent 就会按兴趣和关系挑选可访问的社区内容，也能按你的语言总结；初期更多依赖公开动态。每天送报需要你安排定时任务，且宿主支持并持续运行，通知能力因宿主而异。分享链接可被任何持有者阅读；只想本地保存，请看[报纸发布说明](newspaper-publisher.md)。

<a name="away-agent"></a>

### 我不在屏幕前，Agent 也能参与游戏和服务吗？

只有宿主持续运行，且游戏、服务与动作授权规则都支持时才可以。Claude Code 和 Codex 的 MCP 世界动作需要逐次授权，不能默认无人值守，详见[宿主差异](hosts.md#what-differs-between-hosts)与[已验证范围](support-matrix.md)。Agent 停止后不会继续行动；付款和其他承诺仍需按各自流程取得授权。

<a name="topic-privacy"></a>

## 隐私与权限

<a name="private-messages"></a>

### 私信怎样加密，谁能看到？

私信正文和附件在发送前加密，由收件方的 PopClaw 客户端解密。负责中转的灯坊接收的是密文，仍能看到收发对象、时间和消息大小。

使用托管服务时，客户端和密钥由服务方保管。Agent 及其模型可能接触你让它处理的消息。公开帖子和回复依然是公开内容。

[隐私与威胁模型](threat-model.md)

<a name="bond-book"></a>

### 为什么采用私密、单向的关系模型？可以在本地管理吗？

交情簿记录你眼中的相遇、来往和亲疏，无需对方认可同样的关系；Agent 可建议更新，由你确认。

私人备注与亲疏判断默认不自动发布给对方或灯坊，公开关注状态另算。自主部署时保存在自己的电脑或服务器；托管时由服务方保存和处理，Agent 及模型也可能读取。

[关系模型术语](glossary.md) · [隐私与威胁模型](threat-model.md)

<a name="post-visibility"></a>

### 发一条帖子，谁能看见？

不同入口的用户都能在你选择的社区读取公开帖。发布不会通知所有人，也不会自动转发到其他平台。验证账号时的 `--sync` 仅将受支持的外部帖子导入 PopClaw，不会反向发布。

[发布帖子](first-steps.md#publish-your-first-post)

<a name="storage"></a>

### 身份、交情簿和社交记录放在哪里？

自主部署时，可在自己的电脑或服务器保管身份、交情簿与社交记录；使用托管服务时，由所选服务保管相应数据。你主动发布和发送的内容，会按操作与授权分享。

本地保管不等于额外加密存储。能访问该运行环境的程序，以及处理这些内容的 Agent 或模型，可能接触相应记录。

[隐私与威胁模型](threat-model.md) · [身份复用与恢复](hosts.md)

<a name="agent-approval"></a>

### Agent 会自己替我发帖或作承诺吗？

发帖、回复或私信前，Agent 会在原聊天中展示收件人或去向、灯坊、完整正文和附件，等你指示发送。只要求起草就不会发送；实质修改后须在同一聊天中展示新版，重新取得同意。

关注、取消关注、阅读和收取消息无需审稿。世界动作和重要承诺另有授权要求，由你决定委托范围，详见[在原聊天中处理社交操作](hosts.md#social-activity-in-your-chat)。

<a name="topic-build"></a>

## 建造服务

<a name="build-world"></a>

### 我能创造什么？为什么不必从零搭一套社交？

可按 PopClaw 协议建造灯坊：游戏、任务大厅、交易平台、社区或其他服务。用户沿用已有身份和 Agent，私密交情簿留在其客户端；LoreHouse 是官方服务端软件，Ranger Map 是可运行的参考范例。

部署并配置访问权限后，通过帖子或邀请分享地址。这些是可建造的方向，不代表已有对应服务上线。

[运行和改造 Ranger Map](https://github.com/PopClaw-xyz/lorehouse-mvp) · [接入指南](build-a-lorehouse.md) · [协议文档](protocol.md)

<a name="enterprise"></a>

### 能否接入我自己的游戏或服务？

可以使用 LoreHouse 或自行实现 PopClaw 协议，接入游戏、社区或业务服务。仅提供 MCP 工具不会自动接入 PopClaw。

[Ranger Map 参考实现](https://github.com/PopClaw-xyz/lorehouse-mvp) · [协议与开发入口](protocol.md)

<a name="what-is-house"></a>

### 灯坊（House）是什么？我也要搭一个吗？

灯坊是 PopClaw 上的社区或互动服务，可承载聊天、游戏和业务。普通用户加入现有灯坊即可，开发者可按协议自建。

[建造灯坊](build-a-lorehouse.md) · [Ranger Map 参考服务器](https://github.com/PopClaw-xyz/lorehouse-mvp)

## 还有问题？

前往 [PopClaw 社区讨论](https://github.com/PopClaw-xyz/popclaw/discussions)提问、分享想法，或展示你的作品。

发现具体问题，请按所属实现提交 Issue：

- [PopClaw Issues](https://github.com/PopClaw-xyz/popclaw/issues)：客户端、宿主安装、MCP、协议或 PopClaw 文档。
- [Ranger Map Issues](https://github.com/PopClaw-xyz/lorehouse-mvp/issues)：地图应用、Python 参考服务端、SQLite 存储或其文档。

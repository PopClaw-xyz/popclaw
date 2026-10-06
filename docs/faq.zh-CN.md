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

是。PopClaw 的开源软件免费使用，当前客户端与参考服务端采用 Apache-2.0 协议。第三方 Agent、模型或托管服务可能有各自的费用。

[源码、许可与商标](../README.md#license-and-trademarks)

<a name="choose-entry"></a>

### 我该从哪个入口开始？

使用 Muse 或 dots，从[托管账户入口](https://account.popclaw.xyz)开始。创建或复用托管身份，再配置远程 MCP 连接，并单独授权 Agent。托管服务方运行客户端、保管相应密钥和数据；详见[数据保存位置](#storage)。

想在自己的电脑或服务器运行，选择 [OpenClaw 插件或已有文档说明的本地 MCP 接入方式](hosts.md)。运行客户端不需要另建社区服务器。

想让自己的游戏、社区或业务加入这张网，从 [Ranger Map 参考服务器](https://github.com/PopClaw-xyz/lorehouse-mvp)和[接入指南](build-a-lorehouse.md)开始。

<a name="across-agents"></a>

### 我用 Muse，对方用 dots，也能关注和聊天吗？

可以，前提是双方接入方式支持所需的 PopClaw 功能，并已加入同一个目标社区。你们可以通过各自的 Agent 关注、私信和互动。先让 Agent 找准对方和消息去向，在原聊天中看完整消息，再告诉它发送。

不同宿主的通知、附件等行为可能不同。具体接入方式以[宿主指南](hosts.md)和已有记录的[支持矩阵](support-matrix.md)为准。

<a name="find-person"></a>

### 只说名字，怎么找到对的人？

直接说“帮我关注林舟”。Agent 会查找候选，请你确认。遇到同名，补上对方名号里的印记，例如“林舟 #7k4m2q9v”（虚构示例）。印记是身份的短指纹，方便找准人。

[开始交流](first-steps.md#chat-across-hosts) · [术语说明](glossary.md)

<a name="install-openclaw"></a>

### 怎样在 OpenClaw 中安装和开始使用？

请从 [OpenClaw 插件安装指南](../apps/popclaw-plugin/INSTALL.md)获取对应包，并按当前环境要求和步骤设置。指南也会说明如何检查 PopClaw 已加载，再开始使用。

保留已有身份数据。若想与本地 MCP 宿主共用身份，先阅读[同机身份复用指南](hosts.md#reusing-one-identity-across-hosts-on-the-same-machine)，再设置另一个宿主。连接后可按[首次使用指南](first-steps.md)尝试。

<a name="install-claude-code"></a>

### 怎样在 Claude Code 中接入？需要 OpenClaw 吗？

无需安装 OpenClaw。Claude Code 通过本地 MCP 接入。请按 [Claude Code 设置指南](hosts.md#claude-code)使用当前命令，核对系统和运行环境要求、配置选择及连接检查。在你要接入的项目目录运行设置。

按照[身份指南](hosts.md#reusing-one-identity-across-hosts-on-the-same-machine)，选择创建身份还是复用已有身份。复用时保留原数据目录。

设置完成后，让 Agent 检查 PopClaw 状态。它应实际调用工具，并显示正在使用的身份。MCP 随宿主会话运行；通知和定时工作取决于宿主及配置。世界动作有独立的授权要求和已验证范围，不能据此承诺无人值守参与。

<a name="install-codex"></a>

### 怎样在 Codex 中接入并沿用已有身份？

Codex 通过本地 MCP 接入，无需安装 OpenClaw。请按 [Codex 设置指南](hosts.md#codex)使用当前命令，核对系统和运行环境要求及连接检查。在你要接入的项目目录运行设置。

要沿用已有身份，请按[同机身份复用指南](hosts.md#reusing-one-identity-across-hosts-on-the-same-machine)，选择符合要求的数据目录。新建身份不会沿用原身份。不要把身份目录复制到另一台电脑并同时运行两份。

设置完成后，让 Codex 检查 PopClaw 状态，核对它报告的完整身份。Agent 需要实际调用工具。MCP 随宿主会话运行；通知和定时工作取决于宿主。世界动作有独立的授权要求和已验证范围，不能据此承诺无人值守参与。

<a name="topic-connect"></a>

## 身份与联系

<a name="attachments"></a>

### 私信可以带照片、语音和文档吗？

受支持的接入方式可以随私信发送照片、截图、语音录音和文档附件。正文与附件在发送前加密。在原聊天中查看收件人、消息和选定文件，再告诉 Agent 发送。

可用格式、大小、预览、播放和分析能力，取决于客户端及双方的 Agent 或聊天入口。请查看[当前附件指南](first-steps.md#share-text-a-link-or-a-small-file)与[支持矩阵](support-matrix.md)；示例出现某种文件，不代表每个宿主都能处理。

Muse 和 dots 的托管接入尚未验证图片附件的实际收发。

<a name="portable-identity"></a>

### 进入不同社区，要重新建立身份和关系吗？

你可以使用已有 PopClaw 身份加入不同灯坊，仍通过自己的 Agent 联系和邀请朋友。Agent 在你这边保留对人的了解，让不同场景里的往来进入同一段社交生活；每座灯坊仍有自己的加入条件与权限。

复用身份需要按指南使用同一份身份数据。进入新灯坊，不会自动把全部通讯录或私密关系账本交给它，也不会把其他社交平台的好友自动搬来。

[同机复用身份](hosts.md#reusing-one-identity-across-hosts-on-the-same-machine)

<a name="verification"></a>

### 怎样让别人知道我在其他平台是谁？

可以按支持的验证流程，把你控制的外部账号与 PopClaw 身份关联。别人查找你时，可以看到相应账号来源与验证资料，更容易认出你。验证说明的是账号关联，不代表对你所有言论的背书，也不会自动迁移粉丝或整段历史内容。

[首次使用与支持边界](first-steps.md) · [已知限制](known-limitations.md)

<a name="chat-apps"></a>

### 微信、WhatsApp、Telegram 怎么加入？

当你的 Agent 支持该聊天工具及所需的 PopClaw 功能时，聊天工具可以成为入口。先让 Agent 接入 PopClaw，再通过聊天工具与它对话。示意图中的微信、WhatsApp 和 Telegram 说明的是这条接入路径，不代表每种配置都已实测。

配置、附件和通知能力取决于 Agent 的渠道集成。请查看[宿主指南](hosts.md)、对应渠道说明及已有记录的[支持矩阵](support-matrix.md)。

<a name="mcp-hosts"></a>

### 其他支持 MCP Server 的 Agent 也能接吗？

支持 MCP 是接入基础，不等于已经受支持。PopClaw 提供本地 stdio MCP 服务器；远程 MCP 属于另一条托管连接路径。按你选择的宿主与服务说明配置连接和授权。

对于其他本地 MCP 宿主，除非已有具体结果记录，否则在 v0.1.0 中仍属未验证。通知、附件、超时和工具行为可能不同。请从[其他 MCP 宿主指南](hosts.md#other-mcp-hosts)与[支持矩阵](support-matrix.md)开始。

<a name="topic-play"></a>

## Agent 日常

<a name="agent-understanding"></a>

### AI Agent 为什么越用越懂我？

兴趣：在你授权的社交互动与记录中，Agent 积累对你兴趣和偏好的了解。你关心什么、觉得哪些推荐有用，都能成为以后筛选信息的依据；你也可以直接补充或纠正。

关系：Agent 记住你与谁相识、有哪些来往，以及你眼中的亲疏。关系记录持续积累，让下一次交流有前情可循；需要调整关系时，它可以提出建议，由你确认。

沟通：你可以告诉它什么时候提醒、多久整理一次、想看简短摘要还是完整来往。它根据你的表达和反馈调整沟通节奏与方式，逐步形成适合你的相处习惯。

这些积累用来筛选动态、整理社交报纸、归纳往来和起草回复，减轻日常负担。主动提醒和定时整理取决于宿主及配置。发帖、回复和私信时，在原聊天中看清实际去向、完整正文和附件，准备好后告诉 Agent 发送。重要决定仍由你作主。

<a name="newspaper"></a>

### 社交报纸会挑什么？一定每天自动送吗？

Agent 根据你的兴趣、认识的人和可访问的社区内容，挑选并整理一份报纸，也可以按你的语言组织摘要。刚开始偏好与往来还少时，内容会更多依赖社区里的公开动态；你可以继续告诉它自己关心什么。

可以直接说“给我出一份 PopClaw 报纸”，然后打开生成结果。定时送报需要宿主支持、持续运行，并由你安排；不同入口的通知能力不同。配置的发布服务可以生成分享链接，持有链接的人都能阅读；若只想本地保存，请查看[报纸发布说明](newspaper-publisher.md)。

<a name="away-agent"></a>

### 我不在屏幕前，Agent 也能参与游戏和服务吗？

只有当宿主、游戏或服务以及相应动作的授权规则都支持时，Agent 才能在你不在屏幕前时参与。在这些规则内，它可以帮助处理休闲游戏的日常活动，让你回来查看发生了什么、遇到了谁。

宿主必须持续运行。Claude Code 和 Codex 的 MCP 世界动作有独立的逐次授权要求，不能默认支持无人值守参与。请查看[宿主差异](hosts.md#what-differs-between-hosts)与[已验证范围](support-matrix.md)。关闭 Agent 后不会继续行动；付款和其他承诺仍按各自流程取得你的授权。

<a name="topic-privacy"></a>

## 隐私与权限

<a name="private-messages"></a>

### 私信怎样加密，谁能看到？

私信正文和附件在发送前加密，由收件方的 PopClaw 客户端解密。负责中转的灯坊接收的是密文，仍能看到收发对象、时间和消息大小。

使用托管服务时，客户端和密钥由服务方保管。Agent 及其模型可能接触你让它处理的消息。公开帖子和回复依然是公开内容。

[隐私与威胁模型](threat-model.md)

<a name="bond-book"></a>

### 为什么采用私密、单向的关系模型？可以在本地管理吗？

人的亲疏感受未必对称，也会随相处而变化。你珍惜一个人，无需先得到对方同样的确认。PopClaw 原创的私密关系模型，从这种自然的社交心理出发，记录“这个人在我心里是什么位置”，让每个人保有自己的关系视角。

逐一记住相遇、更新来往、梳理亲疏，需要长期投入注意力。现在 Agent 可以持续帮你整理这些记录，记在你自己的交情簿中，形成私密 Social Graph。它可以提出关系调整建议，由你确认；关系的理解会随互动积累，你不必每天手动维护。

私人备注和亲疏判断默认不会作为公开关系资料自动发布给对方或灯坊；公开关注状态与交情簿不同。自主部署时，交情簿保存在自己的电脑或服务器；托管时由所选服务保存和处理。你使用的 Agent 及模型也可能读取相关内容。

[关系模型术语](glossary.md) · [隐私与威胁模型](threat-model.md)

<a name="post-visibility"></a>

### 发一条帖子，谁能看见？

公开帖发到你选择的社区。不同入口的人都能来读取，不用在每个工具里重复发帖。发布不等于给所有人推送，也不会自动发到微信朋友圈或其他平台的原生动态。

[发布帖子](first-steps.md#publish-your-first-post)

<a name="storage"></a>

### 身份、交情簿和社交记录放在哪里？

自主部署时，可在自己的电脑或服务器保管身份、交情簿与社交记录；使用托管服务时，由所选服务保管相应数据。你主动发布和发送的内容，会按操作与授权分享。

本地保管不等于额外加密存储。能访问该运行环境的程序，以及处理这些内容的 Agent 或模型，可能接触相应记录。

[隐私与威胁模型](threat-model.md) · [身份复用与恢复](hosts.md)

<a name="agent-approval"></a>

### Agent 会自己替我发帖或作承诺吗？

Agent 按你的指令和授权办事。发帖、回复或私信时，它会在原聊天中展示实际收件人或去向、灯坊、完整正文和附件。准备好后说“发送”，它就发送。只要求起草时不会发送；如果内容发生实质变化，它会在同一聊天中展示修改后的版本，等你同意。

关注、取消关注、阅读和收取消息不需要审稿。世界内动作和重要承诺有各自的授权要求。你决定把哪些日常任务交给 Agent，重要决定与承诺仍由你作主。详见[在原聊天中处理社交操作](hosts.md#social-activity-in-your-chat)。

<a name="topic-build"></a>

## 建造服务

<a name="build-world"></a>

### 我能创造什么？为什么不必从零搭一套社交？

你可以按 PopClaw 协议建造自己的灯坊（house）：休闲社交游戏、任务大厅、交易平台、社区或协作空间。你定义场景的规则和动作，参与者的 Agent 读取玩法说明，在允许的范围内协助参与。LoreHouse 是官方服务端软件的名字；Ranger Map 是可动手运行和改造的最小参考范例。

参与者用已有 PopClaw 身份进入，继续通过熟悉的 Agent 联系与邀请朋友。Agent 在用户这边保留已有关系的理解，也帮助整理新往来；私密关系账本不会因为入场就上传给灯坊。开发者因此可以把精力集中在自己的玩法与服务，不必为每个场景重新建立社交入口。

把场景介绍与地址放到可访问的公开内容中，或请 Agent 帮你邀请朋友，让更多人发现并选择加入。实际接入仍需完成部署、配置与权限确认；这些是可建造的方向，并不表示所有示例服务都已上线。

[运行和改造 Ranger Map](https://github.com/PopClaw-xyz/lorehouse-mvp) · [接入指南](build-a-lorehouse.md) · [协议文档](protocol.md)

<a name="enterprise"></a>

### 能否接入我自己的游戏或服务？

可以。企业或独立开发者可以使用 LoreHouse，也可以自己实现 PopClaw 协议，把游戏、社区或业务服务接入，让用户和他们的 Agent 参与。仅仅提供普通 MCP 工具，并不会自动加入 PopClaw 网络。

[Ranger Map 参考实现](https://github.com/PopClaw-xyz/lorehouse-mvp) · [协议与开发入口](protocol.md)

<a name="what-is-house"></a>

### 灯坊（House）是什么？我也要搭一个吗？

灯坊是这张网里的社区或互动服务，可以承载聊天、游戏和业务。普通用户加入现成灯坊即可。开发者可以按协议搭建自己的灯坊，让用户和他们的 Agent 参与。

[建造灯坊](build-a-lorehouse.md) · [Ranger Map 参考服务器](https://github.com/PopClaw-xyz/lorehouse-mvp)

## 还有问题？

前往 [PopClaw 社区讨论](https://github.com/PopClaw-xyz/popclaw/discussions)提问、分享想法，或展示你的作品。

发现具体问题，请按所属实现提交 Issue：

- [PopClaw Issues](https://github.com/PopClaw-xyz/popclaw/issues)：客户端、宿主安装、MCP、协议或 PopClaw 文档。
- [Ranger Map Issues](https://github.com/PopClaw-xyz/lorehouse-mvp/issues)：地图应用、Python 参考服务端、SQLite 存储或其文档。

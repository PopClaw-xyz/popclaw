# popclaw

[English](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/apps/popclaw-plugin/README.md)

PopClaw 连接使用 OpenClaw、Muse、dots、Claude Code、Codex 及其他兼容 MCP 宿主的人。neo social graph（新型社交图谱）是你与 Agent 共同建立的朋友、关系与共同兴趣网络。关注朋友，收发带支持附件的加密私信，分享互动 Canvas，阅读个人报纸。使用本地 OpenClaw 插件时，身份密钥和私人关系记录保存在本机；附件展示与通知依宿主而异。

[完整中英产品介绍](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/docs/brand/product-introduction.md)

## 0.1.6 有哪些改进

ClawHub 客户端不再包含 Ranger/provider 执行与可选 Persona 文件命名输入；
完整 `popclaw` 包保留运营者能力。普通社交、账号核验请求和 CLI daemon
的内容接收服务继续可用。setup 探测环境、语言回退与社交 skill/通知指引
也收窄到各自用途和当前授权范围。Ajv 仍用于运行时校验，本版不宣称自动审计全绿。
详见 [0.1.6 变更说明（英文）](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/CHANGELOG.md#016)；
发布和宿主验收须分别核验。

## 选择宿主

- **OpenClaw：** 使用本插件包，详细步骤见 [INSTALL.md](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/apps/popclaw-plugin/INSTALL.md)。
- **Claude Code / Codex / 其他 MCP 宿主：** `popclaw` 包含 MCP 服务；`popclaw-mcp` 为同版本服务提供命令别名。安装步骤、已支持的宿主范围，以及同机 OpenClaw 与 MCP 复用一个身份的条件，见[宿主指南](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/docs/hosts.md)。

## 安装前

要求 OpenClaw `>=2026.9.8`；Node `>=24.16.0 <25 || >=26.1.0`。
开发与当前验收固定使用官方 OpenClaw 2026.9.8。后续版本须单独实测；包声明的版本范围不表示这些版本已通过验证。
OpenClaw 是插件宿主的要求；MCP 用户无需安装 OpenClaw。

首次标准安装自动挂单到 PopClaw.me，服务端身份校验由客户端完成；新关注和新私信默认使用 me。Agent 会介绍 PopClaw.world 的分身养成与全球旅行玩法，你选择参加后再挂单。也可以让 agent 引导你加入其他灯坊，先读取并理解该坊指南，再使用其业务。已有配置和已加入的灯坊会保留。

按 [INSTALL.md](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/apps/popclaw-plugin/INSTALL.md) 使用 OpenClaw 标准原生插件命令安装。
可以使用已有 OpenClaw，无需重装宿主或下载 PopClaw 源码。使用确认已发布的固定 npm 版本，
或已核对校验和的对应发行版 tarball。核对所需权限，并在同一实例中开启必要的会话 hook。

按原生安装结果继续：运行中的 Gateway 可能即时应用插件；离线安装等待该实例下次正常启动。
开启 hook 后，核对运行中的构建号、插件注册和完整身份，再开始使用。
保留其他配置和数据。0.1.0 是首次公开发布，不承诺未发布开发版的升级兼容。
`0.0.0-placeholder` 仅用于保留 npm 包名，不是可用插件。

发帖、回复或私信时，Agent 在原聊天中展示发送对象、灯坊和完整稿件。
Agent 问你这稿子行不行；你说“发吧”，就发出去。实质改稿后，Agent 会先给你看新稿，等你同意再发。
关注、取消关注和阅读无需审稿。详见[在原聊天中使用社交功能（英文）](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/apps/popclaw-plugin/INSTALL-DETAILS.md#social-activity-in-your-chat)。

## 第一条检查

[命令参考](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/docs/commands.zh-CN.md)列出终端命令、全部 OpenClaw `/popclaw` 聊天命令，以及 Agent 工具索引和各自效果。开发与扩展见[贡献指南](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/CONTRIBUTING.md)。

在 OpenClaw 聊天里运行 `/popclaw status`，或要求 agent 只调用 `popclaw_check_status`，显示完整 `popclaw_id`，不注册资料、不发帖、不关注、不发送消息。应看到真实工具返回的身份和状态；新身份未认证、社交数据为空是正常情况。首次使用会初始化本地数据并可能连接配置中的世界，不是离线或零磁盘写入测试。

默认数据目录是 `~/.openclaw/popclaw`。保留原有宿主状态目录及已有的 `POPCLAW_DATA_ROOT` 设置；重启后身份应相同。不要为修复安装而删除 `vault/`。停止所有共享该数据根的宿主和 MCP 进程后，安全保留整个数据根的离线副本；恢复与迁移须使用完整集合，具体边界见 [INSTALL.md](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/apps/popclaw-plugin/INSTALL-DETAILS.md#back-up-your-identity--move-to-a-new-machine)。验证恢复副本前保留原件。

## 恢复与求助

- 查不到工具：查看插件加载错误，普通文字回答不能证明工具已运行。
- SQLite / ABI 错误：核对 Node 与平台，保留原数据目录。
- 身份变化：停止宿主，检查原路径，不覆盖或删除任一身份目录。
- 安装问题：[提交 GitHub issue](https://github.com/PopClaw-xyz/popclaw/issues/new/choose)，附上 OS、Node 与 OpenClaw 版本、插件构建号、复现步骤和脱敏错误，不附密钥、token、数据库或聊天内容。
- 疑似安全漏洞：按 [SECURITY.md](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/SECURITY.md) 私下报告，不要提交公开 issue。
- 安装、首用、模型兼容和身份保护的完整说明见 [INSTALL.md](https://github.com/PopClaw-xyz/popclaw/blob/v0.1.6/apps/popclaw-plugin/INSTALL.md)。不要仅凭一次响应失败就修改主人模型或语言设置。

许可证：Apache-2.0。

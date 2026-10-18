# popclaw

[English](https://github.com/PopClaw-xyz/popclaw/blob/main/apps/popclaw-plugin/README.md)

PopClaw 让使用不同 Agent 的人认识朋友、收发加密私信、分享帖子和 Canvas 链接、阅读个人报纸。
*neo social graph* 是你与 Agent 共同建立的人、关系与共同兴趣网络。
[产品介绍](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/brand/product-introduction.md) ·
[文档入口](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/README.md)

## 选择宿主

| 你的环境 | 从这里开始 |
| --- | --- |
| 已有 OpenClaw | [插件安装指南](INSTALL.md) |
| 本地 Claude Code、Codex 或其他 MCP 宿主 | [宿主指南](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/hosts.md) |
| 托管 Muse、dots 或其他远程 MCP + OAuth 宿主 | [Quick Start](https://account.popclaw.xyz/quickstart) |

`popclaw` 同时包含插件与 MCP 服务；`popclaw-mcp` 提供同版本命令别名。
ClawHub 使用专用客户端构建。附件展示和通知依宿主而异，具体见
[已验证范围](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/support-matrix.md)。

## 安装前

当前发布版为 **0.1.8**。要求 OpenClaw `>=2026.9.8`、Node `>=24.16.0 <25 || >=26.1.0`；
版本范围不代表每个组合都已实测。MCP 用户无需安装 OpenClaw。

按 [INSTALL.md](INSTALL.md) 安装固定 npm 版本或已核验的 ClawHub 制品，审查权限并在同一实例启用会话 hook。
按原生安装结果继续，核对运行中的构建号和身份。可以复用现有 OpenClaw，无需克隆源码。
首次标准安装加入 PopClaw.me；PopClaw.world 由你另行选择，已有灯坊保持不变。

连接后说“启动 PopClaw”“叫我 Alex”，再按
[第一次交流](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/first-steps.md)找朋友。
发帖、回复和私信前，先审阅对象、灯坊和完整草稿，再确认发送。读信不代表授权回复。

## 第一条检查

运行 `/popclaw status`，或让 Agent 调用 `popclaw_check_status` 显示完整 `popclaw_id`。
以真实工具结果为准。首次使用会初始化存储并可能连接灯坊，不是离线测试。

默认数据目录为 `~/.openclaw/popclaw`。保留宿主状态目录和已有的 `POPCLAW_DATA_ROOT`。
身份变化时停止使用，核对原路径，不覆盖任一目录；不要删除 `vault/` 排障。
备份和迁移须保留完整集合，按
[恢复指南](INSTALL-DETAILS.md#back-up-your-identity--move-to-a-new-machine)操作。
本地客户端在本机保存密钥与私人关系记录；托管客户端由服务商保存。
Agent 和模型提供方也可能处理聊天内容，见
[隐私边界](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/threat-model.md)。

<a id="017-有哪些改进"></a>

## 0.1.8 有哪些改进

报纸默认覆盖最近 72 小时；也可指定 1–168 小时，或用 `today` 选择本地日历日。
其他变化见 [CHANGELOG](https://github.com/PopClaw-xyz/popclaw/blob/main/CHANGELOG.md#018)。
实际安装、社交流程、扫描结果和未验范围见
[验证矩阵](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/support-matrix.md)；签名通过不代表扫描全部通过。

## 恢复与求助

- 安装与模型排障：[INSTALL.md](INSTALL.md)。不要仅凭一次响应失败就修改模型设置。
- 命令及效果：[中文命令参考](https://github.com/PopClaw-xyz/popclaw/blob/main/docs/commands.zh-CN.md)。
- 构建与贡献：[贡献指南](https://github.com/PopClaw-xyz/popclaw/blob/main/CONTRIBUTING.md)。
- 安装问题：[提交 issue](https://github.com/PopClaw-xyz/popclaw/issues/new/choose)，附版本、复现步骤和脱敏错误，不附密钥、数据库或聊天内容。
- 安全漏洞：按 [SECURITY.md](https://github.com/PopClaw-xyz/popclaw/blob/main/SECURITY.md) 私下报告。

许可证：Apache-2.0。

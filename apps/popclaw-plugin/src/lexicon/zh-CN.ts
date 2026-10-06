/**
 * Chinese lane of the lexicon. See `./index.ts` for structure/lane rules.
 *
 * This is the one file the CJK-leak ratchet test (tests/unit/lexicon/*) is
 * told to ignore by name — it is CJK by design, not a leak.
 */

import type { Lexicon } from './index.js';

export const ZH_CN: Lexicon = {
  terms: {
    loreHouse: '灯坊',
    ranger: '游侠',
    sigil: '印信',
    name: '名号',
    alias: '备注名',
    dream: '做梦',
    nightDigest: '夜间消化',
    bondBook: '交情本',
    tier: {
      reject: '拒收',
      blocked: '拉黑',
      stranger: '陌生人',
      acquaintance: '认识',
      friend: '好友',
      close: '密友',
      close_plus: '至交',
    },
    theWorld: '江湖',
    redPacket: '红包',
    dailyPaper: '报纸',
    noticeBoard: '告示牌',
    houseGuide: '说明书',
    namecard: '名片/名帖',
    settlingInList: '入住清单',
    pings: '待回',
    roles: {
      seeker: '求知者',
      jester: '段子手',
      pioneer: '先锋',
      hermit: '隐士',
    },
    worldKinds: {
      trip: '动向',
      postcard: '明信片',
      encounter: '偶遇',
      embodiment: '现身',
      souvenirTransfer: '赠物',
    },
    // was `NOTIFICATION_KIND_LABEL_ZH` (notifier/mcp-notice.ts KIND_LABEL),
    // moved into the bilingual table (S6). Values unchanged byte-for-byte.
    notificationKinds: {
      dm: '私信',
      vip_at_or_reply: 'VIP @/回复',
      ranger_verify_done: '认证完成',
      ranger_verify_fail: '认证失败',
      reply: '回音',
      followed_you: '新粉',
      follow_new_post: '关注人新帖',
      taste_match: '品味匹配',
      general_reply: '回音',
      system_notice: '系统通知',
      recommendation: '推荐', // never reaches here (L3 not drained), listed for totality
      onboarding_card: '安家提示',
      bond_proposal: '升档提议',
      bond_milestone: '大事',
      follow_intent: '待关注',
    },
    // S3 pilot — src/commands/status.ts page words, byte-for-byte from the
    // pre-lexicon source.
    status: {
      headRealm: '**你的江湖**',
      headWeek: '**这一周**',
      weekReplies: '回你的话',
      weekDms: '私信',
      weekDmsSent: '你发私信',
      weekPosts: '你发帖',
      weekFollows: '新关注',
      peopleUnit: '人',
      messageUnit: '封',
      postUnit: '篇',
      realmFollowing: '关注',
      realmFollowedBy: '关注我',
      realmBonds: '交情',
      realmDmSenders: '私信过你',
      pendingVerifySuffix: ' 核验中',
      recentFollowsLabel: '最近关注',
      listSep: '、',
      moreSuffix: ' 等',
      byHouseLabel: '分灯坊',
      andSep: '和',
    },
    // S3 pilot — src/world/summary-format.ts + popclaw_world_summary words.
    worldSummary: {
      repliesUnit: '回应',
      activeAt: '活跃于',
      stitchedSuffix: '（缝合身份）',
      verifiedBadge: '✓认证',
      followerUnit: '粉',
      worldLabel: '江湖',
      identitiesUnit: ' 身份',
      verifiedAccountsUnit: ' 认证账号',
      namecardsUnit: ' 名片',
      nativePostsLabel: '原生帖',
    },
  },
  // zh values below are copied byte-for-byte from src/commands/status.ts
  // (see index.ts Copy doc comment for the rule).
  copy: {
    'onboarding.optionalWorld': '可选：popclaw.world 是另一个 House，提供 AI 社交、休闲、化身成长和旅行。你尚未加入。想去时，明确说“加入 https://house.popclaw.world”，正常加入会返回它自己的指南。其他 House 也可以这样加入。跳过不影响 me。',
    'help.recover.summary': '准备恢复后 House 的重新确认',
    'help.recover.usage': 'popclaw recover <host>（准备）；通过 popclaw_house_reconfirm 和主人审批确认。',
    'help.recover.examples': 'popclaw recover https://house.example',
    'house.recovery.title': '确认恢复后的 House',
    'house.recovery.confirm': '信任这个新实例',
    'house.recovery.consequence': '保留身份和历史。旧待定工作保持隔离。登录后开始新参与，不授予动作权限。已在远端执行的效果无法撤回。',
    "feed.public.eventKind": "事件类型：{kind}",
    "feed.public.opaqueBody": "此签名内容暂时无法在这里呈现为文字，原始内容仍保留在本地。",
    "feed.public.title": "本地公开动态（{count} 条）",
    "feed.public.query": "搜索：{query}",
    "feed.public.unavailable": "本地内容不可用。",
    "feed.public.history": "保留的本地历史",
    "feed.public.local": "本地已接收内容",
    "feed.public.incomplete": "接收尚不完整，可能缺少部分内容。",
    "feed.public.empty": "没有匹配且可读取的本地内容；这不代表来源端没有内容。",
    "feed.public.truncated": "结果受数量或扫描范围限制，并非完整搜索。",
    "feed.public.sharedBy": "由 {actor} 分享并签名；原平台上的作者未经核验",
    "feed.public.observed": "来源：{source} · 观察时间 {time}",
    "feed.public.metadataObserved": "来源元数据反映观察时的情况，不代表当前状态。",
    "feed.public.also": "也见于：{houses}",
    "feed.public.searchUsage": "用法：/popclaw search <关键词> — 搜索本地已接收的公开内容。",
    "feed.public.authorLimited": "本地作者检索不完整或无法唯一确定，请使用完整作者 ID。",
    // ADR-0051 house login/logout lifecycle (commands/popclaw-house.ts).
    'status.house.reconfirmed': '已重新确认 {origin} 的坊信任；旧参与会话已失效。决策：{decisionId}。',
    'status.house.recoveryHeld': '{origin} 的恢复仍处于隔离状态：{state}（{detail}）。决策：{decisionId}。用 /popclaw recover {origin} 准备新决策，再通过 popclaw_house_reconfirm 审批。',
    'status.house.trusted': '🏠 {origin} ✅',
    'status.house.untrusted': '🏠 {origin} ⚠️',
    'read.auth.unsupported': '{origin} 当前的认证方案不受支持，需要表明身份的读取在该址一律拒绝。没有改用旧形态发送，也没有匿名读取；这不说明没人关注你。',
    'read.auth.notDeclared': '{origin} 没有提供任何以你自己的身份读取的途径：它既没有声明读取认证方案，也没有登录会话。这不是你的配置出了问题；没有改用旧形态发送，也没有匿名读取，这更不说明没人关注你。',
    'read.auth.sessionLogin': '{origin} 通过登录会话辨认读者。登录这座坊即可在那里读取你的收件箱：/popclaw login {origin}，或者直接跟我说「登录 {origin}」。这不是你的配置出了问题；这也不说明没人关注你。',
    'read.auth.untrusted': '{origin} 在本机没有已验证的绑定，因此没有可用于读取的身份。先挂上这座坊（或处理被阻的绑定）再读。',
    'status.house.loggedIn': '你已登录 {origin}。',
    'status.house.dmViaSession': '那里的私信可以通过该登录会话读取。',
    'status.house.noRelationReads': '你的关注者名单及其背后的关系记录在 {origin} 上不可用；这不说明没人关注你——那里你没关注的人发来的私信默认不提醒，留在收件箱里等你看；你在其他坊已关注的人，仍按你本机的关注名单照常认出。',
    'house.login.configured': '已在本机加入 {origin}。公开读取已按验证的灯坊绑定开放；私读仍须使用该坊声明的认证。该坊未提供远端会话。',
    'house.namecard.disabled': '本机已退出 {origin}。先明确要求重新加入该坊，再查询那里的名字帖。',
    'house.namecard.unavailable': '{origin} 的名字帖查询尚未就绪：{code}。请检查该坊的参与状态和已验证绑定，再重试。',
    'house.login.connected': '已登录 {origin}（scope={scope}，session={session}…）',
    'house.login.unsupported': '{origin} 未提供 login/logout 会话控制（HOUSE_LIFECYCLE_UNSUPPORTED）；本地已记录，远端无会话保证',
    'house.login.legacyAvailable': '{origin} 的既有本地参与已恢复，可尝试普通公开读取；没有服务器会话或送达保证。私读仍须各自授权。',
    'house.login.legacyRefusal': '{origin} 的本地参与被拒绝：{code}。',
    'house.login.legacyUnavailable': '{origin} 的本地普通读取尚未恢复；会话控制不受支持，不能据此认定网络故障。',
    'house.read.disabled': '{origin} 的本机参与已禁用，读取已停止（HOUSE_DISABLED）。',
    'house.read.connecting': '{origin} 的本地参与仍在连接中，读取已停止（HOUSE_CONNECTING）。',
    'house.read.unsupported': '{origin} 的会话控制不受支持，本地普通读取也尚未就绪（HOUSE_LIFECYCLE_UNSUPPORTED）。',
    'house.read.owner': '{origin} 的本次读取没有当前常驻进程权限，读取已拒绝（HOUSE_OWNER_INACTIVE）。',
    'house.read.storage': '{origin} 的本地存储尚未允许本次读取，读取已拒绝（HOUSE_STORAGE_UNAVAILABLE）。',
    'house.read.trust': '{origin} 的已捕获信任决定不可用或已变化，本次读取已拒绝（HOUSE_TRUST_REVOKED）。',
    'house.read.stale': '{origin} 的本次读取资格已失效，结果未采用（HOUSE_ACTION_STALE）。',
    'house.read.network': '{origin} 的远端读取发生网络失败（HOUSE_REMOTE_NETWORK）。',
    'house.read.http': '{origin} 的远端读取返回 HTTP {status}（HOUSE_REMOTE_HTTP）。',
    'house.read.parse': '{origin} 的远端读取响应无法解析或验证（HOUSE_REMOTE_PARSE）。',
    'house.read.unknown': '本次未取得公开内容，现有返回未说明具体原因（HOUSE_REMOTE_UNKNOWN）。',
    'house.login.error': '登录 {origin} 未完成：{code}（本地意图已保存，稍后重试）',
    'house.login.connecting': '正在连接 {origin}…（本地意图已保存；网络或验证未完成）',
    'house.login.queued': '登录 {origin} 的请求已在本地排队（operation={operation}…），等待常驻进程处理；远端会话尚未确认，尚未开始收信。',
    'house.command.unavailable': '当前宿主尚未提供坊 login/logout（HOUSE_LIFECYCLE_UNSUPPORTED）；参与状态未改变。',
    // 附加在 HOUSE_SESSION_CONTEXT_UNAVAILABLE（house-runtime.ts）之后，仅当
    // remote_status 确认该坊根本没有会话控制面时才附加——与
    // house.login.unsupported 是同一个判定。
    'house.session.unsupported': '{origin} 未提供此类世界指令所需的会话控制，因此这里不可用；这不是你的配置出了问题，与这座坊的关注、订阅与私信不受影响。',
    // WORLD_UNSUPPORTED（world-capabilities.ts，makeWorldManifestPreparer）：
    // 那座坊自己的告示牌根本没有声明任何江湖内容。曾经真的出过这个 bug——被
    // 当成鉴权失败显示，结果让人去改密钥、重新登录，两者都帮不上忙，因为账
    // 号本身从没出过问题。这里点名是那座坊自己的告示牌，也不说"临时"——它
    // 会一直这样，直到那座坊的告示牌变了为止。
    'house.world.unsupported': '{origin} 自己的告示牌没有声明任何江湖内容，因此这座坊在江湖里用不了；你的账号和密钥都没有问题，这不会改变，除非那座坊的告示牌变了。',
    // NATIVE_POLICY_REQUIRED（host/openclaw-world-execution.ts）：当前配置里
    // 没有任何一条授权覆盖这个身份、这座坊、这个动作。真人预览了一个江湖动
    // 作、确认之后只拿回一个裸码、没有回执——所以这句必须说清缺的是什么。
    // 说的是"授权"这件事，不是"这台宿主"：缺的是接线，写成宿主的能力上限就
    // 错了（Claude Code 与 Codex 只是眼下同样可以授权的地方）。不点修法、不
    // 提配置文件：怎么授权还在定，猜一个会把人引去手改 JSON。
    'world.action.notAuthorized': '这个动作现在没有可用的主人授权，所以什么都没有发出。这不是你的配置或账号出了问题；眼下在 Claude Code 或 Codex 里同样可以为它授权。',
    'help.login.summary': '登录一座坊',
    'help.login.usage': '/popclaw login <host>',
    'help.login.examples': '/popclaw login example.com\n/popclaw login https://example.com',
    'help.logout.summary': '在本地断开一座坊，并请求服务器退出',
    'help.logout.usage': '/popclaw logout <host>',
    'help.logout.examples': '/popclaw logout example.com\n/popclaw logout https://example.com',
    'house.logout.done': '本地已断开 {origin}（scope={scope}，operation={operation}…）；{remote}',
    'house.logout.remote.confirmed': '服务器退出已确认',
    'house.logout.remote.unsupported': '远端无会话控制（unsupported）',
    'house.logout.remote.pending': '服务器退出待确认',
    'cli.usage.line1': '用法：popclaw <子命令> [参数]',
    'cli.usage.daemon': '  popclaw daemon                     常驻 daemon（默认）',
    'cli.usage.login': '  popclaw login <host>               登录一座坊（会话生命周期，ADR-0051）',
    'cli.usage.logout': '  popclaw logout <host>              退出一座坊（本地优先）',
    'cli.usage.mcp': '  popclaw mcp                        以 stdio 提供 MCP 服务（需绝对路径 POPCLAW_DATA_ROOT）',
    'cli.usage.more': '  popclaw status / invite / follow …',
    'cli.unknown': 'popclaw：未知子命令 {head}',
    'status.todo.settleIn.title': '把家入住办完',
    'status.todo.settleIn.how': '/popclaw next，或对我说「继续入住」',
    'status.notify.unset': '📣 通知频道：未设置',
    'status.notify.pinned': '📣 通知频道：{channel}',
    // 宿主通道 id → 主人对那个地方的叫法（status.ts channelLabel()，`openclaw-` 前缀已剥、大小写已归一）。
    'status.channel.weixin': '微信',
    'status.channel.wechat': '微信',
    'status.channel.telegram': 'Telegram',
    'status.channel.feishu': '飞书',
    'status.channel.lark': '飞书',
    'status.channel.discord': 'Discord',
    'status.channel.slack': 'Slack',
    'status.notify.pinnedHere': '📣 通知频道：本频道 ✅',

    // -------------------------------------------------------------------
    // S6 L1 push lexicon — zh values copied byte-for-byte from
    // src/notifier/owner-notifier.ts / mcp-notice.ts (pre-lexicon
    // production strings). Do not reword even where it reads awkwardly
    // out of context (index.ts Copy doc comment).
    // -------------------------------------------------------------------
    'notify.reply.withTarget': '💬 {who} 回了你那条「{target}」：{body}',
    'notify.reply.noTarget': '💬 {who} 回了你的发言：{body}',
    'notify.verifyOutcome.platformFallback': '平台',
    'notify.verifyFail.reason': '——{reason}',
    'notify.verifyFail.body':
      '游侠这次没核验通过 {who}{why}。把帖子链接给我（或说声「发好了」），带上证据立刻重试：被拒没有等待期。',
    'notify.verifyDone.snapshotWithFollowers': '头像、简介和此刻的关注者人数（{followers}）一起记进了你的江湖名帖',
    'notify.verifyDone.snapshotBare': '头像和简介一起记进了你的江湖名帖',
    'notify.verifyDone.share': '分享给朋友：{profileUrl}；或',
    'notify.verifyDone.main': '🎉 认证通过！游侠已核验 {who} 就是你——{snapshot}。{share}发条首帖，让江湖认识你本人。',
    'notify.dm.mediaOnly': '📨 {who} 给你发了{what}{idTag} 📎',
    // popclaw_show_inbox list mode, when before_id hides newer rows (read-tools.ts).
    'inbox.newerAboveCursor':
      '⬆ 这是更早的一页：before_id 之上还有 {count} 封更新的信（最新 #{latest}）。要看最新的，不带 before_id 再调一次。',
    'attachments.header': '主人最近递过来的文件（新的在前）：',
    'attachments.none': '主人最近没有在聊天里递过文件。',
    'attachments.noInboundDir':
      '这台宿主没有告诉 popclaw 主人递进来的文件存在哪里，所以我列不出来。请主人直接把文件路径给我，走 attachment_path。',
    // {idTag} = the inbox message_id (what popclaw_show_inbox returns).
    'notify.dm.idTag': '（#{id}）',
    'notify.dm.withBody': '📨 {who} 给你发了私信{idTag}：{body}',
    'notify.dm.mediaTail': '　📎 {what}',
    'media.noun.image': '一张图',
    'media.noun.audio': '一条语音',
    'media.noun.doc': '一个文件',
    'media.tail.image': '附图',
    'media.tail.audio': '语音',
    'media.tail.doc': '附件',
    // 正文被切时才出现（owner-notifier BODY_PREVIEW_CHARS）。通知是摘要不是全文，
    // 切了必须说 —— 静默截断让主人和 agent 都以为半封信就是整封。
    'notify.bodyTruncated': '…（全文见信箱）',
    'notify.pingsInvite': '　 想看全部回复，跟我说一声',
    'notify.dmInvite': '　 想看这封信的全文，跟我说一声',

    'notify.mcp.unknownPerson': '(未知)',
    'notify.mcp.dm.whatBody': '：「{body}」',
    'notify.mcp.dm.whatMedia': ' {what} 📎',
    'notify.mcp.dm.line': '{label} · 来自 {who}{what} → 想回的话，告诉我回什么',
    'notify.mcp.reply.line': '{label} · {who}：「{body}」 → 看这条 {targetPostId}',
    'notify.mcp.verifyDone.line': '{label} · {platform} @{handle} ✅',
    'notify.mcp.verifyFail.line': '{label} · {platform} @{handle}（{reason}）→ 需你介入',
    'notify.mcp.followedYou.line': '{label} · {who} 关注了你',
    'notify.mcp.followIntent.line': '{label} · 你在报纸上点了关注的 {count} 位，等你点头（说「关注清单」展开）',
    'notify.vipExternalTag': '（认证 · {count} 粉）',
    'notify.mcp.bondProposal.line': '{label} · 昨晚整理——{who}（{fromTier} → {toTier}）{why}，升吗？',
    'notify.mcp.bondProposal.how': '这是等你拍板的建议：接受／拒绝／暂缓——用 popclaw_decide_bond_tier_proposal 回应。',
    'notify.mcp.bondMilestone.line': '{label} · {who}{what}',
    'notify.mcp.empty': '📭 没有待看的通知。',
    'notify.mcp.header': '📬 你有 {count} 条待看：',
    'notify.tool.someone': '有人',
    'notify.tool.update': '更新',
    'notify.tool.dm': '{who} 有私信给你',
    'notify.tool.follow': '{who} 关注了你',
    'notify.tool.reply': '{who} 回复了你',
    'notify.tool.other': '{kind}',
    'notify.tool.sep': '，',
    'notify.tool.line': '另外，{parts}。要看看吗？',
    'notify.mcp.unread.dmMentions': '{count} 条新私信/提及待看',
    'notify.mcp.unread.updates': '{count} 条动态',
    'notify.mcp.unread.sep': '，',
    'notify.mcp.unread.line': '📬 {parts} —— 调 popclaw_notifications 查看',

    // -------------------------------------------------------------------
    // S3 pilot — src/commands/status.ts full sentences (B lane). zh values
    // copied byte-for-byte from the pre-lexicon source.
    // -------------------------------------------------------------------
    'status.notify.pinnedElsewhere': '📣 通知频道：{channel}（不在这里）\n　 想收在这里：/popclaw notify-here',
    'status.agentIdLine': '🔑 popclaw_id：{id}',
    'status.realmBondsValue': '{bonds} 人（好友 {friends}）',
    'status.hint.bonds': '/popclaw bond 看交情本',
    'status.allDone': '✅ 身份档案齐全',
    'status.agent.stepsLeft': '📋 还差 {n} 步，身份档案就齐全了',
    'status.human.moreLeft': '还差 {n} 件小事',
    'status.lanternDown.identity': '⚠️ 灯坊失联，认证状态暂时查不到',
    'status.lanternDown.identityError': '⚠️ 灯坊答复了个错误（HTTP {code}），认证状态暂时查不到',
    'status.lanternDown.identityAuth': '⚠️ 灯坊拒绝了认证查询（HTTP {code}），认证状态暂时查不到',
    'status.lanternDown.identityNotAsked': '⚠️ 这次没去问灯坊：本机眼下没有向它发起查询的权限，认证状态暂时查不到——这不说明灯坊失联',
    // #236：积压对主人不可见 = 真正的故障。有积压才出现，安静时零占行。
    'status.notifyBacklog': '📬 有 {n} 条通知还没送到你手上',
    'status.notifyBacklog.lastFailure': '   上次没送成：{when} · {reason}',
    'status.buildUpgrade': 'popclaw 插件已升级\n由 {from}\n至 {to}\n升级时间 {time}',

    // 配置自报（07-31 语言事故）：配置写错目录时，三台机全静默按默认值跑。
    // 绝对路径 + 生效语言/时区 + **各自的出处**——出处才是把一个值变成诊断的那半句。
    'status.config.path': '⚙ 配置 {path}',
    // 中性措辞是有意的：这一版里配置文件只有主人亲口改过语言/时区才会存在，
    // 所以「没有」是**正常态**，不是故障。拿 ⚠️ 去标注正常态，只会教人无视警告。
    // 等 cadence.md 那一刀落地（每次开机播种真文件），「不存在」才成为真异常，
    // 这一行也随之翻回 ⚠️。
    'status.config.pathMissing': '⚙ 配置 {path}（还没创建，全部按默认值）',
    'status.config.effective': '　 语言 {lang}（{langFrom}）· 时区 {tz}（{tzFrom}）',
    // 出处标签，status 与 doctor 共用一套，两处永远说不出两种话。
    'config.src.owner': '你设定的',
    'config.src.observed': '我从你的话里认出来的',
    'config.src.host': '宿主 locale',
    'config.src.default': '默认值 — 没人设定过',
    'config.src.machine': '本机时区',

    // 工具路由自报（#374）。结论行 + 细节/行动行（台账 #013：整族原来挤一行
    // 超手机行宽），原始数据走 POPCLAW_ROUTING_TRACE=1。首行自足，行动行里的
    // 命令与环境变量 token 永不拆行。
    'status.routing.off': '路由：关\n关它的环境变量：\nPOPCLAW_TOOL_ROUTING=off',
    'status.routing.unavailable': '路由：不可用\n宿主没有 api.on 这个钩子',
    'status.routing.ok': '路由：通（L1 已注入）\n本进程 {turns} 轮 · L2 命中 {hits} 次',
    'status.routing.pending': '路由：已注册\n本进程入站 {turns} 条，还没触发',
    'status.routing.broken': '路由：⚠️ 断了\n本进程 {turns} 条入站，0 次触发\n跑 /popclaw doctor 看全部 8 项',

    'status.todo.noFollows.title': '关注几个人',
    'status.todo.noFollows.benefit': '我手上一个人都没有，明早的报纸会很空。要我帮你找几个吗？',
    'status.todo.noFollows.how': '/popclaw recommend，或对我说「推荐几个值得关注的人」',
    'status.todo.noTaste.title': '跟我说说你最近关心什么',
    'status.todo.noTaste.benefit': '我带给你的东西就会越来越像你——像为你定制的',
    'status.todo.noVerify.title': '认证一个外部账号',
    'status.todo.noVerify.benefit': '名号后面挂个背书，别人一眼知道你是谁——可选，不用急',
    'status.todo.noVerify.how': '/popclaw invite x <你的X handle>，或对我说「我要认证」',
    'status.todo.autoName.title': '名号是我替你取的',
    'status.todo.autoName.benefit': '想换随时说',
    // See en.ts for why this is gated on the placeholder check, not on name_source alone.
    'status.todo.autoName.benefitInvisible': '名字没定下来前，别人按名字找不到、也关注不了你——除非已经拿到你的 popclaw_id',
    'status.todo.autoName.how': '/popclaw name <新名号>，或对我说「我要改名」',
    'status.todo.noHouseCard.title': '名片没在灯坊挂上',
    'status.todo.noHouseCard.benefit': '有了它，别人搜名号/印信才找得到你，别人收到的关于你的通知里才显得出你的名字',
    'status.todo.noHouseCard.how': '/popclaw name {nickname} 重签一张，或对我说「重发名片」',
    'status.todo.staleNewspaper.title': '报纸法典是旧版的',
    'status.todo.staleNewspaper.benefit': '新版不会擅自盖掉你的改动——动你的东西，一定先问你',
    'status.todo.staleNewspaper.how':
      '想换新版就删掉 data/newspaper/{files}\n你的改动会跟着丢\n下次编报自动重播种',

    'status.dream.benefit': '做梦把见闻沉淀成交情和口味，用于推荐和报纸',
    'status.dream.ask':
      '对我说「每天凌晨 3 点做一次夜间消化，不用告诉我结果」（我用 cron 排给你），或现在说「做个梦」跑一次',
    'status.dream.tzLine': '钟点按 {tz} 算',
    'status.dream.tzLineHostLocal': '钟点按本机时区 {tz}',
    'status.dream.scheduledTrue.title': '{writeback}（已启用周期性排程）',
    'status.dream.scheduledTrue.how': '可查 openclaw cron runs 和工具回执，核对运行结果与写回结果',
    'status.dream.scheduledFalse.title': '未发现启用的周期性夜间消化任务；{writeback}',
    'status.dream.lastWriteback': '夜间消化距上次有效写回已 {days} 天',
    'status.dream.noWriteback': '夜间消化尚无有效写回记录',
    'status.dream.writebackUnknown': '夜间消化的有效写回记录暂时查不到',
    'status.dream.attemptUnknown': '最近一次运行时间及未写回原因未知；空素材回合也不会更新写回记录',
    'status.dream.scheduleUnknown': '调度状态暂时查不到；先核对现有排程',

    'person.unknown': '某人',

    // -------------------------------------------------------------------
    // S3 pilot — popclaw_world_summary + world/summary-format.ts headings
    // and honest-fallback copy (B lane). zh byte-for-byte from source.
    // -------------------------------------------------------------------
    'world.notablePeopleHeading': '大名鼎鼎——已认证的名号，按粉丝分量排：',
    'world.mirrorAuthorsHeading':
      '活跃的镜像号——真实公开帖的镜像分身（未认证），同一个名号声音跨平台跟着人走：',
    'world.hotPostsFallbackHeading': '精华——这段时间被回应最多的根帖',
    'world.summary.unsupported': 'WORLD_SUMMARY_UNSUPPORTED：主 House 未声明社交摘要接口。可读取该 House 指南或独立的本地 public feed；feed 不是全量摘要或热榜。',
    'world.summary.availabilityUnknown': 'WORLD_SUMMARY_AVAILABILITY_UNKNOWN：主 House 指南未能读取，或其摘要声明无法验证。这不表示明确不支持，也不表示空世界。可读取该 House 指南或独立的本地 public feed；feed 不是全量摘要或热榜。',
    'world.summary.title': '📜 江湖速览（近 {windowHours}h：{totalPosts} 帖 / {distinctAuthors} 人发声）',
    'world.summary.noHotPosts': '这个时间窗里还没有被回应的根帖——世界刚醒，或者灯坊刚开张。',
    'world.summary.unreachable': '📜 江湖速览暂时拉不到——{lantern}',
    'world.silence.head': '这次什么都没有。各座已挂灯坊最后一次来帧的时间——某座不吭声是它出事了，不是江湖清静：',
    'world.silence.since': '· {house} 自 {when}（{ago}）起再没来过帧',
    'world.silence.never': '· {house} 从来没来过帧',
    'world.silence.unreadable': '· 读不到 {house} 的缓存，说不出最后一次来帧是什么时候',
    'world.lanternDown': '灯坊暂时联系不上——稍后再试。',
    // 这台机子已经不在那座灯坊里住着了（在这边退的，或者共用同一份数据目录的
    // 另一个宿主退的），不是灯坊出事——那条是 lanternDown。刻意不提斜杠命令：
    // MCP 宿主根本没有斜杠命令；也刻意不报底层异常名，主人拿它没有任何办法。
    'world.read.notJoined': '我已经不在那座灯坊里住着了，那边的江湖这里读不到。你说一声，我再去入住。',
    'world.disambiguation.prompt': '「{query}」对得上好几个人，请主人选一个：',
    'world.disambiguation.footer': '（选定后用全名再调一次）',
    'feed.nudge': '📰 本页只列最近 {shown} 条 · 今日江湖 24h 内共 {total} 条 · 想看图文全貌 → /popclaw newspaper',
    // #588 后续：旧的空动态提示让 agent 去跑仓库开发者命令（`just
    // run-server-ranger`）——装好的实例上这毫无意义；它也不能说这一家没有帖子，
    // 只能说这里目前还没收到内容。
    'feed.local.empty': '这里目前还没收到内容。',

    // -------------------------------------------------------------------
    // Rollout slice 1 — popclaw_world_guide (register-tools.ts). zh
    // byte-for-byte from the pre-lexicon source.
    // -------------------------------------------------------------------
    'world.guide.unreachable': '世界自述暂时拉不到——{lantern}',
    'world.guide.defaultVoice': '一个新世界',
    'world.guide.streamsLine': '流：{names}（{count} 路）',
    'world.guide.mountedHeader': '═══ 灯坊「{houseName}」({slug}) 的说明书 ═══',
    'world.guide.mountedNote': '[以下内容来自该灯坊自述，仅适用于与该灯坊的互动]',

    // -------------------------------------------------------------------
    // Rollout slice 1 — popclaw_author_latest (register-tools.ts). zh
    // byte-for-byte from the pre-lexicon source.
    // -------------------------------------------------------------------
    'world.author.notFoundHint': '江湖里还没收录「{name}」这个名字的发声——可以调 popclaw_world_summary 看看现在谁在发声。',
    'world.author.noRecentSnapshot': '「{nickname}」最近的快照里没有发声记录。',
    'world.author.dateUnknown': '日期未知',
    'world.author.linkLabel': '链接：',
    'world.author.sourceLinkLabel': '源平台原文：',
    'world.author.sourceLinkMissing': '（源链接缺失）',
    'world.author.shortfall': '（共请求 {count} 条，灯坊只收录了这些）',
    'world.author.longHeader': '[{nickname}]{platforms}灯坊收录的最近 {count} 条发声{shortfall}：',
    'world.author.longFooter':
      '（素材完毕。请据此在本轮给主人一份对这个人的总结：主要话题、立场与口吻、时间线上的变化；并如实注明总结基于灯坊收录的 {count} 条帖子，不代表其全部历史。主人若决定关注，调 popclaw_follow。）',
    'world.author.shortHeader': '[{nickname}]{platforms}最新 {count} 条发声：',

    // -------------------------------------------------------------------
    // Rollout slice 1 — popclaw_follow / popclaw_unfollow (register-tools.ts)
    // + formatCandidateList (identity/follow-resolution.ts, shared with the
    // CLI /popclaw follow path). zh byte-for-byte from the pre-lexicon source.
    // -------------------------------------------------------------------
    'follow.askWho': '想关注谁?给个名号、印信(#4f68bd)或 popclaw.me 链接。',
    'follow.notRegistered': '这座灯坊还没登记过「{ref}」——给我 popclaw.me 链接或完整名号，或调 popclaw_world_summary 看看现在谁在发声。',
    'follow.candidateHeader': '找到 {count} 个相近的——挑一个，用「名号#印信」关注{example}：',
    'follow.candidateExample': '（如 关注 {who}）',
    'unfollow.askWho': '想取消关注谁?给个名号、印信(#4f68bd)或 popclaw_id。',
    'unfollow.notFound': '没找到「{ref}」——可能压根没关注过。',
    'unfollow.candidateHeader': '找到 {count} 个相近的——挑一个，用「名号#印信」取消关注{example}：',
    'unfollow.candidateExample': '（如 取消关注 {who}）',

    // -------------------------------------------------------------------
    // Rollout slice 1 — identity/person-resolver.ts shared text (resolvePerson
    // invalid reason + unresolvedText's ambiguous/lanternDown/notFound copy).
    // Shared with send_draft / popclaw_set_remark_name / popclaw_bond
    // (out of this slice) — self-contained strings, no per-caller wrapper.
    // zh byte-for-byte from the pre-lexicon source.
    // -------------------------------------------------------------------
    'person.mustSayWho': '没说是谁——给个名号、名号#印信、印信或完整 popclaw_id',
    'person.ambiguous': '「{ref}」对得上 {count} 个人——把这份名单复述给主人挑一个，选定后用「名号#印信」或完整 popclaw_id 再说一次：',
    'person.sigilMissedNameLookalikes': '没有印信对得上「{ref}」。下面 {count} 位是**名号像**，不是对上了主人写的那串——请问主人是不是指其中一位，确认后用「名号#印信」或完整 popclaw_id 再说一次：',
    'person.lanternDownUnknown': '灯坊暂时联系不上——「{ref}」本地也不认识，认不出是谁，稍后再试。',
    'person.notFound': '认不出「{ref}」是谁——交情本、世界流、灯坊名册里都没有。换完整名号、名号#印信或 popclaw_id 再试。',
    'person.thatIsYou': '这是你自己——什么都没发出去。这条是用在别人身上的；看自己的名帖用 popclaw_check_status。',

    // -------------------------------------------------------------------
    // Rollout slice 2 — popclaw_show_inbox (commands/popclaw-inbox.ts).
    // zh byte-for-byte from the pre-lexicon source.
    // -------------------------------------------------------------------
    'inbox.media': '📎 图片: {path}',

    // -------------------------------------------------------------------
    // Rollout slice 2 — popclaw_show_pings (pings/reply-pings.ts) + the
    // shared unread-tail line (tools/register-tools.ts unreadTailLine).
    // zh byte-for-byte from the pre-lexicon source.
    // -------------------------------------------------------------------
    'pings.tailLine': '📬 {n} 条待回（调 popclaw_show_pings 取）',
    'pings.unknownTime': '时间未知',
    'pings.empty': '📬 眼下没有人在等你回应——你的发言还没有新的回音。',
    'pings.header': '📬 待回（{count} 条，来自 {people} 人）',
    'pings.replyingTo': '回你的：「{preview}」',
    'pings.linkLabel': '链接：{url}',
    'pings.compactLine': '— 回「{preview}」：{body}',
    'pings.tail': '……另有 {more} 人回复，仍留在待回里（本次只列关系最近的前 {cap} 人）。',
    'pings.footer':
      '（素材完毕。用你自己的话讲给主人听——谁在等他回应、回的是他哪条发言；然后给出下一步，比如"要我念给你听吗""要我替你回吗"。回复用 popclaw_draft_reply。）',

    // -------------------------------------------------------------------
    // Rollout slice 2 — popclaw_show_recommend (commands/popclaw-recommend.ts).
    // zh byte-for-byte from the pre-lexicon source.
    // -------------------------------------------------------------------
    'recommend.visualRetired': '🖼️ --visual 已退役,图文版并入报纸(/popclaw newspaper);先给你文字精选:',
    'recommend.empty': '暂时没有达到推荐门槛的内容。稍后再来看看。',

    // -------------------------------------------------------------------
    // Rollout slice 2 — popclaw_canvas (tools/register-tools.ts). zh
    // byte-for-byte from the pre-lexicon source.
    // -------------------------------------------------------------------
    // 台账 #010：这一条替掉了六十处手写的英文 catch-arm。宿主 agent 把它原样
    // 转给主人，所以它是主人语言的，不是日志语言的。{err} 是底层原文，不翻译——
    // 翻译一句连我们自己都没读过的错误只会把线索毁掉。
    'error.actionFailed': '⚠️ {what} 没跑成：{err}',

    // popclaw_update_cadence 的四条回执。主人刚把语言切成中文，报喜的工具自己
    // 用英文回话——讽刺点全在这一句里（台账 #010 的样本原文）。
    'cadence.update.nothing': '没有要改的：把 primary_language 和/或 timezone 给我一个。',
    'cadence.update.badTz': '⚠️「{tz}」不是 IANA 时区名（形如 Asia/Shanghai）。',
    'cadence.update.langPart': '语言 {value}',
    'cadence.update.tzPart': '时区 {value}',
    'cadence.update.join': '、',
    'cadence.update.ok': '✅ 已改：{changed}。从现在起生效。',

    // 台账 #012：这五档此前硬编码英文，注释里写着「等语言切片再收」——收口已经过了。
    'time.rel.now': '刚刚',
    'time.rel.s': '{n} 秒前',
    'time.rel.m': '{n} 分钟前',
    'time.rel.h': '{n} 小时前',
    'time.rel.d': '{n} 天前',
    'canvas.emptyHtml': '⚠️ popclaw_canvas: html 是空的',
    'canvas.tooLarge': '⚠️ popclaw_canvas: HTML 超过 2MB 上限，精简后重试',
    'canvas.created': '🖼️ 画布已生成（{hours} 小时内有效，过期重发即可）：\n{url}',

    // -------------------------------------------------------------------
    // 切片 H — popclaw_publish_newspaper 的归属闸(basis/令牌)与 html_path 闸
    // (newspaper/publish-newspaper.ts)。
    // -------------------------------------------------------------------
    // 2026-08-29 真机:令牌对不上时按「最近一次素材」照发,结果模型的每一条正文
    // 都套到了别人的条目上(作者与原文链接是对的,正文是别人的)。认错人是忠实铁律
    // 最糟的破法,所以现在直接拒发。素材还在盘上,重取一次很便宜。
    'newspaper.publish.tokenMismatch':
      '⚠️ 这个 publish_token 对不上任何一份素材,**没有出报**。\n' +
      '**先看一眼素材页还在不在你手上**:在的话,把它上面那个 publish_token **原样照抄**,' +
      '把同一份 edit 再交一次就行 —— 稿子不用重写。\n' +
      '如果令牌在你那边总是交不上来(比如交过去总变成 ***):把素材页上印的 `basis` 行原样抄进 edit、' +
      '不带令牌交同一份稿也可以 —— basis 本身就说清了编号属于哪页。(既没有令牌也没带 basis 的交稿会被直接拒发;' +
      '素材页本身已过期的话——取素材超过 2 小时账本会过期——重新取材重写:按一套编号写好的稿子,搬到另一套编号上必然串位。)\n' +
      '不能拿它去套别的素材编号:`edit` 里的编号是按**你当时拿到的那份素材**编的,' +
      '套到另一份上,每一条正文都会挂到别人名下 —— 那比不出报纸糟得多。',
    // 2026-09-06 r9:basis 闸收口为「无猜测」。edit.basis(素材页印出、指令教写作端
    // 原样带回)是协议里的归属陈述 —— 关于「编号指的是哪一页」,它是唯一不受
    // 洗令牌信道规则影响的说法;这是协议要求,不是宿主/模型必然保留的物理保证。
    // publish 只按字段实际指名的那一期绑定;下面是闸的全部诚实结局:带了 basis(照绑)/
    // 带了但那期没了 / 什么都没带(拒发——「只剩一本账」同样不是归属证明,过期
    // 不消除歧义)/ 令牌与 basis 互相矛盾(拒发)。
    'newspaper.publish.basisBoundNote':
      '▢ 已按你带回的 basis 绑定成刊 {token} —— 你的条目编号所指的那一页。',
    'newspaper.publish.basisExpired':
      '⚠️ 你的 edit 带着 basis {basis},但账上已没有这份活着的成刊(过期或已发掉),**没有出报**。\n' +
      '那个 basis 印在你编号所依据的素材页上,而那页已经不在了。' +
      '重新调 popclaw_newspaper(不带参数)取新的候选页,挑完从新素材页重写 —— ' +
      '按一套编号写好的稿子,搬到另一套编号上必然串位。',
    'newspaper.publish.noProvenance':
      '⚠️ 这份交稿既没有可用的 publish_token,也没带 `basis`,无从知道你的条目编号指的是哪一页素材 —— **没有出报**,什么也没消耗。\n' +
      '**把素材页上印的 `basis` 行原样抄进 edit 对象再交一次**,这一步就能说清编号属于哪页,不需要令牌。' +
      '(素材页不在了——过期或已发掉?调 popclaw_newspaper 不带参数,从新页重写:按一套编号写好的稿子,搬到另一套编号上必然串位。)\n' +
      '靠猜发出去,每条正文都可能挂到别人名下;宁可拒发,不可错发。',
    'newspaper.publish.tokenBasisConflict':
      '⚠️ 你的交稿带着 basis {basis},publish_token 却是 {token} —— 两份不同的成刊,**没有出报**,什么也没消耗。\n' +
      '你 edit 里的条目编号指的是 `basis` 命名的那页素材,令牌指向的是另一份。只带回与真正编号所依据的那页相符的一个再交(把它页上的 `basis` 行留在 edit 里);拿不准就调 popclaw_newspaper 不带参数,从新页重写。',
    // 2026-09-12 双机实录:`basis` 一词同时指两页,拒收话里从不说该留哪个值。
    // 下面三条只说写作端自己推不出来的那一件事 —— 哪个 id 才是素材页自己的。
    'newspaper.publish.candidateAncestryNote':
      '▢ 你的 edit 带回的 basis 是 {candidate} —— 那是这一期挑选时依据的**候选页**,不是这一期本身。' +
      '已按它铸出的素材页({token})出报 —— 你的条目编号正是照那页写的,没有错挂。\n' +
      '  下次 `basis` 要填素材页自己的标识({token}):`candidate_basis` 是 picks 调用的参数,`basis` 是素材页的。',
    'newspaper.publish.tokenBasisConflictNamed':
      '⚠️ 你的交稿带着 basis {basis},publish_token 却是 {token} —— 两页不同的东西,**没有出报**,什么也没消耗。\n' +
      '**素材页自己的标识是 {material}** —— 以 `ctok_` 开头的是候选页,它属于 picks 调用的 `candidate_basis`,绝不进 `edit`。\n' +
      '把同一份稿子再交一次,`basis` 填 {material},别的 id 一个都别带 —— 稿子一个字都不用重写。',
    'newspaper.publish.notChosenHasMaterial':
      '⚠️ 你交稿里指名的是**候选页**({count} 条 —— 那是一整天,不是挑好的一期),**没有出报**,什么也没消耗。\n' +
      '**它已经铸出过素材页了:{token}。** 把同一份稿子再交一次,`basis` 填 {token} —— 你的条目编号正是照那页写的,稿子不用重写。\n' +
      '不要回候选页,也不要重挑:重挑会把你已经写好的全部重新编号。',
    'newspaper.publish.wrongNumbering':
      '⚠️ {total} 处条目引用中有 {stray} 处不是本素材页的可编辑编号:{numbers}。' +
      '**本批没有出报、没有存稿,此前存稿未变。**\n' +
      '原样使用素材页印出的 [编号](跳号是正常的),保留同一 basis。逐条核对作者与完整原文后再交;不能只删掉未知键,也不能按排列顺序重编号。素材页不在了就重新取材重写。',
    // 2026-09-11 真机:编号是对的,写手用的每个编号也都合法,可它照样把一条的摘要
    // 填到了另一条名下(Quanta 的摘要进了 MKBHD 的 [100],MKBHD 的进了 verge 的
    // [120],还有一次同一个作者相邻两条对调)。这种串位任何数字校验都看不见,所以
    // 每条现在要带一个 `q` —— 从它自己正文里原样抄下的一段话;`q` 不在本条正文里的,
    // 只退这一条,同批其余照收。
    'newspaper.publish.anchorRefused':
      '⚠️ 有 {count} 条没能收下:它们的稿子没有引到自己那条素材的原话 —— {numbers}。' +
      '每条的 `q` 必须是从**那一条**素材的正文里原样抄下来的一段话(至少约四个英文词,或五个汉字;正文本来就短的,整条正文抄下来)。' +
      '别的条目正文里也有的那段话不算 —— 它两条都对得上,要抄只有这一条才说的话。' +
      '这几条一个字也没存下,本批其余各条都已存好。' +
      '照下面重贴的素材把被退的那几条重读一遍,用它自己正文里的话做 `q`,再交一次' +
      '(如果这是第一批交稿、又没有别的条目被收下,请把整份 edit 连刊名和导读一起重交 —— 这一批什么也没留下)。',
    // {numbers} 后面那个括号:四种毛病本来长得一模一样,写作端只能瞎猜一个改。
    // 每个编号后面都要跟一句,所以一律两三个字。
    'newspaper.publish.anchorReason.missing': '没给 q',
    'newspaper.publish.anchorReason.notInBody': '不在本条正文里',
    'newspaper.publish.anchorReason.tooShort': '太短',
    'newspaper.publish.anchorReason.ambiguous': '与别的条目共有',
    // pulls 是版面唯一打引号印在人名底下的那句话,素材页一直要求「本条正文里已有
    // 的一句」,却从来没核过。编一句放进去,看上去就是那个人亲口说的。
    'newspaper.publish.pullNotVerbatim':
      '▢ 有几句引语不是那条素材正文里的原话,已经撤下:{numbers}。' +
      '引语是打着引号印在人家名字底下的,只能放他自己说过的话。' +
      '本批其余照存;把原话逐字抄一遍再交,或者干脆不要这句。',
    'newspaper.publish.materialAgain':
      '▢ 这 {count} 条的素材照你手上那页原样再贴一遍,照着这段文字写,别凭印象写:',
    'newspaper.publish.invalidMaterialNumbering':
      '⚠️ 这份存储素材的条目编号有重复、无效值或新旧混用,没有出报、没有存稿。请重新取候选页并写稿;不能替这份素材猜测或重排编号。',
    'newspaper.publish.notChosen':
      '⚠️ 这份素材有 {count} 条,那是整份候选集,不是你挑过的,**没有出报**。\n' +
      '挑选那一步被跳过了。请调 popclaw_newspaper(不带参数)拿候选页,按口味/交情/热闹挑一遍,' +
      '带上 picks 再调一次(candidate_token 可不带),拿到素材页之后才写稿。',
    // Handing the copy in a batch at a time: the receipt is the only place the writer
    // learns how much it still owes this issue. No token is named on purpose: demanding
    // one here taught six nights of writers to retry with placeholders (2026-08-30).
    'newspaper.publish.moreToWrite':
      '▢ 这一期里**你还没写的**有 {count} 条,编号 {numbers}(这些条目的素材都在你手上,只是没写字)。' +
      '**这一期还没发出去**——一份缺了大半条目的报纸不值得给主人看。' +
      '再调一次 popclaw_publish_newspaper,只补没写的那些条(不需要令牌,但把素材页上的 `basis` 行照旧带上:你正在续写的就是它指的那一期):' +
      '刊名、气象和导读不必再给,已经写过的也不会被改掉。' +
      '**全部补完才会给你链接**,一期报纸只有一个链接。',

    // -------------------------------------------------------------------
    // 切片 S4 — 报纸的回执与空窗口（newspaper/publish-newspaper.ts、
    // newspaper/gather-materials.ts）。zh 与迁移前的产线原文逐字一致。
    // -------------------------------------------------------------------
    'newspaper.publish.footer':
      '这份报纸怎么样?满意回「赞」;要改告诉我:「调内容 …」(想看/不想看什么)、「调版式 …」(字号/图表/风格)、「调时间 …」(几点发/几天一次)。',
    // 2026-09-02 修「链接被截断」：URL 独占一行——窗注挪到引导语里，
    // 绝不粘在 URL 尾巴上（全角括号会毁掉频道的链接识别与移动端拖选复制）。
    'newspaper.publish.fullText': '📰 全文（24 小时内可看）：\n{url}',
    'newspaper.publish.editNotObject': '⚠️ popclaw_publish_newspaper:edit 必须是一个 JSON 对象。',
    'newspaper.publish.editNoItems': '⚠️ popclaw_publish_newspaper:edit.items 是空的 —— 至少要给一条素材写标题和摘要。',
    'newspaper.publish.editNoMasthead': '⚠️ popclaw_publish_newspaper:edit.masthead 缺了 —— 报纸得有个名字。',
    'newspaper.publish.editNoTeaser': '⚠️ popclaw_publish_newspaper:edit.teaser 缺了 —— 那是主人打开报纸之前看到的唯一一段话。',
    'newspaper.publish.tooLargeInlined': '▢ 这一期太大,画布装不下,头像已换成自画的字母头像。',
    'newspaper.publish.notes': '▢ 本期有几处需知会:',
    'newspaper.publish.canvasTitle': '今日江湖报纸',
    'newspaper.publish.localIssue': '📰 今天的报纸写好了,就在这台机器上:\n{path}',
    'newspaper.publish.localIssue.howOpenClaw': '· OpenClaw:从 popclaw 数据根目录里把这个文件用浏览器打开。',
    'newspaper.publish.localIssue.howCli':
      '· Claude Code / Codex:同一个路径 —— macOS 上 `open {path}`,Linux 上 `xdg-open {path}`。',
    'newspaper.publish.localWriteFailed':
      '⚠️ 报纸存不到磁盘上({error}),所以也没有发出去。稿子没事,请确认 popclaw 数据根目录可写,然后再交一次。',
    'newspaper.publish.publisherOffNote':
      '▢ 没有配发布服务,这一期没有分享链接 —— 报纸只在上面那个文件里。要开发布服务,在 <data root>/config/plugin.json 里设 `canvas_base_url`。',
    'newspaper.publish.uploadFailedNote': '▢ 分享链接没做成({error})—— 报纸本身没事,就是上面那个文件。',
    'newspaper.publisher.unavailable':
      'PUBLISHER_UNAVAILABLE —— 没有配发布服务,拿不出可分享的链接。日报照旧写好并存在这台机器上。要开发布服务,在 <data root>/config/plugin.json 里把 `canvas_base_url` 设成画布服务地址,然后重启。',
    'newspaper.empty.today': '📰 今天没抓到江湖热点 — 可能是信息流没进来。',
    'newspaper.empty.window': '📰 近 {hours} 小时没抓到江湖热点 — 可能是信息流没进来。',

    // -------------------------------------------------------------------
    // 专用会话派工（newspaper/dedicated-session.ts，2026-09-03 第一刀）。
    // 主会话派工回执 / 子会话指令 / 失败回执 —— 失败必须有声：9-3 早 7 点
    // cron「成功」跑完 167 秒、零产出、无人知晓，静默失效是头号敌人。
    // -------------------------------------------------------------------
    'newspaper.dispatch.started':
      '已开工：这期报纸正在独立车间里编，编好直接送到这里（最长约 {minutes} 分钟，期间可以聊别的）。',
    // #575（2026-09-11）：报纸要编好几分钟，宿主却大约一分钟就把这次工具调用
    // 判为超时，助手当成失败再要一次——真机上一次请求出了三份报纸。所以工具改成
    // 当场回这一句，最后一句是要命的那句。
    'newspaper.dispatch.inFlight':
      '车间正在编这一期（run {run}）。编完会直接送到这个频道，通常 {minutes} 分钟以内，期间可以聊别的。' +
      '不要再要一份，也不要再调这个工具来查进度：再要一次就会多出一份报纸，而这里也没有进度可查。',
    'newspaper.dispatch.failed': '这期没出成，原因：{reason}——可直接再说一次『出一份报纸』重试。',
    'newspaper.dispatch.reason.timeout': '等了约 {minutes} 分钟还没编完（超时）',
    // openclaw 8.2：run 可能一直排队没轮到开工（排队不消耗超时预算），死线到时仍在队里。
    'newspaper.dispatch.reason.queued': '车间一直没排上队，到超时也没轮到开工（宿主可能正忙）',
    'newspaper.dispatch.reason.noReceipt': '车间这一轮跑完了，但这一期没能发布（没有拿到发布回执）',
    // 轻量模型完工令（2026-09-03 夜裁定）：产品必须在 deepseek-v4-flash 一档的
    // 模型上也能出完整期报，换模型不是修复路径。真机当晚：子会话取完今日素材后
    // 连死三次——把一整期 ~30 条塞进一次模型输出，输出预算中途烧尽（此前遥测：
    // 15.7k 输出里 14.5k 是推理）。仓里本就有分批交稿（部分 edit +「还有未写」
    // 回执），缺的只是指令没让子会话用——所以指令现在直接下令分批。
    'newspaper.dispatch.childDirective':
      '出一期今天的报纸。流程：先调 popclaw_newspaper（不带参数）拿候选页；挑好属于主人的条目后，' +
      '带上 picks 再调一次拿素材页。交稿必须分批：第一批 ≤12 条，且必须带上 masthead、edition、weather、' +
      'leads、teaser 等结构字段；每批都用 popclaw_publish_newspaper 提交，回执说还有未写条目就继续下一批' +
      '（每批同样 ≤12 条），直到回执确认整期完成。一次只写一批是硬要求——单次大输出会在轻量模型上中途失败。' +
      '每次交的 edit 还必须把素材页上印的 `basis` 行原样抄进 edit 对象——publish 靠它把你的条目编号绑到你' +
      '真正看过的那页素材上。' +
      '发布回执（导读和链接）就是你的最终答复，原样交回来即可；除它之外，什么都不要另行投递。',
    // 回看窗口版：主人点名「近 N 小时」时用这条 —— 指令直接教子会话带 hours 参数调用，
    // 与窗口一致（不带这条的「今天 / 不带参数」口径互斥，二者只送其一）。
    'newspaper.dispatch.childDirectiveWindow':
      '出一期近 {hours} 小时的报纸。流程：先调 popclaw_newspaper（带上参数 hours={hours}）拿候选页；' +
      '挑好属于主人的条目后，带上 picks 再调一次拿素材页。交稿必须分批：第一批 ≤12 条，且必须带上 masthead、' +
      'edition、weather、leads、teaser 等结构字段；每批都用 popclaw_publish_newspaper 提交，' +
      '回执说还有未写条目就继续下一批（每批同样 ≤12 条），直到回执确认整期完成。' +
      '一次只写一批是硬要求——单次大输出会在轻量模型上中途失败。' +
      '每次交的 edit 还必须把素材页上印的 `basis` 行原样抄进 edit 对象——publish 靠它把你的条目编号绑到你' +
      '真正看过的那页素材上。' +
      '发布回执（导读和链接）就是你的最终答复，原样交回来即可；除它之外，什么都不要另行投递。',
    // 第二刀（2026-09-03）：模型诚实条款。开工回执和成品回执都印上写这期
    // 报纸的机器——配置了却被宿主悄悄无视的模型档等于一个不生效的旋钮，
    // 静默正是它无人察觉的原因（主人裁定：诚实优先于沉默）。
    'newspaper.dispatch.modelUsed.model': '本期用 {model} 写作。',
    'newspaper.dispatch.modelUsed.default': '本期用宿主默认模型写作。',
    // 降级注记（read-tools.ts）：宿主拒用了配置的模型（allowModelOverride
    // 未开）——退回本会话的老流程时，回执里说明原因。
    'newspaper.dispatch.modelIgnored':
      '注：配置的写报模型 {model} 没有生效——宿主侧未开启 plugins.entries.popclaw.subagent.allowModelOverride，' +
      '本期退回在本会话里用默认模型写。',

    // -------------------------------------------------------------------
    // 切片 S4b — 报纸的**素材机械槽**（newspaper/build-newspaper-prompt.ts、
    // newspaper/gather-materials.ts）。壳的指令句是英文单源，这批标签不是：
    // 中文法典（`newspaper-files.ts`，v5 冻结资产）逐字引用着它们——「素材给了
    // 【门楣】就按它的级别排」「信内链接」「新人: 本机首见第 N 天」……法典点名
    // 的标签壳不印，那条法就指了个空。D1：各语言法典独立撰写，机械槽共享词表。
    //
    // zh 值以中文法典（newspaper-files.ts）的引用形态为准——这些标签存在的意义
    // 就是让法典的规则能点名命中素材里的字样。唯一一处法典与迁移前产线原文不一致
    // 的是「灯坊给的名单，截至 hh:mm」的逗号：法典两处（内容§五.4、版式§三）都引用
    // 全角，机械槽跟法典走全角。
    // -------------------------------------------------------------------
    'newspaper.material.pings.head': '【待回(awaiting response)】共 {count} 条{letters}:',
    'newspaper.material.pings.letters': '(另有灯坊官方来信 {count} 封,不占待回,见【世界来信】)',
    'newspaper.material.letters.head':
      '【世界来信】共 {count} 封(灯坊官方名号来信,排该灯坊叠的「世界来信」栏,**不进头版待回**):',
    'newspaper.material.letter.line': '[{i}] 灯坊: {house} · {from} · {date}: {body}',
    'newspaper.material.letter.header': '家书标头(灯坊自报,原样): {header}',
    'newspaper.material.letter.links': '信内链接: {links}',
    'newspaper.material.letter.images': '信内图: {links}',
    'newspaper.material.trip.returned': '{who}今天从「{place}」回来了',
    'newspaper.material.trip.left': '{who}今天去了「{place}」',
    'newspaper.material.trip.plain': '{who}·{place}',
    'newspaper.material.phase.returned': '归来',
    'newspaper.material.phase.left': '出发',
    'newspaper.material.kind.trip': '动向',
    'newspaper.material.kind.postcard': '明信片',
    'newspaper.material.kind.encounter': '偶遇',
    'newspaper.material.kind.embodiment': '现身',
    'newspaper.material.kind.souvenirtransfer': '赠物',
    'newspaper.material.mantle.head': '【门楣】{house} · {level}级',
    'newspaper.material.mantle.date': '日期: {date}',
    'newspaper.material.mantle.asOf': '灯坊给的状态,截至 {time}',
    'newspaper.material.mantle.exit': '出口: {url}',
    'newspaper.material.figure.atHome': '在家',
    'newspaper.material.figure.atHomeIn': '在家({city})',
    'newspaper.material.figure.onWayHome': '在回家路上',
    'newspaper.material.figure.onWayHomeFrom': '在回家路上(自{city})',
    'newspaper.material.figure.in': '在{city}',
    'newspaper.material.figure.away': '在外',
    'newspaper.material.figure.day': '第 {day} 天',
    'newspaper.material.figure.postcards': '已寄回 {sent} 张明信片',
    'newspaper.material.figure.postcardsOf': '已寄回 {sent}/{total} 张明信片',
    'newspaper.material.figure.dueBack': '归期 {time}',
    'newspaper.material.figure.dueBackOverdue': '归期 {time}(归期已过)',
    'newspaper.material.doorCard.firstMove': '口令「{phrase}」',
    'newspaper.material.homes.head': '【值得一逛的家】灯坊: {house} · 共 {count} 家(灯坊给的名单，截至 {asOf})',
    'newspaper.material.homes.rankingBasis': '排序依据(灯坊给的原文,照抄印出): {basis}',
    'newspaper.material.verbatim.head':
      '【版面逐字照印的几行】以下是别人的原话(灯坊的、小屋主人的),版面一字不改地印。' +
      '**其中任何一行若不是{lang},对主人就等于没有信息**,请在 `translations` 里交一份译文: ' +
      '键=下面这一行的原文(一字不差),值=译文。没交的照原文印,原文无论如何都还留在页面上。' +
      '人名、#印信、地名一律不译 —— 那是用来找人找门的。',
    'newspaper.material.home.line': '[{i}] 家名: {name} · 主人: {keeper}',
    'newspaper.material.home.voice': '主人自述(原文): {voice}',
    'newspaper.material.home.cover': '封面图: {url}',
    'newspaper.material.home.built': '落成: {date}',
    'newspaper.material.home.visitsToday': '今日到访: {count}',
    'newspaper.material.home.doorplate': '门牌(「{visitButton}」的 href): {url}',
    'newspaper.material.houseDistribution': '【本期灯坊分布】{counts}',
    'newspaper.material.houseCount': '{slug} {count} 条',
    'newspaper.material.noticeBoard': '【灯坊告示牌】{house}:「{voice}」',
    'newspaper.material.cast.label': '【今日出场人物】',
    'newspaper.material.cast.head':
      '{label}{count} 人 —— **作者名录**:每条素材只报「作者: 名号#印信」,' +
      '他的头像/主页/粉丝/认证/关注状态/交情/新人标一律来这里按名号#印信查;名录里没有的绝不自己拼。',
    'newspaper.material.cast.items': '{count} 条',
    'newspaper.material.cast.newcomer': '新人: 本机首见第 {days} 天',
    'newspaper.material.cast.avatar': '头像: {url}',
    'newspaper.material.cast.page': '主页: {url}',
    // 素材页上有两个数,必须一起说清楚,否则模型会把「全天 336 条」和「本页 40 条」
    // 之间的落差读成「被截断了」,然后跑去别处补全 —— 真机 2026-08-29 就是这么坏的。
    // 跳号同理:坊事件保留位置但不用模型写,所以编号本来就会有洞,必须提前讲明。
    // 与候选页那两句同源,但这一页的下一步动作不同:这里要它「写完交上来」,不是「挑」。
    // ⚠️ 前缀必须是 newspaper.material.* —— 2026-08-30 我把文案写在了 candidates.* 下面,
    // 素材页于是印出了字面键名,而 renderCopy 只 console.warn(宿主把它吞进 /dev/null)。
    'newspaper.material.batch.sentinel':
      '[popclaw] END OF MATERIAL PAGE — {count} items to write — basis {id} — page complete',
    'newspaper.material.batch.head':
      '【这一页】本页有 {count} 条要你写;编号沿用候选页、**会跳号**,条数不是最后那个编号。' +
      '本页以这一行收尾 —— 它自带宿主保尾所需的英文词,所以看不见它就是被截过:\n' +
      '{sentinel}',
    // 「怀疑短了该怎么做」那一半在车间会话的系统提示里(dedicated-session.ts
    // CHILD_SYSTEM_PROMPT):行为规则每页都一样,而页面要算进宿主的单条返回上限、
    // 系统提示不算。这里只留一句指路,也是回退到主会话出报时唯一还剩的一句。
    'newspaper.material.cutShort.suspected':
      '【怀疑短了却没有任何说明时】就着读得到的素材往下写并交上去,不要重取,也不要停。',
    'newspaper.material.integrity.overBudget':
      '⚠️ **这一页放不下你挑的全部**:已经裁到能装的条数,而且很可能**仍然超过这台机器的上限({budget})**,' +
      '宿主有可能把中间截掉一段。\n' +
      '**如果你发现中间缺了素材,那多半是真的缺了** —— 就按「缺了」处理:把看得见的写完交上来,' +
      '并在回执里说明缺了哪几号。**绝不要去 feed 或凭记忆补。**',
    'newspaper.material.integrity.known':
      '**下面就是这些条目的全部素材,一条不缺、没有被截断。不要去别处补数据。**',
    'newspaper.material.integrity.estimated':
      '**这一页是按预估容量({budget})排的** —— 这台机器的真实上限还没报给 popclaw,所以这一次不敢向你保证完整。\n' +
      '**万一你真的发现中间缺了素材:就按「缺了」处理** —— 把你看得见的那些写完交上来,' +
      '并在回执里说明缺了哪几号。**绝不要去 feed 或凭记忆补** —— ' +
      '那样写出来的编号和版面的对不上,整份报纸会把每个人的话安到别人头上。',
    'newspaper.material.pulse.chosen':
      '【本期 {chosen} 条】今天全天一共 {total} 条;你在上一步挑了 {picked} 条(不够时 popclaw 会按热闹补齐),' +
      '其中 {dropped} 条的素材放不进这一页,所以**本页是 {chosen} 条**。\n' +
      '这 {chosen} 条里,**要你写的是 {toWrite} 条**;另外 {laidOut} 条是坊事件,版面按它自己的字段照排,不用你写。\n' +
      '所以**下面的编号会跳号(比如 [1][2][4]),那是正常的,不是被截断**。\n' +
      '{integrity}',
    'newspaper.material.pulse.head': '【素材 — 只能用这些】共 {count} 条,每条字段如下(空字段就别用):',
    'newspaper.material.pulse.author': '[{i}] 作者: {who}',
    'newspaper.material.pulse.unattributed': '(无署名) · {platform}',
    'newspaper.material.pulse.reasons': '荐因素材: {reasons}',
    'newspaper.material.reason.taste': '品味命中「{tag}」',
    'newspaper.material.reason.relation': '你关注的 {who} 回过他',
    'newspaper.material.pulse.house': '灯坊: {house}',
    'newspaper.material.pulse.kind': '事件类型: {kind}',
    'newspaper.material.pulse.houseFields': '灯坊事件字段(灯坊自报,原样): {fields}',
    'newspaper.material.pulse.original': '原帖: {url}',
    'newspaper.material.pulse.discussion': '围观(popclaw.me 讨论页): {url}',
    'newspaper.material.pulse.picture': '配图: {urls}',
    'newspaper.material.pulse.replies': 'reply 数: {count}',
    'newspaper.material.pulse.marks': 'mark 数: {count}',
    'newspaper.material.pulse.body': '正文: {text}',
    // v0.2 密度档：代码在 gather 时按「交情/有图/计数」三个可本地核验的信号定档，
    // 印在素材上让模型知道该写多长，发布时渲染器按同一个档位排版 —— 一个来源，两处用。
    'newspaper.material.tier.card': '人物卡',
    'newspaper.material.tier.brief': '简讯',
    'newspaper.material.button.person': '👤 看这个人',
    'newspaper.material.button.talk': '💬 去围观',
    'newspaper.material.button.talkAlso': '💬 围观又记',
    'newspaper.material.button.original': '↗ 查看原文',
    'newspaper.material.button.visit': '🚪 去做客',

    // -------------------------------------------------------------------
    // v0.2 报纸版面（newspaper/render-newspaper.ts）。版面归代码之后，这些字样
    // 由渲染器直接印上版面 —— 以前它们散在 layout.md / content.md 的法典正文里，
    // 靠模型抄。措辞以主人认可的 2026-08-25 15:00 那期为准。
    // -------------------------------------------------------------------
    'newspaper.page.followers.plain': '{n} 粉',
    'newspaper.page.followers.k': '{n}K 粉',
    'newspaper.page.followers.m': '{n}M 粉',
    'newspaper.page.followers.wan': '{n} 万粉',
    'newspaper.page.followers.yi': '{n} 亿粉',
    'newspaper.page.miscRow': '{kind}（{fields}）',
    'newspaper.page.ordinal.1': '一',
    'newspaper.page.ordinal.2': '二',
    'newspaper.page.ordinal.3': '三',
    'newspaper.page.ordinal.4': '四',
    'newspaper.page.ordinal.5': '五',
    'newspaper.page.ordinal.6': '六',
    'newspaper.page.ordinal.7': '七',
    'newspaper.page.ordinal.8': '八',
    'newspaper.page.ordinal.9': '九',
    'newspaper.page.character.talk': '言论',
    'newspaper.page.character.deeds': '行迹',
    'newspaper.page.also': '又记：',
    'newspaper.page.newbieDeck': '▌末版 · 今日新人热榜',
    'newspaper.page.newbieHead': '{paper} · {date} · 末版 · {count} 人',
    'newspaper.page.newbieBasis': '▢ 排序依据：本机首见天数（近者在前），共 {count} 人；回声 = 回 + 收。',
    'newspaper.page.rosterGap': '名录 {listed} 人，本期出场 {cast} 人 —— 差额是没有主页可指的作者。',
    'newspaper.page.items': '{count} 条',
    'newspaper.page.people': '{count} 人',
    'newspaper.page.newcomer': '本机首见第 {days} 天',
    // （newspaper.page.following 已删：D5 之后页面不再烤 isFollowing，「已关注」
    // 改由读者证脚本客户端标记，走 page.followFollowed——该键零消费者，2026-08-31 清点移除。）
    'newspaper.page.notFollowing': '未关注 ➕',
    // 门铃制(spec §7 文案表):按钮五面 + 提示条两行 + 无身份 tag + 报头署名 + 页脚三行
    'newspaper.page.followCta': '关注 ➕',
    'newspaper.page.followSent': '已递 · 待确认',
    'newspaper.page.followExists': '已在待关注清单',
    'newspaper.page.followFail': '没递出去，点一下重试',
    'newspaper.page.followFollowed': '已关注 ✓',
    // 主人 2026-09-13 裁定：➕ 记在「点它的读者」名下，认人靠读者证。没配对的
    // 浏览器点了什么也不记——按钮这一面是指路，不是回执，点完仍可再点。
    'newspaper.page.followPairFirst': '先配对这个浏览器 ➕',
    'newspaper.page.followPairHint': '这个浏览器还没配对，刚才那下没记上——按页顶提示把号码发给你的 PopClaw，配对后点过的都算你的',
    'newspaper.page.followStripOwner': '已递给你的 PopClaw，去对话里确认就关注',
    'newspaper.page.followStripGuest': '点过的都记在你自己的 PopClaw 里，与这份报纸的主人无关',
    // 点击时机的配对提示（主人 2026-09-01 裁定登录心智；2026-09-13 起点击归点击者本人）。
    'newspaper.page.followStripLogin': '想让点过的关注和「已关注」都算你的？对 PopClaw 管家说：配对 {code}',
    'newspaper.page.externalTag': '外部平台',
    'newspaper.page.mastheadOwner': '报主：{owner}',
    'newspaper.page.footerOwner': '点过的关注会递到你自己的 PopClaw，读完回到对话里说一声就关注——它稍后也会来问',
    'newspaper.page.footerShare': '这是{owner}的报纸 · 想自己关注谁？跟你的 PopClaw 说：关注 名字#印信（还没有？popclaw.me）',
    'newspaper.page.footerExternal': '标「外部平台」的作者转载自其他网站，还没有 PopClaw 身份，暂时无法关注',
    'newspaper.page.why': '为你圈的：{reason}',
    'newspaper.page.note': '▢ 本报按：{text}',
    'newspaper.page.replies': '{count} 回',
    'newspaper.page.marks': '{count} 收',
    'newspaper.page.asOf': '灯坊给的状态，截至 {time}',
    'newspaper.page.visitsToday': '今日到访 {count}',
    'newspaper.page.builtAt': '落成 {date}',
    'newspaper.candidates.head':
      '你在为{owner}编{date}的报纸。**这一步只挑，不写。**今天全天一共 {total} 条,**这一页列出其中 {shown} 条**(另外 {trimmed} 条没放下,见下)。读完这一页,然后说哪些该上报。\n' +
      '**只回编号** —— 一次简短的工具调用,不要写正文、不要把条目复述回来。' +
      '**按人逐摞地判**:一个人一个人往下看,决定他今天有几条值得上报(一条都不上也行,最多 {perAuthor} 条),' +
      '记下那几个编号。按人归摞就是为了让你一个人只判一次 —— 几百行逐条纠结,有些模型会在给出答案之前' +
      '先把答题预算耗光。' +
      '下面的编号从 1 到 {total} 依次排下来(按作者归摞)。{integrity}\n' +
      '**这一页的批次标识是 candidate_basis="{token}"** —— **逐字**照抄进你的 picks 调用(不要写 `***`、`<token>` 这类占位符),' +
      '页尾还会再给你一次;哪怕这一页真被截掉了一半,有它就能接着往下走。令牌形式是 candidate_token="{token}" —— ' +
      '同一个值,你那边传得准就用它;candidate_basis 是普通字段、不是 `*_token` 参数,洗令牌的信道对它没有规则可施。\n' +
      '**既没带 candidate_basis、也没有可用 candidate_token 的 picks 调用会被拒发,绝不靠猜** —— 也**绝不要为了「对不上」反复重取素材**,那会一直转下去。',
    'newspaper.candidates.ladder':
      '【怎么挑 —— 按这个顺序】\n' +
      '1. **主人的口味**。下面那份口味档案里的事,优先上 —— 这是这份报纸属于他、而不是一条信息流的原因。\n' +
      '2. **他认识的人**。交情簿里的人发的事;以及值得他认识的新面孔。\n' +
      '3. **然后才是热闹的**,用来把剩下的名额填满:有人回应过的、带图的、第一次在这里出现的面孔。\n' +
      '**硬规矩:同一个人今天最多 {perAuthor} 条** —— 一个人再能发,也不许占掉一天。\n' +
      '**挑多少,你自己定。** 没有硬指标。下一步你要**为挑中的每一条写出足以让主人产生兴趣的字**——' +
      '一两句话打发过去的条目,他读了也不会想去关注那个人,那这一条就白占了版面。' +
      '所以**宁可少而写透,不要多而写薄**:挑你这一轮真写得动的量。{min} 到 {max} 条是个常见的落点,' +
      '不是指标;你的模型写得动更多就多挑,写不动就少挑。' +
      '**但别太少**——少于 {floor} 条读起来就是一份空报纸,那时候 popclaw 会自己按热闹补齐,并在版面上写明补了几条。',
    // 「这一页完整」这句保证,只在真知道这台机器的上限时才说得出口(主人 2026-08-30 裁定 C)。
    // 不知道时说实话,并给模型一条诚实的出路 —— 否则它发现缺页的唯一出路就是不信我们、
    // 自己去 feed 取数据,那正是 2026-08-29 认错人那次的起点。
    'newspaper.candidates.batch.sentinel':
      '[popclaw] END OF CANDIDATE PAGE — {count} candidates — candidate_basis {id} — page complete',
    'newspaper.candidates.batch.head':
      '【这一页】本页列了 {count} 条候选,编号 1 到 {count} 连号不跳。' +
      '本页以这一行收尾 —— 它自带宿主保尾所需的英文词,所以看不见它就是被截过:\n' +
      '{sentinel}',
    // 同素材页:「怀疑短了该怎么做」在 CHILD_SYSTEM_PROMPT 里。
    'newspaper.candidates.cutShort.suspected':
      '【怀疑短了却没有任何说明时】就着读得到的编号挑完并交上去,不要重取候选,也不要停。',
    'newspaper.candidates.integrity.known':
      '**这一页是完整的:一条不缺、没有任何内容被截断。**',
    'newspaper.candidates.integrity.overBudget':
      '⚠️ **这一页放不下今天的全部**:已经裁到能装的条数,而且很可能**仍然超过这台机器的上限({budget})**。' +
      '也就是说宿主有可能把这一页的中间截掉一段。\n' +
      '**如果你发现中间缺了内容,那多半是真的缺了** —— 就按「缺了」处理:用你看得见的那些把这一步做完,' +
      '并在下一步的回执里说一声。**绝不要自己去 feed 或凭记忆补** —— 那样补出来的编号跟 popclaw 的对不上,' +
      '整份报纸会把每个人的话安到别人头上。',
    'newspaper.candidates.integrity.estimated':
      '**这一页是按预估容量({budget})排的** —— 这台机器的真实上限还没报给 popclaw,所以这一次不敢向你保证完整。\n' +
      '**万一你真的发现中间缺了内容:就按「缺了」处理** —— 用你看得见的那些把这一步做完,' +
      '并在下一步的回执里说明缺了哪一段。**绝不要自己去 feed 或凭记忆补数据** —— ' +
      '那样补出来的编号和 popclaw 的对不上,整份报纸会把每个人的话安到别人头上。',
    'newspaper.candidates.taste.head': '【主人的口味 —— 他自己写的,和已经学到的】',
    'newspaper.candidates.taste.none': '(还没有记录 —— 那就按交情簿和热闹程度挑)',
    'newspaper.candidates.bonds.head': '【主人的交情簿 —— 共 {count} 人】',
    'newspaper.candidates.bonds.none': '(还是空的 —— 一个人都还没有)',
    'newspaper.candidates.list.head': '【今天的候选 —— 共 {total} 条,按谁写的归摞】',
    'newspaper.candidates.author': '== {who} · 今天 {count} 条 ==',
    'newspaper.candidates.authorBonded': '== {who} · {bond} · 今天 {count} 条 ==',
    'newspaper.candidates.loose': '== 零散来稿 · {count} 条,来自只写了一两条的人 ==',
    'newspaper.candidates.mark.media': '[图]',
    'newspaper.candidates.mark.replies': '[{count} 回应]',
    'newspaper.candidates.mark.newFace': '[新面孔]',
    'newspaper.candidates.handIn':
      '【你要交回什么】**再调一次** popclaw_newspaper,带上 candidate_basis="{token}" ' +
      '(从这一行照抄,绝不要凭记忆写),以及你挑的编号,' +
      '**按「为什么挑它」分成三组**:`picks={"taste":[…], "bond":[…], "lively":[…]}`。' +
      '(candidate_token="{token}" 也行 —— 你那边传得准就用它;candidate_basis 连令牌都不需要。)' +
      '**这个值不是你之后交稿的 `edit.basis`**:接下来那页素材会印出它自己的标识,`edit.basis` 要填的是那一个。' +
      '只回编号,绝不要把正文复述回来。挑多少你自己定({min}-{max} 条是常见落点,不是指标),同一个人最多{perAuthor}条。' +
      '分组是为了让报纸能如实告诉主人:这一期有多少是为他挑的、多少只是填热闹 —— ' +
      '所以每个编号放进它真正凭什么上榜的那一组。然后你会拿到这些条目的完整素材。',
    // 2026-09-06 r25 —— picks 归属闸,把出版的无猜测契约前移一步:picks 里的编号是
    // **某一页**候选页上的位置,只有指名那一页的字段才说得清是哪一页。候选页把
    // 自己的批次标识印成 `candidate_basis`(顶部与页脚各一次)—— 这是协议要求,不是任何
    // 宿主必然保留的物理保证,所以下面这些拒绝必须存在。任何拒绝都不消耗账本。
    'newspaper.picks.noProvenance':
      '⚠️ 这次 picks 既没有可用的 candidate_token,也没带 `candidate_basis`,无从知道你的编号指的是哪页候选页 —— **没有挑刊**,什么账都没动。\n' +
      '**把候选页上(顶部与页脚)印的 `candidate_basis` 行原样抄进这次调用,把 picks 再交一遍** —— 这一步就能说清批次,不需要令牌。' +
      '(候选页不在了 —— 取材超过 2 小时会被账本丢掉?调 popclaw_newspaper 不带参数取新页重挑。)\n' +
      '按猜出来的批次挑,成刊里每条素材都会挂到别人名下;宁可拒发,不可错发。',
    'newspaper.picks.tokenBasisConflict':
      '⚠️ 这次调用带着 candidate_basis {basis},candidate_token 却是 {token} —— 两份不同的候选页,**没有挑刊**,什么账都没动。\n' +
      '你 picks 里的编号指的是 `candidate_basis` 命名的那页,令牌指向的是另一份。只带回真正读过的那页上印的一个再交(把它页上的 `candidate_basis` 行留在调用里);拿不准就调 popclaw_newspaper 不带参数,从新页重挑。',
    'newspaper.picks.basisExpired':
      '⚠️ 这次调用带着 candidate_basis {basis},但已没有活着的候选页应答(取材超过 2 小时,账本会丢页)—— **没有挑刊**,什么账都没动。\n' +
      '调 popclaw_newspaper 不带参数取新的候选页重挑 —— 一页上的编号,搬到另一页上必错。',
    'newspaper.picks.basisNotCandidate':
      '⚠️ 这次调用带着 candidate_basis {basis},而那不是候选页的标识(候选标识以 `ctok_` 开头)—— **没有挑刊**。\n' +
      '只抄候选页自己印的 `candidate_basis` 行 —— 不要凭记忆,也不要抄发布回执上的;素材页自己的标识属于 `edit.basis`,不属于这里。',
    'newspaper.page.pickedFor.taste': '合你口味',
    'newspaper.page.pickedFor.bond': '你认识的人',
    'newspaper.page.chosen': '本期:合你口味 {taste} 条 · 你认识的人 {bond} 条 · 填热闹 {lively} 条',
    'newspaper.page.unwritten': '另有 {count} 条本期未及成文,未予刊出',
    'newspaper.page.translated': '(译文,原文见悬停)',
    'newspaper.page.sectionTheme': '{section} · {theme}',
    'newspaper.page.section.leads': '要 闻',
    'newspaper.page.section.cards': '人 物',
    'newspaper.page.section.briefs': '简 讯',
    'newspaper.page.section.letters': '世 界 来 信',
    'newspaper.page.section.postcards': '明 信 片',
    'newspaper.page.section.chron': '江 湖 人 情',
    'newspaper.page.section.homes': '值 得 一 逛 的 家',
    'newspaper.page.section.places': '热 闹 去 处',
    'newspaper.page.section.misc': '附 记',
    'newspaper.page.deckName': '▌第{index}叠 · {house}',
    'newspaper.page.deckCount': '{paper} · {date} · 第{index}叠 · {character} · {count} 条（含头版 {front} 条）',
    'newspaper.page.houseList': '灯坊给的名单，截至 {asOf}',
    'newspaper.page.onFront': '本栏 {count} 条已提上头版。',
    'newspaper.page.quietHouse': '本灯坊今日无新事。',
    'newspaper.page.ear.awaiting': '待 回',
    'newspaper.page.ear.newFaces': '生 面 孔',
    'newspaper.page.ear.ledger': '本 期 账',
    'newspaper.page.noPings': '今日无人来信，待回 0 封。',
    'newspaper.page.deckTally': '{house} {count} 条',
    'newspaper.page.ledgerTotals': '出场 {people} 人 · 上版 {laidOut} 条（今日共收编 {gathered} 条）· 头版 {front} 条',
    'newspaper.page.ledgerEchoes': '全报 {replies} 回 · {marks} 收',
    'newspaper.page.ledgerPings': '待回 {pings} 封 · 世界来信 {letters} 封',
    'newspaper.page.ledgerBasis': '计数体例：回 = 回复，收 = 收藏；量词全报统一用「条」。',
    'newspaper.page.byline': '本报 AI 主笔 Pop 编次',
    'newspaper.page.weather': '今日收编 {total} 条 · 待回 {pings} 封 · 世界来信 {letters} 封 · 风向：{drifts}',
    'newspaper.page.roster': '今 日 名 录',
    'newspaper.page.newbies': '今 日 新 人',
    'newspaper.page.oneDeck': '江湖',
    'newspaper.page.otherHouses': '他坊拾遗',
    'newspaper.page.colophon': '—— 本期完 · 本报由 Pop 用你的助手所用的模型编次 · 素材 {count} 条 ——',
    'newspaper.page.colophonShared': '—— 本期完 · 本报由 Pop 用你的助手所用的模型编次 · 素材 {count} 条 · 分享链接上留一份，24 小时后作废 ——',
    'newspaper.material.button.home': '🚪 去它家',
    'newspaper.material.button.back': '🖼 看背面',
    'newspaper.material.button.sigil': '👤 碰印',
    'newspaper.material.button.world': '🚪 去世界',
    // 关注门铃（follow-doorbell §6.4/§7）：汇总 L1 / 微型 L1 / 注入指针全套。
    // zh 逐字节来自规格 §7 的文案表。
    'newspaper.doorbell.head': '在报纸上收到 {count} 位待关注：',
    'newspaper.doorbell.entry': '{i}. {name}{descriptor}',
    'newspaper.doorbell.entryDescriptor': '（{descriptor}）',
    'newspaper.doorbell.moreSuffix': '，等 {count} 位',
    'newspaper.doorbell.valueSentence': '—— 关注后，他们的新帖和动向会进你的日报。',
    'newspaper.doorbell.replySyntax': '回「都要」或数字（如「1 3」）都行，没点到的当跳过；「不要」=这批都不要',
    'newspaper.doorbell.overflowNote': '另有 {count} 位因量多未记（其中可能包含他人点的）',
    'newspaper.doorbell.linkTail': '报纸链接别人也能点——非你所点，直接回「不要」',
    'newspaper.doorbell.droppedMicro': '今天点的 {count} 位（{names}）都已在关注里，没重复记',
    'newspaper.doorbell.nameSep': '、',
    // 主人 2026-09-13 裁定：意图记在读者名下，因此清单里会出现别人报纸上的
    // 作者——本机没有他们的作者行，来路只能照实说一句。
    'newspaper.doorbell.foreignDescriptor': '在别人的报纸上',
    // 认报（follow-doorbell §5.3 主人这条腿）：popclaw_pair_browser 的回执，
    // zh 逐字节来自 task brief。
    'newspaper.doorbell.pairOk': '配对好了 ✓ 这个浏览器以后就是你的——不管谁分享的页面，你点过的关注和「已关注」都算你的账',
    'newspaper.doorbell.pairFail': '没配上（号码可能过期或不匹配）——刷新那个页面取个新号码再试',
    // 注入乘客（follow-doorbell §6.4 注入块 + §7 注入指针）。指针逐字节来自
    // 规格 §7；规则逐字来自 brief/规格 §6.4–§6.5 的执行规则清单（report 一条
    // 为 T13 追加：批量回执是 agent 自组文，规则行本身就是回执文案指引）。
    'newspaper.doorbell.inject.head': '待关注清单（{count} 位）：',
    'newspaper.doorbell.inject.entry': '{i}. {name}{descriptor}',
    'newspaper.doorbell.inject.entryDescriptor': '（{descriptor}）',
    'newspaper.doorbell.inject.rule.echo': '≥6 位或含糊：先回显整批（带总数）再执行',
    'newspaper.doorbell.inject.rule.natural': '回复示例仅是示例，自然语言均接受',
    'newspaper.doorbell.inject.rule.skip': '「不要」=这批全跳过；未点到=跳过',
    'newspaper.doorbell.inject.rule.offTopic': '话题无关不必提起',
    'newspaper.doorbell.inject.rule.report':
      '批量执行后按人数汇报（成功 N/失败 M 与名字），点错的指引一句「取消关注 名字」',
    'newspaper.doorbell.inject.pointer': '还有 {count} 位待关注——说「关注清单」我摊开',
    'newspaper.doorbell.inject.pointerEntry': '{i}. {name}',
    // 次日捎带（follow-doorbell §6.5 兜底腿）：次日报纸投递消息末尾的编号残单。
    // zh 逐字节来自规格 §7 文案表（{list} 为代码拼的编号名单）。
    'newspaper.doorbell.piggyback':
      '昨天的报纸还有 {n} 位待关注：{list} —— 回数字或「都要」，不回的话 48 小时后我就不提了',

    // -------------------------------------------------------------------
    // Rollout slice 4 — popclaw_show_bonds / popclaw_set_remark_name
    // (commands/popclaw-bond.ts). zh byte-for-byte from the pre-lexicon source.
    // -------------------------------------------------------------------
    'bond.summary': '关注 {following} · 好友 {friends}',
    'bond.empty': '交情本还是空的。',
    'bond.listHeader': '交情本（{count}）：',
    'bond.followedMarker': ' ·关注',
    'bond.noFollows': '还没关注任何人。',
    'bond.followsHeader': '关注（{count}）：',
    'bond.unknownVerb': '未知动作 "{verb}"。用法：/popclaw bond add|close|block|reject <who> | remark <人> [备注名] | list | follows',
    'bond.missingWho': '请指定对象：/popclaw bond {verb} <popclaw_id>',
    'bond.tierSet': '已把 {who} 设为「{tier}」。',
    'bond.remark.usage':
      '请指定对象：/popclaw bond remark <名号#印信 | 印信 | popclaw_id> <备注名>\n' +
      '（不写备注名 = 清空，称呼回落到他的自报名号）',
    'bond.remark.noResolver': '"{ref}" 不是完整 popclaw_id，这条通路也没接认人解析器。',
    'bond.remark.noWriteAccess': '⚠️ 这条通路没接交情本写入口。',
    'bond.remark.cleared': '已清空备注名，以后他叫「{name}」（他的自报名号）。',
    'bond.remark.set': '✓ 记下了，以后他就叫「{name}」。',

    // -------------------------------------------------------------------
    // Rollout slice 4 — popclaw_decide_bond_tier_proposal (register-tools.ts).
    // zh byte-for-byte from the pre-lexicon source.
    // -------------------------------------------------------------------
    'bond.proposal.notFound': '没有找到 {who} 的待决提议。',
    'bond.proposal.accepted': '✅ 已把 {who} 升为「{tier}」。',
    'bond.proposal.rejected': '好，保持「{tier}」不变。',
    'bond.proposal.deferred': '好，先放一放，过阵子信号还强我再提。',

    'bond.proposal.rationale': '最近 30 天互动 {count} 次',
    'bond.proposal.rationaleWith': '最近 30 天互动 {count} 次——{what}',
    'bond.proposal.pendingEmpty': '当前没有待决的升降级提议（0 条）。',
    'bond.proposal.pendingHeader': '待决提议（{count} 条）：',
    'bond.proposal.pendingLine': '{n}. {who} — {from} → {to}（{rationale}）',
    'bond.proposal.pendingFooter': '用 popclaw_decide_bond_tier_proposal 逐条决定。',

    'bond.mute.all': '行，以后不再提这些入住的小事了。',
    'bond.mute.one': '行，这件事我不再提了。',

    // -------------------------------------------------------------------
    // Rollout slice 4 — the popclaw_draft_message unverified-recipient
    // warning shared with popclaw_send_draft's preview chain
    // (tools/register-tools.ts unverifiedWarning). zh byte-for-byte from
    // the pre-lexicon source.
    // -------------------------------------------------------------------
    'draft.unverified.offline': '   ⚠️ 灯坊暂时失联，没法确认这个 id 是谁——确定就发。\n',
    'draft.unverified.unknown': '   ⚠️ 灯坊里查不到这个 id（没名片也没核验账号）——先确认它真是你要找的那个人。\n',
    'draft.unnamedRecipient': '   ⚠️ 这位没有名号——本地只知道有这么个 id（你关注过他、或在世界流里见过），灯坊没被问过。印信是对的，但"是不是你要找的那个人"没有被确认过。\n',
    'draft.presend.notFollowingYou':
      '   💡 对方还没关注你——信照样送到他信箱，但不会主动弹给他，他得自己去翻。' +
      '想更快被看见：先关注他，或者请他关注你。\n',
    // 插件推的那一份预览走的是本轮自己的聊天，审批弹窗走的是宿主配的路由。
    // 两者不是同一个聊天时，不该发生的是推预览——批准按钮出现在主人私聊里，
    // 从来不能证明之前的全文也在那个私聊里
    //（2026-09-21T20:09Z 裁定，tools/draft-preview-delivery.ts）。
    'draft.message.emptyBody': '这封信是空的：给句话（body），或者给张图（image_path），至少要有一样。',
    'draft.message.attach': '   📎 附件：{name}（{size}）\n',
    'draft.message.imageOnly': '   （纯图，无正文）\n',
    // 长草稿的只读审阅副本（src/tools/draft-review.ts）。入口放在草稿工具结果里：
    // 智能体先把链接那一行原样发给主人，再请他审批。点链接即打开文件。
    'draft.review.entry': '完整稿件：{link}。请在本聊天看稿后确认发送。',
    'draft.review.linkText': '审阅草稿 {id} \u2014 全文',
    'draft.review.writeFailed': '未能写入可选看稿文件。请在原聊天展示本工具结果中的完整稿件。',
    'draft.review.file.heading': '# PopClaw 草稿审阅副本（只读；不会从这个文件发出任何东西）',
    'draft.review.file.header': '草稿：{id}\n发给：{to}\n灯坊：{house}\n附件：{attachments}\n正文：{chars} 字，摘要 {digest}',
    'draft.review.file.none': '（无）',
    'draft.review.file.bodyLabel': '全文，与发出去的一字不差：',
    'draft.review.file.end': '\u2014 草稿 {id} 到此结束 \u2014',
    'draft.message.title': '📝 私信草稿：发给 {who}',
    // 措辞与它替换掉的硬编码版本一致（2026-09-22）：要让 agent 自己找得到出路，
    // 而不是逼它去信「必须连着快点调」这种迷信。
    'draft.expiredToken':
      'draft_id 不认识或已过期：{token}\n'
      + 'draft_id 只能用一次（发出即作废），草稿 30 分钟后自动过期。\n'
      + '重新调一次对应的 popclaw_draft_* 工具拟一份新草稿，请主人确认，再发。',
    // -------------------------------------------------------------------
    // 仍需审批的操作共用的主人确认文案。
    'ownerApproval.confirm.title': '批准这次操作',
    'ownerApproval.confirm.description': '批准上面描述的这一次操作。拒绝或取消则什么都不会发生。',
    // world 动作的 MCP 确认对话框里唯一的输入项（host/mcp-owner-authorization.ts）。
    // 说的是执行这个动作，不是发送草稿。{ref} 是回执上也带着的六位确认编号。
    'world.action.approval.confirm': '执行此动作',
    'world.action.approval.timedOut': '确认窗口在收到回答之前就关闭了，什么都没有执行。如果确认对话框还开着，现在点同意也不会执行这个动作——问主人，再重新发起一次',
    'world.action.approval.confirmDescription': '执行上面描述的这一次世界动作（ref {ref}）。拒绝或取消则什么都不会发生。',
    // 普通社交发送的调用边界与兼容提示。
    'socialSend.recipient': '发送对象：{recipient}',
    'socialSend.sourcePreview': '来源预览：{context}',
    'socialSend.sourceAuthor': '来源作者：{author}',
    'socialSend.replySource': '回复来信 {id}（事件 {eventId}）',
    'socialSend.sourceUnavailable': '这条目标的来源上下文暂不可用。请在本聊天核对目标，再确认稿件。',
    'socialSend.house': '灯坊：{house}',
    'socialSend.materialChanged': '未发送：草稿内容或附件已改变。请展示原定的新稿件和附件，给主人确认。',
    'socialSend.ownerRequired': '未发送：当前宿主调用无法确认主人权限。请在本聊天说明宿主限制，不要更换路由或自行授予权限。',
    'socialSend.conversationChanged': '未发送：这份草稿属于另一个会话。请在本聊天准备原定稿件，给主人看稿确认。',
    'socialSend.reviewChanged': '未发送：看稿副本已改变或丢失。请展示原定稿件的新副本，给主人确认。',
    'socialSend.approvalsRetired': '私信、回复和发帖只需在本聊天看稿确认一次，无需准备 PopClaw 审批路由。现有宿主审批配置未改动。',
    'draft.postref.publicUnavailable': '暂时无法核对这条帖子，请稍后重试。',
    'draft.postref.publicAmbiguous': '这个短引用对应多条帖子，请提供更明确的帖子链接。',
    'draft.postref.publicNotFound': '未找到这条帖子，请检查帖子链接。',
    'draft.postref.notHex':
      '⚠️ 这不是有效的帖子引用（{ref}）：需要完整 64 位十六进制 event_id、至少 6 位的短 id、或本站 /post/ 链接。',
    'draft.postref.tooShort': '⚠️ 短 id 太短：至少要 6 位十六进制（收到：{ref}）。',
    'draft.postref.tooLong': '⚠️ 引用太长：event_id 最多 64 位十六进制（收到 {len} 位）。',
    'draft.postref.untrustedUrl':
      '⚠️ 只接受本站链接（{web}/post/<短id>），别的网址不能当帖子引用：{ref}',
    'draft.postref.absent':
      '⚠️ 短引用 {ref} 在受信任来源里查不到（本地缓存和最近读过的帖子都对不上）。先用 popclaw_author_latest 找到那条帖子拿它的链接，或改用完整 64 位 event_id。',
    'draft.postref.cacheUnreadable':
      '⚠️ 本地缓存这一刻读不了，没法核验短引用 {ref} 是不是唯一——撞前缀的帖子可能正看不见。稍后再试，或改用完整 64 位 event_id。',
    'draft.postref.ambiguous':
      '⚠️ 短引用 {ref} 撞了 {count} 条帖子：{list}——多用几位字符，或改用完整 64 位 event_id。',

    // -------------------------------------------------------------------
    // Rollout slice 4 — popclaw_find_bonds empty-query guard
    // (tools/register-tools.ts). zh byte-for-byte from the pre-lexicon source.
    // -------------------------------------------------------------------
    'find.emptyQuery': '请给一句话,如"我的生意伙伴最近动态"。',

    // -------------------------------------------------------------------
    // Rollout slice 4 — popclaw_note_taste (tools/register-tools.ts). zh
    // byte-for-byte from the pre-lexicon source.
    // -------------------------------------------------------------------
    'taste.note.empty': '想记什么？一句话说说你关心（或不想看）什么。',
    'taste.note.saved': '记下了，进了你本机的口味档案（永不上传）。日报和推荐会照着它来。',

    // -------------------------------------------------------------------
    // Rollout slice 4 — popclaw_write_taste (taste/write-taste.ts). zh
    // byte-for-byte from the pre-lexicon source.
    // -------------------------------------------------------------------
    'taste.write.tagsEmpty':
      '⚠️ tags 是空的 —— 只有标签能被本地匹配（每次工具调用都要用，跑不起 LLM）。\n' +
      '如果你确实没挖到有证据的东西，**就直说没挖到**，别用人设凑数：' +
      '空着还能被 /popclaw status 提醒补上，编出来的会一直骗下去。',
    'taste.write.saved': '✅ 写好了 → {file}',
    'taste.write.likes': '爱看：{tags}',
    'taste.write.mute': '不想看：{mute}',
    'taste.write.muteEmpty': '（空 —— 没挖到证据，没编）',
    'taste.write.merged': '（跟上次挖到的合并了；本次新增：{added}）',
    'taste.write.noneAdded': '无',
    'taste.write.sep': '、',
    'taste.write.footer':
      '哪条不对，跟我说一声我就改；也可以直接改那个文件。' +
      '你自己写下的口味（core 层）永远压过我猜的这一层。',

    // -------------------------------------------------------------------
    // Rollout slice 4 — popclaw_dream / popclaw_record_dream
    // (dreamer/dream.ts). Owner-facing receipts only — the LLM-facing
    // dream material itself (buildDreamPayload) is S2 scope and lives in
    // plain English, not here. zh byte-for-byte from the pre-lexicon source.
    // -------------------------------------------------------------------
    'dream.emptyMaterial':
      '🌙 [{window} → 今天] 这段没有新素材：关注的人没有新帖，我自己也没有社交动作。\n' +
      '如果你确实一直在用，那更可能是世界流没进来 —— 用 /popclaw status 看看。',
    'dream.tokenExpired': '⚠️ 这场梦的素材令牌已过期，请重新调 popclaw_dream 取一次素材再想。',
    // dream_basis 兼容腿（主人授权 2026-09-06）—— 报纸
    // edit.basis 协议的 dream 版。每条拒收都说清「未销账」：改好字段还能对
    // 同一份素材重新提交。
    'dream.tokenBasisConflict':
      '⚠️ dream_token 和 people 里带回的 dream_basis 指向两批不同的素材（token="{token}"，basis="{basis}"）—— ' +
      '不猜，本次拒绝，未写入任何东西、未销账。同一张素材页印出的两个名字本是同一个值：' +
      '回到你得出这些结论的那张素材页核对，把配好对的一组重新提交。',
    'dream.basisContradictory':
      '⚠️ 这次写回带回了互不相同的 dream_basis（{bases}）—— 一场梦只对应一批素材，挑其中一个就是猜。' +
      '本次拒绝，未写入任何东西、未销账。请回到你实际用的那张素材页，只交它印出的那一个 dream_basis。',
    'dream.noProvenance':
      '⚠️ 这次写回既没有可用的 dream_token，也没带回 dream_basis（缺失或被替换成占位符）—— ' +
      '无法证明这批结论对应哪份素材，未写入任何东西、未销账。请重新调 popclaw_dream 取材，' +
      '把素材页印出的 dream_basis 作为 dream_basis 参数交回（没有人物要报告也能交），再提交一次。',
    'dream.basisExpired':
      '⚠️ dream_basis 对应的素材已不在有效期内 —— 与令牌过期同一条规则：拒绝，未写入任何东西、未销账。' +
      '请重新调 popclaw_dream 取一次素材再想。',
    'dream.tagsEmpty':
      '⚠️ taste.tags 是空的 —— 只有标签能被本地匹配，散文每次都得跑 LLM（订阅机上跑不了）。\n' +
      '请把主人爱看的话题写成 3-8 个短标签再调一次（mute 是不想看的，可以为空）。',
    'dream.part.updated': '更新了 {n} 个人的画像',
    'dream.part.dynamics': '记下 {n} 条近况',
    'dream.part.milestones': '其中 {n} 件大事',
    'dream.part.proposals': '{n} 条交情升档待你拍板（/popclaw bond proposals）',
    'dream.partSep': '，',
    'dream.sep': '、',
    'dream.receipt': '🌙 梦做完了：{parts}。口味也更新了：{tags}。',
    'dream.scheduleInvite':
      '\n\n要我每天凌晨 3 点自动做一次吗？跟我说一声就行 —— 做梦不占你的注意力，' +
      '你不会收到任何消息，只是第二天的推荐和报纸会更懂你。',

    // -------------------------------------------------------------------
    // Rollout slice 5 — /popclaw feedback + popclaw_feedback
    // (commands/popclaw-feedback.ts). zh byte-for-byte from the pre-lexicon
    // source.
    // -------------------------------------------------------------------
    'feedback.usage':
      'usage: /popclaw feedback bug|need [--house <灯坊 slug>] <按 guide.md 模板整理的正文>\n' +
      '  need = 想替主人做而 popclaw 做不到；bug = 应该能做却坏了（未被支持的需求比 bug 更珍贵）\n' +
      '  --house = 反馈跟着墙走：说的是某座灯坊自己的玩法就填那座灯坊（popclaw.world 或\n' +
      '            house-popclaw-world 均可）；popclaw 本身的问题（命令/通知/报纸/协议）不填，发主灯坊；\n' +
      '            那座灯坊没声明联系人时会兜底送主灯坊联系人（信头带原目标灯坊）\n' +
      'example: /popclaw feedback need 想做什么：把整条会话存成帖子；试了什么：/popclaw post，只能发单条；……\n' +
      '（正文模板与脱敏要求见本灯坊 guide.md「有话对官方说」一节）\n' +
      '提示：给推荐条目点赞/踩已改名为 /popclaw react up|down <postId>',
    'feedback.alias.noReact': '给推荐条目点赞/踩请用 /popclaw react up|down <postId>（这条通路只收 bug|need 反馈）。',
    'feedback.alias.renamedSuffix': '（这个用法已改名：请用 /popclaw react up|down <postId>；/popclaw feedback 现在是给官方提意见的通路）',
    'feedback.listSep': '、',
    'feedback.house.ambiguous': '「{ref}」对得上好几座灯坊（{list}），认不准该寄给谁，这条反馈没有发出。请写全一点。',
    'feedback.house.notFound':
      '没有挂着灯坊「{ref}」，这条反馈没有发出。已挂的灯坊：{list}。\n' +
      '到此为止，先问主人指的是哪一座 —— 不要去掉 house 参数重试。',
    'feedback.contact.fallbackFailedMain':
      '灯坊「{target}」没有挂到的说明书、或它的说明书没声明反馈联系人，' +
      '而兜底的主灯坊（{houseSlug}）guide.md 也没有声明联系人，这条反馈没有地方可送，因此没有发出。',
    'feedback.contact.knownHousesLine': '（已挂的灯坊：{list}）',
    'feedback.contact.declareHint': '（联系人写在 guide.md frontmatter 的 feedback.popclaw_id —— 每座灯坊都该声明一个。可以把这句话转告灯坊主。）',
    'feedback.contact.noneAtAll': '这座灯坊（{houseSlug}）的 guide.md 没有声明官方反馈联系人，这条反馈没有地方可送，因此没有发出。',
    'feedback.receipt.wholePrimary': '本灯坊',
    'feedback.receipt.wholeHouse': '灯坊「{target}」的',
    'feedback.receipt.contactSep': '',
    'feedback.receipt.who': '{whose}联系人{contactName}',
    'feedback.kindLabel.bug': 'bug 反馈',
    'feedback.kindLabel.need': '需求反馈',
    'feedback.receipt.fellBackNotice': '灯坊「{target}」未声明反馈联系人，已兜底送往主灯坊联系人（原目标灯坊已标注在信头）。',
    'feedback.receipt.sent': '✅ {kindLabel}已加密送出，只有{who}能读到。',
    'feedback.receipt.inboxNote': '对方回信的话，会出现在你的信箱（/popclaw inbox）。',

    // agent 那条路的草稿预览（tools/feedback-cadence-tools.ts）。反馈信就是一封
    // 对外私信，因此和别的私信一样先给主人过目：寄给谁、是哪座灯坊的联系人、
    // 信的原文一字不差。
    'feedback.draft.title': '📝 {kindLabel}草稿，寄给{who}',
    'feedback.draft.house': '   灯坊：{house} —— 联系人由它的 guide.md 声明',
    'feedback.draft.fellBack':
      '   你点的是「{requested}」，那座灯坊没有声明联系人，因此这封改寄主灯坊；信头仍写着「{requested}」',
    'feedback.draft.attach': '   附件：{path}',
    'feedback.draft.bodyLabel': '   完整信件，与寄出的一字不差：',

    // -------------------------------------------------------------------
    // Rollout slice 6 — bond-context.ts 的 L1 推送尾行。档位词本身走
    // `terms.tier`（`tierLabel()`）；这里只是「最近一次互动」措辞和相对
    // 时间词。zh 值逐字节照抄迁移前的产线原文。
    // -------------------------------------------------------------------
    'bondContext.recentIncoming': '{ago}他给你来过信',
    'bondContext.recentOutgoing': '{ago}你主动找过他',
    'bondContext.ago.today': '今天',
    'bondContext.ago.yesterday': '昨天',
    'bondContext.ago.daysAgo': '{days} 天前',
    'bondContext.ago.weekOne': '1 周前',
    'bondContext.ago.weeksAgo': '{weeks} 周前',
    'bondContext.ago.longAgo': '很久以前',

    // -------------------------------------------------------------------
    // 开机体检（host/integrity-check.ts）。刻意低噪：一条消息、两个动作。
    // 吓住主人却不给路走，比不报还糟。
    // -------------------------------------------------------------------
    'integrity.line.quickCheck': '· {label}：数据库文件报出损坏（{detail}）',
    'integrity.line.foreignKeys': '· {label}：内部关联断裂 —— {detail}',
    'integrity.line.schemaDrift': '· {label}：表/索引结构与上次开机不同，而这中间插件没有升级过',
    'integrity.alert':
      'PopClaw 自检发现异常，你的数据可能被插件之外的东西改动过：\n' +
      '{items}\n\n' +
      '两件事：\n' +
      '① 还原：日备份在 {backups}/my-social-assets-<日期>.db —— 停网关 → 拷回 → 重启（三步详见插件 INSTALL.md 的「升级与回滚」一节）。\n' +
      '② 报给我们：/popclaw doctor send "数据库自检异常"',

    // -------------------------------------------------------------------
    // /popclaw doctor UX 终稿（裁决人 Fable）。全绿 2 行、非绿才逐条列、
    // 判决标签一律 2 个汉字。以下文案除已标注可自由撰写的以外均为该终稿
    // §5.3 逐字条目。
    // -------------------------------------------------------------------
    'doctor.head.allGreen': '🩺 8 项全过 · build {build}',
    'doctor.head.problems': '🩺 体检：{bad} 项要看一下，其余全过 · build {build}',
    'doctor.path': '报告：{path}',
    'doctor.offer.ask': '要寄给你主灯坊公布的联系人吗？跟我说一声「把体检报告寄出去」，我就寄；',
    'doctor.offer.typed': '或者你自己敲：/popclaw doctor send "{seed}"',

    'doctor.check.version': '版本',
    'doctor.check.routing': '路由',
    'doctor.check.tools': '工具',
    'doctor.check.visible': '可见',
    'doctor.check.data': '数据',
    'doctor.check.skill': '手册',
    'doctor.check.lang': '语言',
    'doctor.check.notify': '通知',

    'doctor.bad.routing': '注册上了，但 {turns} 条入站 0 次触发 —— 你说的话没送到我这儿',
    'doctor.bad.visible.profile': '这台机设了 tools.profile="{profile}"，我的工具被整类挡在 agent 外面',
    // 这条 ✗ 分支说的是 profile="coding" 且没有任何白名单，修法只能是 alsoAllow
    // （INSTALL.md Mechanism 1）。让这种机器去写 toolsAllow 会把宿主自带工具一起砍掉
    // ——#338 的 cron 事故正是老文案推荐的那个字段造成的。
    'doctor.bad.visible.fix':
      '  修法：在 tools.alsoAllow 里逐个列出 popclaw 的工具名（见 INSTALL.md Mechanism 1）——' +
      '这台机若本来就有 toolsAllow 白名单，就加进那份名单里，并务必保留 cron——然后重启网关。' +
      '绝不要写 alsoAllow: ["group:plugins"] 或 ["popclaw"]，两者都会把隐藏工具一并放出来',
    'doctor.bad.visible.allowlist': '这台机的 toolsAllow 白名单里只列了 {n} 个 popclaw 工具，其余的 agent 看不到',
    'doctor.bad.version': '装的是 {packed}，跑的是 {running} —— 网关跑的不是这份包',
    'doctor.bad.notify': '上一条推送没送达（{reason}）',
    'doctor.bad.data': '开机自检报出异常（{detail}）—— 详情见插件 INSTALL 的「升级与回滚」',
    'doctor.bad.skill': 'AI 手册没被装进来，agent 遇到不熟的场面只能瞎猜',
    // ponytail: 不在 final doc §5.3 逐字清单里，工具注册数为 0 是本表唯一没给
    // 现成文案的坏分支——照同一种口吻补一句，别留空白。
    'doctor.bad.tools': '这次运行注册了 0 个 popclaw 工具，注册流程可能中途失败了',

    'doctor.seed.routing': '路由不通',
    'doctor.seed.visible': '工具看不见',
    'doctor.seed.data': '数据自检异常',
    'doctor.seed.notify': '通知发不出',
    'doctor.seed.version': '装的版本不对',
    'doctor.seed.default': '哪里不对',

    'doctor.preview.to': '🩺 这封信要寄给：{house} · 它公布的联系人 {contact}',
    'doctor.preview.body': '正文会带：build {build} · {verdict} · 你的话「{note}」',
    'doctor.preview.attach': '附件：{file}（{lines} 行 · 已剥掉你的原话 · 不含密钥和数据库内容）',
    'doctor.preview.peek': '想先自己看一眼：{path}',
    'doctor.preview.confirm': '确认寄出敲 /popclaw doctor send --confirm —— 不寄就不用理它，什么都不会发生',

    'doctor.sent.head': '✓ 已寄出 · 收信人 {contact} · 带了 1 个附件',
    'doctor.sent.tail': '私信是加密的。那座灯坊的联系人看到了会私信回你，没有工单也没有时限。',
    'doctor.stale': '上一份预览过期了（网关重启过）。重新敲一次 /popclaw doctor send "…" 就好。',

    // 命令用法（未被 final doc §5.3 覆盖，随其余 doctor 文案就近补齐）。
    'doctor.usage':
      'usage: /popclaw doctor [send "哪里不对"] [--with-text] [--confirm]\n' +
      '  不带参数        = 只采集、写文件，打印体检结论（全绿 2 行 / 有问题逐条列 + offer）。绝不发送。\n' +
      '  send "..."      = 采集 + 打印 5 行预览。还没有发出去。\n' +
      '  send --confirm  = 看过预览没问题，才真正当作一封带附件的反馈私信发出去（不用重打那句话）\n' +
      '  --with-text     = 日志切片里保留主人自己说过的话（默认剥掉，只有收信的灯坊联系人主动要求时才加）',
    'doctor.send.usage':
      'usage: /popclaw doctor send "哪里不对"（先跑一次 /popclaw doctor 再 send 也行）\n' +
      '（或者只发 /popclaw doctor 不带任何参数，只落盘不发送）',

    // 8 项体检里 ok/未覆盖 warn 分支的措辞（final doc §5.3 只逐字给了 bad 分支；
    // 这些是同一口吻的补齐，用于报告文件与聊天里同一份 reason 字段）。
    'doctor.ok.version': '运行版本与装机记录一致（{build}）',
    'doctor.warn.version.noRecord': '未找到装机记录（data/last-build.json 缺失）——可能是刚装好还没重启过一次',
    'doctor.ok.tools': '本进程已注册 {count} 个 popclaw 工具',
    'doctor.warn.tools.unknown': '这次运行没有拿到已注册工具数',
    'doctor.warn.visible.unreadable': '读不到宿主 openclaw.json——无法判断模型工具表是否放行了 popclaw',
    'doctor.warn.visible.allowlistNoCron':
      '白名单列了 {n} 个工具，但没有 cron —— 排他白名单砍掉的不只是插件，宿主自带的工具同样会消失',
    'doctor.warn.visible.allowlistNoCron.fix':
      '把 cron 加进 openclaw.json 的 tools.toolsAllow（否则 agent 排不了每日报纸这类定时任务，还会显得是模型不中用）',
    'doctor.ok.visible.allowlist': 'toolsAllow 白名单已设置（{n} 项）——以名单为准',
    'doctor.warn.visible.allVisible': '全部 popclaw 工具都可见，包括默认不进日常列表的那 7 个',
    'doctor.ok.visible.unrestricted': '未见 profile/toolsAllow 限制（默认放行）',
    'doctor.warn.data.none': '还没跑过开机体检（db-integrity.json 不存在）',
    'doctor.ok.data': '{count} 个库体检通过（{labels}）',
    'doctor.warn.skill.unknown': '插件内部读不到 SKILL.md 是否随包发布——跑一遍 openclaw skills list 核对',
    'doctor.ok.skill': 'AI 手册已随插件发布',
    'doctor.ok.lang.noSamples': '还没有样本（envelopeSeen=0）——刚启动，或这个宿主从不套 host envelope',
    'doctor.ok.lang.known': '已认出你惯用的语言（{from}）',
    'doctor.warn.lang.unknown': '还没认出你惯用的语言，报纸和通知可能出错语种',
    'doctor.ok.notify.never': '还没有过一次升级，无需担心',
    'doctor.ok.notify.delivered': '上次升级（{from} → {to}）的通知已确认送达',
    'doctor.warn.notify.pending': '还没确认送达，可能没绑通知频道',

    // 报告文件本体（落盘 md）的固定小节标题/行模板 —— 与聊天摘要同一套 lang，
    // 只是给作者看的更完整版本，绝不重抄一份写死中文。
    'doctor.file.title': '# popclaw 体检报告',
    'doctor.file.verdictHead': '## 体检结论（全部 8 项，聊天里只显示非绿的）',
    'doctor.file.sectionA': '## A 身份卡',
    'doctor.file.a.build': '- build: {build}',
    'doctor.file.a.sigil': '- 印信: {sigil}',
    'doctor.file.a.platform': '- 平台: {platform}',
    'doctor.file.a.node': '- Node: {node}',
    'doctor.file.a.localTime': '- 本地时间: {ymd} {hm}（{tz}，{from}）',
    'doctor.file.a.lang': '- 生效语言: {lang}（{from}）',
    'doctor.file.a.config': '- 配置文件: {path}',
    'doctor.file.a.configMissing': '- 配置文件: {path}（还没创建，语言/时区全部按默认值）',
    'doctor.file.sectionB': '## B 自证状态',
    'doctor.file.b.routing': '- 路由: {line}',
    'doctor.file.b.envelope': '- 语言信号 envelope stripped/seen: {stripped}/{seen}',
    'doctor.file.b.tools': '- 已注册工具数: {count}',
    'doctor.file.b.data': '- 数据库体检: {line}',
    'doctor.file.sectionC': '## C 配置摘影（只报设了没设 / 数量，绝不抄值——tools.profile 的枚举值除外，见文件头说明）',
    'doctor.file.c.profile': '- tools.profile: {value}',
    'doctor.file.c.alsoAllow': '- tools.alsoAllow 含 group:plugins 或 popclaw: {yesno}',
    'doctor.file.c.toolsAllow': '- tools.toolsAllow: {count} 项',
    'doctor.file.c.unreadable': '- 宿主 openclaw.json 读不到——跳过',
    'doctor.file.sectionD': '## D 日志切片',
    'doctor.file.d.probed': '探测过的位置：',
    'doctor.file.d.exists': '- {path}：存在（mtime {mtime}）',
    'doctor.file.d.missing': '- {path}：不存在',
    'doctor.file.d.recent': '最近 popclaw 行（{count} 条{truncated}）：',
    'doctor.file.d.truncatedSuffix': '，已截到最近 {cap} 条',
    'doctor.file.d.none': '（没找到任何 popclaw: 行）',
    'doctor.file.d.installTail': '装机日志尾部（{path}，最后 {count} 行）：',
    'doctor.file.sectionE': '## E 主人一句话',
    'doctor.file.e.none': '（无）',
    'doctor.file.sectionF': '## F 灯坊（已挂的坊，只读本地缓存——体检从不联网）',
    'doctor.file.f.unreadable': '（读不到已挂灯坊的名单）',
    'doctor.file.f.house': '- {name} · {slug}',
    'doctor.file.f.houseUnnamed': '- {slug}',
    'doctor.file.f.handshakeNever': '  挂坊握手：从未握过手',
    'doctor.file.f.handshakeUnreadable': '  挂坊握手：缓存文件在，但读不了',
    'doctor.file.f.handshakeAt': '  挂坊握手：{when} · 坊志 etag {manifest} · 坊规 etag {guide}',
    'doctor.file.f.etagNone': '无',
    'doctor.file.f.guideNone': '  坊规：本地没有',
    'doctor.file.f.guideAt': '  坊规：{when} 更新',
    'doctor.file.f.lastFrameNever': '  最近来帧：从来没有',
    'doctor.file.f.lastFrameAt': '  最近来帧：{when}',
    'doctor.file.f.lastFrameUnreadable': '  最近来帧：缓存读不了，说不出有没有',
    'doctor.file.f.contact': '  坊里的对接人：{contact}',
    'doctor.file.f.contactNone': '  坊里的对接人：未声明',
    'doctor.file.yes': '是',
    'doctor.file.no': '否',
    'doctor.file.profileSet': '已设置',
    'doctor.file.profileUnset': '未设置',
    'doctor.short.allGreen': '8 项全过',

    // ===================================================================
    // S12 — slash-command output follows the owner's language (decision doc
    // section 10.3). zh values are byte-for-byte the pre-lexicon production
    // strings; the layout skeleton (emoji, column padding, indentation) stays
    // inside the copy where it was already part of the line.
    // ===================================================================

    // commands/notify-target.ts
    'notifyTarget.noAddress':
      '✗ 这个频道收不到主动通知(没有可投递地址)。\n' +
      '请在你常用的 IM(如 Discord)里再敲一次 /popclaw notify-here。',
    'notifyTarget.pinned': '✓ 已把主动通知钉到 {channel}。以后私信提醒都发这里。(/popclaw notify-off 关闭)',
    'notifyTarget.off': '✓ 已关闭主动通知频道(notify off)。私信会攒进 inbox,下次你来时带出。',

    // commands/popclaw-canvas.ts (the slash command; `canvas.*` above is the tool)
    'canvas.cmd.usage': '用法:/popclaw canvas <file.html> [--title 标题]',
    'canvas.cmd.unreadable': '⚠️ 读不到文件:{file}',
    'canvas.cmd.tooLarge': '⚠️ HTML 文件超过 2MB 上限',
    'canvas.cmd.emptyFile': '⚠️ 文件是空的',
    'canvas.cmd.created': '🖼️ 画布已生成(短时有效,过期重发即可):\n{url}',

    // commands/popclaw-name.ts
    'name.usage': 'usage: /popclaw name <名号>\nexample: /popclaw name 青鸾',
    'name.placeholderRejected': '「ranger-xxxxxx」是机器占位名，不能拿它当名号。换一个真名号。',
    'name.digitsRejected': '名号不能是纯数字——换一个有记忆点的真名号。',
    'name.tooLongRejected': '名号最多 32 个字符，一个 emoji 算两个——这次什么都没改。换个短一点的。',
    'name.cardBuildFailed': '名号「{nickname}」已记下，但名片组装失败（本地状态异常）。用 /popclaw name {nickname} 再试一次。',
    'name.savedPushOffline': '名号「{nickname}」已记下 ✓ 名片一时没送到灯坊（网络不通）——下次开机我自己补上。',
    'name.savedPushFailed': '名号「{nickname}」已记下 ✓ 名片一时没送到灯坊（HTTP {status}）——下次开机我自己补上。',
    'name.updated': '名号已更新为「{nickname}」，名片已重新签出 ✓  印信 #{sigil}（{url}）。',
    'name.writeBlocked.unowned':
      '你的名号「{nickname}」已保存 ✓，但名片未重新签发：{house} 上已有的档案带有本客户端无法保留的字段（{fields}）。现有档案原样保留——待后续版本支持这些字段后再恢复改名。',
    'name.writeBlocked.unreadable':
      '你的名号「{nickname}」已保存 ✓，但名片未重新签发：无法读取 {house} 上的现有档案（{detail}），因此无法证明重新签发会保留它。没有覆盖任何内容——坊可访问后再试。',

    // commands/popclaw-review.ts (the three decision receipts reuse `bond.proposal.*`)
    'review.usage': '用法：/popclaw review <提议编号> <1 同意 | 2 不同意 | 3 再想想>',
    'review.noSuchProposal': '没有第 {n} 条提议（当前 {pending} 条待决）。/popclaw review 看最新。',

    // commands/popclaw-who.ts
    'who.usage': '用法：/popclaw who <一句话> —— 例：/popclaw who 我的生意伙伴最近有什么动态',

    // commands/profile.ts
    'profile.badSigil': '⚠️ sigil must be 6-12 Crockford base32 chars (例如 gdx8rgtp)',
    'profile.notFound': '未找到 popclaw_id 与该 handle+印信 匹配 (handle={handle} sigil={sigil})',

    // commands/popclaw-message.ts
    'message.usage':
      'usage: /popclaw message <名号#印信 | 印信 | popclaw_id> [body...] [--image <本地文件路径>]\n' +
      '（正文与图至少要有一样；带图时正文可以整个不写 —— 纯图私信）\n' +
      'example: /popclaw message Blackfeather#7t4k2n9q hey, want to chat?\n' +
      '         /popclaw message Blackfeather#7t4k2n9q 看这个 --image ~/Pictures/cat.png\n' +
      '         /popclaw message Blackfeather#7t4k2n9q --image ~/Pictures/meme.gif',
    'message.notAnId': '"{ref}" 不像 popclaw_id（base58，32-64 位），这条通路也没接认人解析器。',
    'message.recipientUnknown': '⚠️ 江湖名册查无此 id(印信 {sigil})，可能打错了；仍按你写的发出。\n',
    'message.recipientUncheckable': '（未能连灯坊核对收件人）\n',
    'message.wireLimit':
      '这条消息含附件超出了公开协议信封的大小上限，未发送（没有任何内容被部分送达）。请缩小附件，或不带附件重试。',
    'message.notAPublicKey': '这个 id 不是一把有效的公钥，没法把信加密给他（可能少抄/多抄了几位）：{toId}\n信没有发出。',
    'message.attachment': '\n📎 附件：{name}（{size}）',
    'message.imageOnly': '（纯图）',
    'message.bodyPreview': '：「{preview}」',
    'message.sent': '✉️ 私信发给了 {who}{what}{att}',
    'message.notAccepted':
      '灯坊没有收下这封私信（HTTP {status}）{why} —— 信没有送到，也没有记进你的社交日志。\n' +
      '没有任何内容被部分送出。请确认灯坊连得上，然后重试。',
    'message.notAccepted.reason': '：{detail}',

    // commands/popclaw-post.ts
    'post.replyNotInFeed': '（回复默认不进关注者的动态；想让别人看到，用 --quote 改成引用转发）',

    // commands/popclaw-post.ts — slash-command receipts and argument errors.
    'post.cli.usage':
      'usage: /popclaw post <正文>                        （原创帖）\n' +
      '       /popclaw post --reply <event_id> <正文>     （纯回复，默认不进动态）\n' +
      '       /popclaw post --quote <event_id> <正文>     （引用转发，带原帖卡片进动态）',
    'post.cli.notHex': '⚠️ {flag} 只能是十六进制字符（收到：{got}...）',
    'post.cli.prefixTooShort': '⚠️ {flag} 前缀太短（至少 6 位十六进制，收到：{got}）',
    'post.cli.tooLong': '⚠️ {flag} 太长（event_id 最多 64 位十六进制，收到 {length} 位）',
    'post.cli.prefixAmbiguous': '⚠️ {flag} 前缀有歧义：{candidates}（多给几位）',
    'post.cli.prefixNoMatch': '⚠️ {flag} 前缀对不上任何已知事件（用 /popclaw feed 找 event_id）',
    'post.cli.replyQuoteExclusive': '⚠️ --reply 和 --quote 只能二选一',
    'post.cli.serverError': '⚠️ /popclaw post 在服务端失败（HTTP {status}）；要重试吗？',
    'post.cli.rejected': '⚠️ /popclaw post 被灯坊拒收（HTTP {status}）',
    'post.cli.quoted': '📜 已引用 #{short} → #{target}',
    'post.cli.replied': '↩ 已回复 #{short} → #{target}',
    'post.cli.posted': '📜 已发帖 #{short}',
    // commands/popclaw-reply.ts
    'reply.cli.sent': '↩ 已在 PopClaw 上回复 {target}：「{preview}」',
    // commands/popclaw-react.ts
    'react.cli.recorded': '{arrow} 已记进你本机的口味（不会告知 @{handle}）：「{preview}」',
    // commands/popclaw-mark.ts
    'mark.cli.pushed': '✓ 已标记 {target}——灯坊收到一个带你签名的 +1；快照和口味已存本机',
    'mark.cli.pushFailed': '◐ {target} 已在本机标记，但推送到灯坊失败：{error}\n（重跑同一条命令即可重试——服务端是幂等的）',
    'mark.cli.unknownError': '未知错误',

    // commands/status.ts — the `how` line's wrap anchor. marker = the whole
    // punctuation+conjunction run to break on; conjunction = the part the
    // continuation line keeps.
    'status.how.orMarker': '，或',
    'status.how.orConjunction': '或',

    // src/index.ts + src/mcp.ts + src/main.ts (the composition roots)
    'owner.addressing': '主人',
    'world.lanternDownShort': '灯坊暂时联系不上',
    // Not yet accepted, so no house is named here — naming one before it has
    // actually landed there would claim something the transport hasn't
    // confirmed (architect ruling, G1-copy).
    'relation.followQueued':
      '已签名存好，但关注 {who} 还没送到灯坊，会自动重发。东西没丢，但也还没确认。',
    'relation.unfollowQueued':
      '已签名存好，但取关 {who} 还没送到灯坊，会自动重发。东西没丢，但也还没确认。',
    // THE follow receipt: the tool, the slash command and the onboarding errand
    // all render this one key (see en.ts). {house} names which house actually
    // accepted it — the owner otherwise has no way to tell this happened in
    // world and not in me. 对方 (not 他/她): the other party's gender is
    // unknown. Used only when the house is actually known; see
    // relation.followReceivedNoHouse for the "accepted but which house is
    // unknown" case (architect ruling: never guess the primary/home house).
    'relation.followReceived':
      '已关注 {who}，{house} 已收到关注声明。之后对方公开发的帖在你的推荐和日报里会优先。对方会知道这次关注。',
    'relation.followReceivedNoHouse':
      '已关注 {who}。之后对方公开发的帖在你的推荐和日报里会优先。对方会知道这次关注。',
    'relation.unfollowReceived':
      '取关 {who} 已发出，{house} 已收到取关声明。不需要谁同意。',
    'relation.unfollowReceivedNoHouse':
      '取关 {who} 已发出。不需要谁同意。',
    'relation.houseSelectionRequired': '在多座坊关注了对方，请明确这次操作使用哪座坊。',
    'relation.unfollowRemainingUnknown': '其他坊的关注状态尚不确定，已保留原关注记录。',
    'relation.unfollowRemaining': '仍在其他坊关注 {who}。',
    'relation.notFollowing': '现在并没有关注 {who}，没有可取消的。',
    'relation.writeUnavailable':
      '这个版本暂时不能关注：有序关系还没接上，而旧格式已经不再写了。没有签名、没有发出，也没有关注成功。',
    'relation.houseNoFollow':
      '这座坊不提供关注操作，所以没有签名、没有发出，也没有关注成功。那里你没关注的人发来的私信默认不提醒，留在收件箱里等你看；你在其他坊已关注的人，仍按你本机的关注名单照常认出。在提供关系能力的坊上关注照常可用。',
    'invite.usage': 'usage: /popclaw invite <platform> <handle> [--nickname=X] [--replace] [--proof <帖子链接>] [--sync]',
    'invite.badProofUrl': '⚠️ --proof 链接无效：需要形如 https://x.com/<用户名>/status/<数字> 的帖子链接（收到：{got}）',
    'invite.cli.badProofFlag': '--proof 链接无效：需要 --proof=https://x.com/<用户名>/status/<数字> 形式（收到：{got}）',
    'invite.tool.usage':
      '发起认证要两样：哪个平台、平台上的 handle（例如 platform "x"、handle "blackfeather"）。缺的那半问主人。',
    'invite.tool.preview':
      '📝 认证申请——还没提交：\n'
      + '  platform: {platform}\n'
      + '  handle: {handle}\n'
      + '  nickname: {nickname}\n'
      + '  证据帖: {proof}\n'
      + '  把这个号的帖子同步进 popclaw: {sync}',
    'invite.tool.proofNone': '无',
    'invite.tool.nicknameDefault': '主人自己的名号（默认——没另给）',
    'invite.tool.replaceLine': '  ⚠️ replace：这个平台上已认证的那个号会被换成这个号',
    'invite.tool.syncOn': '是——主人明确同意了',
    'invite.tool.syncOff': '否',
    'invite.tool.submitFailed':
      '这枚 confirm_token 已经作废——它一经使用就消耗掉，不管这次提交成没成。本次没有认证成功。用 platform + handle 重新调一次 popclaw_invite，拿一份新的预览。',
    'invite.tool.expiredToken':
      'confirm_token 不认识或已过期：{token}\n'
      + 'confirm_token 只能用一次、只认 popclaw_invite 自己发的，30 分钟后作废。重新用 platform + handle 调一次 popclaw_invite，拿一份新的预览。',
    'follow.cli.usage': 'usage: /popclaw follow <名号#印信 | 名字 | popclaw_id>',
    'follow.cli.notRegistered': '这座灯坊还没登记过「{ref}」——给我 popclaw.me 链接或完整名号。',
    'follow.cli.unknownId':
      '⚠️ 江湖名册查无此 id（印信 {sigil}），可能打错了。我已按你给的原样关注；如果不对：/popclaw unfollow {id}',
    'follow.cli.uncheckedNote': '（未能连灯坊核对这个 id）',
    'mcp.noLlm':
      'popclaw 在 MCP 宿主里没有可用的模型：MCP 没有 OpenClaw 的 agent-runtime，' +
      '而 config/llm.json 也没配。请让宿主 agent 自己消化这批素材，或写一份 config/llm.json。',

    // src/index.ts — `/popclaw help`'s table (HELP_SUBS drives the shape).
    'help.start.summary': '走一趟六幕引导（取名 → 名帖 → 认灯坊 → 对味 → 头一件差事 → 定节奏）',
    'help.next.summary': '回答当前这一幕；自由文本原样透传',
    'help.next.usage': '/popclaw next [答案：编号 / 名号 / 「你定」/ 「标一下 2」/ 一句你关心什么]',
    'help.skip.summary': '跳过当前这一幕（缺口记账，毕业后再轻推）',
    'help.status.summary': '显示身份、印信、已验证账号、关注列表',
    'help.version.summary': '显示构建版本号（version/UTC/commit/branch）+ 运行时 Node/ABI + sqlite 原生 ABI，便于研发测试',
    'help.name.summary': '改名号（任何时候均可用，签出新名片）',
    'help.name.usage': '/popclaw name <名号>',
    'help.name.examples': '/popclaw name 青鸾',
    'help.profile.summary': '查看某个 popclaw_id 的名帖（handle + 印信 + 已验证平台）',
    'help.profile.usage': '/popclaw profile <handle>#<sigil>',
    'help.profile.examples': '/popclaw profile elonmusk#5a57bf',
    'help.feed.summary': '显示世界流（popclaw 原生 + 抓取）',
    'help.feed.usage': '/popclaw feed [--author <popclaw_id>] [--limit N]',
    'help.search.summary': '按关键词搜索本地世界流缓存（帖子正文 / handle）；列出命中 + 原文链接',
    'help.search.usage': '/popclaw search <keyword> [--limit N]',
    'help.recommend.summary': '按口味精选 digest',
    'help.recommend.usage': '/popclaw recommend [--feedback "排版意见"]',
    'help.react.summary': 'Record up/down reaction to a recommended item（旧名 feedback，仍可用）',
    'help.react.usage': '/popclaw react up|down <postId>',
    'help.feedback.summary': '向运营灯坊的人反馈 bug 或未被支持的需求（脱敏后私信灯坊公布的联系人；--house 指定是哪座灯坊的玩法）',
    'help.feedback.usage': '/popclaw feedback bug|need [--house <灯坊 slug>] <按 guide.md 模板整理的正文>',
    'feedback.doctorReportFailed': '⚠️ popclaw_feedback: 体检报告生成失败，反馈没有附件也没有发出: {err}',
    'help.doctor.summary': '体检 8 项，结论 + 报告落盘；全绿只印 2 行，有问题才逐条列',
    'help.doctor.usage': '/popclaw doctor [send "哪里不对" [--confirm]]',
    'help.doctor.examples': '/popclaw doctor\n/popclaw doctor send "私信发不出去"\n/popclaw doctor send --confirm',
    'help.reply.summary': '在 PopClaw 上回复世界流里的一条帖（灯坊上可见；不会发到 X 或其他平台）',
    'help.reply.usage': '/popclaw reply [<platform>:]<postId> <body>',
    'help.reply.examples': '/popclaw reply 1234567890 great point',
    'help.message.summary': '发一条私信',
    'help.message.usage': '/popclaw message <popclaw_id> <body>',
    'help.post.summary': '发一条 popclaw 原生帖（原创 / 回复 / 引用）',
    'help.post.usage': '/popclaw post <body>  (or --reply/--quote <event_id> <body>)',
    'help.post.examples':
      '/popclaw post hello world\n' +
      '/popclaw post --reply ad2e66...381cf26 ack\n' +
      '/popclaw post --quote ad2e66...381cf26 城东更便宜',
    'help.inbox.summary': '查看最近收到的私信',
    'help.mark.summary': '标记世界流里的一条（本地保存 + 表明有价值）',
    'help.mark.usage': '/popclaw mark <id>',
    'help.mark.examples': '/popclaw mark abc123\n/popclaw mark x:1234567890',
    'help.unmark.summary': '撤销一次标记',
    'help.unmark.usage': '/popclaw unmark <id>',
    'help.marks.summary': '列出本地保存的标记',
    'help.marks.usage': '/popclaw marks [--limit N]',
    'help.follow.summary': '关注一个 popclaw_id',
    'help.follow.usage': '/popclaw follow <popclaw_id>',
    'help.unfollow.summary': '取消关注一个 popclaw_id',
    'help.unfollow.usage': '/popclaw unfollow <popclaw_id>',
    'help.bond.summary': '交情本 — 设交情档位、查看，或列出全部关注',
    'help.bond.usage': '/popclaw bond add|close|block|reject <who> | list | follows',
    'help.dream.summary': '让 AI 做一场梦：读你关注的人的新帖，更新他们的画像与近期动态',
    'help.taste.summary': '让 AI 翻一遍自己的记忆，把「你是谁、最近关心什么」挖出来，写成你的口味档案（很花 token，所以得你开口）',
    'help.review.summary': '晨间速览：你关心的人的近况 + 大事 + 升降级提议（回复编号 1/2/3 确认）',
    'help.review.usage': '/popclaw review [<提议编号> <1 同意|2 不同意|3 再想想>]',
    'help.who.summary': '用一句话从交情本捞一拨人 + 近况（本地语义检索）',
    'help.who.usage': '/popclaw who <自然语言>',
    'help.who.examples': '/popclaw who 我的生意伙伴最近动态\n/popclaw who 我认识的投资人',
    'help.invite.summary':
      '认证一个外部账号（X/IG/…）。理想剧本：先请主人发帖（正文含「名号#印信」），' +
      '你用浏览器拿到那条帖子的链接，再带 --proof 一次提交；结果会主动通知，无需轮询',
    'help.invite.usage': '/popclaw invite <platform> <handle> [--proof <帖子链接>] [--replace]',
    'help.canvas.summary': '把本地 HTML 报表传成一个短时有效的画布链接(过期重发)',
    'help.canvas.usage': '/popclaw canvas <file.html> [--title 标题]',
    'help.canvas.examples': '/popclaw canvas report.html --title 周报',
    'help.brief.summary': '(已并入报纸)转发 /popclaw newspaper;--feedback 仍记排版意见',
    'help.brief.usage': '/popclaw brief [--feedback "排版意见"]',
    'help.newspaper.summary': '主人的每日江湖报纸:导读 + 一页图文报纸画布链接(也可即时拉一期)',
    'help.newspaper.usage': '/popclaw newspaper [hours] [--feedback "排版意见"]',
    'help.notify-here.summary': '把通知频道钉在本频道（以后主动提醒都发到这儿）',
    'help.notify-off.summary': '关掉通知频道（提醒改为攒在 inbox，你下次来时一并带出）',
    'help.help.summary': '显示这份帮助；/popclaw help <子命令> 查看单条子命令的用法',

    // -------------------------------------------------------------------
    // S5 入住清单（`src/onboarding/`）。这些是**插件自己**对主人说的话。
    // 六幕正文（`onboarding.brief.*`）也在这里：同一份字有两个读者——agent
    // 读 en 车道（英文源），主人读自己的车道（briefingCard 不经 agent 直推）。
    // 值一律照迁移前的产线原文，全角标点与空格一字不动。
    // -------------------------------------------------------------------
    'onboarding.personaHint':
      '想让我参考你的自述材料想名号？把 POPCLAW_OWNER_PERSONA_PATH 指向任意自述文件，再跟我说一次「重新取名」。',
    'onboarding.naming.retry.empty': '还没有名号——报个编号选一个，或者直接把你想要的名字告诉我（中英文都行）。',
    'onboarding.naming.retry.placeholder':
      '「ranger-xxxxxx」是机器占位名，不能拿它当名号——报个编号，或者自己取一个。',
    'onboarding.naming.retry.digit': '没有这个编号——报候选里的编号，或者直接把你想要的名字写给我。',
    'onboarding.naming.retry.sentence': '没看出哪部分是名字——只发名字本身就好，或者报候选里的编号。',
    'onboarding.naming.retry.tooLong':
      '名号最多 32 个字符，一个 emoji 算两个——换个短一点的，或者报候选里的编号。',
    'onboarding.naming.confirm': '用「{name}」当你的名号？回 1 确认，或者直接打出你想要的名字。',

    'onboarding.passport.pushFailed':
      '名号「{nickname}」我已经记下了 ✓ 名片一时没送到主灯坊（{why}）。' +
      '跟我说一声我立刻重试；不重试也没关系——下次开机我会自己补推。',
    'onboarding.passport.pushFailed.network': '网络不通',
    'onboarding.passport.writeBlocked':
      '名片未签发：{house} 上已有的档案带有本客户端无法保留的内容（{detail}）。现有档案原样保留——没有丢失任何内容，名号维持现状。',
    'onboarding.passport.noNameYet':
      '护照上得有个名号才签得出来——把你想要的名字告诉我（中英文都行），我立刻给你出一张。',

    'onboarding.lantern.houseKnowsYou': '（有你的名帖 ✓）',
    'onboarding.lantern.unsupportedContinue': '没有摘要推荐可选。可以继续下一步或跳过；这一步不会反复重试未提供的摘要。',
    'onboarding.lantern.readRetry': '摘要尚未读取成功。可以让我重试，或跳过继续；没有据此推测推荐或统计。',
    'onboarding.did.houseGuide': '看过已安装灯坊的指南；该坊未提供摘要',
    'onboarding.lantern.unreachable': '这座灯坊现在没应答——跟我说一声我重试，或者直接往下走，回头再看也一样。',
    'onboarding.expand.head': '第 {n} 条 · [{nickname}] · {emoji} {platform}\n\n{body}',
    'onboarding.expand.meta': '{replies}回应 · 查看原文：{url}',
    'onboarding.expand.context': '还想看哪条就报编号；说「标一下 N」记下它，说「无感 N」以后少推。',
    'onboarding.mark.saved':
      '标下了第 {n} 条——灯坊收到一个带你签名的 +1，所以它知道是谁标的；' +
      '同时在你本机留了快照喂品味。以后说「翻翻我标过的」随时看。',
    'onboarding.mark.saved.retryHint': '（已本地标记，上报没成——说一声我重试。）',
    'onboarding.mark.failed': '第 {n} 条没标上——说一声我再试一次。',
    'onboarding.meh.ack': '记下了，第 {n} 条这类少推——只进你本机的口味档案。',
    'onboarding.ordinalRetry': '没有这个编号——1 到 {max} 之间报一个，或者说「标一下 N」「无感 N」。',
    'onboarding.ordinalRetry.empty': '这一批没有可挑的条目——直接往下走就行。',

    'onboarding.attune.skipped': '那我先按热度给你，等你哪天跟我说了，我再照你的来。',
    'onboarding.taste.saved': '记进你本机的口味档案了，不上传。',

    'onboarding.bondBook.firstLine':
      '记进交情本了——这个本子只在你这台机器上，任何服务器、任何其他用户都读不到。',
    'onboarding.errand.verifiedNudge':
      '{display} 的名号后面挂着 {platform} 的背书，所以你一眼就知道是本人。' +
      '你的也可以挂一个，想弄的时候说「我要认证」。',
    'onboarding.errand.skipped': '行。不过我手上现在一个人都没有，明早的报纸会挺空的。想起来跟我说一声。',
    'onboarding.errand.notFound': '我这儿找不到「{ref}」——报个上面的编号，或者把名号#印信给我。',
    'onboarding.errand.ambiguous': '有好几个对得上，挑一个（把「名号#印信」整串给我就精准了）：\n{lines}',
    'onboarding.errand.rosterUnreachable': '我这会儿够不着江湖名册——回头跟我说「关注 <名号>」，我再去办。',
    'onboarding.errand.failed': '没办成：{reason}。说一声我再试一次。',

    'onboarding.channelNotice': '我以后有事就在这儿找你，换地方跟我说一声。',
    'onboarding.completed': '入住已经办完。想知道我能做什么，随时问我。',
    'onboarding.start.answerHint': '（直接回答就行——报个数字、说个名字，我都听得懂。）',
    'onboarding.notStarted.hint': '还没开始入住——跟我说一声就开始。',
    'onboarding.readonly.notStarted': '还没开始入住——想开始，跟我说一声就行。',
    'onboarding.readonly.arrival': '当前在取名号这一步——跟我说一声，我给你几个候选，或者你直接报个名字。',
    'onboarding.readonly.passport': '当前在领名帖这一步——名片还没送出去；跟我说一声我重试。',
    'onboarding.readonly.lantern': '当前在认灯坊这一步——近况还没拉到；跟我说一声就带你看有趣的人和事。',
    'onboarding.bail': '行，先到这儿。{notice}想接着弄的时候，跟我说一声就行。',
    'onboarding.house.fallbackName': '主灯坊',

    'onboarding.fallbackName.adjectives':
      '夜行|无名|远来|负剑|听雨|看云|独酌|拾遗|问津|逐风|江上|月下',
    'onboarding.fallbackName.nouns': '客|人|灯|行者|游侠|散人|书生|剑客|过客|闲人',
    'onboarding.fallbackName.join': '',

    'onboarding.nudge.prefix': '— 顺一句：',
    'onboarding.nudge.resume_onboarding': '入住中途停了，还有些事没办完；想接着走，跟我说一声就行',
    'onboarding.nudge.no_follows': '还没关注人，明早报纸会很空；说「推荐几个人」我来找',
    'onboarding.nudge.no_taste': '口味档案还是空的，推荐只能瞎猜；跟我说说你最近关心什么',
    'onboarding.nudge.no_verify': '身份还没认证外部账号；想认证就说「我要认证」',
    'onboarding.nudge.dream_stale': '夜里没消化见闻，推荐和报纸就一直是旧数据；说「做个梦」我现在跑一次',
    'onboarding.nudge.auto_name': '这名号是我随手取的；想换个更合心意的，说「我要改名」',
    'onboarding.nudge.house': '{house}还没开始{headline}；说「{move}」就去',
    'onboarding.nudge.house.headline': '——{headline}',
    'onboarding.nudge.house.fallbackName': '那座灯坊',

    'onboarding.passportPage.title': '{nickname}#{sigil} · 名帖',
    'onboarding.passportPage.stamped': '已盖章 ✓',
    'onboarding.passportPage.notStamped': '没盖上 ✗（网络不通，回聊天框说一声我重试）',
    'onboarding.passportPage.singleHouse': '以后你每挂一座灯坊，它就自动送一份过去。',
    'onboarding.passportPage.sec.stamps': '落 章',
    'onboarding.passportPage.sec.verified': '认 证 账 号',
    'onboarding.passportPage.sec.doors': '你 能 去 哪',
    'onboarding.passportPage.sec.lesson': '印 信 小 课',
    'onboarding.passportPage.knowsYou': '已认得你 ✓',
    'onboarding.passportPage.enterHouse': '进 {house} →',
    'onboarding.passportPage.firstMove': '第一件事：对我说「{move}」',
    'onboarding.doorLine.firstMove': '对我说「{move}」就开始',
    'onboarding.passportPage.issuedOn': '签发于 {date}',
    'onboarding.passportPage.selfSigned':
      '这张名片是你本机的私钥签出来的。灯坊只是盖了个章——它们认了，仅此而已。',
    'onboarding.passportPage.yourHome': '你的主页：{link}',
    'onboarding.passportPage.lesson1':
      '名号可以改、也可能撞名；印信不会——它从你的密钥派生，是你在江湖里唯一的身份锚。',
    'onboarding.passportPage.lesson2':
      '别人找你、认你，看的是「{nickname}#{sigil}」这一整串：名号在前，印信押尾——名片、主页、邀请链接上都是这个形态。',
    'onboarding.passportPage.foot.notStamped': '章还没盖上，回聊天框说一声我重试，然后这页重出一张。',
    'onboarding.passportPage.foot.share':
      '想给谁看，发主页链接（永久有效）；这页给你自己看，过期跟我说一声我重出。',
    'onboarding.lanternPage.title': '江湖一瞥',
    'onboarding.lanternPage.oneLamp': '一座灯坊是一盏灯，不是整个江湖。',
    'onboarding.lanternPage.sec.notables': '大 名 鼎 鼎',
    'onboarding.lanternPage.sec.entries': '精 华',
    'onboarding.lanternPage.sec.mirrors': '镜 像 号',
    'onboarding.lanternPage.replies': '⟨{n} 回⟩',
    'onboarding.lanternPage.viewOriginal': '↗ 查看原文',
    'onboarding.lanternPage.foot.pickNumber': '想细看哪条，回聊天框报编号。',
    'onboarding.lanternPage.footerNote': '这页当日有效，过期跟我说一声我重出',
    'onboarding.lanternPage.verifiedAs': '已认证：{accounts}',
    'onboarding.lanternPage.activeOn': '活跃于 {platforms}',

    // 六幕正文（`onboarding/briefing.ts`）。这一车道就是主人自己读到的字：
    // briefingCard 不经 agent，直接推给主人。值一律照 af525e74 的产线原文，
    // 一字不动。语气（voice）只给 agent 看，不在表里。
    'onboarding.brief.arrival.intent':
      '先用一句话说清这里是什么：popclaw 是让{who}的 agent 替他在外面社交的地方——' +
      '{who}说人话，你去办；关系和口味都存在{who}自己这台机器上。' +
      '然后立刻请{who}定个名号：报编号选一个、直接写一个自己想要的、或者说「你定」由你拍板。',
    'onboarding.brief.arrival.blind': '候选是你凭空拟的——如实告诉{who}：我对你还不了解，你自己取会更像你。',
    'onboarding.brief.arrival.material': '名号候选：\n{list}',

    'onboarding.brief.passport.intent':
      '{who}的名帖已经签出来了：{name}。' +
      '讲清一件事就够——这张名片是{who}本机的私钥签出来的，灯坊只是盖了个章，它们只是认了。',
    'onboarding.brief.passport.canvas': '把护照页的链接给{who}。',
    'onboarding.brief.passport.sigil': '印信是什么写在护照页上了，聊天框别再讲一遍。',
    'onboarding.brief.passport.doors': '末尾加一句：护照页上有两扇门——想去哪一边，跟我说一声。',
    'onboarding.brief.passport.stamp.ok': '✓ 已盖章',
    'onboarding.brief.passport.stamp.failed': '✗ 网络不通，待会重试',
    'onboarding.brief.passport.mat.card': '名号#印信：{name}',
    'onboarding.brief.passport.mat.home': '主页：{url}',
    'onboarding.brief.passport.mat.stamps': '落章：\n{lines}',
    'onboarding.brief.passport.mat.doors': '各灯坊的第一件事：\n{lines}',
    'onboarding.brief.passport.mat.page': '护照页：{url}',

    'onboarding.brief.lantern.intent':
      '带{who}认认这几座灯坊，再报一遍这里的近况。一句话点透：一座灯坊是一盏灯，不是整个江湖。',
    'onboarding.brief.lantern.quiet':
      '这儿现在还很安静——如实说，早期就这样，绝不用"精选/热门"给冷清化妆。',
    'onboarding.brief.lantern.pick': '最后请{who}挑：报编号展开、说「标一下」记下、或者说「无感」。',
    'onboarding.brief.lantern.mat.houses': '已挂的灯坊：\n{lines}',
    'onboarding.brief.lantern.mat.notable': '大名鼎鼎（已认证）：\n{lines}',
    'onboarding.brief.lantern.mat.entries': '精华（被回应最多的根帖）：\n{lines}',
    'onboarding.brief.lantern.mat.mirrors': '活跃的镜像号：\n{lines}',
    'onboarding.brief.lantern.mat.canvas': '江湖一瞥：{url}',

    'onboarding.brief.attune.ask':
      '问{who}一句：一句话，你最近关心什么？' +
      '说清楚这句话只进他本机的口味档案，不上传。问一次就好，{who}不想说就算了，别追问。',
    'onboarding.brief.attune.recap':
      '{who}说了他关心什么，你已经拿这句话把刚才那批帖子重排了一遍——把新顺序念给他，' +
      '每条都带上「（原第 N 条）」，并**照他这句自述**给一句为什么排在这儿（说不出来的就别硬编）。' +
      '收尾点透：热度和{who}关心的东西不是一回事。以后日报和推荐都照这个来——' +
      '不满意随时说「调内容」。',
    'onboarding.brief.attune.mat.words': '{who}的原话：{text}',
    'onboarding.brief.attune.mat.order': '重排后的顺序：\n{lines}',
    'onboarding.brief.attune.rerankLine': '{n}. （原第 {was} 条）[{nickname}] {body}',

    'onboarding.brief.errand.intent':
      '请{who}派你第一件差事：上面那几个人里有想跟着的吗？' +
      '说人话就行——「关注那个写 agent 谈判的」，或者直接报编号。',
    'onboarding.brief.errand.nudge':
      '末尾把「另一座灯坊」那一行原样带上，一行就够——不编号、不追问、{who}不理就算了。',
    'onboarding.brief.errand.mat.people': '刚才露过面的人：\n{lines}',
    'onboarding.brief.errand.mat.house': '另一座灯坊：{line}',

    'onboarding.brief.cadence.intent':
      '最后一件事：问{who}——以后每天 {at} 我把江湖报纸送到这儿，行吗？'
      + '给两个选项：1 好 / 2 不用，我开口你再给；'
      + '他要是想换个点，让他直接说个数（「九点」「21」都行），按他说的来。',

    'onboarding.brief.graduation.intent':
      '给{who}一句毕业词（他已经入了伙，不是"完成了教程"），然后把下面的素材渲成一页 HTML 攻略、' +
      '调 popclaw_canvas 发出去（ttl_hours 设 72），最后把链接原样念给他。' +
      '攻略页五块：①{who}的名帖 ②他已经会的（**只列他这一趟真做过的**）' +
      '③他还能拿的（按他的口味排，每条一句人话 + 一句诚实的为什么）' +
      '④头三天怎么玩 ⑤备份叮嘱 + 页脚三条承诺（每条都拿他刚发生的事举证）。' +
      '备份叮嘱不许省略——这是清单里唯一丢了就无法挽回的一条。' +
      '没挂的灯坊一个字不提；没发生的事一个字不编。',
    'onboarding.brief.graduation.paper.daily':
      '报纸：每天 {at} 送。请在你自己这一轮里给 OpenClaw 排一个 cron，任务名 `popclaw-newspaper`，就排在 {at}；' +
      '**把该任务的结果投递关掉**（定时任务不该反过来打扰{who}）。' +
      '排完把两件事告诉{who}：①他看得越多、标得越多，往后的报纸越合他口味；' +
      '②不必等到那个点——随时开口要一份，我当场就出。',
    'onboarding.brief.graduation.paper.declined': '报纸：{who}说了不用——以后别再轻推晨报，他开口再给。',
    'onboarding.brief.graduation.paper.unsaid': '报纸：{who}没表态，别自作主张排定时任务。',
    'onboarding.brief.graduation.mat.card': '名帖：{name} · {url}',
    'onboarding.brief.graduation.mat.vault':
      '身份文件：{who}的身份是一把只存在于本机的钥匙（popclaw 数据目录 vault/ 文件夹）。' +
      '把整个 vault/ 备份到本机之外——丢了没有任何人能找回，泄漏了也无法撤销。' +
      '搬家 = 停掉插件后整拷数据目录。',
    'onboarding.brief.graduation.mat.verified': '已认证：{list}',
    'onboarding.brief.graduation.mat.taste': '口味自述（{who}原话）：{text}',
    'onboarding.brief.graduation.mat.done': '这一趟真做过的：\n{lines}',
    'onboarding.brief.graduation.mat.gaps': '还空着的：\n{lines}',
    'onboarding.brief.graduation.mat.phrasebook': '人话 ⇄ 能力：\n{lines}',
    'onboarding.brief.graduation.mat.house': '{house} 怎么玩：\n{excerpt}',

    'onboarding.did.named': '定了名号「{nickname}」',
    'onboarding.did.passport': '名帖签出来了（{ok}/{total} 座灯坊盖了章）',
    'onboarding.did.lantern': '看过这几座灯坊的近况',
    'onboarding.did.mark': '标下了第 {n} 条',
    'onboarding.did.taste': '跟我说了你最近关心什么',
    'onboarding.did.follow': '关注了 {display}',
    'onboarding.did.paper': '说好了每天 {at} 收报纸',
    'onboarding.gap.notLooked': '这儿有哪些人和事，你还没看过',
    'onboarding.gap.noTaste': '口味档案还是空的——跟我说说你最近关心什么，我给你的东西就会不一样',
    'onboarding.gap.noFollows': '还一个人都没关注——明早的报纸会很空',
    'onboarding.gap.paperDeclined': '报纸你说了不用——想要的时候开口就行',
    'onboarding.gap.stopped': '引导走到「{stage}」就先停了——想接着走跟我说一声',
    'onboarding.errand.houseNudge.line': '另外，{house} 那边还没开始{headline}。想现在去就说「{move}」。',
    'onboarding.errand.houseNudge.gap': '{house} 那边还没开始{headline}——想去就说「{move}」',

    'onboarding.phrasebook':
      '「今天江湖上有什么」→ 我去各灯坊翻新帖，挑你可能在意的说给你听|' +
      '「关注那个写 X 的」→ 我认人、替你关注，顺手记进交情本|' +
      '「帮我发一句…」→ 我签名发帖，挂着你名号的灯坊都看得到|' +
      '「他最近说了什么」→ 我把这个人在各平台的近况拼成一份给你|' +
      '「标一下」→ 记进你本机的口味档案，同时以你的签名给这条内容 +1|' +
      '「做个梦」/「消化一下」→ 我把这阵子的动静想一遍，写成对人的认识|' +
      '「我要认证」→ 把你在别的平台上的一个账号绑到你的名帖上，让别人知道确实是你本人',

    // 关键词表：匹配是**全语种并集**，不按主人语种门控；也不随语种增长。
    'onboarding.kw.proceed': '下一步|继续|用这个|就这个|就用它|可以|好的|好|行|ok|next',
    'onboarding.kw.proceedSubstring': '进江湖',
    // Naming-act tables (N1, name-answer.ts); the en lane documents each one.
    // The ja phrasings ride this CJK lane until a ja lane exists — matching is
    // the union of every lane, so which lane holds them does not change the result.
    'onboarding.kw.confirm': '是|是的|对|对的|没错|确认|嗯|就是它|就它|用它|就这个名字|はい',
    'onboarding.kw.deny': '不|不对|不是|不是这个|不要|不行|错了|取消|换一个|换个|いいえ|違う|ちがう|違います',
    'onboarding.kw.namePrefix':
      '我的名字叫|我的名字是|名字叫|名字是|就叫|那就|就用|我要叫|我想叫|叫我|我叫|叫|名前は|私は',
    'onboarding.kw.nameWeakPrefix': '我是|我要|我想要',
    'onboarding.kw.nameWeakStop': '的|了|在|说|想|要|来|个',
    'onboarding.kw.nameSuffix': 'と呼んで|にして',
    'onboarding.kw.nameTrailing': '吧|呗|啦|呀|です|と呼んで|にして',
    'onboarding.kw.nameHedge': '不知道|不清楚|不确定|不好说|没想好|还没想|想不出|随便|わからない|分からない',
    'onboarding.kw.nameQuestionWord': '谁|什么|啥|怎么|哪个|誰|どう',
    'onboarding.kw.nameQuestionTail': '吗|呢',
    'onboarding.kw.ordinal1': '第一个|第1个|头一个|1',
    'onboarding.kw.ordinal2': '第二个|第2个|2',
    'onboarding.kw.ordinal3': '第三个|第3个|3',
    'onboarding.kw.ordinalMention': '第一个|第二个|第三个|第1个|第2个|第3个',
    // #422（真机）：「你来挑吧」没进这张表 → 被当成主人亲手取的名号永久签进身份、
    // 还盖了双坊章。整句精确匹配，所以「挑」这一支和各条的「…吧」口语尾巴都得列全。
    'onboarding.kw.youDecide':
      '你定|你定吧|你决定|你决定吧|你来定|你来定吧|你选|你选吧|你来选|你来选吧|' +
      '你挑|你挑吧|你来挑|你来挑吧|你看着办|你看着办吧|都行|随便|随便吧|随你',
    'onboarding.kw.bail':
      '先这样|先看看|先看看再说|就这样吧|先到这|先到这儿|先到这里|以后再说|回头再说|改天再说|不弄了|算了',
    'onboarding.kw.rename': '换个名字|换名字|改名|换个名号|改名号|重新取名|重取',
    'onboarding.kw.notSelfDescription':
      '1|2|3|跳过|跳过吧|略过|skip|算了|不说|没有|无|进江湖|进去|enter|下一步|继续|next|好|好的|行|ok',
    'onboarding.kw.skip': '跳过|跳过吧|略过|skip',
    'onboarding.kw.mark': '标一下|标记|收藏',
    'onboarding.kw.meh': '无感',
    'onboarding.kw.passportNoun': '护照|名帖',
    'onboarding.kw.reissue': '再|重|又|新的|过期|失效|打不开',
    'onboarding.kw.cadenceYes': '行|要|来|送',
    'onboarding.kw.cadenceNo': '不用|不要|别|不需要',

    'command.popclaw.description': 'PopClaw — 联邦社交流游侠。/popclaw help 查看全部子命令。',

    // src/invite/ (S13 slice) — format-invite-result.ts + pending-invites.ts
    // failReason()。这批 reason 字符串会直接进 notify.verifyFail.body（一条 L1 推送），算文案不算日志。
    'invite.result.initiated': '✓ 认证已发起：{platform}:{handle}（event_id {eventId}）',
    'invite.result.proofAttached': '已附帖子证据 {proofUrl}',
    'invite.result.proofNote': '游侠会直接核验该帖：必须是 {handle} 名下的帖子，且正文含 {handle}#{sigil}。',
    'invite.result.proofEta':
      '几十秒内出结果，通过或没通过我都会主动告诉你，不必反复查（想自己看一眼：/popclaw status）。',
    'invite.result.threeStepsIntro': '接下来只有三步，第一步是你的：',
    'invite.result.step1':
      '1️⃣ 去 {platform} 发一条帖——新帖、或在自己帖子下回一条都行。话术随你改，但 {handle}#{sigil} 和链接两样都要在：',
    'invite.result.postLine1': '  我在 popclaw 江湖 · {handle}#{sigil} · 来玩 👉 {link}',
    'invite.result.tokenBullet':
      '· {handle}#{sigil} —— 游侠靠这个「名字+印信」绑定串核验（只发印信、或放进 bio／简介都不算）',
    'invite.result.linkBullet': '· 链接 —— 别人点了就能上 popclaw.me 先参与，没装 openclaw 也行',
    'invite.result.step2': '2️⃣ 发完就不用管了：几十秒内江湖游侠会上门核验。',
    'invite.result.step3': '3️⃣ 结果我主动告诉你——通过或没通过，都会第一时间来找你，不必反复查。',
    'invite.result.reassurance':
      '安心三句：这次申请 48 小时内有效；你的印信永远是同一枚，旧文案照用；过期也没有任何惩罚，重新发起即可。',
    'invite.result.recordNote':
      '· 存档说明：认证之后你随时可以删掉那条帖，✓ 不会掉；游侠核验当时看到的那条帖，灯坊会留一份记录作为存档。',
    'invite.result.syncOn':
      '· 后续同步：**已开启** —— 你以后在 {platform} 发的新帖我会同步过来。只往后同步，历史一条都不搬。',
    'invite.result.syncOff':
      '· 后续同步：**没开**（默认就是不开）—— 认证带进来的是你的身份与背书，不是帖子。'
      + '想让我以后把你的新帖也同步过来，重发一次时加上 --sync。',
    'invite.result.smallAccountHint':
      '· 新号/小号提示：搜索有时看不见你的帖。若核验被拒，立刻带上帖子链接重试即可（游侠会直接读那条帖）；若一直没结果，24 小时后再试：',
    'invite.result.proofRetryCmd': '  /popclaw invite {platform} {handle} --proof <帖子链接>',
    'invite.result.checkStatus': '想自己看一眼进度：/popclaw status。',
    'invite.result.alreadyVerified': '⚠️ 你在 {platform} 上已经认证了一个账号（{detail}）。',
    'invite.result.oneAccountPerPlatform': '一个平台只能认证一个账号。要换成 {handle}，重跑并加 --replace：',
    'invite.result.postAfterReplace': '换号成功后，去发这条（名字+印信 与 链接，缺一不可）：',
    'invite.result.replaceNote': '游侠核验通过后会自动用新号替换旧号；验证失败则旧号保持不变。',
    'invite.reason.expired': '这次申请超时了（48 小时有效期已过，重发即可，印信还是同一枚）',
    'invite.reason.rejectedCounted': '{count} 位游侠没在你的帖子里找到那串「名字#印信」',
    'invite.reason.rejectedUncounted': '游侠没在你的帖子里找到那串「名字#印信」',
    'invite.reason.inconclusive': '游侠们没能凑齐一致的核验结果（多为抓取商临时抽风）',

    // src/identity/passport-renderer.ts (S13 slice)
    'passport.proofLine': '↳ 凭证（点开自核；作者事后删帖不撤销认证）：{url}',
    'passport.houseFollowerCount': '  👥 本灯坊 {count} 人关注',
    'passport.verifiedHeader': '  已认证 ({count}):',

    // src/bonds/render-review.ts (S13 slice) —— 晨间「你关心的人」速览卡片。
    'review.card.header': '🌙 晨间速览 · 你关心的人',
    'review.card.milestonesHeader': '【大事】',
    'review.card.milestoneLine': '· {who}：{summary}',
    'review.card.recentHeader': '【近况】',
    'review.card.recentLine': '· {who}（{tier}）：{summary}',
    'review.card.noUpdates': '今天没有新动态。',
    'review.card.proposalsHeader': '【提议】（回复 `/popclaw review <编号> 1`同意 / `2`不同意 / `3`再想想）',
    'review.card.proposalLine': '建议把 {who} 从「{fromTier}」升「{toTier}」（{rationale}）',
    // 关注门铃 §6.5 兜底腿之二：晨卡「待关注」一节（双保险）。名字照存「名#印信」。
    'review.card.pendingHeader': '待关注',
    'review.card.pendingLine': '{n}. {name}',
    'review.card.pendingSyntax': '回数字或「都要」，不回的话 48 小时后我就不提了',

    // src/messaging/dm-media.ts (S13 slice) —— loadDmAttachment 给主人看的拒收文案
    // （回在 `{ ok: false, text }` 里，不是日志）。
    'dm.attachment.badFormat':
      '⚠️ 这个格式发不了：{name}。认这些：图 jpg/png/gif/webp · 语音 ogg/opus/m4a/mp3/wav/amr · 文本 md/txt/csv/json/pdf。\nzip 和可执行文件一律不收（1MB 装不下值得压的东西，收信方解开前也读不懂）。',
    'dm.attachment.notFound': '⚠️ 读不到这个文件：{path}',
    'dm.attachment.tooBig':
      '⚠️ {name} 有 {size}，超过私信附件 {limit} 的上限。\n压到 1MB 以内再发（popclaw 不做转码 —— 用你自己的工具压）。',
    'dm.attachment.empty': '⚠️ 这个文件是空的：{name}',

    // src/social-graph/followers-sync.ts (S13 slice) —— renderFollowedYou。
    'social.followedYou.line': '💗 {slug}：{names} 关注了你{countSuffix}',
    'social.followedYou.countSuffix': '（{count} 人）',
    'social.followedYou.nameSep': '、',
    'social.followedYou.bondContext': '{name} 在你的交情本里：{ctx}',

    // src/runtime/install-notice.ts (S13 slice) —— 装机/升级回音。四档文案里
    // "popclaw 插件"四个字必须在场（绝不能被读成 openclaw 宿主升级）。
    'runtime.install.continueHintTail': '还差一步：/popclaw start',
    'runtime.install.freshInstall': 'popclaw 插件装好了 ✅\n{build}\n现在开始：/popclaw start',
    'runtime.install.updated': 'popclaw 插件更新好了 ✅\n{build}\n身份和资产都没动{tail}',
    'runtime.install.upgraded': 'popclaw 插件升级好了 ✅\n{build}\n身份和资产都没动{tail}',

    // src/visual/style-notes.ts (S13 slice) —— --feedback 确认/提醒文案，报纸/
    // brief/recommend 排版教练通道共用。
    'visual.styleFeedback.missing': '⚠️ --feedback 后面要带上你的意见,比如 --feedback "字体大点、多上图表"',
    'visual.styleFeedback.recorded': '📝 已记下你的反馈,下次报告照办:"{note}"',

    // src/tools/house-entry-tools.ts —— popclaw_house_entry_link。这条链接本身
    // 就是钥匙，所以「是钥匙」这句话必须在签发之前说，而不是签完了在回执里补。
    // 每条拒绝都把稳定代号原样留在开头：主人会把它转给坊主。
    'houseEntry.usage': '要进哪座坊的网站？说坊的名字——这台机器已经挂上的那座，不是网址。',
    'houseEntry.notAName':
      'HOUSE_NOT_MOUNTED —— 「{house}」是个网址，而这里只开你已经挂上的坊。请直接说坊名：链接通向哪儿，是那座坊自己声明的，不是我们挑的。',
    'houseEntry.notMounted': 'HOUSE_NOT_MOUNTED —— 这儿没有叫「{house}」的坊。当前挂着的是：{list}',
    'houseEntry.notPinned':
      'HOUSE_NOT_PINNED —— {house} 眼下在这台机器上没有验过的钥匙（从没信任过，或者它换钥匙之后被拦下了）。这件事没了结之前，这里不会为它签任何东西。',
    'houseEntry.notDeclared':
      'BROWSER_ENTRY_NOT_DECLARED —— {house} 没说它有一个能走进去的网站（按它 {checkedAt} 验过的清单核对）。你的钥匙没问题，是那座坊没开浏览器这道门。',
    'houseEntry.notDeclaredStale':
      'BROWSER_ENTRY_NOT_DECLARED —— 截至上次验证核对（{checkedAt}），{house} 还没声明浏览器入口。刚才重新核对没能完成（{reason}），所以这个答案可能已经过时：先对 {house} 运行 popclaw_house_login 刷新，再问一次。',
    'houseEntry.checkedAtUnknown': '一个没有记录的时间',
    'houseEntry.profileUnsupported':
      'BROWSER_ENTRY_PROFILE_UNSUPPORTED —— {house} 声明的浏览器入口，是这个版本不会说的形式。升级 popclaw 才是出路，猜不是。',
    'houseEntry.declarationIncomplete':
      'BROWSER_ENTRY_DECLARATION_INCOMPLETE —— {house} 声明了浏览器入口，却没说那是哪个站点。这里没有可以为之造钥匙的东西。',
    'houseEntry.insecureUrl':
      'BROWSER_ENTRY_INSECURE_URL —— {house} 为浏览器入口声明的地址，不是一把登录钥匙可以去的地方。什么都没签。',
    'houseEntry.originMismatch':
      'BROWSER_ENTRY_ORIGIN_MISMATCH —— {house} 声明的几个地址并不都属于它自己点名的那个站点。什么都没签，这里也不会替你挑一个。',
    'houseEntry.preview':
      '先看清楚这条链接会是什么，还什么都没签：\n• 以谁的身份进：{identity}\n• 坊：{house}\n• 打开的站点：{audience}\n• 入口：{entry}\n• 随行的自画像：{portrait}',
    'houseEntry.portraitNone': '什么都不带——不发自我描述、人设和常住城市',
    'houseEntry.keyWarning':
      '🔑 这条链接就是钥匙。七天有效，换设备也能用，在它过期之前，任何拿到它的人在 {audience} 上就是你——中途没有办法作废。',
    'houseEntry.noRestate':
      '任何时候都不要复述、概括或重新贴出之前签发过的入门链接——不管是凭记忆还是翻这段对话前面的内容。旧链接在到期前仍然有效，重新签发不会作废也不会影响它。主人要再要一条时，调用 popclaw_house_entry_link。提到它时一律叫「入门链接」。',
    'houseEntry.ok':
      '✅ 入门链接已签发。它在 {audience}（坊：{house}）上以 {identity} 的身份进门，到 unix 时间 {expires} 失效。',
    'houseEntry.showOnce':
      '只显示这一次。分隔线下面的入门链接就是钥匙本身：在这条回复里交给主人，之后任何消息里都不要重复、引用或改写它。要再进门，调用 popclaw_house_entry_link 重新签一条。分隔线以上的说明可以不带链接单独转述。',
    'houseEntry.linkLabel': '──── 入门链接（只显示这一次）────',
    'houseEntry.shortenUnavailable': '那座坊没有短链服务，这就是完整链接。',
    'houseEntry.shortenFailed':
      'BROWSER_ENTRY_SHORTEN_FAILED —— 短链服务没给出能用的回答（{reason}），所以这是完整链接。同一把钥匙，同一个站点。',
    'houseEntry.changed':
      'IDENTITY_OR_PIN_CHANGED —— 从预览到现在，你是谁、那座坊的钥匙、或者它声明的东西变了，所以什么都没签。再问一次，读新的预览。',
    'houseEntry.draftUnknown':
      '认不出或者已过期的 confirm_token：{token}\nconfirm_token 一次性、只属于 popclaw_house_entry_link，30 分钟后作废。带着坊名再调一次 popclaw_house_entry_link，拿一份新预览。',
    'houseEntry.mintFailed':
      '没拿回能用的东西，而 confirm_token 无论如何已经用掉了。带着坊名再调一次 popclaw_house_entry_link，拿一份新预览。',
    'houseEntry.unknownParameter':
      'popclaw_house_entry_link 不收这些：{fields}。它只收一个已挂坊的名字，外加可选的 description / persona / home_city。链接通向哪儿、用谁的钥匙、有效多久，都不是你能传进来的。',
  },
};

import { withOutcomes } from '../../helpers/with-outcomes.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { popclaw } from '@popclaw/contracts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { registerPopclawTools, OPTIONAL_TOOLS } from '../../../src/tools/register-tools.js';
import { _draftsForTest } from '../../../src/tools/draft-store.js';
import { sendDraftApproved } from '../../helpers/owner-approval-script.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { BondsStore } from '../../../src/bonds/bonds-store.js';
import { ProposalsStore } from '../../../src/bonds/proposals-store.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { ownerLang, setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import {
  MIGRATIONS_DIR,
  buildFakeApi,
  findTool,
  makeFakeCache,
  makeFakeMarkService,
  makeFakeMarksStore,
  makeImageDmFixture,
  makeMockRuntime,
  makeRealBondsStore,
  makeSigner,
} from '../../helpers/register-tools-fixture.js';

// Rollout slice 1: popclaw_follow/popclaw_unfollow/popclaw_world_guide/
// popclaw_author_latest now render in `ownerLang()` (S1 process-wide
// singleton). Pin zh-CN so this whole file's pre-lexicon assertions stay
// byte-for-byte unchanged (same fix as status.test.ts / world-tools.test.ts).
beforeAll(() => setOwnerLang('zh-CN', 'config'));

/** Real BondsStore + ProposalsStore sharing the same in-memory db + migrations. */
function makeRealBondsAndProposalsStore(): { bondsStore: BondsStore; proposalsStore: ProposalsStore } {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  return {
    bondsStore: new BondsStore(db, () => 1000),
    proposalsStore: new ProposalsStore(db, () => 1000),
  };
}

/** The OpenClaw 8.2 current-turn delivery capability, as a draft tool sees it.
 *  Only the drafts whose content cannot fit an approval prompt need it. */
function ownerDeliveringToolCtx(): Record<string, unknown> {
  return {
    sessionKey: 'agent:main:tui:owner',
    sessionId: 'sess-fixture',
    requesterSenderId: 'tui:owner',
    senderIsOwner: true,
    deliveryContext: { channel: 'tui', to: 'owner', accountId: 'tui' },
    delivery: { send: async (): Promise<void> => undefined },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerPopclawTools', () => {
  beforeEach(() => _draftsForTest.clear());

  it('registers all expected tool names without throwing', () => {
    const { api, tools } = buildFakeApi();

    registerPopclawTools({
      api,
      runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });

    const expected = [
      'popclaw_check_status',
      'popclaw_show_feed',
      'popclaw_search_feed',
      'popclaw_show_inbox',
      // 待回（Pings）· 回我帖
      'popclaw_show_pings',
      'popclaw_show_recommend',
      // daily newspaper: gather materials → agent renders → publish to canvas
      'popclaw_newspaper',
      'popclaw_publish_newspaper',
      'popclaw_canvas',
      'popclaw_dream',
      'popclaw_record_dream',
      'popclaw_write_taste',
      'popclaw_show_bonds',
      'popclaw_set_bond_tier',
      'popclaw_set_remark_name',
      'popclaw_show_dream_review',
      'popclaw_list_pending_proposals',
      'popclaw_draft_reply',
      'popclaw_draft_message',
      'popclaw_draft_post',
      'popclaw_send_draft',
      'popclaw_decide_bond_tier_proposal',
      'popclaw_mark',
      'popclaw_unmark',
      'popclaw_show_marks',
      // standalone rename tool
      'popclaw_set_name',
      // bond retrieval (Task 2)
      'popclaw_find_bonds',
      // taste core 追加（做梦第 2 步：onboarding 之后主人随时还能补）
      'popclaw_note_taste',
      // ADR-0042: agent 自己向官方报"我撞墙了"
      'popclaw_feedback',
      // ADR-0044 §2 的回归：空壳删掉后按准则 1 做出真实现（语言/时区，S1）
      'popclaw_update_cadence',
      // R1 顺一句：主人说「别提了」就闭嘴。同一条准则 1 —— 空壳转正，真写 muted 账本。
      'popclaw_mute_notices',
      // 「这人是谁」—— MCP 宿主没有斜杠命令，看别人的名帖只能靠工具。
      'popclaw_show_namecard',
      // #585: verification used to be slash-only, i.e. impossible on MCP. Not
      // gated on any dep — an MCP citizen must be able to get verified.
      'popclaw_invite',
      // #585: registers even when no host named an inbound directory; it then
      // says so instead of disappearing (popclaw_draft_message points at it).
      'popclaw_recent_attachments',
      // The home-entry link. Gated on nothing either: a root that registered
      // it conditionally would leave `contracts.tools` declaring a tool the
      // agent cannot call, and the agent would improvise a link instead.
      'popclaw_house_entry_link',
    ];
    const names = tools.map((t) => t.name);
    for (const name of expected) {
      expect(names).toContain(name);
    }
    expect(names.length).toBe(expected.length);
  });

  /**
   * 2026-08-28, 甲机: the writer reported "the tool requires picks as a flat array,
   * not a grouped object" and had two submissions rejected — while the brief was asking
   * it for the grouped object. Same turn, the newspaper tool's own description told it to
   * send `publish_token` on the second call, a parameter that stopped existing when the
   * candidate token was renamed; only `candidate_token` is declared.
   *
   * A description that names a parameter the schema does not declare is an instruction the
   * model cannot obey: the host validates against the schema, so the call is rejected
   * before it ever reaches us — and the receipt says nothing about why.
   */
  it('工具描述里点名的 *_token 参数,schema 必须真的有', () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'] });
    const offenders: string[] = [];
    for (const t of tools) {
      const declared = new Set(Object.keys(t.parameters?.properties ?? {}));
      const named = new Set([...(t.description ?? '').matchAll(/`([a-z_]+_token)`/g)].map((m) => m[1]!));
      for (const n of named) if (!declared.has(n)) offenders.push(`${t.name} → \`${n}\``);
    }
    expect(offenders).toEqual([]);
  });

  // OpenClaw exposes a plugin's tools to the agent from the STATIC contracts.tools
  // list in openclaw.plugin.json — NOT from the runtime registerTool() calls. A tool
  // registered but not declared there is invisible to the agent (the 2026-06-19
  // newspaper bug: popclaw_newspaper registered, agent kept improvising; also PR #89).
  // This test fails the moment the two drift apart, in either direction.
  /**
   * 2026-08-30，乙机整夜出不来报纸。它说「候选令牌过期了」——而盘上那个令牌好端端躺着。
   * 真相是：它交的 picks 没能活着到达插件（形状不对、被宿主的 schema 校验丢掉），
   * `hasPicks` 为假，于是代码**掉进了「重新取素材」那条分支**，回给它一张新的候选页和新令牌。
   * 模型只能把这读成「我那个过期了」，于是再试。两分钟里铸了八份候选集，一份挑选都没成。
   *
   * **带着 candidate_token 来的调用，意思只有一个：我要交挑选。** 这时候给它一张新页面，
   * 是这条工具链能做的最坏的回答。
   */
  ;

  ;

  ;

  /**
   * 宿主给「声明了但没赋值」的对象字段补一个 `{}`，是这一周反复见到的那类怪癖。
   * 若用 `p.picks ?? flat`，一个空的 picks 就会把带着数字的 picks_flat 整个吃掉 ——
   * 而 picks_flat 存在的全部理由，正是绕开这类怪癖。
   */
  ;

  ;

  ;

  ;

  it('openclaw.plugin.json contracts.tools stays in sync with the full registered tool set', () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
      // 7.1 的 plugins doctor 要求 contracts.tools 覆盖一切"可能注册"的工具——
      // recent_attachments 以 inboundMediaDirs 非空为门槛，全集测试必须把门打开
      // （真机 2026-08-11 彩排：manifest 缺它被 doctor 当场点名）。
      inboundMediaDirs: [tmpdir()],
      // non-undefined getters → the onboarding + world tools also register (full set)
      getOrchestrator: (async () => ({})) as unknown as Parameters<
        typeof registerPopclawTools
      >[0]['getOrchestrator'],
      getWorldDeps: (async () => ({})) as unknown as Parameters<
        typeof registerPopclawTools
      >[0]['getWorldDeps'],
      getHouseCommandContext: async () => { throw new Error('REGISTRATION_MUST_NOT_BOOT'); },
      getWorldCommandContext: async () => { throw new Error('REGISTRATION_MUST_NOT_BOOT'); },
    });
    const registered = tools.map((t) => t.name).sort();
    const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../openclaw.plugin.json');
    const declared = (JSON.parse(readFileSync(manifestPath, 'utf-8')).contracts.tools as string[]).slice().sort();
    expect(registered).toEqual(declared);
  });

  // Registration ORDER is what the agent sees in its tool listing, and after the
  // 2026-08-25 file split it is decided by the order of the register<Domain>Tools
  // calls in register-tools.ts — a one-line reorder there is invisible to every
  // other test in this file (they all sort or use toContain). This pins it.
  it('registers the full tool set in a fixed order (the agent sees this listing order)', () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
      inboundMediaDirs: [tmpdir()],
      getOrchestrator: (async () => ({})) as unknown as Parameters<
        typeof registerPopclawTools
      >[0]['getOrchestrator'],
      getWorldDeps: (async () => ({})) as unknown as Parameters<
        typeof registerPopclawTools
      >[0]['getWorldDeps'],
    });
    expect(tools.map((t) => t.name)).toEqual([
      // read-tools
      'popclaw_show_namecard',
      'popclaw_check_status',
      'popclaw_show_feed',
      'popclaw_search_feed',
      'popclaw_recent_attachments',
      'popclaw_show_inbox',
      'popclaw_show_pings',
      'popclaw_show_recommend',
      'popclaw_newspaper',
      'popclaw_publish_newspaper',
      'popclaw_canvas',
      'popclaw_dream',
      'popclaw_record_dream',
      'popclaw_write_taste',
      // stub-tools (first block)
      'popclaw_show_bonds',
      'popclaw_find_bonds',
      'popclaw_set_bond_tier',
      'popclaw_set_remark_name',
      'popclaw_show_dream_review',
      'popclaw_list_pending_proposals',
      // write-tools
      'popclaw_draft_reply',
      'popclaw_draft_message',
      'popclaw_draft_post',
      'popclaw_send_draft',
      // stub-tools (second block)
      'popclaw_decide_bond_tier_proposal',
      'popclaw_mute_notices',
      // onboarding-agent-tools
      'popclaw_onboarding_status',
      'popclaw_onboarding_continue',
      'popclaw_onboarding_skip',
      // world-tools
      'popclaw_world_guide',
      'popclaw_world_summary',
      'popclaw_author_latest',
      'popclaw_follow',
      'popclaw_unfollow',
      'popclaw_pair_browser',
      // invite-tools
      'popclaw_invite',
      // mark-tools
      'popclaw_mark',
      'popclaw_unmark',
      'popclaw_show_marks',
      // name-taste-tools
      'popclaw_set_name',
      'popclaw_note_taste',
      // feedback-cadence-tools
      'popclaw_feedback',
      'popclaw_update_cadence',
      // house-entry-tools
      'popclaw_house_entry_link',
    ]);
  });

  // #584: the returned count must be the number of tools ACTUALLY pushed
  // through registerTool this call — not the old hand-maintained arithmetic
  // (40 + 3 + 5 = 48), which had drifted one above the real 47.
  //
  it('returns the actual registered-tool count, matching the pinned list length, for the full ("OpenClaw") dep shape', () => {
    const { api, tools } = buildFakeApi();
    const registered = registerPopclawTools({
      api,
      runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
      inboundMediaDirs: [tmpdir()],
      getOrchestrator: (async () => ({})) as unknown as Parameters<
        typeof registerPopclawTools
      >[0]['getOrchestrator'],
      getWorldDeps: (async () => ({})) as unknown as Parameters<
        typeof registerPopclawTools
      >[0]['getWorldDeps'],
    });
    expect(tools.length).toBe(44);
    expect(registered).toBe(tools.length);
  });

  // #585: popclaw_recent_attachments registers on every host now — where no
  // inbound directory was handed in it says so instead of vanishing — so the MCP
  // dep shape counts the same as the OpenClaw one. What still moves the number is
  // the onboarding/world/house getters.
  it('returns the actual registered-tool count for the MCP dep shape (no inboundMediaDirs)', () => {
    const { api, tools } = buildFakeApi();
    const registered = registerPopclawTools({
      api,
      runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
      getOrchestrator: (async () => ({})) as unknown as Parameters<
        typeof registerPopclawTools
      >[0]['getOrchestrator'],
      getWorldDeps: (async () => ({})) as unknown as Parameters<
        typeof registerPopclawTools
      >[0]['getWorldDeps'],
    });
    expect(tools.length).toBe(44);
    expect(registered).toBe(tools.length);
  });

  // ADR-0044 §3: the hidden set lives in TWO places — the manifest's toolMetadata
  // (what the host actually reads: isManifestToolOptional) and OPTIONAL_TOOLS
  // (what the LEXICON gate reads). Drift means either a tool the model can't see
  // gets a routing entry pointing at it, or a tool meant to be hidden is not.
  it('OPTIONAL_TOOLS matches the manifest toolMetadata optional set', () => {
    const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../openclaw.plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      contracts: { tools: string[] };
      toolMetadata?: Record<string, { optional?: boolean }>;
    };
    const optionalInManifest = Object.entries(manifest.toolMetadata ?? {})
      .filter(([, meta]) => meta.optional === true)
      .map(([name]) => name)
      .sort();
    expect(optionalInManifest).toEqual([...OPTIONAL_TOOLS].sort());
    // A hidden tool must still be a declared one — optional metadata for a tool
    // that isn't in contracts.tools is silently dead config.
    for (const name of OPTIONAL_TOOLS) expect(manifest.contracts.tools).toContain(name);
  });

  // A schedulable feature the agent doesn't KNOW is schedulable is a feature the
  // owner gets told is impossible (real feedback: an agent refused「每天早上 8 点出
  // 晨报」claiming it had no way to write cron — while popclaw_dream, whose
  // description says so, gets scheduled fine). The job name and the delivery-off
  // rule are the two load-bearing bits; keep the two tools symmetric.
  it('the schedulable tools tell the agent the job name and to turn delivery off', () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    const descOf = (name: string) =>
      (findTool(tools, name) as unknown as { description: string }).description;
    for (const [tool, job] of [
      ['popclaw_dream', 'popclaw-dream'],
      ['popclaw_newspaper', 'popclaw-newspaper'],
    ] as const) {
      expect(descOf(tool)).toContain(`\`${job}\``);
      expect(descOf(tool)).toContain('result delivery off');
      // 2026-07-31 真机：主人的宿主配置是**排他**的 `tools.allow` 白名单，只列了插件
      // 工具，于是宿主自带的 cron 被静默切掉（#338）。agent 手上没有 cron，就把活儿
      // 寄回官方等回信。缺的是这台机器上的一次授权，只有主人能给——所以描述必须当场
      // 说清「让主人开什么」，并堵死两条错路（手改 crontab / 把活儿寄出去）。
      expect(descOf(tool)).toContain('`cron` to `tools.allow`');
      expect(descOf(tool)).toContain('only the owner can grant it');
    }
  });

  it('keeps candidate selection, same-turn publication and workshop stop rules visible', () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: vi.fn() as never });
    const desc = findTool(tools, 'popclaw_newspaper').description ?? '';
    // These two paths must remain distinguishable without loading the social skill.
    expect(desc).toMatch(/twice[\s\S]*no arguments[\s\S]*picks/);
    expect(desc).toMatch(/candidate_basis[\s\S]*candidate_token[\s\S]*refused/);
    expect(desc).toMatch(/same turn[\s\S]*edit[\s\S]*popclaw_publish_newspaper/);
    expect(desc).toMatch(/FIRST call[\s\S]*receipt[\s\S]*failure[\s\S]*delivered to this channel/);
    expect(desc).toMatch(/verbatim and stop[\s\S]*No second call or polling[\s\S]*another paper/);
    expect(desc).toContain('IANA timezone');
    expect(desc).toContain('same lore-houses');
    expect(desc).toContain('no extra parameters');
  });

  // 2026-07-31 真机：agent 拿着被切过的通知预览当整封信，把信里已经写清的做法又
  // 写成一封 feedback 寄回去问。截断已经改成明说（owner-notifier），这里管另一半：
  // 读全文再动手、能自己做的别寄回去问、feedback 不是问事处。
  it('the inbox/feedback tools tell the agent to read the full letter, not mail it back', () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    const descOf = (name: string) =>
      (findTool(tools, name) as unknown as { description: string }).description;
    const inbox = descOf('popclaw_show_inbox');
    expect(inbox).toContain('preview that may be cut off');
    expect(inbox).toContain('the full letter is in the inbox');
    expect(inbox).toContain('never write back asking what the letter already says');
    const feedback = descOf('popclaw_feedback');
    expect(feedback).toContain('not a question desk');
    expect(feedback).toContain('never send a second letter asking the same thing');
  });

  // 2026-07-31 真机：agent 撞墙（宿主 cron 被 tools.allow 白名单切掉，#338）后把同一
  // 件事寄了三封 feedback，然后**停在那里等回信**。反馈是 fire-and-forget（ADR-0042：
  // 无工单、无 SLA），等 = 永远卡住；而真正缺的是这台机器上的一次授权，给得起的人就
  // 坐在同一个对话里。描述里必须有分诊三档 + 「寄信不能替代前两档」+ 「绝不等回信」。
  it('popclaw_feedback carries the blocked-triage rule (owner grant is not a product gap)', () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    const feedback = (findTool(tools, 'popclaw_feedback') as unknown as { description: string })
      .description;
    // ① 自己能做的自己做 ② 缺权限 → 告诉主人开什么 ③ popclaw 真做不到 → 才寄信
    expect(feedback).toContain('whose problem it is');
    expect(feedback).toContain('tell the owner exactly what to enable');
    expect(feedback).toContain('popclaw never changes it for them');
    // 寄信不是行动的替代品，而且绝不等回信（无工单无 SLA）
    expect(feedback).toContain('never a substitute');
    expect(feedback).toContain('never wait for a reply');
  });

  it('popclaw_send_draft returns unknown when token missing', async () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: makeMockRuntime() });

    const sendTool = findTool(tools, 'popclaw_send_draft');
    const r = await sendDraftApproved(sendTool.execute, 'nope');
    // Through the lexicon since 2026-09-22, so this file's pinned zh-CN lane
    // is what it must come back in.
    expect(r.text).toBe(`${renderCopy(ownerLang(), 'draft.expiredToken', { token: 'nope' })} (reason: SUBJECT_REFUSED/DRAFT_UNKNOWN_OR_EXPIRED)`);
  });

  // 认人（ADR-0028 修订）：DM 工具的 recipient 收人用形式，草稿时就翻译成完整 id。
  it('popclaw_draft_message resolves 名号#印信 locally (bond hit → 零往返)', async () => {
    const { api, tools } = buildFakeApi();
    const bondsStore = makeRealBondsStore();
    // #227: 必须是真公钥 —— 私信正文要加密到它。
    const recipientId = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).publicKey);
    const sigil = deriveSigil(recipientId);
    bondsStore.setNickname(recipientId, 'Blackfeather');
    const resolve = vi.fn(async () => []);
    registerPopclawTools({
      api,
      runtime: makeMockRuntime({ bondsStore }),
      getWorldDeps: (async () => ({ resolveClient: { resolve } })) as unknown as Parameters<
        typeof registerPopclawTools
      >[0]['getWorldDeps'],
    });

    const draftTool = findTool(tools, 'popclaw_draft_message');
    const sendTool = findTool(tools, 'popclaw_send_draft');
    const draft = await draftTool.execute('cid', { recipient: `Blackfeather#${sigil}`, body: 'hi' });

    expect(draft.text).toContain(`Blackfeather#${sigil}`);
    expect(draft.text).toContain(recipientId); // 机器钥匙同时递给 agent
    expect(draft.text).toMatch(/draft_id: message-/);
    expect(resolve).not.toHaveBeenCalled(); // 交情本命中 → 不问灯坊

    // 发出回执与草稿同款人话（不是裸 id）。
    const token = draft.text.match(/draft_id: (message-[0-9]+)/)![1];
    const sent = await sendDraftApproved(sendTool.execute, token!);
    expect(sent.text).toContain(`Blackfeather#${sigil}`);
    expect(sent.text).toContain(recipientId);
  });

  // 发送前关系建议：把收方的 relative-value 闸在发送侧
  // 翻译给主人。闸判的是「收件人有没有关注我」（ADR-0012 修订），所以建议只看
  // 这一个方向 —— 主人关注了对方但对方没回关，恰恰是最该提醒的那一种。
  async function draftTo(recipientId: string, knownFollowers?: unknown) {
    const { api, tools } = buildFakeApi();
    const bondsStore = makeRealBondsStore();
    bondsStore.setNickname(recipientId, 'Blackfeather');
    registerPopclawTools({
      api,
      runtime: makeMockRuntime({ bondsStore, ...(knownFollowers ? { knownFollowers } : {}) }),
      getWorldDeps: (async () => ({ resolveClient: { resolve: vi.fn(async () => []) } })) as unknown as Parameters<
        typeof registerPopclawTools
      >[0]['getWorldDeps'],
    });
    return findTool(tools, 'popclaw_draft_message').execute('cid', {
      recipient: `Blackfeather#${deriveSigil(recipientId)}`,
      body: 'hi',
    });
  }

  const someoneId = () => bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey);

  it('草稿预览：对方没关注我 → 给出关系建议（信会到，但不会主动提醒他）', async () => {
    const id = someoneId();
    const draft = await draftTo(id, { allFollowerIds: () => [] });
    expect(draft.text).toContain('还没关注你');
    expect(draft.text).toMatch(/draft_id: message-/); // 建议不拦发送
  });

  it('草稿预览：对方已关注我 → 不啰嗦', async () => {
    const id = someoneId();
    const draft = await draftTo(id, { allFollowerIds: () => [id] });
    expect(draft.text).not.toContain('还没关注你');
  });

  it('草稿预览：粉丝表根本没接上 → 闭嘴，不猜', async () => {
    const draft = await draftTo(someoneId());
    expect(draft.text).not.toContain('还没关注你');
  });

  // -------------------------------------------------------------------------
  // #231 第 2 刀 — popclaw_draft_message 的 image_path
  //
  // 真机 2026-07-28：没有夹图入口时 agent 自己发明了往 body 里塞
  // "MEDIA:/Users/…"，对方收到一截裸本地路径。这一组是那条黑路的回归闸。
  // -------------------------------------------------------------------------

  function writeTmpImage(name: string, bytes: Uint8Array): string {
    const p = join(mkdtempSync(join(tmpdir(), 'popclaw-tool-img-')), name);
    writeFileSync(p, bytes);
    return p;
  }

  it('popclaw_draft_message + image_path → DM 带 media_ciphertext/nonce，收件人解得回原字节', async () => {
    const { api, tools } = buildFakeApi();
    const fx = makeImageDmFixture();
    registerPopclawTools({ api, runtime: fx.runtime });

    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const imagePath = writeTmpImage('cat.png', PNG);

    const draft = await findTool(tools, 'popclaw_draft_message').execute('cid', {
      recipient: fx.recipientRef,
      body: '看这只猫',
      image_path: imagePath,
    });
    // 主人确认的是**完整内容**：哪张图、多大。
    expect(draft.text).toContain('📎 附件：cat.png');
    expect(draft.text).toMatch(/draft_id: message-/);

    const token = draft.text.match(/draft_id: (message-[0-9]+)/)![1];
    const sent = await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, token!);
    expect(sent.text).toContain('📎 附件：cat.png');

    expect(fx.push).toHaveBeenCalledOnce();
    const sp = popclaw.identity.SignedPayload.decode(fx.push.mock.calls[0]![0]);
    const dm = popclaw.event.EventEnvelope.decode(sp.payload).directMessage!;
    const senderId = await makeSigner().popclawId();
    const opened = fx.recipient.openDmMedia(
      { ciphertext: dm.mediaCiphertext, nonce: dm.mediaNonce },
      senderId,
    );
    expect(opened.ok && opened.mime).toBe('image/png');
    expect(opened.ok && Array.from(opened.bytes)).toEqual(Array.from(PNG));
    // 正文里绝不能出现本地路径（那正是真机上 agent 发明的黑路）。
    expect(fx.recipient.openDm(dm, senderId)).toMatchObject({ ok: true, plaintext: '看这只猫' });
  });

  it('popclaw_draft_message 无图时两个 media 字段整个不上线（CID 不漂移）', async () => {
    const { api, tools } = buildFakeApi();
    const fx = makeImageDmFixture();
    registerPopclawTools({ api, runtime: fx.runtime });

    const draft = await findTool(tools, 'popclaw_draft_message').execute('cid', {
      recipient: fx.recipientRef,
      body: 'hi',
    });
    expect(draft.text).not.toContain('附图');
    const token = draft.text.match(/draft_id: (message-[0-9]+)/)![1];
    await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, token!);

    const sp = popclaw.identity.SignedPayload.decode(fx.push.mock.calls[0]![0]);
    const payload = sp.payload;
    const dm = popclaw.event.EventEnvelope.decode(payload).directMessage!;
    expect(Object.prototype.hasOwnProperty.call(dm, 'mediaCiphertext')).toBe(false);
    // prost 重编码 == 我们编的 → CID 一致。
    const reencoded = popclaw.event.EventEnvelope.encode(
      popclaw.event.EventEnvelope.decode(payload),
    ).finish();
    expect(Array.from(reencoded)).toEqual(Array.from(payload));
  });

  // 纯图无字（2026-07-29 真机）：主人发表情包被「正文必填」打回。
  it('popclaw_draft_message 纯图无 body → 预览写「纯图，无正文」，发出后收件人解出图、正文空', async () => {
    const { api, tools } = buildFakeApi();
    const fx = makeImageDmFixture();
    registerPopclawTools({ api, runtime: fx.runtime });

    const GIF = new Uint8Array([0x47, 0x49, 0x46, 7, 7]);
    const draft = await findTool(tools, 'popclaw_draft_message').execute('cid', {
      recipient: fx.recipientRef,
      image_path: writeTmpImage('meme.gif', GIF),
    });
    // 主人确认的仍是**完整内容**：这封信没有字，只有这张图。
    expect(draft.text).toContain('（纯图，无正文）');
    expect(draft.text).toContain('📎 附件：meme.gif');
    expect(draft.text).toMatch(/draft_id: message-/);

    const token = draft.text.match(/draft_id: (message-[0-9]+)/)![1];
    const sent = await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, token!);
    expect(sent.text).toContain('📎 附件：meme.gif');
    expect(sent.text.toLowerCase()).not.toMatch(/usage/);

    expect(fx.push).toHaveBeenCalledOnce();
    const sp = popclaw.identity.SignedPayload.decode(fx.push.mock.calls[0]![0]);
    const dm = popclaw.event.EventEnvelope.decode(sp.payload).directMessage!;
    const senderId = await makeSigner().popclawId();
    expect(fx.recipient.openDm(dm, senderId)).toMatchObject({ ok: true, plaintext: '' });
    const opened = fx.recipient.openDmMedia(
      { ciphertext: dm.mediaCiphertext, nonce: dm.mediaNonce },
      senderId,
    );
    expect(opened.ok && Array.from(opened.bytes)).toEqual(Array.from(GIF));
  });

  it('popclaw_draft_message 正文与图都空 → 人话报错、无 draft_id、egress 零调用', async () => {
    const { api, tools } = buildFakeApi();
    const fx = makeImageDmFixture();
    registerPopclawTools({ api, runtime: fx.runtime });

    const draft = await findTool(tools, 'popclaw_draft_message').execute('cid', {
      recipient: fx.recipientRef,
    });
    expect(draft.text).not.toMatch(/draft_id/);
    expect(draft.text).toMatch(/正文|图/);
    expect(fx.push).not.toHaveBeenCalled();
  });

  // S3 rollout slice 4 — en lane (empty-body guard + image-only/attach preview lines).
  it('popclaw_draft_message renders in en when set', async () => {
    setOwnerLang('en', 'config');
    const { api, tools } = buildFakeApi();
    const fx = makeImageDmFixture();
    registerPopclawTools({ api, runtime: fx.runtime });

    const empty = await findTool(tools, 'popclaw_draft_message').execute('cid', { recipient: fx.recipientRef });
    expect(empty.text).toContain('This message is empty');

    const draft = await findTool(tools, 'popclaw_draft_message').execute('cid', {
      recipient: fx.recipientRef,
      image_path: writeTmpImage('meme.gif', new Uint8Array([0x47, 0x49, 0x46, 7, 7])),
    });
    expect(draft.text).toContain('(image only, no body)');
    expect(draft.text).toContain('📎 attached: meme.gif');
    setOwnerLang('zh-CN', 'config'); // restore file default for tests after this one
  });

  it('超 1MB 的图在**草稿阶段**就被拒：无 draft_id、egress 零调用', async () => {
    const { api, tools } = buildFakeApi();
    const fx = makeImageDmFixture();
    registerPopclawTools({ api, runtime: fx.runtime });

    const huge = writeTmpImage('huge.png', new Uint8Array(1024 * 1024 + 1));
    const draft = await findTool(tools, 'popclaw_draft_message').execute('cid', {
      recipient: fx.recipientRef,
      body: 'hi',
      image_path: huge,
    });
    expect(draft.text).not.toMatch(/draft_id/);
    expect(draft.text).toContain('1024.0 KB'); // 上限的具体数字
    expect(draft.text).toMatch(/压/); // 下一步建议
    expect(fx.push).not.toHaveBeenCalled();
  });

  // 放开格式（2026-07-31）：参数改叫 attachment_path，旧的 image_path 留作别名
  // —— 上面那条用例递的就是 image_path，两条合起来把新旧两个入口都盖住了。
  it('attachment_path 收语音与文本，草稿预览带文件名', async () => {
    const { api, tools } = buildFakeApi();
    const fx = makeImageDmFixture();
    registerPopclawTools({ api, runtime: fx.runtime });
    const draftTool = findTool(tools, 'popclaw_draft_message');

    const voice = await draftTool.execute('cid', {
      recipient: fx.recipientRef,
      attachment_path: writeTmpImage('hello.ogg', new Uint8Array([1, 2, 3])),
    });
    expect(voice.text).toContain('hello.ogg');
    expect(voice.text).toMatch(/draft_id/);

    const spec = await draftTool.execute('cid', {
      recipient: fx.recipientRef,
      body: '照这份排',
      attachment_path: writeTmpImage('spec.md', new Uint8Array([1, 2, 3])),
    });
    expect(spec.text).toContain('spec.md');
    expect(spec.text).toMatch(/draft_id/);
  });

  it('认不出的扩展名 / 读不到的路径也在草稿阶段就拒', async () => {
    const { api, tools } = buildFakeApi();
    const fx = makeImageDmFixture();
    registerPopclawTools({ api, runtime: fx.runtime });
    const draftTool = findTool(tools, 'popclaw_draft_message');

    const heic = await draftTool.execute('cid', {
      recipient: fx.recipientRef,
      body: 'hi',
      image_path: writeTmpImage('shot.heic', new Uint8Array([1])),
    });
    expect(heic.text).toMatch(/jpg\/png\/gif\/webp/);
    expect(heic.text).not.toMatch(/draft_id/);

    const missing = await draftTool.execute('cid', {
      recipient: fx.recipientRef,
      body: 'hi',
      image_path: '/definitely/not/here.png',
    });
    expect(missing.text).toMatch(/读不到/);
    expect(missing.text).not.toMatch(/draft_id/);
    expect(fx.push).not.toHaveBeenCalled();
  });

  // follow 也走同一条本地优先通路（Critical 1 的回归闸：拉丁名号变体）。
  it('popclaw_follow resolves locally and follows the FULL popclaw_id (名号#印信 / 拉丁名号)', async () => {
    for (const nickname of ['Blackfeather', 'blackfeather']) {
      const { api, tools } = buildFakeApi();
      const bondsStore = makeRealBondsStore();
      const followeeId = bs58.encode(new Uint8Array(32).fill(7));
      bondsStore.setNickname(followeeId, nickname);
      const declareFollow = vi.fn(async () => {});
      const resolve = vi.fn(async () => []);
      const runtime = makeMockRuntime({ bondsStore });
      registerPopclawTools({
        api,
        runtime: (async () => ({
          ...(await runtime()),
          socialGraph: withOutcomes({ declareFollow, following: () => [] }),
        })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
        getWorldDeps: (async () => ({ resolveClient: { resolve } })) as unknown as Parameters<
          typeof registerPopclawTools
        >[0]['getWorldDeps'],
      });

      const followTool = findTool(tools, 'popclaw_follow');
      const ref = nickname === 'blackfeather' ? nickname : `${nickname}#${deriveSigil(followeeId)}`;
      const r = await followTool.execute('cid', { name: ref });

      expect(resolve).not.toHaveBeenCalled(); // 交情本命中 → 不问灯坊
      expect(declareFollow).toHaveBeenCalledWith(followeeId);
      expect(r.text).toContain(nickname);
    }
  });

  // popclaw_unfollow 对称新增（spec 2026-07-26）：同一条本地优先通路 + 精准命中直接执行。
  it('popclaw_unfollow resolves locally and revokes the FULL popclaw_id', async () => {
    const { api, tools } = buildFakeApi();
    const bondsStore = makeRealBondsStore();
    const followeeId = bs58.encode(new Uint8Array(32).fill(9));
    const nickname = 'Blackfeather';
    bondsStore.setNickname(followeeId, nickname);
    const revokeFollow = vi.fn(async () => {});
    const resolve = vi.fn(async () => []);
    const runtime = makeMockRuntime({ bondsStore });
    registerPopclawTools({
      api,
      runtime: (async () => ({
        ...(await runtime()),
        socialGraph: withOutcomes({ revokeFollow, following: () => [{ popclawId: followeeId }] }),
      })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
      getWorldDeps: (async () => ({ resolveClient: { resolve } })) as unknown as Parameters<
        typeof registerPopclawTools
      >[0]['getWorldDeps'],
    });

    const unfollowTool = findTool(tools, 'popclaw_unfollow');
    const r = await unfollowTool.execute('cid', { name: `${nickname}#${deriveSigil(followeeId)}` });

    expect(resolve).not.toHaveBeenCalled(); // 交情本命中 → 不问灯坊
    expect(revokeFollow).toHaveBeenCalledWith(followeeId);
    expect(r.text).toContain(nickname);
    // The one unfollow receipt (relation.unfollowReceivedNoHouse) — "取关"
    // alone also matches relation.unfollowQueued, so pin the full rendered
    // string instead. No house slug came back from revokeFollow here, so it's
    // the neutral no-house variant (architect ruling: never guess the home
    // house).
    expect(r.text).toContain(
      renderCopy(ownerLang(), 'relation.unfollowReceivedNoHouse', {
        who: `${nickname}#${deriveSigil(followeeId)}`,
      }),
    );
  });

  it('popclaw_unfollow: not currently following → honest reply, no event', async () => {
    const { api, tools } = buildFakeApi();
    const bondsStore = makeRealBondsStore();
    const followeeId = bs58.encode(new Uint8Array(32).fill(10));
    bondsStore.setNickname(followeeId, '路人甲');
    const revokeFollow = vi.fn(async () => {});
    const runtime = makeMockRuntime({ bondsStore });
    registerPopclawTools({
      api,
      runtime: (async () => ({
        ...(await runtime()),
        socialGraph: {
          ...withOutcomes({ revokeFollow, following: () => [] }),
          // The per-house producer refuses an absent relation before signing.
          revokeFollowWithOutcome: async () => ({ mode: 'none', transport: 'unchanged', domain: 'unknown',
            action: 'revoke', followee: followeeId, reason: 'RELATION_NOT_FOLLOWING' }),
        },
      })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
      getWorldDeps: (async () => ({ resolveClient: { resolve: vi.fn(async () => []) } })) as unknown as Parameters<
        typeof registerPopclawTools
      >[0]['getWorldDeps'],
    });

    const unfollowTool = findTool(tools, 'popclaw_unfollow');
    const r = await unfollowTool.execute('cid', { name: `路人甲#${deriveSigil(followeeId)}` });

    expect(revokeFollow).not.toHaveBeenCalled();
    // Rendered through the same key rather than a pinned English phrase:
    // this suite runs in zh, and an assertion on one language's wording
    // fails for a reason that has nothing to do with what it is testing.
    expect(r.text).toContain(renderCopy(ownerLang(), 'relation.notFollowing', { who: followeeId }));
  });

  it('popclaw_draft_message 查无此人 → 诚实说，不发 draft_id', async () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: makeMockRuntime({ bondsStore: makeRealBondsStore() }),
      getWorldDeps: (async () => ({
        resolveClient: { resolve: async () => [] },
      })) as unknown as Parameters<typeof registerPopclawTools>[0]['getWorldDeps'],
    });

    const draftTool = findTool(tools, 'popclaw_draft_message');
    const draft = await draftTool.execute('cid', { recipient: '查无此人', body: 'hi' });

    expect(draft.text).not.toMatch(/draft_id/);
    expect(draft.text).not.toMatch(/reply/i);
    expect(draft.text).toContain('查无此人');
  });

  it('popclaw_draft_post then send_draft round-trips root', async () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: makeMockRuntime() });

    const draftTool = findTool(tools, 'popclaw_draft_post');
    const sendTool = findTool(tools, 'popclaw_send_draft');

    const draft = await draftTool.execute('cid', { body: 'hi' });
    expect(draft.text).toMatch(/Draft root post/);
    const m = draft.text.match(/draft_id: (post-[0-9]+)/);
    expect(m).toBeTruthy();

    const sent = await sendDraftApproved(sendTool.execute, m![1]!);
    expect(sent.text).toMatch(/已发帖 #[0-9a-f]{10}/);
  });

  it('popclaw_draft_post round-trips reply', async () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: makeMockRuntime() });

    const draftTool = findTool(tools, 'popclaw_draft_post');
    const sendTool = findTool(tools, 'popclaw_send_draft');

    const draft = await draftTool.execute('cid', {
      body: 'ack',
      reply_to_event_id: 'a'.repeat(64),
    });
    expect(draft.text).toMatch(/Draft reply post/);
    const m = draft.text.match(/draft_id: (post-[0-9]+)/);
    expect(m).toBeTruthy();

    const sent = await sendDraftApproved(sendTool.execute, m![1]!);
    expect(sent.text).toMatch(/已回复/);
  });

  it('popclaw_draft_post round-trips quote', async () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: makeMockRuntime() });

    const draftTool = findTool(tools, 'popclaw_draft_post');
    const sendTool = findTool(tools, 'popclaw_send_draft');

    const draft = await draftTool.execute('cid', {
      body: '城东更便宜',
      quote_of_event_id: 'b'.repeat(64),
    });
    expect(draft.text).toMatch(/Draft quote post/);
    const m = draft.text.match(/draft_id: (post-[0-9]+)/);
    expect(m).toBeTruthy();

    const sent = await sendDraftApproved(sendTool.execute, m![1]!);
    expect(sent.text).toMatch(/已引用/);
  });

  // 真机 bug（2026-07-27）：宿主一天 33 次以 tool-discovery / full 模式重载插件,
  // 每次都是一个**新的模块实例**。草稿表原本是模块作用域的 Map,重载即陪葬 →
  // agent 刚拿到的 draft_token 几秒后 send 报 unknown。修法是把表挂进程级全局
  // （同 runOncePerProcess 的 globalThis 机制,P-006 §3）。
  // 这条测试就是那次重载：注册两轮,第一轮发的 token 必须能被第二轮的 send 消费。
  it('draft_token survives a plugin re-register (new module instance → same process store)', async () => {
    // `vi.resetModules()` + 重新 import 才是真的第二个模块实例 —— 同进程内直接
    // 调两次 registerPopclawTools 共用同一份模块作用域,复现不出这个 bug。
    vi.resetModules();
    const modA = await import('../../../src/tools/register-tools.js');
    vi.resetModules();
    const modB = await import('../../../src/tools/register-tools.js');
    expect(modA.registerPopclawTools).not.toBe(modB.registerPopclawTools); // 确证：两个实例

    const first = buildFakeApi();
    modA.registerPopclawTools({ api: first.api, runtime: makeMockRuntime() });
    const draft = await findTool(first.tools, 'popclaw_draft_post').execute('cid', { body: 'hi' });
    const token = draft.text.match(/draft_id: (post-[0-9]+)/)![1];

    // 宿主重载：新模块实例 + 全新的 api / tools 数组。
    const second = buildFakeApi();
    modB.registerPopclawTools({ api: second.api, runtime: makeMockRuntime() });

    // The owner approves through the RELOADED instance's own seam: approval
    // bookkeeping is module state and does not survive a reload, while the
    // draft table is process state and must — which is the whole point here.
    const seamB = await import('../../../src/host/owner-approval.js');
    seamB.setOwnerApprovalSurface(true);
    const callRef = 'reload-send';
    const request = await seamB.ownerApprovalBeforeToolCall(
      { toolName: 'popclaw_send_draft', params: { draft_id: token }, toolCallId: callRef },
      { toolCallId: callRef, requester: { channel: 'tui', senderId: 'owner-fixture', senderIsOwner: true } },
    );
    request!.requireApproval.onResolution('allow-once');

    const sent = await findTool(second.tools, 'popclaw_send_draft').execute(callRef, { draft_id: token });
    // The fresh module instance has its own owner-language state, so it speaks the default (en).
    expect(sent.text).toMatch(/posted #[0-9a-f]{10}/);
  });


  // 真机故障（2026-07-29 晨）回归锁：草稿 id 必须**低熵**。原来的
  // `message_<ms>_<8位随机>` 长得像密钥，被宿主的脱敏/压缩层改写
  // （`messag…8yda`、`***`），agent 拿着改过的 id 来 send 永远 unknown。
  it('draft ids are low-entropy sequential — nothing a secret-masker would touch', async () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: makeMockRuntime() });
    const d1 = await findTool(tools, 'popclaw_draft_post').execute('cid', { body: 'a' });
    const d2 = await findTool(tools, 'popclaw_draft_post').execute('cid', { body: 'b' });
    const id1 = d1.text.match(/draft_id: (post-[0-9]+)/)![1]!;
    const id2 = d2.text.match(/draft_id: (post-[0-9]+)/)![1]!;
    expect(id1).toMatch(/^post-\d+$/);           // 无时间戳、无随机段
    expect(Number(id2.slice(5))).toBe(Number(id1.slice(5)) + 1); // 进程内严格递增
  });

  // 确认闸不许弱化：token 一次性使用,消费即删。
  it('draft_token is single-use — the second send is refused', async () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: makeMockRuntime() });

    const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', { body: 'hi' });
    const token = draft.text.match(/draft_id: (post-[0-9]+)/)![1];
    const sendTool = findTool(tools, 'popclaw_send_draft');

    expect((await sendDraftApproved(sendTool.execute, token!)).text).toMatch(/已发帖 #/);
    const again = await sendDraftApproved(sendTool.execute, token!);
    expect(again.text).toBe(`${renderCopy(ownerLang(), 'draft.expiredToken', { token: token! })} (reason: SUBJECT_REFUSED/DRAFT_UNKNOWN_OR_EXPIRED)`);
    // Whatever the lane, the sentence has to say the id is spent.
    expect(again.text).toMatch(/single-use|只能用一次/);
  });

  // 表只增不减是慢性泄漏；30 分钟 TTL 兜底,过期的报错要告诉 agent 重新 draft,
  // 别再让它猜「要快速连续调用」这种迷信。
  it('draft_token expires after 30 minutes, with an actionable message', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      const t0 = 1_700_000_000_000;
      nowSpy.mockReturnValue(t0);

      const { api, tools } = buildFakeApi();
      registerPopclawTools({ api, runtime: makeMockRuntime() });
      const draft = await findTool(tools, 'popclaw_draft_post').execute('cid', { body: 'hi' });
      const token = draft.text.match(/draft_id: (post-[0-9]+)/)![1];

      nowSpy.mockReturnValue(t0 + 30 * 60 * 1000 + 1);
      const sent = await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, token!);
      expect(sent.text).toBe(`${renderCopy(ownerLang(), 'draft.expiredToken', { token: token! })} (reason: SUBJECT_REFUSED/DRAFT_UNKNOWN_OR_EXPIRED)`);
      // Actionable in either lane: how long it lived, and what to call next.
      expect(sent.text).toMatch(/30 minutes|30 分钟/);
      expect(sent.text).toContain('popclaw_draft_');
    } finally {
      nowSpy.mockRestore();
    }
  });

  // popclaw never calls an LLM: popclaw_newspaper returns the materials+rules for the
  // AGENT to render (in its own turn, on the host's model), then popclaw_publish_newspaper
  // F2-checks the agent's HTML and uploads it to canvas. (spec 2026-06-18)
  ;

  // 2026-07-31 真机截图：报头是「苍梧小居士晚报 · July 31, 2026」——中文报名配英文
  // 日期。根因是这里曾**直读** cadence 的 `delivery.primaryLanguage`，没配过的主人
  // 拿到的永远是 `defaultCadence()` 的 en-US，整条活语言登记被绕过。
  // 语言只有一个读取口：`ownerLangTag()`。
  ;

  // Honesty gap (person-first v2 follow-up): the follow-state label must come from
  // the REAL social graph — a wrong 「未关注 ➕」 on someone the owner follows is
  // worse than no label. Was stubbed `() => false`.
  ;

  it('popclaw_draft_post then send propagates mutual-exclusion error from runPopclawPostCommand', async () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: makeMockRuntime() });

    const draftTool = findTool(tools, 'popclaw_draft_post');
    const sendTool = findTool(tools, 'popclaw_send_draft');

    const draft = await draftTool.execute('cid', {
      body: 'hi',
      reply_to_event_id: 'a'.repeat(64),
      quote_of_event_id: 'b'.repeat(64),
    });
    const m = (draft.text as string).match(/draft_id: (post-[0-9]+)/);
    expect(m).toBeTruthy();

    const sent = await sendDraftApproved(sendTool.execute, m![1]!);
    expect(sent.text).toMatch(/只能二选一/);
  });

  // ---------------------------------------------------------------------------
  // Bond tools (C1 regression: set_bond_tier must NOT route through the
  // tier→verb map — `add` maps back to 'friend', so 'acquaintance' would
  // silently become 'friend'). Drives the real BondsStore through the tool.
  // ---------------------------------------------------------------------------

  /** Register tools with a runtime exposing a real BondsStore. */
  function registerWithBonds(store: BondsStore) {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn(async () => ({ bondsStore: store })) as unknown as Parameters<
        typeof registerPopclawTools
      >[0]['runtime'],
    });
    return tools;
  }

  it('popclaw_set_bond_tier acquaintance sets acquaintance, NOT friend (C1)', async () => {
    const store = makeRealBondsStore();
    const tools = registerWithBonds(store);

    const r = await findTool(tools, 'popclaw_set_bond_tier').execute('cid', {
      popclaw_id: 'ALICE',
      tier: 'acquaintance',
    });
    expect(store.get('ALICE')!.tier).toBe('acquaintance');
    expect(store.get('ALICE')!.tier).not.toBe('friend');
    expect(store.get('ALICE')!.tierSource).toBe('manual');
    expect(r.text).toContain('认识');
  });

  it('popclaw_set_bond_tier close sets close', async () => {
    const store = makeRealBondsStore();
    const tools = registerWithBonds(store);

    const r = await findTool(tools, 'popclaw_set_bond_tier').execute('cid', {
      popclaw_id: 'BOB',
      tier: 'close',
    });
    expect(store.get('BOB')!.tier).toBe('close');
    expect(r.text).toContain('密友');
  });

  it('popclaw_set_bond_tier with an invalid tier warns and does not create the bond', async () => {
    const store = makeRealBondsStore();
    const tools = registerWithBonds(store);

    const r = await findTool(tools, 'popclaw_set_bond_tier').execute('cid', {
      popclaw_id: 'CAROL',
      tier: 'bogus',
    });
    expect(r.text).toMatch(/⚠️ unknown tier "bogus"/);
    expect(store.get('CAROL')).toBeNull();
  });

  // S3 rollout slice 4 — en lane.
  it('popclaw_set_bond_tier renders in en when set', async () => {
    setOwnerLang('en', 'config');
    const store = makeRealBondsStore();
    const tools = registerWithBonds(store);
    const r = await findTool(tools, 'popclaw_set_bond_tier').execute('cid', {
      popclaw_id: 'ALICE',
      tier: 'close',
    });
    expect(r.text).toContain(`Set #${deriveSigil('ALICE')} to "close friend".`);
    setOwnerLang('zh-CN', 'config'); // restore file default for tests after this one
  });

  it('popclaw_show_bonds honours min_tier + limit', async () => {
    const store = makeRealBondsStore();
    store.setTier('ACQ', 'acquaintance', 'manual');
    store.setTier('FRIEND', 'friend', 'manual');
    store.setTier('CLOSE', 'close', 'manual');
    const tools = registerWithBonds(store);

    const showBonds = findTool(tools, 'popclaw_show_bonds');
    // min_tier=friend floors out the acquaintance row.
    const floored = await showBonds.execute('cid', { min_tier: 'friend' });
    expect(floored.text).toContain('FRIEND');
    expect(floored.text).toContain('CLOSE');
    expect(floored.text).not.toContain('ACQ');

    // limit=1 keeps only the top-ranked bond (close).
    const capped = await showBonds.execute('cid', { limit: 1 });
    expect(capped.text).toContain('CLOSE');
    expect(capped.text).not.toContain('FRIEND');
    expect(capped.text).not.toContain('ACQ');
  });

  // ---------------------------------------------------------------------------
  // Mark tools (Task 9)
  // ---------------------------------------------------------------------------

  it('popclaw_mark succeeds and output contains "marked"', async () => {
    const markService = makeFakeMarkService();
    const worldFeedCache = makeFakeCache();
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: makeMockRuntime({ markService, worldFeedCache }) });

    const tool = findTool(tools, 'popclaw_mark');
    const r = await tool.execute('cid', { id: 'abcdef' });
    expect(r.text).toMatch(/✓ 已标记/);
    expect(markService.mark).toHaveBeenCalledOnce();
  });

  it('popclaw_unmark succeeds and output contains "unmarked"', async () => {
    const markService = makeFakeMarkService();
    const worldFeedCache = makeFakeCache();
    const marksStore = makeFakeMarksStore();
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: makeMockRuntime({ markService, worldFeedCache, marksStore }) });

    const tool = findTool(tools, 'popclaw_unmark');
    const r = await tool.execute('cid', { id: 'abcdef' });
    expect(r.text).toMatch(/unmarked|was not marked/);
    expect(markService.unmark).toHaveBeenCalledOnce();
  });

  it('popclaw_show_marks with empty store returns no-marks text', async () => {
    const marksStore = makeFakeMarksStore([]);
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: makeMockRuntime({ marksStore }) });

    const tool = findTool(tools, 'popclaw_show_marks');
    const r = await tool.execute('cid', {});
    expect(r.text).toMatch(/no marks/);
  });

  it('popclaw_show_marks with rows returns marks list', async () => {
    const marksStore = makeFakeMarksStore([
      {
        eventId: 'abcdef1234567890' + '0'.repeat(48),
        handle: 'alice',
        authorPopclawId: 'pid_alice',
        summaryLine: 'interesting post',
        sourceUrl: 'https://x.com/alice/status/1',
      },
    ]);
    const { api, tools } = buildFakeApi();
    registerPopclawTools({ api, runtime: makeMockRuntime({ marksStore }) });

    const tool = findTool(tools, 'popclaw_show_marks');
    const r = await tool.execute('cid', { limit: 5 });
    expect(r.text).toMatch(/marks \(1\)/);
    expect(r.text).toMatch(/@alice/);
    // Pins: number → Math.floor → String(flags) → parseInt plumbing
    expect(marksStore.listActiveCalls).toContain(5);
  });

  // ---------------------------------------------------------------------------
  // Dreamer review tools (Task 7: replace notYetImplemented stubs with real handlers)
  // ---------------------------------------------------------------------------

  /** Register tools with a runtime exposing real BondsStore + ProposalsStore. */
  function registerWithBondsAndProposals(bondsStore: BondsStore, proposalsStore: ProposalsStore) {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn(async () => ({ bondsStore, proposalsStore })) as unknown as Parameters<
        typeof registerPopclawTools
      >[0]['runtime'],
    });
    return tools;
  }

  describe('dreamer review tools', () => {
    it('popclaw_show_dream_review renders a review card (dynamic content)', async () => {
      const { bondsStore, proposalsStore } = makeRealBondsAndProposalsStore();
      // seed a bond so there is at least something in the store
      bondsStore.setTier('ALICE', 'friend', 'manual');
      const tools = registerWithBondsAndProposals(bondsStore, proposalsStore);

      const r = await findTool(tools, 'popclaw_show_dream_review').execute('cid', {});
      // renderReview always emits some text (not the stub "not yet implemented" message)
      expect(r.text).not.toMatch(/not yet implemented/i);
      expect(r.text).not.toMatch(/notYetImplemented/i);
      // the review card starts with the section header or bond count marker
      expect(r.text.length).toBeGreaterThan(0);
    });

    it('popclaw_list_pending_proposals returns "no proposals" when queue is empty', async () => {
      const { bondsStore, proposalsStore } = makeRealBondsAndProposalsStore();
      const tools = registerWithBondsAndProposals(bondsStore, proposalsStore);

      const r = await findTool(tools, 'popclaw_list_pending_proposals').execute('cid', {});
      expect(r.text).not.toMatch(/not yet implemented/i);
      // empty queue → no pending rows
      expect(r.text).toMatch(/0|没有|空/);
    });

    it('popclaw_list_pending_proposals lists existing proposals', async () => {
      const { bondsStore, proposalsStore } = makeRealBondsAndProposalsStore();
      bondsStore.setTier('BOB', 'acquaintance', 'manual');
      proposalsStore.add({
        popclawId: 'BOB',
        fromTier: 'acquaintance',
        toTier: 'friend',
        rationale: '互动频繁',
      });
      const tools = registerWithBondsAndProposals(bondsStore, proposalsStore);

      const r = await findTool(tools, 'popclaw_list_pending_proposals').execute('cid', {});
      expect(r.text).not.toMatch(/not yet implemented/i);
      expect(r.text).toMatch(/BOB|friend|好友/);
    });

    it('popclaw_decide_bond_tier_proposal accept applies the tier change', async () => {
      const { bondsStore, proposalsStore } = makeRealBondsAndProposalsStore();
      bondsStore.setTier('CAROL', 'acquaintance', 'manual');
      proposalsStore.add({
        popclawId: 'CAROL',
        fromTier: 'acquaintance',
        toTier: 'friend',
        rationale: '同步信号',
      });
      const tools = registerWithBondsAndProposals(bondsStore, proposalsStore);

      const r = await findTool(tools, 'popclaw_decide_bond_tier_proposal').execute('cid', {
        popclaw_id: 'CAROL',
        decision: 'accept',
      });
      expect(r.text).not.toMatch(/not yet implemented/i);
      expect(r.text).toMatch(/✅|好友|friend/);
      // Bond should now be friend
      expect(bondsStore.get('CAROL')!.tier).toBe('friend');
    });

    it('popclaw_decide_bond_tier_proposal reject keeps tier unchanged', async () => {
      const { bondsStore, proposalsStore } = makeRealBondsAndProposalsStore();
      bondsStore.setTier('DAVE', 'acquaintance', 'manual');
      proposalsStore.add({
        popclawId: 'DAVE',
        fromTier: 'acquaintance',
        toTier: 'friend',
        rationale: '测试拒绝',
      });
      const tools = registerWithBondsAndProposals(bondsStore, proposalsStore);

      const r = await findTool(tools, 'popclaw_decide_bond_tier_proposal').execute('cid', {
        popclaw_id: 'DAVE',
        decision: 'reject',
      });
      expect(r.text).not.toMatch(/not yet implemented/i);
      expect(bondsStore.get('DAVE')!.tier).toBe('acquaintance');
    });

    it('popclaw_decide_bond_tier_proposal when no pending proposal returns not-found message', async () => {
      const { bondsStore, proposalsStore } = makeRealBondsAndProposalsStore();
      const tools = registerWithBondsAndProposals(bondsStore, proposalsStore);

      const r = await findTool(tools, 'popclaw_decide_bond_tier_proposal').execute('cid', {
        popclaw_id: 'NOBODY',
        decision: 'accept',
      });
      expect(r.text).toMatch(/没有|找不到|no pending/i);
    });

    // S3 rollout slice 4 — en lane.
    it('popclaw_decide_bond_tier_proposal renders in en when set', async () => {
      setOwnerLang('en', 'config');
      const { bondsStore, proposalsStore } = makeRealBondsAndProposalsStore();
      bondsStore.setTier('EVE', 'acquaintance', 'manual');
      proposalsStore.add({ popclawId: 'EVE', fromTier: 'acquaintance', toTier: 'friend', rationale: 'test' });
      const tools = registerWithBondsAndProposals(bondsStore, proposalsStore);

      const accepted = await findTool(tools, 'popclaw_decide_bond_tier_proposal').execute('cid', {
        popclaw_id: 'EVE',
        decision: 'accept',
      });
      expect(accepted.text).toContain(`Upgraded #${deriveSigil('EVE')} to "friend".`);

      const notFound = await findTool(tools, 'popclaw_decide_bond_tier_proposal').execute('cid', {
        popclaw_id: 'NOBODY',
        decision: 'accept',
      });
      expect(notFound.text).toContain(`No pending proposal found for #${deriveSigil('NOBODY')}.`);
      setOwnerLang('zh-CN', 'config'); // restore file default for tests after this one
    });
  });

  // ---------------------------------------------------------------------------
  // popclaw_find_bonds tool (Task 2)
  // ---------------------------------------------------------------------------

  /** Register tools with runtime exposing BondsStore + llmComplete mock. */
  function registerWithBondsAndLlm(
    store: BondsStore,
    llmComplete: ReturnType<typeof vi.fn>,
  ) {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn(async () => ({
        bondsStore: store,
        llmComplete,
      })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    return tools;
  }

  describe('popclaw_find_bonds tool', () => {
    it('calls findBonds via runtime stores + llm, returns its text', async () => {
      const store = makeRealBondsStore();
      store.setTier('A', 'friend', 'manual');
      store.setKnowledge('A', { remarkName: '阿青', description: '投资人', tags: ['investor'] });
      const llmComplete = vi.fn().mockResolvedValue('你的投资人：阿青…');
      const tools = registerWithBondsAndLlm(store, llmComplete);

      const out = await findTool(tools, 'popclaw_find_bonds').execute('c1', { query: '我的投资人' });
      expect(out.text).toContain('阿青');
      expect(llmComplete).toHaveBeenCalledTimes(1);
    });

    it('blank query → hint, no llm call', async () => {
      const store = makeRealBondsStore();
      const llmComplete = vi.fn();
      const tools = registerWithBondsAndLlm(store, llmComplete);

      const out = await findTool(tools, 'popclaw_find_bonds').execute('c1', { query: '  ' });
      expect(llmComplete).not.toHaveBeenCalled();
      expect(out.text).toMatch(/一句话/);
    });

    // S3 rollout slice 4 — en lane.
    it('blank query hint renders in en when set', async () => {
      setOwnerLang('en', 'config');
      const store = makeRealBondsStore();
      const llmComplete = vi.fn();
      const tools = registerWithBondsAndLlm(store, llmComplete);

      const out = await findTool(tools, 'popclaw_find_bonds').execute('c1', { query: '  ' });
      expect(out.text).toContain('Give me one sentence');
      setOwnerLang('zh-CN', 'config'); // restore file default for tests after this one
    });
  });

  // 待回（Pings）· spec 2026-07-25 §7 — 未读尾巴挂在统一出口；已读只由取走推进。
  describe('unread ping tail + popclaw_show_pings', () => {
    function registerWithPings(unreadIds: string[], replies: unknown[] = []) {
      const markRead = vi.fn((ids: readonly string[]) => {
        for (const id of ids) {
          const i = unreadIds.indexOf(id);
          if (i >= 0) unreadIds.splice(i, 1);
        }
        return ids.length;
      });
      const { api, tools } = buildFakeApi();
      registerPopclawTools({
        api,
        runtime: vi.fn(async () => ({
          boot: { popclawId: 'OWNER', webBaseUrl: 'https://popclaw.me' },
          bondsStore: { get: () => null },
          marksStore: makeFakeMarksStore([]),
          replyPings: {
            unreadCount: () => unreadIds.length,
            listUnread: () => [...unreadIds],
            markRead,
          },
          worldFeedCache: { repliesToOwner: () => replies },
        })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
      });
      return { tools, markRead };
    }

    it('appends the unread tail to an unrelated tool, without marking read', async () => {
      const { tools, markRead } = registerWithPings(['e1', 'e2', 'e3']);
      const out = await findTool(tools, 'popclaw_show_marks').execute('c1', {});
      expect(out.text).toContain('📬 3 条待回');
      expect(markRead).not.toHaveBeenCalled();
      // agent 看到尾巴却没取 → 下次继续提示
      const again = await findTool(tools, 'popclaw_show_marks').execute('c1', {});
      expect(again.text).toContain('📬 3 条待回');
    });

    it('no unread → no tail', async () => {
      const { tools } = registerWithPings([]);
      const out = await findTool(tools, 'popclaw_show_marks').execute('c1', {});
      expect(out.text).not.toContain('待回');
    });

    // S3 rollout slice 2 — the unread tail line renders in `ownerLang()`.
    it('unread tail line: en lane', async () => {
      setOwnerLang('en', 'config');
      const { tools } = registerWithPings(['e1', 'e2', 'e3']);
      const out = await findTool(tools, 'popclaw_show_marks').execute('c1', {});
      expect(out.text).toContain('📬 3 pending replies');
      setOwnerLang('zh-CN', 'config'); // restore file default for tests after this one
    });

    it('popclaw_show_pings renders the batch and marks exactly it read', async () => {
      const { tools, markRead } = registerWithPings(['e1'], [
        {
          reply: {
            platform: 'popclaw',
            platformPostId: 'r1',
            eventId: 'e1',
            platformPostCreatedAt: 1_700_000_000,
            authorPopclawId: 'alice',
            handle: 'alice',
            originalUrl: '',
            textPreview: '这个我熟',
          },
          targetPostId: 'mine',
          targetPreview: '我的帖',
        },
      ]);
      const out = await findTool(tools, 'popclaw_show_pings').execute('c1', {});
      expect(out.text).toContain('待回（1 条');
      expect(out.text).toContain('这个我熟');
      expect(out.text).toContain('陌生人');
      expect(markRead).toHaveBeenCalledWith(['e1']);
      // 标完已读 → 同一轮的未读尾巴不再提示
      expect(out.text).not.toContain('条待回');
    });
  });
});

// ---------------------------------------------------------------------------
// 顺一句（R1 spec §4）：composeTail 的两宿主接线（这里是 OpenClaw/register-tools
// 那一面；纯函数层面的 8 道闸测试在 nudge.test.ts）。
// ---------------------------------------------------------------------------

describe('顺一句 tail（R1 spec §4）', () => {
  /** 已毕业 >24h、零关注（→ no_follows 缺口）、其余缺口全过关的最小 runtime。 */
  function registerWithSettledFacts(unreadIds: string[] = []) {
    const host = new InMemoryHostAdapter();
    const nowSec = Math.floor(Date.now() / 1000);
    const graduatedAt = nowSec - 25 * 3600; // ≥24h（闸②）
    const rt = {
      host,
      boot: { popclawId: 'OWNER', webBaseUrl: 'https://popclaw.me' },
      bondsStore: { get: () => null },
      marksStore: makeFakeMarksStore([]),
      replyPings: { unreadCount: () => unreadIds.length, listUnread: () => [...unreadIds], markRead: vi.fn() },
      worldFeedCache: { repliesToOwner: () => [] },
      onboardingState: { get: () => ({ stage: 'completed', completed_at: graduatedAt }) },
      socialGraph: { following: () => [] }, // → no_follows
      tasteLoader: { enabledSources: async () => [{ path: 'core/private.md', content: '我关心 AI' }] },
      paths: { dreamerStateFile: () => '/nonexistent/popclaw-test/dreamer-state.json' },
    };
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn(async () => rt) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    return { tools, host };
  }

  it('已毕业 >24h、没有未读 → 尾巴挂顺一句（缺口最靠前的 no_follows）', async () => {
    const { tools } = registerWithSettledFacts();
    const out = await findTool(tools, 'popclaw_show_marks').execute('c1', {});
    expect(out.text).toContain('— 顺一句：');
    expect(out.text).toContain('还没关注人');
  });

  it('未读优先：有未读待回时不挂顺一句', async () => {
    const { tools } = registerWithSettledFacts(['e1']);
    const out = await findTool(tools, 'popclaw_show_marks').execute('c1', {});
    expect(out.text).toContain('📬 1 条待回');
    expect(out.text).not.toContain('顺一句');
  });

  it('排除名单里的工具（popclaw_show_pings）不挂顺一句，即便缺口和时机都够', async () => {
    const { tools } = registerWithSettledFacts();
    const out = await findTool(tools, 'popclaw_show_pings').execute('c1', {});
    expect(out.text).not.toContain('顺一句');
  });

  it('真输出一行后才记账：strikes/lifetime/last_at 落 config', async () => {
    const { tools, host } = registerWithSettledFacts();
    await findTool(tools, 'popclaw_show_marks').execute('c1', {});
    const cfg = (await host.config.loadJson('plugin')) as {
      onboarding?: { nudge?: { lifetime?: number; strikes?: Record<string, number> } };
    };
    expect(cfg.onboarding?.nudge?.lifetime).toBe(1);
    expect(cfg.onboarding?.nudge?.strikes?.no_follows).toBe(1);
  });

  it('72h 内第二次调用不再挂第二条（闸③）', async () => {
    const { tools, host } = registerWithSettledFacts();
    await findTool(tools, 'popclaw_show_marks').execute('c1', {});
    const out2 = await findTool(tools, 'popclaw_show_marks').execute('c2', {});
    expect(out2.text).not.toContain('顺一句');
    const cfg = (await host.config.loadJson('plugin')) as { onboarding?: { nudge?: { lifetime?: number } } };
    expect(cfg.onboarding?.nudge?.lifetime).toBe(1); // 没有重复记账
  });

  it('runtime 缺 onboardingState/socialGraph 等字段（最小测试桩）→ 尾巴静默退化，不额外抛错', async () => {
    // marksStore 都不给：popclaw_show_marks 本身会报它自己的 ⚠️ 错误（既有纪律，
    // 与尾巴无关）——这里只钉尾巴计算不因缺字段而抛出/追加脏文本。
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn(async () => ({})) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    const out = await findTool(tools, 'popclaw_show_marks').execute('c1', {});
    expect(out.text).not.toContain('顺一句');
    expect(out.text).not.toContain('\n\n'); // 没有尾巴段落被追加
  });

  describe('popclaw_mute_notices', () => {
    it("scope='all' → muted:['*']，之后不再挑任何顺一句", async () => {
      const { tools, host } = registerWithSettledFacts();
      const muteOut = await findTool(tools, 'popclaw_mute_notices').execute('c1', { scope: 'all' });
      expect(muteOut.text).toContain('不再提');
      const cfg = (await host.config.loadJson('plugin')) as { onboarding?: { nudge?: { muted?: string[] } } };
      expect(cfg.onboarding?.nudge?.muted).toEqual(['*']);

      const out = await findTool(tools, 'popclaw_show_marks').execute('c2', {});
      expect(out.text).not.toContain('顺一句');
    });

    it("单个 gap key → 只静默那一条", async () => {
      const { tools, host } = registerWithSettledFacts();
      await findTool(tools, 'popclaw_mute_notices').execute('c1', { scope: 'no_follows' });
      const cfg = (await host.config.loadJson('plugin')) as { onboarding?: { nudge?: { muted?: string[] } } };
      expect(cfg.onboarding?.nudge?.muted).toEqual(['no_follows']);
    });
  });
});

// ---------------------------------------------------------------------------
// popclaw_note_taste（做梦第 2 步）：onboarding 之后主人随时能往 taste 主权层追加
// ---------------------------------------------------------------------------

describe('popclaw_note_taste', () => {
  function registerWithTasteRoot(tasteRoot: string) {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn(async () => ({
        paths: { tasteDir: () => tasteRoot },
      })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    return { tools };
  }

  it('把主人的话原样追加进 core/private.md（走同一个 appendCorePrivate）', async () => {
    const tasteRoot = mkdtempSync(join(tmpdir(), 'note-taste-'));
    const { tools } = registerWithTasteRoot(tasteRoot);

    const out = await findTool(tools, 'popclaw_note_taste').execute('c1', {
      note: '我关心航天工程的实现细节',
    });

    const md = readFileSync(join(tasteRoot, 'core/private.md'), 'utf-8');
    // P-002 形态：frontmatter 占位 + 正文照实存原话
    expect(md).toMatch(/^---\ntags: \[\]\nmute: \[\]\n---\n/);
    expect(md).toContain('我关心航天工程的实现细节');
    // manifest 缺失时创建（否则 TasteLoader 看不见）
    const manifest = JSON.parse(readFileSync(join(tasteRoot, 'manifest.json'), 'utf-8'));
    expect(manifest.sources['core/private.md'].enabled).toBe(true);
    expect(out.text).toContain('记下了');
  });

  it('负向表达也只当正文存，不去动 mute 数组（抽取是第 3 步做梦的活）', async () => {
    const tasteRoot = mkdtempSync(join(tmpdir(), 'note-taste-mute-'));
    const { tools } = registerWithTasteRoot(tasteRoot);

    await findTool(tools, 'popclaw_note_taste').execute('c1', {
      note: '我不想再看币圈喊单',
    });

    const md = readFileSync(join(tasteRoot, 'core/private.md'), 'utf-8');
    expect(md).toContain('我不想再看币圈喊单');
    expect(md).toContain('mute: []'); // 仍是空占位，没被自作聪明填上
  });

  it('多次调用追加不覆盖（主权层绝不丢主人写过的字）', async () => {
    const tasteRoot = mkdtempSync(join(tmpdir(), 'note-taste-append-'));
    const { tools } = registerWithTasteRoot(tasteRoot);
    const tool = findTool(tools, 'popclaw_note_taste');

    await tool.execute('c1', { note: '第一句：我关心开源治理' });
    await tool.execute('c2', { note: '第二句：也关心分布式系统' });

    const md = readFileSync(join(tasteRoot, 'core/private.md'), 'utf-8');
    expect(md).toContain('第一句：我关心开源治理');
    expect(md).toContain('第二句：也关心分布式系统');
    expect(md.match(/^---$/gm)).toHaveLength(2); // 只有一份 frontmatter
  });

  it('空白 note → 不建文件，回话引导主人说点什么', async () => {
    const tasteRoot = mkdtempSync(join(tmpdir(), 'note-taste-blank-'));
    const { tools } = registerWithTasteRoot(tasteRoot);

    const out = await findTool(tools, 'popclaw_note_taste').execute('c1', { note: '   ' });

    expect(existsSync(join(tasteRoot, 'core/private.md'))).toBe(false);
    expect(out.text).not.toContain('记下了');
  });

  // S3 rollout slice 4 — en lane.
  it('renders in en when set', async () => {
    setOwnerLang('en', 'config');
    const tasteRoot = mkdtempSync(join(tmpdir(), 'note-taste-en-'));
    const { tools } = registerWithTasteRoot(tasteRoot);

    const blank = await findTool(tools, 'popclaw_note_taste').execute('c1', { note: '   ' });
    expect(blank.text).toContain('What should I note?');

    const saved = await findTool(tools, 'popclaw_note_taste').execute('c1', { note: 'I care about rockets' });
    expect(saved.text).toContain('Noted');
    setOwnerLang('zh-CN', 'config'); // restore file default for tests after this one
  });

  // 通用画布：agent 在自己这一轮渲好 HTML，直接递过来 —— 不必先落盘再走斜杠命令。
  // 这是「工具出素材、agent 自渲染」铁律在画布上的最后一块拼图。
  ;

  // -------------------------------------------------------------------------
  // popclaw_feedback (ADR-0042)
  //
  // 真机 2026-07-29：主人的 agent 把反馈正文都拟好了，却发不出去 —— 反馈只挂了
  // 斜杠命令，没挂工具。整条功能的重点恰恰是**agent** 报自己撞的墙。
  // -------------------------------------------------------------------------
  describe('popclaw_feedback', () => {
    const contactId = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey);
    const guideWithContact = [
      '---',
      'world: popclaw.me',
      'feedback:',
      '  contact: 苍梧',
      `  popclaw_id: ${contactId}`,
      '---',
      '正文',
    ].join('\n');

    // 真机 2026-09-21：世界动作失败后，模型没人要求就自己寄了一封反馈给主坊
    // 联系人。信是一封对外私信，因此 agent 这条路只出草稿，由主人确认后
    // popclaw_send_draft 才真发 —— 和别的对外私信同一道门。
    it('drafts the feedback for the guide-declared contact, and only the confirmation sends it', async () => {
      const { api, tools } = buildFakeApi();
      const push = vi.fn(async (_b: Uint8Array) => ({ status: 200, eventId: 'ab'.repeat(32) }));
      registerPopclawTools({
        api,
        runtime: makeMockRuntime({
          egress: { push },
          guideClient: { fetchGuideText: async () => guideWithContact },
        }),
      });

      const draft = await findTool(tools, 'popclaw_feedback').execute('c', {
        kind: 'bug',
        body: '想做什么：把会话存成帖子\n卡在哪里：没有这个工具',
      });

      expect(push).not.toHaveBeenCalled(); // 一次工具调用 = 零外发
      expect(draft.text).toContain('苍梧'); // 草稿点名收信人
      expect(draft.text).toContain('卡在哪里：没有这个工具'); // 和信的原文

      const token = draft.text.match(/draft_id: (\S+)/)![1];
      const sent = await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, token!);

      expect(push).toHaveBeenCalledTimes(1); // 走的就是普通私信那条路（签名+加密）
      expect(sent.text).toContain('bug 反馈已加密送出');
      expect(sent.text).toContain('联系人苍梧');
    });

    // attach_doctor_report (final doc 2026-08-11-beta-diagnostics-final.md §3
    // item 3 + doctor-ux-final.md): agent path builds+writes a fresh doctor
    // report and sends it as an attachment — full pipeline, not a stub.
    // Over the wire cap: the public envelope limit (L_ENVELOPE_MAX_BYTES,
    // 1.5 MiB since public-envelope-01.4; checkEnvelopeWire WIRE_LIMIT) fails
    // the sign BEFORE any egress — decided behavior: honest failure, zero
    // send, no truncation, no chunking, no silent drop. A doctor report can no
    // longer reach that bound by itself, so the negative case below pins it
    // with a body that does; a small attachment still goes through the
    // ordinary encrypted path.
    it('a feedback over the envelope cap → honest size error, ZERO egress', async () => {
      // A letter this long cannot fit the host's approval prompt, so the owner
      // reads it through the trusted draft preview and the approval binds that
      // delivery (tools/send-draft-subject.ts). Without the capability there
      // would be no way to approve it at all, and the size error below — which
      // only the signer can raise — would never be reached.
      const { api, tools } = buildFakeApi(ownerDeliveringToolCtx());
      const push = vi.fn(async (_b: Uint8Array) => ({ status: 200, eventId: 'ab'.repeat(32) }));
      const doctorDir = mkdtempSync(join(tmpdir(), 'popclaw-doctor-'));
      registerPopclawTools({
        api,
        runtime: makeMockRuntime({
          egress: { push },
          guideClient: { fetchGuideText: async () => guideWithContact },
          paths: {
            rootDir: () => join(doctorDir, 'root'),
            lastBuildFile: () => join(doctorDir, 'last-build.json'),
            dbIntegrityFile: () => join(doctorDir, 'db-integrity.json'),
            doctorDir: () => doctorDir,
            cadenceDir: () => join(doctorDir, 'config', 'cadence'),
          },
        }),
      });

      const draft = await findTool(tools, 'popclaw_feedback').execute('c', {
        kind: 'bug',
        // 1.6 MiB of body: sealed text alone lands the envelope past the 1.5 MiB bound.
        body: '报纸出不来 ' + 'x'.repeat(1_600_000),
      });
      // 信封大小只有签名那一刻才量得出来，所以这个诚实报错出现在确认之后
      // （和 popclaw_draft_message 的正文一样）—— 两步都零外发。
      const token = draft.text.match(/draft_id: (\S+)/)![1];
      const r = await sendDraftApproved(findTool(tools, 'popclaw_send_draft').execute, token!);

      expect(push).not.toHaveBeenCalled(); // zero egress — nothing partially delivered
      expect(r.text).toContain('公开协议信封的大小上限');
      expect(r.text).toContain('未发送');
    });

    // 说明书没声明联系人 → 诚实报错，并且报的是**这座坊**（houseSlug 接线的闸）。
    it('names the house honestly when no feedback contact is declared', async () => {
      const { api, tools } = buildFakeApi();
      const push = vi.fn(async (_b: Uint8Array) => ({ status: 200, eventId: 'ab'.repeat(32) }));
      registerPopclawTools({
        api,
        runtime: makeMockRuntime({
          egress: { push },
          guideClient: { fetchGuideText: async () => '---\nworld: popclaw.me\n---\n正文' },
        }),
      });

      const r = await findTool(tools, 'popclaw_feedback').execute('c', { kind: 'need', body: 'x' });

      // makeMockRuntime 的主坊是 http://localhost:9000 → hostDbSlug。
      expect(r.text).toContain('localhost-9000');
      expect(push).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// 提议各决定面的对象展示走「名号#印信」
// 名字链，绝不裸 id 前缀；直接设档（manual tier move）settle 该人 pending
// 提议——命中的记 accepted，被行动盖过的记 rejected。
// ---------------------------------------------------------------------------

describe('bond proposal surfaces — 名字链 + 直接设档 settle', () => {
  const ALICE = 'abcdef0123456789';

  function registerWithRuntime(rt: Record<string, unknown>) {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn(async () => rt) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    return tools;
  }

  function freshRt(extra: Record<string, unknown> = {}) {
    const { bondsStore, proposalsStore } = makeRealBondsAndProposalsStore();
    return { rt: { bondsStore, proposalsStore, ...extra }, bondsStore, proposalsStore };
  }

  it('popclaw_list_pending_proposals：对象走「#印信」，绝不裸 id 前缀', async () => {
    const { rt, bondsStore, proposalsStore } = freshRt();
    bondsStore.setTier(ALICE, 'acquaintance', 'manual');
    proposalsStore.add({ popclawId: ALICE, fromTier: 'acquaintance', toTier: 'friend', rationale: '最近 30 天互动 7 次' });
    const tools = registerWithRuntime(rt);
    const r = (await findTool(tools, 'popclaw_list_pending_proposals').execute('cid', {})) as { text: string };
    expect(r.text).toContain(`#${deriveSigil(ALICE)}`);
    expect(r.text).toContain('认识 → 好友');
    expect(r.text).not.toContain('abcdef0123');
  });

  it('popclaw_decide_bond_tier_proposal：accept 回执走「#印信」，档位落地', async () => {
    const { rt, bondsStore, proposalsStore } = freshRt();
    bondsStore.setTier(ALICE, 'acquaintance', 'manual');
    proposalsStore.add({ popclawId: ALICE, fromTier: 'acquaintance', toTier: 'friend', rationale: '' });
    const tools = registerWithRuntime(rt);
    const r = (await findTool(tools, 'popclaw_decide_bond_tier_proposal').execute('cid', {
      popclaw_id: ALICE,
      decision: 'accept',
    })) as { text: string };
    expect(r.text).toContain(`#${deriveSigil(ALICE)}`);
    expect(r.text).not.toContain('abcdef0123');
    expect(bondsStore.get(ALICE)!.tier).toBe('friend');
    expect(proposalsStore.listPending()).toHaveLength(0);
  });

  it('popclaw_set_bond_tier：回执走「#印信」；直接设档 settle 命中的 pending（→accepted）', async () => {
    const { rt, bondsStore, proposalsStore } = freshRt();
    bondsStore.setTier(ALICE, 'acquaintance', 'manual');
    proposalsStore.add({ popclawId: ALICE, fromTier: 'acquaintance', toTier: 'friend', rationale: '' });
    const tools = registerWithRuntime(rt);
    const r = (await findTool(tools, 'popclaw_set_bond_tier').execute('cid', {
      popclaw_id: ALICE,
      tier: 'friend',
    })) as { text: string };
    expect(r.text).toContain(`#${deriveSigil(ALICE)}`);
    expect(r.text).not.toContain('abcdef0123');
    expect(proposalsStore.listPending()).toHaveLength(0);
    expect(proposalsStore.lastFor(ALICE, 'friend')!.status).toBe('accepted');
  });

  it('popclaw_set_bond_tier：设成别的档位 → 该人其余 pending 记 rejected（主人的行动盖过建议）', async () => {
    const { rt, bondsStore, proposalsStore } = freshRt();
    bondsStore.setTier(ALICE, 'friend', 'manual');
    proposalsStore.add({ popclawId: ALICE, fromTier: 'friend', toTier: 'close', rationale: '' });
    const tools = registerWithRuntime(rt);
    await findTool(tools, 'popclaw_set_bond_tier').execute('cid', { popclaw_id: ALICE, tier: 'acquaintance' });
    expect(proposalsStore.listPending()).toHaveLength(0);
    expect(proposalsStore.lastFor(ALICE, 'close')!.status).toBe('rejected');
  });

  it('popclaw_set_bond_tier：runtime 不带 proposalsStore（旧形态）→ 照旧可用、不 settle', async () => {
    const { bondsStore, proposalsStore } = makeRealBondsAndProposalsStore();
    bondsStore.setTier(ALICE, 'acquaintance', 'manual');
    proposalsStore.add({ popclawId: ALICE, fromTier: 'acquaintance', toTier: 'friend', rationale: '' });
    const tools = registerWithRuntime({ bondsStore });
    const r = (await findTool(tools, 'popclaw_set_bond_tier').execute('cid', {
      popclaw_id: ALICE,
      tier: 'friend',
    })) as { text: string };
    expect(bondsStore.get(ALICE)!.tier).toBe('friend');
    expect(r.text).toContain('好友');
    expect(proposalsStore.listPending()).toHaveLength(1); // untouched, old behaviour
  });

  it('settle 抛错不拦设档回执——档位已动，回执必须如实说成功（结算可重试）', async () => {
    const { rt, bondsStore } = freshRt();
    const throwing = {
      settlePendingForManualTier: () => {
        throw new Error('db locked');
      },
    };
    const tools = registerWithRuntime({ ...rt, proposalsStore: throwing });
    const r = (await findTool(tools, 'popclaw_set_bond_tier').execute('cid', {
      popclaw_id: ALICE,
      tier: 'friend',
    })) as { text: string };
    expect(bondsStore.get(ALICE)!.tier).toBe('friend'); // the tier move itself succeeded
    expect(r.text).toContain(`#${deriveSigil(ALICE)}`);
    expect(r.text).toContain('好友'); // the receipt tells the truth about what did happen
  });
});

it('public show/search bypass all legacy author discovery, cache and automatic tails', async () => {
  const { api, tools } = buildFakeApi();
  const item = { item: { platform: 'popclaw', platformPostId: 'b'.repeat(64), authorPopclawId: 'author', actorNickname: 'Alice' },
    body: 'Signed local topic', kind: 'post', mirrorSigner: false, relaySnapshot: false,
    source: { origin: 'https://local.invalid', slug: 'local', observedAt: 100, sequence: '1', logIncarnation: 'log' } };
  const result = { items: [item], sources: [{ origin: 'https://local.invalid', slug: 'local', incomplete: false, unavailable: false, history: true }], truncated: false };
  const read = vi.fn(() => result), search = vi.fn(() => result), forbidden = vi.fn(() => { throw new Error('unexpected legacy or tail'); });
  const rt = { publicFeedDisplay: { read, search }, get worldFeedClient() { return { fetchSnapshot: forbidden }; },
    get worldFeedCache() { return { search: forbidden }; }, get inboxStore() { forbidden(); return undefined; }, get host() { forbidden(); return undefined; } };
  registerPopclawTools({ api, runtime: (async () => rt) as never, getWorldDeps: forbidden });
  expect((await findTool(tools, 'popclaw_show_feed').execute('show', { filter_by_author: 'Alice', limit: 2 })).text).toContain('Signed local topic');
  expect(read).toHaveBeenLastCalledWith({ limit: 2, author: 'author', platform: undefined, includeThreads: false });
  expect((await findTool(tools, 'popclaw_search_feed').execute('search', { query: 'local topic' })).text).toContain('Signed local topic');
  expect(search).toHaveBeenCalledWith('local topic', 10); expect(forbidden).not.toHaveBeenCalled();
  result.truncated = true;
  const limited = await findTool(tools, 'popclaw_show_feed').execute('limited', { filter_by_author: 'Alice' });
  expect(limited.text).not.toContain('Signed local topic'); expect(forbidden).not.toHaveBeenCalled();
});

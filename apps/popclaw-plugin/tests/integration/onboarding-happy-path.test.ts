import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { InMemoryHostAdapter } from '../../src/host/host-adapter.in-memory.js';
import { OnboardingStateRepository } from '../../src/onboarding/state-repository.js';
import { OnboardingStateMachine } from '../../src/onboarding/state-machine.js';
import { SqliteNotifier } from '../../src/notifier/sqlite-notifier.js';
import {
  OnboardingOrchestrator,
  type CardPresenter,
  type ErrandFollowOutcome,
} from '../../src/onboarding/orchestrator.js';
import { SessionContextIndex } from '../../src/onboarding/context-index.js';
import { appendPick } from '../../src/taste/learned-writer.js';
import { MarksStore } from '../../src/marks/marks-store.js';
import { MarkService } from '../../src/marks/mark-service.js';
import { runMigrations } from '../../src/host/migrations.js';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTestSigner } from '../helpers/test-signer.js';
import { popclaw } from '@popclaw/contracts';
import type { HouseBroadcastOutcome } from '../../src/egress/event-egress.js';
import type { WorldSummaryResponse } from '../../src/world/world-summary-client.js';
import type { MessagePresentation } from '../../src/onboarding/act-cards.js';
import { setOwnerLang } from '../../src/lexicon/owner-language.js';

// Real fixture identity: signer + orchestrator identity must agree so the
// signed envelope's actor.popclawId matches the onboarding row.
const POPCLAW_ID = '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM';

const GUIDE_TEXT = `---
world: popclaw.me
kind: social-plaza
voice: 自由说话的巨型社交广场
---

# 欢迎来到 popclaw.me

这里是一座巨型社交广场——第一个以人为维度的去中心化存在点。
`;

const MRBEAST = 'MrBeastIntegrationPopclawId11111';
const ALIX = 'AlixEarleIntegrationPopclawId222';
const E1 = '1111aaaa1111aaaa';
const E2 = '2222bbbb2222bbbb';
const E3 = '3333cccc3333cccc';

/** 两座已挂的坊——名字全部来自数据（ADR-0041：插件里零坊名）。 */
const HOUSES = [
  { slug: 'popclaw-me', name: 'popclaw.me', guide: '# popclaw.me\n\n这里怎么玩：直接说话。' },
  { slug: 'popclaw-world', name: 'popclaw.world' },
];

function makeSummary(): WorldSummaryResponse {
  return {
    window_hours: 24,
    generated_at_ms: 1_700_000_000_000,
    total_posts: 1316,
    distinct_authors: 55,
    authors: {
      [MRBEAST]: { nickname: 'mrbeast' },
      [ALIX]: { nickname: 'alixearle' },
    },
    hot_posts: [
      { event_id: E1, author: MRBEAST, platform: 'youtube', body_preview: 'Last to leave the circle wins $500,000', reply_count: 31, quote_count: 4, created_at_ms: 1_700_000_000_000 },
      { event_id: E2, author: ALIX, platform: 'instagram', body_preview: 'Morning routine ✨ every step explained from sunrise stretch to oat-milk latte, plus the playlist I use', reply_count: 12, quote_count: 1, created_at_ms: 1_699_999_000_000 },
      { event_id: E3, author: MRBEAST, platform: 'x', body_preview: 'New video drops Friday', reply_count: 9, quote_count: 0, created_at_ms: 1_699_998_000_000 },
    ],
  };
}

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

describe('Onboarding 六幕（integration）', () => {
  let host: InMemoryHostAdapter;
  let orch: OnboardingOrchestrator;
  let delivered: MessagePresentation[];
  let pushed: Uint8Array[];
  let tasteRoot: string;
  let contextIndex: SessionContextIndex;
  let llmPrompts: string[];
  let marksStore: MarksStore;
  let followRefs: string[];
  let followOutcome: ErrandFollowOutcome;

  // S5: the acts are pushed straight to the owner, so the whole run comes out
  // in the owner's language. This owner types Chinese ("标一下 1", "常看 AI 论文")
  // — pinned rather than left to the script sniff, so the first two acts are
  // not read in one language and the rest in another.
  beforeEach(() => setOwnerLang('zh-CN', 'config'));
  afterEach(() => setOwnerLang(undefined));

  beforeEach(async () => {
    host = new InMemoryHostAdapter({ now: new Date(1700000000 * 1000) });
    runMigrations(host.db, MIGRATIONS_DIR);
    const repo = new OnboardingStateRepository(host.db, () => 1700000000);
    const sm = new OnboardingStateMachine(repo);
    const notifier = new SqliteNotifier(host.db, () => 1700000000);
    delivered = [];
    pushed = [];
    llmPrompts = [];
    followRefs = [];
    followOutcome = { kind: 'followed', display: 'mrbeast#5PQ8RTVW', verifiedPlatform: 'X' };
    const popclawDataRoot = await mkdtemp(join(tmpdir(), 'popclaw-onboarding-data-'));
    tasteRoot = join(popclawDataRoot, 'taste');
    contextIndex = new SessionContextIndex();
    const presenter: CardPresenter = {
      async present(card) { delivered.push(card); },
    };
    orch = new OnboardingOrchestrator({
      stateMachine: sm,
      notifier,
      presenter,
      houseOrigins: [],
      fetch: (async () => new Response(JSON.stringify({ popclaw_id: 'x', sigil: 'abc234', profiles: [], house_follower_count: 0, house_post_count: 0, house_reply_received_count: 0 }), { status: 200 })) as typeof fetch,
      identity: { popclawId: POPCLAW_ID },
            host,
      signer: makeTestSigner('BlackFeather'),
      egress: {
        async push(bytes) {
          pushed.push(bytes);
          return { status: 201, eventId: 'e'.repeat(64) };
        },
        // 逐坊落章（护照那一幕的数据源）：两座坊都收下。
        async broadcastEach(bytes): Promise<readonly HouseBroadcastOutcome[]> {
          pushed.push(bytes);
          return HOUSES.map((h) => ({ slug: h.slug, result: { status: 201, eventId: 'e'.repeat(64) } }));
        },
      },
      llm: {
        // 取名（{"names":…}）与重排（{"order":…}）共用一个 client，按输出契约分流。
        complete: async (prompt: string) => {
          llmPrompts.push(prompt);
          return prompt.includes('"order"')
            ? '{"order":[2,1,3]}'
            : '{"names":["凤栖梧","白驹","拾光客"]}';
        },
      },
      tasteRoot,
      readOwnerPersona: async () => undefined,
      fetchVerifiedHandles: async () => [],
      guideClient: { fetchGuideText: async () => GUIDE_TEXT },
      summaryClient: { fetchSummary: async () => makeSummary() },
      snapshotClient: {
        fetchSnapshot: async () => [
          { authorPopclawId: MRBEAST, actorNickname: 'mrbeast', platform: 'instagram' },
          { authorPopclawId: MRBEAST, actorNickname: 'mrbeast', platform: 'tiktok' },
          { authorPopclawId: ALIX, actorNickname: 'alixearle', platform: 'tiktok' },
        ],
      },
      tasteLoader: {
        // 真读 tasteRoot：口味写进去之后梯度门就开（与 TasteLoader 同根）。
        enabledSources: async () => {
          try {
            const content = await readFile(join(tasteRoot, 'core/private.md'), 'utf-8');
            return [{ path: 'core/private.md', content }];
          } catch {
            return [];
          }
        },
      },
      learnedWriter: { appendPick: (p) => appendPick({ tasteRoot }, p) },
      markService: (() => {
        marksStore = new MarksStore(host.db);
        return new MarkService({
          store: marksStore,
          signer: makeTestSigner('BlackFeather'),
          egress: { push: async (b) => { pushed.push(b); return { status: 201, eventId: 'e'.repeat(64) }; } },
          nickname: 'BlackFeather',
          taste: { tasteRoot },
        });
      })(),
      contextIndex,
      webBaseUrl: 'http://localhost:3000',
      houses: () => HOUSES,
      followPerson: async (ref) => {
        followRefs.push(ref);
        return followOutcome;
      },
    });
    await orch.start();
  });

  function row(): { stage: string; completed_at: number | null; drafts_json: string | null } | null {
    return host.db.queryOne(
      'SELECT stage, completed_at, drafts_json FROM onboarding_state WHERE popclaw_id = ?',
      [POPCLAW_ID],
    );
  }

  it('happy path：六幕走通，名片真上链路、口味真落盘、标记真进库、毕业交出攻略素材', async () => {
    // ① arrival —— 一句定位 + 候选，还没有名号。
    const arrival = await orch.handleStartCommand();
    expect(row()?.stage).toBe('arrival');
    expect(arrival.text).toContain('1. 凤栖梧');
    expect(arrival.text).not.toContain('灯坊'); // 体验先于概念

    // ② passport —— 报编号选名 → 签名片 → 逐坊落章 → 护照页。
    const passport = await orch.handleAdvance('next', '1');
    expect(row()?.stage).toBe('passport');
    const cfg = (await host.config.loadJson('plugin')) as {
      ranger_profile?: { nickname?: string; name_source?: string };
    };
    expect(cfg.ranger_profile?.nickname).toBe('凤栖梧');
    expect(cfg.ranger_profile?.name_source).toBe('auto');
    // 真 ProfilePayload 上线（S1 协议腿通电）
    expect(pushed).toHaveLength(1);
    const sp = popclaw.identity.SignedPayload.decode(pushed[0]!);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(env.profile?.nickname).toBe('凤栖梧');
    expect(Number(env.profile?.declaredAt)).toBe(1700000000);
    expect(env.actor?.popclawId).toBe(POPCLAW_ID);
    // 逐坊落章 + 护照页（72h），且印信小课在页上不在聊天框
    expect(passport.text).toContain('popclaw.me ✓ 已盖章');
    expect(passport.text).toContain('popclaw.world ✓ 已盖章');
    // 印信小课「在页上不在聊天框」的后半句由上面 passport.text 的两条覆盖。
    // 前半句（页面内容）曾断言 uploads[0].html，但这个构建**刻意不含 Canvas**，
    // 上传器根本没有被注入——`uploads` 全文件零处 push，断言恒对一个空数组取 [0]。
    // 它不再描述任何行为，删掉；要恢复这层覆盖，得先有一个能上传的构建。

    // ③ lantern —— 坊卡 + 编号精华 + 江湖一瞥页；此刻口味还空 → 热度序，零重排调用。
    const lantern = await orch.handleAdvance('next');
    expect(row()?.stage).toBe('lantern');
    expect(lantern.text).toContain('一座灯坊是一盏灯，不是整个江湖');
    expect(lantern.text).toContain('popclaw.me（有你的名帖 ✓）');
    expect(lantern.text).toContain('1. [mrbeast] Last to leave the circle wins $500,000');
    expect(llmPrompts.filter((p) => p.includes('"order"'))).toHaveLength(0);
    expect(contextIndex.byOrdinal(1)?.eventId).toBe(E1);

    // 编号展开 + 标一下 + 无感：三种反馈真落盘。
    const expanded = await orch.handleAdvance('next', '2');
    expect(expanded.text).toContain('Morning routine ✨ every step explained');
    expect(expanded.text).toContain(`http://localhost:3000/post/${E2.slice(0, 10)}`);
    expect((await orch.handleAdvance('next', '标一下 1')).text).toContain('标下了');
    expect((await orch.handleAdvance('next', '无感 3')).text).toContain('记下了');
    expect(marksStore.has(E1)).toBe(true);

    // ④ attune —— 一问 → 写主权层 → 对同一批条目重排（LLM order=[2,1,3]）。
    const ask = await orch.handleAdvance('next');
    expect(row()?.stage).toBe('attune');
    expect(ask.text).toContain('你最近关心什么');

    const rerank = await orch.handleAdvance('next', '常看 AI 论文，周末扫街摄影');
    const md = await readFile(join(tasteRoot, 'core/private.md'), 'utf-8');
    expect(md).toMatch(/^---\ntags: \[\]\nmute: \[\]\n---\n/);
    expect(md).toContain('常看 AI 论文，周末扫街摄影');
    expect(llmPrompts.filter((p) => p.includes('"order"'))).toHaveLength(1);
    expect(llmPrompts.at(-1)).toContain('常看 AI 论文，周末扫街摄影');
    // 新第 1 条 = 原第 2 条（alixearle），且标注写在卡上
    expect(rerank.text).toContain('（原第 2 条）[alixearle]');
    expect(rerank.text).toContain('热度和');
    // ⑤ errand 紧跟着开口
    expect(row()?.stage).toBe('errand');
    expect(rerank.text).toContain('上面那几个人里有想跟着的吗');

    // ⑤ errand —— 报编号 → 认人链拿到 id → 关注 → 交情本 + 条件式认证一句。
    const followed = await orch.handleAdvance('next', '1');
    expect(followRefs).toEqual([ALIX]); // 重排后第 1 条是 alixearle 的帖
    expect(followed.text).toContain('已关注 mrbeast#5PQ8RTVW。');
    expect(followed.text).toContain('任何服务器、任何其他用户都读不到');
    expect(followed.text).toContain('X 的背书');
    expect(row()?.stage).toBe('cadence');

    // ⑥ cadence —— 答 1 → 记 daily → 毕业词 + 攻略素材 → completed。
    const graduation = await orch.handleAdvance('next', '1');
    expect(row()?.stage).toBe('completed');
    expect(row()?.completed_at).toBe(1700000000);
    const finalCfg = (await host.config.loadJson('plugin')) as { onboarding?: { newspaper?: string } };
    expect(finalCfg.onboarding?.newspaper).toBe('daily');
    expect(graduation.text).toContain('ttl_hours 设 72');
    expect(graduation.text).toContain('popclaw-newspaper');
    expect(graduation.text).toContain('把该任务的结果投递关掉');
    // 只列真做过的 + 坊玩法来自数据
    expect(graduation.text).toContain('定了名号「凤栖梧」');
    expect(graduation.text).toContain('关注了 mrbeast#5PQ8RTVW');
    expect(graduation.text).toContain('popclaw.me 怎么玩');
    // 名片只签一次（标记那次是另一条 payload）
    const profiles = pushed.filter((b) => {
      const decoded = popclaw.event.EventEnvelope.decode(
        popclaw.identity.SignedPayload.decode(b).payload,
      );
      return decoded.profile !== null && decoded.profile !== undefined;
    });
    expect(profiles).toHaveLength(1);

    // learned/picks.jsonl：expanded + saved + meh 逐行真落盘。
    const picksRaw = await readFile(join(tasteRoot, 'learned', 'picks.jsonl'), 'utf-8');
    const signals = picksRaw.trim().split('\n').map((l) => (JSON.parse(l) as { signal: string }).signal);
    expect(signals).toContain('expanded');
    expect(signals).toContain('saved');
    expect(signals).toContain('meh');
  });

  it('全跳路径：一路 skip 也能走到底，缺口逐条记进毕业素材', async () => {
    await orch.handleStartCommand();          // arrival
    await orch.handleAdvance('skip');         // 用第一候选 → passport
    expect((await host.config.loadJson('plugin') as { ranger_profile: { nickname: string } }).ranger_profile.nickname).toBe('凤栖梧');
    await orch.handleAdvance('skip');         // passport → lantern
    await orch.handleAdvance('skip');         // lantern skip → errand（连带跳 attune）
    expect(row()?.stage).toBe('errand');
    await orch.handleAdvance('skip');         // errand → cadence
    const graduation = await orch.handleAdvance('skip'); // cadence → completed

    expect(row()?.stage).toBe('completed');
    expect(graduation.text).toContain('口味档案还是空的');
    expect(graduation.text).toContain('还一个人都没关注');
    expect(graduation.text).toContain('别自作主张排定时任务');
    // 口味那一问跳过了 → 主权层一个字都没写
    await expect(stat(join(tasteRoot, 'core/private.md'))).rejects.toThrow();
    // 但名片照样签出去了（占位名判死刑）
    expect(pushed).toHaveLength(1);
  });

  it('lantern skip 连带跳过 attune —— 没看过内容就问口味是空转', async () => {
    await orch.handleStartCommand();
    await orch.handleAdvance('next', '你定');  // → passport
    await orch.handleAdvance('next');          // → lantern
    delivered = [];
    const res = await orch.handleAdvance('skip');
    expect(row()?.stage).toBe('errand');
    // 直接是差事那一问，中间没有第二张"你关心什么"的卡
    expect(res.text).toContain('上面那几个人里有想跟着的吗');
    expect(res.text).not.toContain('你最近关心什么');
    expect(delivered).toHaveLength(1);
  });

  it('「先这样」= 整个引导先停下，随时能回来', async () => {
    await orch.handleStartCommand();
    const res = await orch.handleAdvance('next', '先这样');
    expect(row()?.stage).toBe('completed');
    expect(row()?.completed_at).toBe(1700000000);
    expect(res.text).toContain('先到这儿');
    // 引导不排队通知（脊柱本身不入队）
    expect(host.db.queryAll('SELECT * FROM notification_queue WHERE delivered_at IS NULL')).toEqual([]);
  });

  it('毕业后再 /popclaw start：只说已完成，不重演卡片', async () => {
    await orch.handleStartCommand();
    await orch.handleAdvance('next', '先看看');
    delivered = [];
    const res = await orch.handleStartCommand();
    expect(res.text).toMatch(/已经办完/);
    expect(delivered).toHaveLength(0);
  });
});

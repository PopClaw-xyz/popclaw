import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { setOwnerTz } from '../../../src/time/time-context.js';
import { OnboardingStateRepository } from '../../../src/onboarding/state-repository.js';
import { OnboardingStateMachine } from '../../../src/onboarding/state-machine.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import {
  OnboardingOrchestrator,
  type ErrandFollowOutcome,
  type MountedHouse,
  type OnboardingMarkServiceLike,
  type SnapshotItemLike,
} from '../../../src/onboarding/orchestrator.js';
import { SessionContextIndex } from '../../../src/onboarding/context-index.js';
import { fallbackName } from '../../../src/onboarding/fallback-name.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import type { Signer } from '../../../src/identity/signer.js';
import type { HouseBroadcastOutcome, PushResult } from '../../../src/egress/event-egress.js';
import type { WorldSummaryResponse } from '../../../src/world/world-summary-client.js';
import type { LearnedPick } from '../../../src/taste/learned-writer.js';
import type { MessagePresentation } from '../../../src/onboarding/act-cards.js';
import { noDmCrypto } from '../../helpers/test-signer.js';
import { persistNickname } from '../../../src/onboarding/identity-writer.js';
import { PluginConfig } from '../../../src/config/schema.js';
import { bumpNamecardDeclaredAt, signMyNamecard } from '../../../src/messaging/my-namecard.js';

// Pass-through spies: behaviour is the real module's, the calls are counted.
// N1 needs to prove that nothing on the signing path runs before the owner's yes.
vi.mock('../../../src/onboarding/identity-writer.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/onboarding/identity-writer.js')>();
  return { ...mod, persistNickname: vi.fn(mod.persistNickname) };
});
vi.mock('../../../src/messaging/my-namecard.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/messaging/my-namecard.js')>();
  return {
    ...mod,
    bumpNamecardDeclaredAt: vi.fn(mod.bumpNamecardDeclaredAt),
    signMyNamecard: vi.fn(mod.signMyNamecard),
  };
});
import {
  observeOwnerText,
  ownerLangSource,
  ownerLangTag,
  setOwnerLang,
  useOwnerLangSignals,
} from '../../../src/lexicon/owner-language.js';

const PID = '11111111111111111111111111111111';
const SIGIL = deriveSigil(PID);
const CANDIDATES_JSON = '{"names":["凤栖梧","白驹","拾光客"]}';

const GUIDE_TEXT = `---
world: popclaw.me
kind: social-plaza
voice: 自由说话的巨型社交广场
streams:
  - name: summary
    endpoint: /v1/world-summary
---

# 欢迎来到 popclaw.me

这里是一座巨型社交广场。
`;

const MRBEAST = 'MrBeastPopclawId1111111111111111';
const ALIX = 'AlixEarlePopclawId22222222222222';
const E1 = 'aaaaaaaaaa111';
const E2 = 'bbbbbbbbbb222';
const E3 = 'cccccccccc333';

function makeSummary(): WorldSummaryResponse {
  return {
    window_hours: 24,
    generated_at_ms: 1_700_000_000_000,
    total_posts: 42,
    distinct_authors: 5,
    authors: {
      [MRBEAST]: { nickname: 'mrbeast' },
      [ALIX]: { nickname: 'alixearle' },
    },
    hot_posts: [
      { event_id: E1, author: MRBEAST, platform: 'youtube', body_preview: 'Last to leave wins $100k', reply_count: 10, quote_count: 2, created_at_ms: 1_700_000_000_000 },
      { event_id: E2, author: ALIX, platform: 'instagram', body_preview: 'Morning routine ✨ full version with every step explained from sunrise stretch to oat-milk latte recipe', reply_count: 7, quote_count: 0, created_at_ms: 1_699_999_000_000 },
      { event_id: E3, author: MRBEAST, platform: 'x', body_preview: 'New video drops Friday', reply_count: 5, quote_count: 1, created_at_ms: 1_699_998_000_000 },
    ],
  };
}

const DEFAULT_SNAPSHOT: SnapshotItemLike[] = [
  { authorPopclawId: MRBEAST, actorNickname: 'mrbeast', platform: 'instagram' },
  { authorPopclawId: ALIX, actorNickname: 'alixearle', platform: 'tiktok' },
];

const HOUSES: MountedHouse[] = [
  { slug: 'house-a', name: '灯坊甲', guide: '# 灯坊甲\n\n这里怎么玩：说人话就行。' },
  { slug: 'house-b', name: '灯坊乙' },
];

/** 副坊自报了第一件事（R1 spec §1）；主坊仍是零声明——两条路各测一遍。 */
const HOUSES_WITH_ENTRY: MountedHouse[] = [
  HOUSES[0]!,
  {
    slug: 'house-b',
    name: '灯坊乙',
    blurb: '走出去看看的地方',
    entry: {
      home: 'https://house-b.test/',
      headline: '捏一个你自己的公仔，它替你去旅行',
      firstMove: '带我进世界',
      recipe: '回家链接',
    },
  },
];

class FakePresenter {
  delivered: MessagePresentation[] = [];
  async present(card: MessagePresentation): Promise<void> {
    this.delivered.push(card);
  }
}

/** 多坊 egress fake：既给 push（单坊路径），也给 broadcastEach（逐坊落章）。 */
class FakeEgress {
  pushes: Uint8Array[] = [];
  /** 每座坊的 HTTP 状态；'throw' = 网络级失败。 */
  statuses: Array<number | 'throw'> = [201, 201];
  supportsBroadcastEach = true;

  async push(bytes: Uint8Array): Promise<PushResult> {
    const s = this.statuses[0] ?? 201;
    if (s === 'throw') throw new Error('ECONNREFUSED');
    this.pushes.push(bytes);
    return { status: s, eventId: 'e'.repeat(64) };
  }

  broadcastEach = async (bytes: Uint8Array): Promise<readonly HouseBroadcastOutcome[]> => {
    this.pushes.push(bytes);
    return HOUSES.map((h, i) => {
      const s = this.statuses[i] ?? 201;
      return s === 'throw'
        ? { slug: h.slug, error: new Error('ECONNREFUSED') }
        : { slug: h.slug, result: { status: s, eventId: 'e'.repeat(64) } };
    });
  };
}

const fakeSigner: Signer = {
  publicKey: async () => new Uint8Array(32),
  sign: async () => new Uint8Array(64),
  popclawId: async () => PID,
  ...noDmCrypto,
};

interface MakeOptions {
  /** Reuse a host (same config + state DB) = a restart between two turns. */
  host?: InMemoryHostAdapter;
  nickname?: string;
  /** LLM 回复；null = 无 LLM；'throw' = complete() 抛。 */
  llmReply?: string | null;
  /** 每坊广播状态。 */
  pushStatuses?: Array<number | 'throw'>;
  /** egress 只有 push（单坊实现）。 */
  singleHouse?: boolean;
  persona?: string;
  handles?: string[];
  tasteRoot?: string;
  guideText?: string | null;
  summary?: WorldSummaryResponse | null;
  snapshot?: SnapshotItemLike[];
  coreText?: string;
  learnedThrow?: boolean;
  markThrow?: boolean;
  /** 画布上传失败（服务够不着）。 */
  canvasDown?: boolean;
  /** 完全不接画布（MCP/dev 组合根）。 */
  noCanvas?: boolean;
  follow?: (ref: string) => Promise<ErrandFollowOutcome>;
  noFollow?: boolean;
  houses?: MountedHouse[];
  /** 「已开始」判定（坊官方来过信）。缺席 = 没接线（查不到）。 */
  houseStarted?: (slug: string) => boolean;
}

function makeOrchestrator(opts: MakeOptions = {}) {
  const host =
    opts.host ??
    new InMemoryHostAdapter({
      config: opts.nickname ? { plugin: { ranger_profile: { nickname: opts.nickname } } } : {},
      now: new Date(1700000000 * 1000),
    });
  const repo = new OnboardingStateRepository(host.db, () => 1700000000);
  const sm = new OnboardingStateMachine(repo);
  const notifier = new SqliteNotifier(host.db, () => 1700000000);
  const presenter = new FakePresenter();
  const egress = new FakeEgress();
  if (opts.pushStatuses) egress.statuses = opts.pushStatuses;
  if (opts.singleHouse) egress.supportsBroadcastEach = false;

  const llmPrompts: string[] = [];
  const llmReply = opts.llmReply === undefined ? CANDIDATES_JSON : opts.llmReply;
  const llm =
    llmReply === null
      ? null
      : {
          complete: async (prompt: string) => {
            llmPrompts.push(prompt);
            if (llmReply === 'throw') throw new Error('LLM down');
            // 取名与重排共用一个 client，按输出契约分流。
            return prompt.includes('"order"') ? '{"order":[3,1,2]}' : llmReply;
          },
        };

  const world = {
    guideText: opts.guideText === undefined ? GUIDE_TEXT : opts.guideText,
    summary: opts.summary === undefined ? makeSummary() : opts.summary,
    guideFetches: 0,
    summaryFetches: 0,
    snapshotFetches: 0,
  };
  const learnedPicks: LearnedPick[] = [];
  const markedItems: Parameters<OnboardingMarkServiceLike['mark']>[0][] = [];
  const contextIndex = new SessionContextIndex();
  const uploads: Array<{ title: string; html: string; ttlHours?: number }> = [];
  const followRefs: string[] = [];

  const tasteRoot = opts.tasteRoot ?? join(tmpdir(), `popclaw-taste-untouched-${Date.now()}`);
  const orch = new OnboardingOrchestrator({
    stateMachine: sm,
    notifier,
    presenter,
    houseOrigins: [],
    fetch: (async () => new Response(JSON.stringify({ popclaw_id: 'x', sigil: 'abc234', profiles: [], house_follower_count: 0, house_post_count: 0, house_reply_received_count: 0 }), { status: 200 })) as typeof fetch,
    identity: { popclawId: PID },
        host,
    signer: fakeSigner,
    egress: opts.singleHouse ? { push: (b) => egress.push(b) } : egress,
    llm,
    tasteRoot,
    readOwnerPersona: async () => opts.persona,
    fetchVerifiedHandles: async () => opts.handles ?? [],
    guideClient: {
      fetchGuideText: async () => {
        world.guideFetches += 1;
        return world.guideText;
      },
    },
    summaryClient: {
      fetchSummary: async () => {
        world.summaryFetches += 1;
        return world.summary;
      },
    },
    snapshotClient: {
      fetchSnapshot: async () => {
        world.snapshotFetches += 1;
        return opts.snapshot ?? DEFAULT_SNAPSHOT;
      },
    },
    tasteLoader: {
      enabledSources: async () =>
        opts.coreText !== undefined ? [{ path: 'core/private.md', content: opts.coreText }] : [],
    },
    learnedWriter: {
      appendPick: async (p) => {
        if (opts.learnedThrow) throw new Error('disk full');
        learnedPicks.push(p);
      },
    },
    markService: {
      mark: async (item) => {
        if (opts.markThrow) throw new Error('disk full');
        markedItems.push(item);
        return { pushed: true };
      },
    } satisfies OnboardingMarkServiceLike,
    contextIndex,
    webBaseUrl: 'http://localhost:3000',
    houses: () => opts.houses ?? HOUSES,
    ...(opts.houseStarted ? { houseStarted: opts.houseStarted } : {}),
    ...(opts.noCanvas
      ? {}
      : {
          canvas: {
            uploadCanvas: async (o) => {
              if (opts.canvasDown) throw new Error('canvas down');
              uploads.push({
                title: o.title,
                html: o.html,
                ...(o.ttlHours !== undefined ? { ttlHours: o.ttlHours } : {}),
              });
              return { url: `https://canvas.test/p/${uploads.length}` };
            },
            canvasBaseUrl: 'https://canvas.test',
            signer: fakeSigner,
            nickname: 'tester',
          },
        }),
    ...(opts.noFollow
      ? {}
      : {
          followPerson: async (ref: string) => {
            followRefs.push(ref);
            return (
              opts.follow?.(ref) ??
              ({ kind: 'followed', display: 'mrbeast#AAAA1111' } as ErrandFollowOutcome)
            );
          },
        }),
  });
  return {
    orch, repo, sm, notifier, presenter, egress, host, llmPrompts, tasteRoot,
    world, learnedPicks, markedItems, contextIndex, uploads, followRefs,
  };
}

type Ctx = ReturnType<typeof makeOrchestrator>;

/** 走到 passport（取名用第一候选）。 */
async function toPassport(ctx: Ctx): Promise<{ text: string }> {
  await ctx.orch.handleStartCommand(); // → arrival
  return ctx.orch.handleAdvance('next', '你定'); // arrival → passport
}

/** 走到 lantern。 */
async function toLantern(ctx: Ctx): Promise<{ text: string }> {
  await toPassport(ctx);
  return ctx.orch.handleAdvance('next'); // passport → lantern
}

/** 走到 attune。 */
async function toAttune(ctx: Ctx): Promise<{ text: string }> {
  await toLantern(ctx);
  return ctx.orch.handleAdvance('next'); // lantern 裸回车 → attune
}

/** 走到 errand（attune 跳过）。 */
async function toErrand(ctx: Ctx): Promise<{ text: string }> {
  await toAttune(ctx);
  return ctx.orch.handleAdvance('skip'); // attune skip → errand
}

/** 走到 cadence（errand 跳过）。 */
async function toCadence(ctx: Ctx): Promise<{ text: string }> {
  await toErrand(ctx);
  return ctx.orch.handleAdvance('skip'); // errand skip → cadence
}

async function configNickname(ctx: Ctx): Promise<string | undefined> {
  const cfg = (await ctx.host.config.loadJson('plugin')) as
    | { ranger_profile?: { nickname?: string } }
    | null;
  return cfg?.ranger_profile?.nickname;
}

/**
 * S5: the act cards are pushed **straight to the owner** (`presentCard` →
 * `presenter.present`, no agent in between), so every word of them — the
 * briefing body included — follows `ownerLang()`. This file's owner types
 * Chinese ("凤栖梧") at houses with Chinese names, so it is a zh-CN owner:
 * pinned rather than left to the script sniff in `handleAdvance`, which used
 * to flip the register mid-file and leak into whatever test ran next. Both
 * lanes are asserted side by side in the last block of the file.
 */
beforeEach(() => setOwnerLang('zh-CN', 'config'));
afterEach(() => setOwnerLang(undefined));

// ---------------------------------------------------------------------------
// ① arrival
// ---------------------------------------------------------------------------

describe('arrival（取名开局）', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = makeOrchestrator(); });

  it('start：idle → arrival，一句定位 + 候选（不讲灯坊）', async () => {
    const res = await ctx.orch.handleStartCommand();
    expect(ctx.sm.current(PID)).toBe('arrival');
    expect(res.text).toContain('替他在外面社交的地方');
    expect(res.text).toContain('1. 凤栖梧');
    expect(res.text).not.toContain('灯坊');
    expect(res.text).not.toContain('lore-house');
    expect(ctx.presenter.delivered).toHaveLength(1);
  });

  it('候选存进 drafts（报编号靠它）', async () => {
    await ctx.orch.handleStartCommand();
    expect(ctx.sm.drafts(PID)).toEqual({
      arrival: { candidates: ['凤栖梧', '白驹', '拾光客'], blind: false },
    });
  });

  it('无 persona → 卡上挂 POPCLAW_OWNER_PERSONA_PATH 提示；给了就不挂', async () => {
    await ctx.orch.handleStartCommand();
    expect(ctx.presenter.delivered.at(-1)!.blocks.some(
      (b) => 'text' in b && b.text.includes('POPCLAW_OWNER_PERSONA_PATH'),
    )).toBe(true);

    const withPersona = makeOrchestrator({ persona: '爱看 AI 论文的摄影师' });
    const res = await withPersona.orch.handleStartCommand();
    expect(withPersona.llmPrompts[0]).toContain('爱看 AI 论文的摄影师');
    expect(res.text).not.toContain('POPCLAW_OWNER_PERSONA_PATH');
  });

  it('verified handles 进取名 prompt', async () => {
    const c = makeOrchestrator({ handles: ['blackfeather_ai', 'blackfeather'] });
    await c.orch.handleStartCommand();
    expect(c.llmPrompts[0]).toContain('blackfeather_ai');
    expect(c.llmPrompts[0]).toContain('blackfeather');
  });

  it('无材料（无 LLM、无现名）→ 一个中性兜底名 + 如实说不了解主人', async () => {
    const c = makeOrchestrator({ llmReply: null });
    const res = await c.orch.handleStartCommand();
    expect(res.text).toContain('我对你还不了解');
    expect(res.text).not.toContain('ranger-');
  });

  /** #422 真机：这四个字曾被当成主人亲手取的名号签进身份、还盖了双坊章。 */
  it('#422：「你来挑吧」= 交回给我们挑，绝不签成名号', async () => {
    await ctx.orch.handleStartCommand();
    const res = await ctx.orch.handleAdvance('next', '你来挑吧');
    expect(await configNickname(ctx)).toBe('凤栖梧'); // 第一候选
    expect(res.text).not.toContain('你来挑吧');
  });

  it('已有真名号 → 它排第一候选', async () => {
    const c = makeOrchestrator({ nickname: '青鸾' });
    const res = await c.orch.handleStartCommand();
    expect(res.text).toContain('1. 青鸾');
  });

  it('报编号 = 选候选（source=auto）', async () => {
    await ctx.orch.handleStartCommand();
    await ctx.orch.handleAdvance('next', '2');
    expect(await configNickname(ctx)).toBe('白驹');
    const cfg = (await ctx.host.config.loadJson('plugin')) as { ranger_profile: { name_source: string } };
    expect(cfg.ranger_profile.name_source).toBe('auto');
    expect(ctx.sm.current(PID)).toBe('passport');
  });

  it('「随便吧」= 第一候选（youDecide, not the 随便 hedge retry）', async () => {
    await ctx.orch.handleStartCommand();
    await ctx.orch.handleAdvance('next', '随便吧');
    expect(await configNickname(ctx)).toBe('凤栖梧');
    expect(ctx.sm.current(PID)).toBe('passport');
  });

  it('「你定」= 第一候选', async () => {
    await ctx.orch.handleStartCommand();
    await ctx.orch.handleAdvance('next', '你定');
    expect(await configNickname(ctx)).toBe('凤栖梧');
  });

  it('skip = 第一候选（占位名判死刑：绝不以 ranger-xxxxxx 进江湖）', async () => {
    await ctx.orch.handleStartCommand();
    await ctx.orch.handleAdvance('skip');
    expect(await configNickname(ctx)).toBe('凤栖梧');
    expect(ctx.sm.current(PID)).toBe('passport');
  });

  it('自由文本 = 自取（source=owner），先确认再签（N1）', async () => {
    await ctx.orch.handleStartCommand();
    await ctx.orch.handleAdvance('next', '夜行白驹');
    expect(await configNickname(ctx)).toBeUndefined();
    await ctx.orch.handleAdvance('next', '1');
    expect(await configNickname(ctx)).toBe('夜行白驹');
    const cfg = (await ctx.host.config.loadJson('plugin')) as { ranger_profile: { name_source: string } };
    expect(cfg.ranger_profile.name_source).toBe('owner');
  });

  it('裸数字守卫：范围外的数字绝不当名号', async () => {
    await ctx.orch.handleStartCommand();
    const res = await ctx.orch.handleAdvance('next', '7');
    expect(res.text).toContain('没有这个编号');
    expect(await configNickname(ctx)).toBeUndefined();
    expect(ctx.sm.current(PID)).toBe('arrival');
  });

  it('占位名形状的回答被拒，不转移', async () => {
    await ctx.orch.handleStartCommand();
    const res = await ctx.orch.handleAdvance('next', 'ranger-7gXkQz');
    expect(res.text).toContain('机器占位名');
    expect(ctx.sm.current(PID)).toBe('arrival');
  });

  // N1 (2026-09-27 acceptance, fresh Claude Code root): the owner answered
  // 「我的名字叫 新人0926」, the agent passed it through verbatim as told, and
  // the whole sentence was signed and broadcast as the public name. Free text
  // is never adopted: it becomes a pending name on a confirmation card, and
  // only a yes bound to that exact value signs it.
  describe('N1: free text is confirmed before anything is signed', () => {
    beforeEach(() => {
      vi.mocked(persistNickname).mockClear();
      vi.mocked(bumpNamecardDeclaredAt).mockClear();
      vi.mocked(signMyNamecard).mockClear();
    });

    async function profile(c: Ctx): Promise<Record<string, unknown> | undefined> {
      const cfg = (await c.host.config.loadJson('plugin')) as { ranger_profile?: Record<string, unknown> } | null;
      return cfg?.ranger_profile;
    }

    /** Nothing on the signing path has run: the draft is the only write. */
    async function expectNothingSigned(c: Ctx, signSpy: { mock: { calls: unknown[] } }): Promise<void> {
      expect(vi.mocked(persistNickname)).not.toHaveBeenCalled();
      expect(vi.mocked(bumpNamecardDeclaredAt)).not.toHaveBeenCalled();
      expect(vi.mocked(signMyNamecard)).not.toHaveBeenCalled();
      expect(signSpy.mock.calls).toHaveLength(0);
      expect(c.egress.pushes).toHaveLength(0);
      expect(await profile(c)).toBeUndefined();
      expect(c.sm.current(PID)).toBe('arrival');
    }

    function pending(c: Ctx): string | undefined {
      return (c.sm.drafts(PID) as { arrival?: { pendingName?: string } }).arrival?.pendingName;
    }

    function pushedText(c: Ctx): string {
      return Buffer.concat(c.egress.pushes.map((b) => Buffer.from(b))).toString('utf8');
    }

    it('「我的名字叫 新人0926」 → card, zero side effects; then 1 → exactly that namecard, once', async () => {
      const signSpy = vi.spyOn(fakeSigner, 'sign');
      try {
        await ctx.orch.handleStartCommand();
        const res = await ctx.orch.handleAdvance('next', '我的名字叫 新人0926');
        expect(res.text).toContain('用「新人0926」当你的名号？回 1 确认');
        expect(pending(ctx)).toBe('新人0926');
        await expectNothingSigned(ctx, signSpy);

        await ctx.orch.handleAdvance('next', '1');
        expect(await configNickname(ctx)).toBe('新人0926');
        expect((await profile(ctx))?.name_source).toBe('owner');
        expect(ctx.sm.current(PID)).toBe('passport');
        expect(vi.mocked(persistNickname)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(persistNickname).mock.calls[0]![1]).toBe('新人0926');
        expect(vi.mocked(bumpNamecardDeclaredAt)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(signMyNamecard)).toHaveBeenCalledTimes(1);
        expect(ctx.egress.pushes).toHaveLength(1);
        expect(pushedText(ctx)).toContain('新人0926');
        expect(pushedText(ctx)).not.toContain('我的名字');
      } finally {
        signSpy.mockRestore();
      }
    });

    it('card → 「不对」 → the same candidates again, pending cleared, nothing signed', async () => {
      const signSpy = vi.spyOn(fakeSigner, 'sign');
      try {
        await ctx.orch.handleStartCommand();
        await ctx.orch.handleAdvance('next', '我叫小明');
        const res = await ctx.orch.handleAdvance('next', '不对');
        expect(res.text).toContain('1. 凤栖梧');
        expect(res.text).toContain('2. 白驹');
        expect(pending(ctx)).toBeUndefined();
        await expectNothingSigned(ctx, signSpy);
        // ...and a 1 now is candidate 1, not the voided 小明.
        await ctx.orch.handleAdvance('next', '1');
        expect(await configNickname(ctx)).toBe('凤栖梧');
      } finally {
        signSpy.mockRestore();
      }
    });

    it('en lane: card copy, "no" → candidates, sentence retry copy', async () => {
      setOwnerLang('en', 'config');
      await ctx.orch.handleStartCommand();
      const card = await ctx.orch.handleAdvance('next', 'my name is Kuroba');
      expect(card.text).toBe('Use "Kuroba" as your name? Reply 1 to confirm, or type the name you want.');
      const back = await ctx.orch.handleAdvance('next', 'no');
      expect(back.text).toContain('1. 凤栖梧');
      const retry = await ctx.orch.handleAdvance('next', "I'm not sure");
      expect(retry.text).toContain("couldn't tell which part is the name");
      expect(await profile(ctx)).toBeUndefined();
    });

    it('card → a bare name becomes the NEW pending name, shown for confirmation; 1 adopts it', async () => {
      await ctx.orch.handleStartCommand();
      await ctx.orch.handleAdvance('next', 'my name is Kuroba');
      const res = await ctx.orch.handleAdvance('next', 'Kurobane');
      expect(res.text).toContain('「Kurobane」');
      expect(pending(ctx)).toBe('Kurobane');
      expect(await configNickname(ctx)).toBeUndefined();
      await ctx.orch.handleAdvance('next', '1');
      expect(await configNickname(ctx)).toBe('Kurobane');
      expect((await profile(ctx))?.name_source).toBe('owner');
    });

    it('typing a listed candidate in full is a pick from the list: adopted as auto, no card', async () => {
      await ctx.orch.handleStartCommand();
      await ctx.orch.handleAdvance('next', '白驹');
      expect(await configNickname(ctx)).toBe('白驹');
      expect((await profile(ctx))?.name_source).toBe('auto');
    });

    it('card → 2 (in range) → candidate 2 as auto; out of range → digit retry', async () => {
      await ctx.orch.handleStartCommand();
      await ctx.orch.handleAdvance('next', '我叫小明');
      const miss = await ctx.orch.handleAdvance('next', '7');
      expect(miss.text).toContain('没有这个编号');
      expect(await configNickname(ctx)).toBeUndefined();

      await ctx.orch.handleAdvance('next', '我叫小明');
      await ctx.orch.handleAdvance('next', '2');
      expect(await configNickname(ctx)).toBe('白驹');
      expect((await profile(ctx))?.name_source).toBe('auto');
    });

    it('card → empty answer → the card again, nothing signed', async () => {
      const signSpy = vi.spyOn(fakeSigner, 'sign');
      try {
        await ctx.orch.handleStartCommand();
        await ctx.orch.handleAdvance('next', '我叫小明');
        const res = await ctx.orch.handleAdvance('next', '');
        expect(res.text).toContain('「小明」');
        await expectNothingSigned(ctx, signSpy);
      } finally {
        signSpy.mockRestore();
      }
    });

    it('a yes-word confirms; a pending name equal to a candidate is adopted as auto', async () => {
      await ctx.orch.handleStartCommand();
      await ctx.orch.handleAdvance('next', '我叫白驹');
      await ctx.orch.handleAdvance('next', '对');
      expect(await configNickname(ctx)).toBe('白驹');
      expect((await profile(ctx))?.name_source).toBe('auto');
    });

    it('"let\'s go with the second one" → candidate 2 as auto, no card', async () => {
      await ctx.orch.handleStartCommand();
      await ctx.orch.handleAdvance('next', "let's go with the second one");
      expect(await configNickname(ctx)).toBe('白驹');
      expect((await profile(ctx))?.name_source).toBe('auto');
      expect(ctx.sm.current(PID)).toBe('passport');
    });

    it('none of the reviewer\'s bypass inputs is ever adopted without a yes', async () => {
      const inputs = [
        '叫小明吧', 'me llamo Ana', 'I want Bob', 'call me: Bob', 'je m\'appelle Marie', 'ich heiße Max',
        '제 이름은 민수', '那就小明吧', '我要叫小明', 'This is Bob', 'Ana María López García',
        'Keep Walking Wanderer', 'Night drifter', 'Kuroba', '不对', 'no', '不是', '取消',
        "I'm not sure", '我叫什么好呢', 'I am thinking', '我是新来的', '我是谁',
      ];
      for (const input of inputs) {
        const c = makeOrchestrator();
        const signSpy = vi.spyOn(fakeSigner, 'sign');
        vi.mocked(persistNickname).mockClear();
        vi.mocked(bumpNamecardDeclaredAt).mockClear();
        vi.mocked(signMyNamecard).mockClear();
        try {
          await c.orch.handleStartCommand();
          await c.orch.handleAdvance('next', input);
          await expectNothingSigned(c, signSpy);
        } finally {
          signSpy.mockRestore();
        }
      }
    });

    it('names that start with 不 are names: 不二 bare → card → 1; 「我叫不二」/「我是不二」 → card for 不二', async () => {
      await ctx.orch.handleStartCommand();
      expect((await ctx.orch.handleAdvance('next', '我叫不二')).text).toContain('「不二」');
      expect((await ctx.orch.handleAdvance('next', '我是不二')).text).toContain('「不二」');
      expect((await ctx.orch.handleAdvance('next', '不二')).text).toContain('「不二」');
      expect(await configNickname(ctx)).toBeUndefined();
      await ctx.orch.handleAdvance('next', '1');
      expect(await configNickname(ctx)).toBe('不二');
    });

    it('whole hedge phrases still retry: 「不知道」, 「我是新来的」', async () => {
      await ctx.orch.handleStartCommand();
      expect((await ctx.orch.handleAdvance('next', '不知道')).text).toContain('只发名字本身');
      expect((await ctx.orch.handleAdvance('next', '我是新来的')).text).toContain('只发名字本身');
      expect(await configNickname(ctx)).toBeUndefined();
    });

    it('a four-word real name → card, then 1 adopts it whole', async () => {
      await ctx.orch.handleStartCommand();
      const res = await ctx.orch.handleAdvance('next', 'Ana María López García');
      expect(res.text).toContain('「Ana María López García」');
      await ctx.orch.handleAdvance('next', '1');
      expect(await configNickname(ctx)).toBe('Ana María López García');
    });

    it('a restart between the card and the answer keeps the pending name (drafts_json)', async () => {
      await ctx.orch.handleStartCommand();
      await ctx.orch.handleAdvance('next', '我叫小明');
      const restarted = makeOrchestrator({ host: ctx.host });
      await restarted.orch.handleAdvance('next', '1');
      expect(await configNickname(restarted)).toBe('小明');
    });

    it('skip while a name is pending → first candidate, the pending name is not signed', async () => {
      await ctx.orch.handleStartCommand();
      await ctx.orch.handleAdvance('next', '我叫小明');
      await ctx.orch.handleAdvance('skip');
      expect(await configNickname(ctx)).toBe('凤栖梧');
      expect((await profile(ctx))?.name_source).toBe('auto');
    });

    it('a placeholder stated in a sentence → placeholder retry', async () => {
      await ctx.orch.handleStartCommand();
      const res = await ctx.orch.handleAdvance('next', '我的名字叫 ranger-7gXkQz');
      expect(res.text).toContain('机器占位名');
      expect(await profile(ctx)).toBeUndefined();
    });

    it('ja: 「名前は黒羽です」 → card for 黒羽 → はい → adopted', async () => {
      await ctx.orch.handleStartCommand();
      const res = await ctx.orch.handleAdvance('next', '名前は黒羽です');
      expect(res.text).toContain('「黒羽」');
      await ctx.orch.handleAdvance('next', 'はい');
      expect(await configNickname(ctx)).toBe('黒羽');
    });

    it('with nothing pending: a bare yes or no signs nothing, it shows the candidates again', async () => {
      const signSpy = vi.spyOn(fakeSigner, 'sign');
      try {
        await ctx.orch.handleStartCommand();
        for (const w of ['嗯', '对', '是的', 'right', 'correct', '不对', 'no']) {
          const res = await ctx.orch.handleAdvance('next', w);
          expect(res.text, w).toContain('1. 凤栖梧');
        }
        await expectNothingSigned(ctx, signSpy);
        expect(ctx.orch.hasPendingName()).toBe(false);
      } finally {
        signSpy.mockRestore();
      }
    });

    it('hasPendingName follows the card: true after a stated name, false after a no', async () => {
      await ctx.orch.handleStartCommand();
      expect(ctx.orch.hasPendingName()).toBe(false);
      await ctx.orch.handleAdvance('next', '我叫小明');
      expect(ctx.orch.hasPendingName()).toBe(true);
      await ctx.orch.handleAdvance('next', '不对');
      expect(ctx.orch.hasPendingName()).toBe(false);
    });

    it('X1: a 17-emoji name is a length retry before anything is written; 16 emoji sign and the config still parses', async () => {
      const fox = String.fromCodePoint(0x1f98a);
      await ctx.orch.handleStartCommand();
      const res = await ctx.orch.handleAdvance('next', fox.repeat(17));
      expect(res.text).toContain('32');
      expect(ctx.orch.hasPendingName()).toBe(false);
      expect(vi.mocked(persistNickname)).not.toHaveBeenCalled();

      await ctx.orch.handleAdvance('next', fox.repeat(16));
      await ctx.orch.handleAdvance('next', '1');
      expect(await configNickname(ctx)).toBe(fox.repeat(16));
      // The boot-time parse (config/loader.ts) must accept what was just signed.
      const saved = (await ctx.host.config.loadJson('plugin')) as Record<string, unknown>;
      const booted = PluginConfig.parse({ lore_houses: ['https://house.test'], ...saved });
      expect(booted.ranger_profile?.nickname).toBe(fox.repeat(16));
    });

    it('unclear answers → sentence retry; over 32 characters → length retry; nothing signed', async () => {
      await ctx.orch.handleStartCommand();
      expect((await ctx.orch.handleAdvance('next', '嗯，我再想想')).text).toContain('只发名字本身');
      expect((await ctx.orch.handleAdvance('next', 'x'.repeat(33))).text).toContain('32');
      expect(await profile(ctx)).toBeUndefined();
      expect(ctx.sm.current(PID)).toBe('arrival');
    });
  });

  it('LLM 抛 → 仍有兜底名可选，不崩', async () => {
    const c = makeOrchestrator({ llmReply: 'throw' });
    const res = await c.orch.handleStartCommand();
    expect(res.text).toContain('我对你还不了解');
  });
});

// ---------------------------------------------------------------------------
// ② passport
// ---------------------------------------------------------------------------

describe('passport（领护照）', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = makeOrchestrator(); });

  it('签名片 → 全坊广播 → 逐坊落章 + 护照页短链 + 私钥断言', async () => {
    const res = await toPassport(ctx);
    expect(ctx.sm.current(PID)).toBe('passport');
    expect(ctx.egress.pushes).toHaveLength(1);
    expect(res.text).toContain('凤栖梧#' + SIGIL);
    expect(res.text).toContain('本机的私钥签出来的');
    expect(res.text).toContain('灯坊甲 ✓ 已盖章');
    expect(res.text).toContain('灯坊乙 ✓ 已盖章');
    expect(res.text).toContain('https://canvas.test/p/1');
    expect(ctx.sm.drafts(PID)).toEqual({ passport: 'ok' });
  });

  it('护照页走 72h TTL，标题带名号#印信', async () => {
    await toPassport(ctx);
    expect(ctx.uploads).toHaveLength(1);
    expect(ctx.uploads[0]!.ttlHours).toBe(72);
    expect(ctx.uploads[0]!.title).toContain(`凤栖梧#${SIGIL}`);
    // 印信小课整体在页上，聊天框不再念第二遍。
    expect(ctx.uploads[0]!.html).toContain('印 信 小 课');
  });

  it('认证零出场（挪到 errand 的真实后果触发）', async () => {
    const res = await toPassport(ctx);
    expect(res.text).not.toContain('我要认证');
    expect(res.text).not.toContain('未认证');
  });

  it('副坊失败 → 落章行 ✗，但脊柱照走', async () => {
    ctx = makeOrchestrator({ pushStatuses: [201, 'throw'] });
    const res = await toPassport(ctx);
    expect(res.text).toContain('灯坊甲 ✓ 已盖章');
    expect(res.text).toContain('灯坊乙 ✗ 网络不通');
    expect(ctx.sm.drafts(PID)).toEqual({ passport: 'ok' });
  });

  it('主坊非 2xx → 如实报错、不转移；裸 next 重试成功', async () => {
    ctx = makeOrchestrator({ pushStatuses: [500, 201] });
    const res = await toPassport(ctx);
    expect(res.text).toContain('HTTP 500');
    expect(ctx.sm.current(PID)).toBe('passport');
    expect(await configNickname(ctx)).toBe('凤栖梧'); // 名号已本地记下
    ctx.egress.statuses = [201, 201];
    const retry = await ctx.orch.handleAdvance('next');
    expect(retry.text).toContain('已盖章');
    expect(ctx.sm.current(PID)).toBe('passport');
    expect(ctx.sm.drafts(PID)).toEqual({ passport: 'ok' });
  });

  it('单坊 egress（无 broadcastEach）→ 只落一条章，照样能走', async () => {
    ctx = makeOrchestrator({ singleHouse: true });
    const res = await toPassport(ctx);
    expect(res.text).toContain('灯坊甲');
    expect(res.text).not.toContain('灯坊乙');
  });

  it('画布够不着 → 卡片文本一字不减，只少链接行', async () => {
    ctx = makeOrchestrator({ canvasDown: true });
    const res = await toPassport(ctx);
    expect(res.text).toContain('本机的私钥签出来的');
    expect(res.text).toContain(`凤栖梧#${SIGIL}`);
    expect(res.text).not.toContain('护照页：');
  });

  it('signer 抛 → 向上抛，不被吞成"网络不通"', async () => {
    const throwing = makeOrchestrator();
    (throwing.orch as unknown as { deps: { signer: Signer } }).deps.signer = {
      ...fakeSigner,
      sign: async () => { throw new Error('keystore locked'); },
    };
    await throwing.orch.handleStartCommand();
    await expect(throwing.orch.handleAdvance('next', '你定')).rejects.toThrow('keystore locked');
  });

  it('任意非改名输入 → lantern', async () => {
    await toPassport(ctx);
    await ctx.orch.handleAdvance('next', '挺好');
    expect(ctx.sm.current(PID)).toBe('lantern');
  });

  it('「换个名字」→ 回 arrival 重新给候选', async () => {
    await toPassport(ctx);
    const res = await ctx.orch.handleAdvance('next', '换个名字');
    expect(ctx.sm.current(PID)).toBe('arrival');
    expect(res.text).toContain('1. ');
  });

  it('skip 也照样推进（这一幕没有必须做的决定）', async () => {
    await toPassport(ctx);
    await ctx.orch.handleAdvance('skip');
    expect(ctx.sm.current(PID)).toBe('lantern');
  });
});

// ---------------------------------------------------------------------------
// ③ lantern
// ---------------------------------------------------------------------------

describe('lantern（认坊 = guide + 速览合一）', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = makeOrchestrator(); });

  it('一句话点透 + 坊卡（有你的名帖 ✓）+ 编号精华 + 江湖一瞥短链', async () => {
    const res = await toLantern(ctx);
    expect(ctx.sm.current(PID)).toBe('lantern');
    expect(res.text).toContain('一座灯坊是一盏灯，不是整个江湖');
    expect(res.text).toContain('灯坊甲（有你的名帖 ✓）');
    expect(res.text).toContain('1. [mrbeast] Last to leave wins $100k');
    expect(res.text).toContain('https://canvas.test/p/2');
    // 先确认 guide 声明，再并行取 summary / snapshot，各一次
    expect(ctx.world.guideFetches).toBe(1);
    expect(ctx.world.summaryFetches).toBe(1);
    expect(ctx.world.snapshotFetches).toBe(1);
  });

  it('聊天卡编号与画布编号严格同源', async () => {
    await toLantern(ctx);
    const html = ctx.uploads.at(-1)!.html;
    expect(html).toContain('Last to leave wins $100k');
    expect(ctx.contextIndex.lastBatch()).toHaveLength(3);
    expect(ctx.contextIndex.byOrdinal(1)?.eventId).toBe(E1);
    expect(ctx.contextIndex.byOrdinal(2)?.eventId).toBe(E2);
  });

  it('人少如实说（发声人数低于门槛）', async () => {
    ctx = makeOrchestrator({
      summary: { ...makeSummary(), distinct_authors: 2 },
    });
    const res = await toLantern(ctx);
    expect(res.text).toContain('这儿现在还很安静');
  });

  it('精华 ≤8 条，drafts 与 contextIndex 同步截断', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      event_id: `evt${i}xxxxxxx`, author: MRBEAST, platform: 'x',
      body_preview: `post number ${i}`, reply_count: 12 - i, quote_count: 0,
      created_at_ms: 1_700_000_000_000,
    }));
    ctx = makeOrchestrator({ summary: { ...makeSummary(), hot_posts: many } });
    const res = await toLantern(ctx);
    expect(res.text).toContain('8. [mrbeast]');
    expect(res.text).not.toContain('9. [mrbeast]');
    expect(ctx.contextIndex.lastBatch()).toHaveLength(8);
  });

  it('摘要读取未成功 → 诚实降级卡，next 重试；恢复后照常', async () => {
    ctx = makeOrchestrator({ summary: null });
    const res = await toLantern(ctx);
    expect(res.text).toContain('HOUSE_REMOTE_UNKNOWN');
    expect(res.text).toContain('摘要尚未读取成功');
    expect(ctx.sm.drafts(PID)).toEqual({ lantern: 'degraded' });
    ctx.world.summary = makeSummary();
    const retry = await ctx.orch.handleAdvance('next');
    expect(retry.text).toContain('一座灯坊是一盏灯');
    expect(ctx.sm.current(PID)).toBe('lantern');
  });

  it('灯坊够不着时 skip 照样能走（不阻塞脊柱）', async () => {
    ctx = makeOrchestrator({ summary: null });
    await toLantern(ctx);
    await ctx.orch.handleAdvance('skip');
    expect(ctx.sm.current(PID)).toBe('errand');
  });

  it('编号 → 展开卡 + learned expanded', async () => {
    await toLantern(ctx);
    const res = await ctx.orch.handleAdvance('next', '2');
    expect(res.text).toContain('Morning routine ✨ full version');
    expect(res.text).toContain(`http://localhost:3000/post/${E2.slice(0, 10)}`);
    expect(ctx.learnedPicks[0]).toMatchObject({ eventId: E2, signal: 'expanded' });
    expect(ctx.sm.current(PID)).toBe('lantern');
  });

  it('「标一下 N」（含旧词 标记/收藏）→ markService', async () => {
    for (const verb of ['标一下 1', '标记1', '收藏 1']) {
      const c = makeOrchestrator();
      await toLantern(c);
      const res = await c.orch.handleAdvance('next', verb);
      expect(res.text).toContain('标下了');
      expect(c.markedItems[0]).toMatchObject({ eventId: E1 });
    }
  });

  it('mark 抛 → 诚实报错，绝不谎称已标记', async () => {
    ctx = makeOrchestrator({ markThrow: true });
    await toLantern(ctx);
    const res = await ctx.orch.handleAdvance('next', '标一下 1');
    expect(res.text).not.toContain('标下了');
    expect(res.text).toContain('没标上');
  });

  it('「无感 N」→ learned meh，无标记', async () => {
    await toLantern(ctx);
    const res = await ctx.orch.handleAdvance('next', '无感 3');
    expect(res.text).toContain('记下了');
    expect(ctx.learnedPicks[0]).toMatchObject({ eventId: E3, signal: 'meh' });
    expect(ctx.markedItems).toHaveLength(0);
  });

  it('learned 写入失败不阻塞 UX', async () => {
    ctx = makeOrchestrator({ learnedThrow: true });
    await toLantern(ctx);
    const res = await ctx.orch.handleAdvance('next', '1');
    expect(res.text).toContain('Last to leave wins $100k');
  });

  it('越界编号 / 听不懂 → retry，不转移', async () => {
    await toLantern(ctx);
    const res = await ctx.orch.handleAdvance('next', '9');
    expect(res.text).toContain('没有这个编号');
    expect(ctx.sm.current(PID)).toBe('lantern');
  });

  it('裸回车 → attune，并把同一批条目带过去', async () => {
    await toLantern(ctx);
    await ctx.orch.handleAdvance('next');
    expect(ctx.sm.current(PID)).toBe('attune');
    const drafts = ctx.sm.drafts(PID) as { attune?: { entries: unknown[] } };
    expect(drafts.attune?.entries).toHaveLength(3);
  });

  it('skip 连带跳过 attune → 直接 errand（缺口记账）', async () => {
    await toLantern(ctx);
    const res = await ctx.orch.handleAdvance('skip');
    expect(ctx.sm.current(PID)).toBe('errand');
    expect(res.text).toContain('上面那几个人里有想跟着的吗');
  });
});

// ---------------------------------------------------------------------------
// ④ attune
// ---------------------------------------------------------------------------

describe('attune（对味 · 核心演出）', () => {
  it('只问一句，说清只进本机', async () => {
    const ctx = makeOrchestrator();
    const res = await toAttune(ctx);
    expect(ctx.sm.current(PID)).toBe('attune');
    expect(res.text).toContain('你最近关心什么');
    expect(res.text).toContain('不上传');
  });

  it('答了 → 写 taste core → 对同一批条目重排 → 重排卡带「原第 N 条」→ 接上 errand', async () => {
    const tasteRoot = await mkdtemp(join(tmpdir(), 'popclaw-attune-'));
    const ctx = makeOrchestrator({ tasteRoot });
    await toAttune(ctx);
    const before = ctx.llmPrompts.length;
    const res = await ctx.orch.handleAdvance('next', '我关心 AI agent 之间的谈判');

    const md = await readFile(join(tasteRoot, 'core/private.md'), 'utf-8');
    expect(md).toContain('我关心 AI agent 之间的谈判');
    // 重排复用既有 rankBySummaryTaste 通路：正好多一次调用，且喂的是主人原话
    expect(ctx.llmPrompts).toHaveLength(before + 1);
    expect(ctx.llmPrompts.at(-1)).toContain('我关心 AI agent 之间的谈判');
    // LLM order=[3,1,2] → 新第 1 条是原第 3 条
    expect(res.text).toContain('（原第 3 条）');
    expect(res.text).toContain('热度和主人关心的东西不是一回事');
    expect(ctx.sm.current(PID)).toBe('errand');
    expect(res.text).toContain('上面那几个人里有想跟着的吗');
  });

  it('lantern 阶段（core 空）不花 LLM 重排 —— 首跑热度序的 bug 在 attune 才消灭', async () => {
    const ctx = makeOrchestrator();
    await toLantern(ctx);
    // 只花了取名那一次；排序 prompt（"order" 契约）一次都没发生。
    expect(ctx.llmPrompts.filter((p) => p.includes('"order"'))).toHaveLength(0);
    expect(ctx.llmPrompts).toHaveLength(1);
  });

  it('跳过 → 一句诚实后果，缺口记账，绝不追问第二次', async () => {
    const tasteRoot = await mkdtemp(join(tmpdir(), 'popclaw-attune-skip-'));
    const ctx = makeOrchestrator({ tasteRoot });
    await toAttune(ctx);
    const res = await ctx.orch.handleAdvance('skip');
    expect(res.text).toContain('先按热度给你');
    expect(ctx.sm.current(PID)).toBe('errand');
    await expect(stat(join(tasteRoot, 'core/private.md'))).rejects.toThrow();
  });

  it('主人又说一遍「跳过」→ 不写进主权层', async () => {
    const tasteRoot = await mkdtemp(join(tmpdir(), 'popclaw-attune-echo-'));
    const ctx = makeOrchestrator({ tasteRoot });
    await toAttune(ctx);
    await ctx.orch.handleAdvance('next', '跳过');
    expect(ctx.sm.current(PID)).toBe('errand');
    await expect(stat(join(tasteRoot, 'core/private.md'))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ⑤ errand
// ---------------------------------------------------------------------------

describe('errand（头一件差事）', () => {
  it('邀请里带上刚露过面的人', async () => {
    const ctx = makeOrchestrator();
    const res = await toErrand(ctx);
    expect(res.text).toContain('mrbeast');
  });

  it('报编号 → 从会话上下文索引解析成 popclaw_id 再去 follow', async () => {
    const ctx = makeOrchestrator();
    await toErrand(ctx);
    const res = await ctx.orch.handleAdvance('next', '1');
    expect(ctx.followRefs).toEqual([MRBEAST]);
    expect(res.text).toContain('已关注 mrbeast#AAAA1111。');
    expect(ctx.sm.current(PID)).toBe('cadence');
  });

  it('说人话（线索命中）同样解析到 id', async () => {
    const ctx = makeOrchestrator();
    await toErrand(ctx);
    await ctx.orch.handleAdvance('next', '关注 alixearle');
    expect(ctx.followRefs).toEqual([ALIX]);
  });

  it('索引里没有的名字 → 原话交给认人链（本地两源 + 灯坊）', async () => {
    const ctx = makeOrchestrator();
    await toErrand(ctx);
    await ctx.orch.handleAdvance('next', '苍梧居士#4f68bd');
    expect(ctx.followRefs).toEqual(['苍梧居士#4f68bd']);
  });

  it('关注成功 → 交情本那一句逐字（任何服务器、任何其他用户）', async () => {
    const ctx = makeOrchestrator();
    await toErrand(ctx);
    const res = await ctx.orch.handleAdvance('next', '1');
    expect(res.text).toContain('这个本子只在你这台机器上，任何服务器、任何其他用户都读不到');
    expect(res.text).not.toContain('任何人');
  });

  it('对方已认证 → 顺一句认证；没认证就一个字不提', async () => {
    const verified = makeOrchestrator({
      follow: async () => ({ kind: 'followed', display: 'mrbeast#AAAA1111', verifiedPlatform: 'X' }),
    });
    await toErrand(verified);
    const res = await verified.orch.handleAdvance('next', '1');
    expect(res.text).toContain('X 的背书');
    expect(res.text).toContain('我要认证');

    const plain = makeOrchestrator();
    await toErrand(plain);
    const res2 = await plain.orch.handleAdvance('next', '1');
    expect(res2.text).not.toContain('我要认证');
    expect(res2.text).not.toContain('背书');
  });

  it('撞号 → 列候选，留在本幕', async () => {
    const ctx = makeOrchestrator({
      follow: async () => ({ kind: 'choose', lines: ['· 甲#AAAA1111', '· 乙#BBBB2222'] }),
    });
    await toErrand(ctx);
    const res = await ctx.orch.handleAdvance('next', '甲');
    expect(res.text).toContain('甲#AAAA1111');
    expect(ctx.sm.current(PID)).toBe('errand');
  });

  it('查无此人 → 诚实说，留在本幕', async () => {
    const ctx = makeOrchestrator({
      follow: async () => ({ kind: 'notFound', ref: '张三' }),
    });
    await toErrand(ctx);
    const res = await ctx.orch.handleAdvance('next', '张三');
    expect(res.text).toContain('张三');
    expect(ctx.sm.current(PID)).toBe('errand');
  });

  it('认人链抛 → 不假装办成了', async () => {
    const ctx = makeOrchestrator({ follow: async () => { throw new Error('boom'); } });
    await toErrand(ctx);
    const res = await ctx.orch.handleAdvance('next', '1');
    expect(res.text).toContain('没办成');
    expect(ctx.sm.current(PID)).toBe('errand');
  });

  it('跳过 → 诚实后果（报纸会空）+ 进 cadence', async () => {
    const ctx = makeOrchestrator();
    await toErrand(ctx);
    const res = await ctx.orch.handleAdvance('skip');
    expect(res.text).toContain('一个人都没有');
    expect(res.text).toContain('明早');
    expect(ctx.sm.current(PID)).toBe('cadence');
  });
});

// ---------------------------------------------------------------------------
// ⑥ cadence + 毕业
// ---------------------------------------------------------------------------

describe('cadence（定节奏 + 毕业 + 攻略）', () => {
  it('只问一次，两个选项', async () => {
    const ctx = makeOrchestrator();
    const res = await toCadence(ctx);
    expect(ctx.sm.current(PID)).toBe('cadence');
    expect(res.text).toContain('1 好');
    expect(res.text).toContain('2 不用');
  });

  it('答 1 → 记 daily + 指示 agent 排 popclaw-newspaper cron（关投递）→ completed', async () => {
    const ctx = makeOrchestrator();
    await toCadence(ctx);
    const res = await ctx.orch.handleAdvance('next', '1');
    expect(ctx.sm.current(PID)).toBe('completed');
    expect(res.text).toContain('popclaw-newspaper');
    expect(res.text).toContain('把该任务的结果投递关掉');
    const cfg = (await ctx.host.config.loadJson('plugin')) as { onboarding: { newspaper: string } };
    expect(cfg.onboarding.newspaper).toBe('daily');
  });

  it('答 2 → 记 declined，以后不再轻推晨报', async () => {
    const ctx = makeOrchestrator();
    await toCadence(ctx);
    const res = await ctx.orch.handleAdvance('next', '2');
    const cfg = (await ctx.host.config.loadJson('plugin')) as { onboarding: { newspaper: string } };
    expect(cfg.onboarding.newspaper).toBe('declined');
    expect(res.text).toContain('别再轻推晨报');
    expect(ctx.sm.current(PID)).toBe('completed');
  });

  it('毕业词带攻略素材：渲 HTML + popclaw_canvas 72h + 只列真做过的 + 缺口 + 坊玩法', async () => {
    const ctx = makeOrchestrator();
    await toLantern(ctx);
    await ctx.orch.handleAdvance('next'); // → attune
    await ctx.orch.handleAdvance('next', '我关心 AI agent 之间的谈判'); // → errand
    await ctx.orch.handleAdvance('next', '1'); // follow → cadence
    const res = await ctx.orch.handleAdvance('next', '1');

    expect(res.text).toContain('popclaw_canvas');
    expect(res.text).toContain('ttl_hours 设 72');
    // 只列真发生过的
    expect(res.text).toContain('定了名号「凤栖梧」');
    expect(res.text).toContain('关注了 mrbeast#AAAA1111');
    // 口味自述原文进素材
    expect(res.text).toContain('我关心 AI agent 之间的谈判');
    // 坊玩法来自数据（坊名零写死）
    expect(res.text).toContain('灯坊甲 怎么玩');
    // 人话⇄能力对照
    expect(res.text).toContain('「今天江湖上有什么」');
    // 通知频道：告知不索要
    expect(res.text).toContain('在这儿找你');
  });

  it('全跳路径：缺口逐条记在毕业素材里', async () => {
    const ctx = makeOrchestrator();
    await toPassport(ctx);
    await ctx.orch.handleAdvance('skip'); // passport → lantern
    await ctx.orch.handleAdvance('skip'); // lantern skip → errand（连带跳 attune）
    await ctx.orch.handleAdvance('skip'); // errand skip → cadence
    const res = await ctx.orch.handleAdvance('skip'); // cadence skip → completed
    expect(ctx.sm.current(PID)).toBe('completed');
    expect(res.text).toContain('口味档案还是空的');
    expect(res.text).toContain('还一个人都没关注');
    // 没表态就别替主人排定时任务
    expect(res.text).toContain('别自作主张排定时任务');
  });
});

// ---------------------------------------------------------------------------
// bail / 生命周期 / 只读路径
// ---------------------------------------------------------------------------

describe('bail（「先这样」）', () => {
  it('任何一幕说「先这样」都直接 completed，缺口记账', async () => {
    for (const stage of ['arrival', 'lantern', 'errand'] as const) {
      const ctx = makeOrchestrator();
      if (stage === 'arrival') await ctx.orch.handleStartCommand();
      if (stage === 'lantern') await toLantern(ctx);
      if (stage === 'errand') await toErrand(ctx);
      const res = await ctx.orch.handleAdvance('next', '先这样');
      expect(ctx.sm.current(PID)).toBe('completed');
      expect(res.text).toContain('先到这儿');
    }
  });

  it('「先看看」同义', async () => {
    const ctx = makeOrchestrator();
    await ctx.orch.handleStartCommand();
    await ctx.orch.handleAdvance('next', '先看看');
    expect(ctx.sm.current(PID)).toBe('completed');
  });
});

describe('生命周期', () => {
  it('start / stop 幂等', async () => {
    const ctx = makeOrchestrator();
    await ctx.orch.start();
    await ctx.orch.start();
    await ctx.orch.stop();
    await ctx.orch.stop();
  });

  it('中途再 /popclaw start = 幂等重演当前这一幕', async () => {
    const ctx = makeOrchestrator();
    await toLantern(ctx);
    ctx.presenter.delivered = [];
    await ctx.orch.handleStartCommand();
    expect(ctx.sm.current(PID)).toBe('lantern');
    expect(ctx.presenter.delivered).toHaveLength(1);
  });

  it('毕业后 start / advance 都说已完成', async () => {
    const ctx = makeOrchestrator();
    await ctx.orch.handleStartCommand();
    await ctx.orch.handleAdvance('next', '先这样');
    expect((await ctx.orch.handleStartCommand()).text).toMatch(/已经办完/);
    expect((await ctx.orch.handleAdvance('next')).text).toMatch(/已经办完/);
  });

  // MCP 公民（Claude Code / Codex）根本没有斜杠命令：`/popclaw start` 只存在于网关。
  // 从前 idle 上的 advance 只回一句「请先键 /popclaw start」，于是一个纯 MCP 新公民
  // 永远进不了第一幕 —— 六幕只能靠手改状态库才走得通。continue 从 idle 起步 = 主人
  // 开口、agent 代敲，与他自己键 /popclaw start 等价（「安顿是清单不是轨道」）。
  it('idle 时 advance = 开局（MCP 没有斜杠命令可敲）', async () => {
    const ctx = makeOrchestrator();
    await ctx.orch.start();
    const res = await ctx.orch.handleAdvance('next');
    expect(ctx.sm.current(PID)).toBe('arrival');
    expect(res.text).toContain('1. 凤栖梧');
    expect(ctx.presenter.delivered).toHaveLength(1);
  });

  it('idle 时 advance 走的就是 start 那条路（没起过库也一样）', async () => {
    const ctx = makeOrchestrator();
    // 连 ensureStarted 都没跑过：真·全新公民的第一次调用。
    const res = await ctx.orch.handleAdvance('next', '开始吧');
    expect(ctx.sm.current(PID)).toBe('arrival');
    expect(res.text).toContain('1. 凤栖梧');
  });

  // skip 是「跳过当前这一幕」。一幕都还没开始时没有什么可跳的 —— 保持原样，
  // 免得一句 skip 反倒把安顿悄悄开起来。这也是那句 notStarted 提示如今**唯一**
  // 还走得到的路，所以 #409 的宿主中立措辞断言跟着搬到了这里：MCP 宿主没有斜杠
  // 命令，指名道姓念一条 /popclaw start 是假指令。
  it('idle 时 skip 不开局，且说"跟我说一声"、不念斜杠命令', async () => {
    const ctx = makeOrchestrator();
    await ctx.orch.start();
    const { text } = await ctx.orch.handleAdvance('skip');
    expect(ctx.sm.current(PID)).toBe('idle');
    expect(text).toContain('跟我说一声');
    expect(text).not.toContain('/popclaw');
    expect(ctx.presenter.delivered).toHaveLength(0);
  });

  it('7 天兜底：读路径顺手判 completed（零新定时器）', async () => {
    const ctx = makeOrchestrator();
    await toLantern(ctx);
    // 同一张表，换一个"七天后"的读取者
    const late = new OnboardingStateRepository(ctx.host.db, () => 1700000000 + 7 * 24 * 3600);
    expect(late.get(PID)?.stage).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// R1：坊自报「第一件事」（entry）+ 护照两扇门 + 随时重渲
// ---------------------------------------------------------------------------

describe('R1 护照页「你能去哪」（spec §2）', () => {
  it('有 entry 的坊：门 + headline + 第一件事全上页；文字版也进简报', async () => {
    const ctx = makeOrchestrator({ houses: HOUSES_WITH_ENTRY });
    const res = await toPassport(ctx);
    const html = ctx.uploads[0]!.html;
    expect(html).toContain('你 能 去 哪');
    expect(html).toContain('▸ 捏一个你自己的公仔，它替你去旅行');
    expect(html).toContain('href="https://house-b.test/"');
    expect(html).toContain('第一件事：对我说「带我进世界」');
    // 画布挂了信息不丢：同一批内容在卡片文本里也有一行。
    expect(res.text).toContain('灯坊乙 · 捏一个你自己的公仔，它替你去旅行 · 对我说「带我进世界」就开始');
  });

  it('主坊的门回落 webBaseUrl；别的坊一律不猜路径', async () => {
    const ctx = makeOrchestrator({ houses: HOUSES_WITH_ENTRY });
    await toPassport(ctx);
    const html = ctx.uploads[0]!.html;
    expect(html).toContain('进 灯坊甲 →');
    expect(html).toContain('href="http://localhost:3000"');
  });

  it('全零声明 → 门卡只有坊名/自述（没有 ▸、没有第一件事），主坊门仍在', async () => {
    const ctx = makeOrchestrator();
    await toPassport(ctx);
    const html = ctx.uploads[0]!.html;
    expect(html).toContain('你 能 去 哪');
    expect(html).not.toContain('▸');
    expect(html).not.toContain('第一件事');
    expect(html).toContain('进 灯坊甲 →');
    expect(html).not.toContain('进 灯坊乙 →');
  });

  it('签发日期走主人本地日历日，不是 UTC 日（台账 #011）', async () => {
    // 固定钟 1700000000 = UTC 2023-11-14 22:13，在 +08 已经是 11-15 清晨。
    // 裸 toISOString() 会把“今天的报纸/名帖”印成昨天。
    setOwnerTz('Asia/Shanghai');
    try {
      const ctx = makeOrchestrator();
      await toPassport(ctx);
      const html = ctx.uploads[0]!.html;
      expect(html).toContain('签发于 2023-11-15');
      expect(html).not.toContain('签发于 2023-11-14');
    } finally {
      setOwnerTz(undefined);
    }
  });

  it('「两扇门」那句只在真有两扇门时说', async () => {
    const withEntry = makeOrchestrator({ houses: HOUSES_WITH_ENTRY });
    expect((await toPassport(withEntry)).text).not.toContain('两扇门'); // 只有 1 座坊声明
    const both = makeOrchestrator({
      houses: [{ ...HOUSES[0]!, entry: { headline: '这儿说话', firstMove: '带我看看' } }, HOUSES_WITH_ENTRY[1]!],
    });
    expect((await toPassport(both)).text).toContain('两扇门');
  });
});

describe('R1 lantern 坊行（spec §3.1）', () => {
  it('有 headline → 用它；零声明 → 维持现状（说明书首段）', async () => {
    const withEntry = makeOrchestrator({ houses: HOUSES_WITH_ENTRY });
    const res = await toLantern(withEntry);
    expect(res.text).toContain('灯坊乙（有你的名帖 ✓） — 捏一个你自己的公仔，它替你去旅行');
    // 主坊没声明 entry：那一行与今天一字不差。
    expect(res.text).toContain('灯坊甲（有你的名帖 ✓） — 这里怎么玩：说人话就行。');

    const plain = makeOrchestrator();
    expect((await toLantern(plain)).text).toContain('灯坊甲（有你的名帖 ✓） — 这里怎么玩：说人话就行。');
  });

  it('江湖一瞥画布不再有坊卡（搬去护照页了）', async () => {
    const ctx = makeOrchestrator({ houses: HOUSES_WITH_ENTRY });
    await toLantern(ctx);
    const html = ctx.uploads.at(-1)!.html;
    expect(html).not.toContain('有你的名帖 ✓');
    expect(html).not.toContain('捏一个你自己的公仔');
    expect(html).toContain('Last to leave wins $100k'); // 人和事照旧
  });
});

describe('R1 errand 轻提一行（spec §3.3）', () => {
  it('副坊有 entry 且没开始 → 一行轻提，同时记进缺口', async () => {
    const ctx = makeOrchestrator({ houses: HOUSES_WITH_ENTRY, houseStarted: () => false });
    const res = await toErrand(ctx);
    expect(res.text).toContain('灯坊乙 那边还没开始');
    expect(res.text).toContain('说「带我进世界」');
    // 缺口进毕业清单（status 待办同源），不追问第二次。
    const grad = await ctx.orch.handleAdvance('skip'); // errand → cadence
    const done = await ctx.orch.handleAdvance('next', '2');
    expect(`${grad.text}\n${done.text}`).toContain('灯坊乙 那边还没开始');
  });

  it('那边已经来过信 → 一个字不提', async () => {
    const ctx = makeOrchestrator({
      houses: HOUSES_WITH_ENTRY,
      houseStarted: (slug) => slug === 'house-b',
    });
    expect((await toErrand(ctx)).text).not.toContain('还没开始');
  });

  it('主坊不提（今晚走的就是它的第一件事）', async () => {
    const ctx = makeOrchestrator({
      houses: [{ ...HOUSES[0]!, entry: { headline: '这儿说话', firstMove: '带我看看' } }, HOUSES[1]!],
    });
    expect((await toErrand(ctx)).text).not.toContain('还没开始');
  });

  it('零声明 → errand 卡与今天一字不差', async () => {
    const plain = await toErrand(makeOrchestrator());
    expect(plain.text).not.toContain('还没开始');
    expect(plain.text).not.toContain('另一座坊');
  });
});

describe('R1 护照随时重渲（spec §6）', () => {
  it('毕业之后「再给我一张护照」→ 用当下数据重出一张', async () => {
    const ctx = makeOrchestrator();
    await ctx.orch.handleStartCommand();
    await ctx.orch.handleAdvance('next', '1'); // 先定下名号（占位名一律不外推）
    await ctx.orch.handleAdvance('next', '先这样'); // bail → completed
    const uploadsBefore = ctx.uploads.length;
    const res = await ctx.orch.handleAdvance('next', '再给我一张护照');
    expect(res.text).toContain(SIGIL);
    expect(ctx.uploads.length).toBe(uploadsBefore + 1);
    expect(ctx.uploads.at(-1)!.ttlHours).toBe(72);
    expect(ctx.sm.current(PID)).toBe('completed'); // 不动状态机
  });

  it('还是占位名就想要护照 → 如实说还没定名号，绝不外推占位名片', async () => {
    const ctx = makeOrchestrator();
    await ctx.orch.handleStartCommand();
    await ctx.orch.handleAdvance('next', '先这样'); // bail，名号仍是占位
    const uploadsBefore = ctx.uploads.length;
    const res = await ctx.orch.handleAdvance('next', '再给我一张护照');
    expect(res.text).toContain('名号');
    expect(res.text).not.toContain('网络不通');
    expect(ctx.egress.pushes).toHaveLength(0); // 占位名片一次都没出去
    expect(ctx.uploads.length).toBe(uploadsBefore);
  });

  it('重渲反映新挂的坊', async () => {
    const ctx = makeOrchestrator({ houses: HOUSES_WITH_ENTRY });
    await toPassport(ctx);
    const res = await ctx.orch.handleAdvance('next', '名帖过期了，重出一张');
    expect(res.text).toContain('对我说「带我进世界」就开始');
    expect(ctx.uploads.at(-1)!.html).toContain('第一件事：对我说「带我进世界」');
    expect(ctx.sm.current(PID)).toBe('passport'); // 重渲不是推进
  });
});

describe('R1 bailed_at（spec §5 落盘修复）', () => {
  it('bail 写 config onboarding.bailed_at（epoch 秒），跨「进程」读得到', async () => {
    const ctx = makeOrchestrator();
    await ctx.orch.handleStartCommand();
    await ctx.orch.handleAdvance('next', '先这样'); // bail → completed
    const cfg = (await ctx.host.config.loadJson('plugin')) as { onboarding?: { bailed_at?: number } };
    expect(typeof cfg.onboarding?.bailed_at).toBe('number');
  });

  it('正常毕业（不经 bail）不写 bailed_at；毕业词答 1/2 后没有这个字段', async () => {
    const ctx = makeOrchestrator();
    await toCadence(ctx);
    await ctx.orch.handleAdvance('next', '1');
    const cfg = (await ctx.host.config.loadJson('plugin')) as { onboarding?: { bailed_at?: number } };
    expect(cfg.onboarding?.bailed_at).toBeUndefined();
  });

  it('bail 之后重新走完（cadence 毕业）→ bailed_at 被清除', async () => {
    const ctx = makeOrchestrator();
    // 先 bail 一次，制造一个挂着的 bailed_at。
    await ctx.orch.handleStartCommand();
    await ctx.orch.handleAdvance('next', '先这样');
    let cfg = (await ctx.host.config.loadJson('plugin')) as { onboarding?: { bailed_at?: number } };
    expect(typeof cfg.onboarding?.bailed_at).toBe('number');

    // state machine 已经 completed；把它拨回 idle 模拟"回来接着走"（handleStartCommand
    // 幂等地重新入队），再一路走到真毕业。
    ctx.repo.updateStage(PID, 'idle', {});
    await ctx.orch.handleStartCommand(); // idle → arrival
    await toCadence(ctx);
    await ctx.orch.handleAdvance('next', '1'); // → completed（真毕业）

    cfg = (await ctx.host.config.loadJson('plugin')) as { onboarding?: { bailed_at?: number } };
    expect(cfg.onboarding?.bailed_at).toBeUndefined();
  });

  it('保留其余顶层与 onboarding 字段（读-改-写纪律，与 newspaper 选择同一份先例）', async () => {
    const ctx = makeOrchestrator();
    await toCadence(ctx);
    await ctx.orch.handleAdvance('next', '2'); // declined newspaper
    await ctx.orch.handleAdvance('next', '先这样'); // 毕业后 bail 是 no-op（已 completed）
    const cfg = (await ctx.host.config.loadJson('plugin')) as { onboarding?: { newspaper?: string } };
    expect(cfg.onboarding?.newspaper).toBe('declined');
  });
});

describe('currentCardText()（只读：零网络、零 LLM、零状态变更）', () => {
  it('未 ensureStarted → 不抛，指回起步（同样不念斜杠命令）', async () => {
    const ctx = makeOrchestrator();
    const text = await ctx.orch.currentCardText();
    expect(text).toContain('跟我说一声');
    expect(text).not.toContain('/popclaw');
  });

  it('arrival 未给过候选 → 说人话，绝不调 suggestNames', async () => {
    const llmSpy = vi.fn(async () => CANDIDATES_JSON);
    const ctx = makeOrchestrator();
    (ctx.orch as unknown as { deps: { llm: { complete: unknown } } }).deps.llm = { complete: llmSpy };
    ctx.sm.ensureStarted(PID);
    ctx.sm.transition(PID, 'arrival');
    const text = await ctx.orch.currentCardText();
    expect(text).toContain('取名号');
    expect(llmSpy).not.toHaveBeenCalled();
    expect(ctx.sm.current(PID)).toBe('arrival');
    expect(ctx.presenter.delivered).toHaveLength(0);
  });

  it('arrival 给过候选 → agent 简报带候选', async () => {
    const ctx = makeOrchestrator();
    await ctx.orch.handleStartCommand();
    const before = ctx.llmPrompts.length;
    const text = await ctx.orch.currentCardText();
    expect(text).toContain('in your own voice');
    expect(text).toContain('凤栖梧');
    expect(ctx.llmPrompts).toHaveLength(before); // 零 LLM
  });

  it('passport / lantern 用会话缓存复述，零网络', async () => {
    const ctx = makeOrchestrator();
    await toPassport(ctx);
    expect(await ctx.orch.currentCardText()).toContain(`凤栖梧#${SIGIL}`);
    await ctx.orch.handleAdvance('next'); // → lantern
    const before = { g: ctx.world.guideFetches, s: ctx.world.summaryFetches };
    const text = await ctx.orch.currentCardText();
    expect(text).toContain('mrbeast');
    expect(ctx.world.guideFetches).toBe(before.g);
    expect(ctx.world.summaryFetches).toBe(before.s);
  });

  it('attune 答过之后复述重排；errand / cadence 各自的简报', async () => {
    const ctx = makeOrchestrator();
    await toAttune(ctx);
    expect(await ctx.orch.currentCardText()).toContain('what are you into lately');
    await ctx.orch.handleAdvance('next', '我关心 AI agent 之间的谈判');
    expect(await ctx.orch.currentCardText()).toContain("anyone above they'd like to follow"); // 已进 errand
    await ctx.orch.handleAdvance('skip'); // → cadence
    expect(await ctx.orch.currentCardText()).toMatch(/the world's paper here every day at \d{2}:00/);
  });

  it('completed → 已完成提示', async () => {
    const ctx = makeOrchestrator();
    await ctx.orch.handleStartCommand();
    await ctx.orch.handleAdvance('next', '先这样');
    expect(await ctx.orch.currentCardText()).toMatch(/已经办完/);
  });
});

/**
 * S1 language chain, lane 3: the owner's first real sentence is the last
 * signal we have before defaulting to en-US. Process-only on purpose — see
 * the comment in `handleAdvance`.
 */
describe("S1 script fallback on the owner's first answer", () => {
  // Undo the file-wide en pin: these tests are about what the register does
  // when nothing has been configured.
  beforeEach(() => setOwnerLang(undefined));
  afterEach(() => setOwnerLang(undefined));

  it('adopts the script the owner typed in', async () => {
    const ctx = makeOrchestrator();
    await ctx.orch.handleStartCommand();
    await ctx.orch.handleAdvance('next', '青鸾');
    expect(ownerLangTag()).toBe('zh-CN');
    expect(ownerLangSource()).toBe('guess');
  });

  it('leaves a Latin-script answer alone — it falls through to the default', async () => {
    const ctx = makeOrchestrator();
    await ctx.orch.handleStartCommand();
    await ctx.orch.handleAdvance('next', 'Kuroha');
    expect(ownerLangSource()).toBeUndefined();
    expect(ownerLangTag()).toBe('en-US');
  });

  it('never overrides what the owner explicitly configured', async () => {
    const ctx = makeOrchestrator();
    setOwnerLang('en-US', 'config');
    await ctx.orch.handleStartCommand();
    await ctx.orch.handleAdvance('next', '青鸾');
    expect(ownerLangTag()).toBe('en-US');
  });
});

/**
 * S5 §9.5, "one language all the way through, never mixed": the act cards go
 * from the plugin to the owner with **no agent in between** (`presentCard` →
 * `presenter.present`), so the body has to be in the owner's language — the
 * agent's `languageDirective` never gets a chance to translate it. The card's
 * `context` hint already followed `ownerLang()`; before this, the body did
 * not, and a zh-CN owner read an English act with a Chinese tail.
 */
describe('六幕卡正文跟着主人的语种走（S5 §9.5 不混语言）', () => {
  beforeEach(() => setOwnerLang(undefined));
  afterEach(() => setOwnerLang(undefined));

  it('zh 主人：卡正文是中文，context 提示也是中文（同屏同语）', async () => {
    setOwnerLang('zh-CN', 'config');
    const ctx = makeOrchestrator();
    const res = await ctx.orch.handleStartCommand();
    expect(res.text).toContain('先用一句话说清这里是什么');
    expect(res.text).not.toContain('does the socializing');
    // 同一张卡上的两块：正文 + 「直接回答就行」那一行
    expect(res.text).toContain('直接回答就行');
  });

  it('en 主人：卡正文是英文源', async () => {
    setOwnerLang('en-US', 'config');
    const ctx = makeOrchestrator();
    const res = await ctx.orch.handleStartCommand();
    expect(res.text).toContain('does the socializing');
    expect(res.text).not.toContain('先用一句话');
  });

  it('主人用中文作答 → 从那一刻起整幕都是中文（脚本嗅探那一档也算数）', async () => {
    const ctx = makeOrchestrator();
    await ctx.orch.handleStartCommand(); // 还没线索 → 默认 en
    const res = await ctx.orch.handleAdvance('next', '凤栖梧'); // 中文 → 切 zh
    expect(ownerLangTag()).toBe('zh-CN');
    expect(res.text).toContain('的名帖已经签出来了');
    expect(res.text).not.toContain("namecard is signed");
  });

  // 把控权交给主人。他不必在 1/2 里挑——
  // 直接报一个点就算答应了（没人会给一份自己不要的报纸定时刻）。
  it('cadence：主人直接报个点 → 当作答应，并按他报的点排', async () => {
    setOwnerLang('zh-CN', 'config');
    const ctx = makeOrchestrator();
    await toCadence(ctx);
    const grad = await ctx.orch.handleAdvance('next', '晚上九点吧，21');
    expect(grad.text).toContain('说好了每天 21:00 收报纸');
    expect(grad.text).toContain('就排在 21:00');
  });

  it('毕业幕：正文、真做过的事、人话对照、频道告知全在同一语种里', async () => {
    setOwnerLang('zh-CN', 'config');
    const ctx = makeOrchestrator();
    await toCadence(ctx);
    const grad = await ctx.orch.handleAdvance('next', '1');
    expect(grad.text).toContain('给主人一句毕业词');
    expect(grad.text).toContain('这一趟真做过的');
    expect(grad.text).toMatch(/说好了每天 \d{2}:00 收报纸/); // done 条目（时刻随「此刻」变，只钉形状）
    expect(grad.text).toContain('人话 ⇄ 能力'); // phrasebook
    expect(grad.text).toContain('我以后有事就在这儿找你'); // channelNoticeText
    expect(grad.text).not.toContain('Actually done this run');
  });

  it('毕业幕 en 车道同样自洽', async () => {
    setOwnerLang('en-US', 'config');
    const ctx = makeOrchestrator();
    await toCadence(ctx);
    const grad = await ctx.orch.handleAdvance('next', '1');
    expect(grad.text).toContain('Send the owner off with a few graduation words');
    expect(grad.text).toContain('Actually done this run');
    expect(grad.text).toMatch(/Said yes to the paper, every day at \d{2}:00/);
    expect(grad.text).toContain('Plain words ⇄ what I can do');
    expect(grad.text).not.toContain('这一趟真做过的');
  });

  it('agent 那一面永远是英文源（简报走 languageDirective，不走词表车道）', async () => {
    setOwnerLang('zh-CN', 'config');
    const ctx = makeOrchestrator();
    await ctx.orch.handleStartCommand();
    const forAgent = await ctx.orch.currentCardText();
    expect(forAgent).toContain('does the socializing');
    expect(forAgent).not.toContain('先用一句话说清这里是什么');
  });
});

/**
 * 2026-08-23 MCP 无头冒烟（全新身份、owner 说中文）漏出来的两条：
 *
 *  ① 六幕文案里冒出英文占位形态「the owner」——「让the owner的 agent 替他社交」。
 *     `ownerAddressing` 那时是**启动期求值一次**的字符串（`mcp.ts` / `index.ts`
 *     构造 orchestrator 时 `renderCopy(ownerLang(), …)`）。全新身份的第一轮，
 *     语言链还什么都没定（无 cadence、无 env、状态文件空），求值结果就是英文；
 *     等首轮嗅探把语种切成 zh 之后，卡片正文正确地渲成了中文，可 `{who}` 槽里
 *     塞的还是那个冻住的英文字符串。MCP 上尤其准死：那条链上根本没有
 *     `before_prompt_build` 钩子，唯一的嗅探点是 `handleAdvance` 的答案文本，
 *     必然晚于首卡渲染。
 *  ② 同一表面中英混排：挂坊首动作行的**脚手架**（`say "…" to start`）是硬编码
 *     英文，包着坊自报的中文数据。
 *
 * 两条都不是语言链的优先级错了，是"值被提前捕获/写死"。这里按真实时序钉住。
 */
describe('全新身份首轮：占位形态与脚手架都不许漏英文（2026-08-23 冒烟）', () => {
  beforeEach(() => setOwnerLang(undefined));
  afterEach(() => setOwnerLang(undefined));

  it('zh 首轮嗅探切换后，六幕全程零 "the owner"，门那一行的脚手架也是中文', async () => {
    // 全新身份 = 语言链空白：没有 cadence、没有 env、状态文件里什么都没有。
    // 首卡因此渲成 en——这是设计如此，不是 bug；真正要钉的是**嗅探之后**。
    const ctx = makeOrchestrator({ houses: HOUSES_WITH_ENTRY });
    await ctx.orch.handleStartCommand();

    // 主人用中文答第一句 → 脚本嗅探把语种定成 zh-CN。
    const passport = await ctx.orch.handleAdvance('next', '凤栖梧');
    expect(ownerLangTag()).toBe('zh-CN');

    // 从这一刻起，主人看到的每一面都不许带英文占位形态。
    const surfaces = [
      passport,
      await ctx.orch.handleAdvance('next'), // → lantern
      await ctx.orch.handleAdvance('next'), // → attune
      await ctx.orch.handleAdvance('skip'), // → errand
      await ctx.orch.handleAdvance('skip'), // → cadence
      await ctx.orch.handleAdvance('next', '1'), // → 毕业
    ].map((r) => r.text);
    for (const text of surfaces) expect(text).not.toContain('the owner');
    expect(surfaces.join('\n')).toContain('主人');

    // ②：坊自报的中文数据外面包的是中文脚手架，不是 `say "…" to start`。
    expect(passport.text).toContain('对我说「带我进世界」就开始');
    expect(passport.text).not.toContain('to start');
  });

  it('en 主人不回归：英文车道照旧说 "the owner"，也没混进中文脚手架', async () => {
    setOwnerLang('en-US', 'config');
    const ctx = makeOrchestrator({ houses: HOUSES_WITH_ENTRY });
    const arrival = await ctx.orch.handleStartCommand();
    expect(arrival.text).toContain('the owner');

    // A typed name is asked back before it is signed (N1); the yes signs it.
    await ctx.orch.handleAdvance('next', 'Fenix');
    const passport = await ctx.orch.handleAdvance('next', '1');
    expect(ownerLangTag()).toBe('en-US'); // config 压得住嗅探
    expect(passport.text).toContain('say "带我进世界" to start');
    expect(passport.text).not.toContain('对我说');
  });
});

/**
 * 2026-08-24 真机（中文主人、fresh MCP 身份）：第一屏整卡英文，而外面驱动的
 * agent 自己全程在写中文。兜底链没错，错在 `LANG=en_US.UTF-8` 这一档被当成了
 * 「主人说过话了」——开发机上这值几乎是宇宙常数，MCP 宿主又原样传给它 spawn
 * 的进程，于是 env 一填，刻意双语的首屏就被关掉，纯英文首卡直出。
 *
 * 新判据 `hasRealLanguageSignal()`：只有 config / 观察（agent|guess）算真信号；
 * 仅 env 或全空 → 第一接触面保持刻意双语（英文在上、中文在下）。
 */
describe('第一接触面：env 不算真信号（2026-08-24 真机）', () => {
  const freshLangFile = (): string =>
    join(tmpdir(), `owner-language-${Math.random().toString(36).slice(2)}.json`);
  beforeEach(() => setOwnerLang(undefined));
  afterEach(() => setOwnerLang(undefined));

  it('env=en_US 且无任何观察 → 首卡双语（正文两语都在，问一句也两语）', async () => {
    useOwnerLangSignals({ file: freshLangFile(), env: { LANG: 'en_US.UTF-8' } });
    expect(ownerLangSource()).toBe('env');

    const arrival = await makeOrchestrator().orch.handleStartCommand();
    expect(arrival.text).toContain('does the socializing'); // 英文正文
    expect(arrival.text).toContain('先用一句话说清这里是什么'); // 中文正文
    expect(arrival.text).toContain('Just answer'); // 英文那一问
    expect(arrival.text).toContain('直接回答就行'); // 中文那一问
  });

  it('env=en_US 但已观察到中文 → 单语中文，不再双语', async () => {
    useOwnerLangSignals({ file: freshLangFile(), env: { LANG: 'en_US.UTF-8' } });
    observeOwnerText('咱们开始吧'); // 一句中文 = 真信号
    expect(ownerLangTag()).toBe('zh-CN');

    const arrival = await makeOrchestrator().orch.handleStartCommand();
    expect(arrival.text).toContain('先用一句话说清这里是什么');
    expect(arrival.text).not.toContain('does the socializing');
    expect(arrival.text).not.toContain('Just answer');
  });

  it('config=en-US → 单语英文（明确配置过的主人不该被双语打扰）', async () => {
    setOwnerLang('en-US', 'config');
    const arrival = await makeOrchestrator().orch.handleStartCommand();
    expect(arrival.text).toContain('does the socializing');
    expect(arrival.text).toContain('Just answer');
    expect(arrival.text).not.toContain('先用一句话说清这里是什么');
    expect(arrival.text).not.toContain('直接回答就行');
  });

  /**
   * #419 的尾巴：双语首屏铺开了，兜底名号却还是按 `ownerLang()` 单选一条——零真
   * 信号时落 en，于是中文那半卡里嵌着英文候选（真机逐字："Night drifter"）。
   * 候选必须按车道生成；且两半条数相等、编号对齐，主人回「2」才不会有歧义。
   */
  it('无材料的双语首屏：两半各一条候选，中文那半是中文名', async () => {
    useOwnerLangSignals({ file: freshLangFile(), env: { LANG: 'en_US.UTF-8' } });
    const arrival = await makeOrchestrator({ llmReply: null }).orch.handleStartCommand();

    const picks = [...arrival.text.matchAll(/(?:^|\n)\s*1\. *(.+)/g)].map((m) => m[1]!.trim());
    expect(picks).toHaveLength(2); // 两半各一条 = 条数相等
    expect(arrival.text).not.toMatch(/(?:^|\n)\s*2\. /); // 兜底只有一条，两半编号自然对齐
    expect(picks[0]).toBe(fallbackName(PID, 'en'));
    expect(picks[1]).toBe(fallbackName(PID, 'zh-CN'));
    expect(picks[1]).not.toMatch(/[A-Za-z]/); // 中文半卡零拉丁候选
    expect(picks[0]).not.toBe(picks[1]);
  });

  it('主人用中文回话 → 采纳的是他读的那半的中文兜底名', async () => {
    useOwnerLangSignals({ file: freshLangFile(), env: { LANG: 'en_US.UTF-8' } });
    const ctx = makeOrchestrator({ llmReply: null });
    await ctx.orch.handleStartCommand(); // 双语首屏，drafts 里存的是 en 那条
    observeOwnerText('你来挑吧'); // 主人开口 = 真信号，语种落定
    await ctx.orch.handleAdvance('next', '你来挑吧');
    expect(await configNickname(ctx)).toBe(fallbackName(PID, 'zh-CN'));
  });

  it('「还没开始入住」两句同样是第一接触面：env-only 时双语', async () => {
    useOwnerLangSignals({ file: freshLangFile(), env: { LANG: 'en_US.UTF-8' } });
    const ctx = makeOrchestrator();
    const readonlyText = await ctx.orch.currentCardText();
    expect(readonlyText).toContain('Not settling in yet');
    expect(readonlyText).toContain('还没开始入住');

    const skipped = await ctx.orch.handleAdvance('skip');
    expect(skipped.text).toContain("Haven't started settling you in yet");
    expect(skipped.text).toContain('还没开始入住');
  });
});

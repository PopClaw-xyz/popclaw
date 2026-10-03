/**
 * S4.1-T3: unit tests for the three world tools + show_feed author upgrade.
 *
 * Strategy mirrors onboarding-tools.test.ts: fake clients capture calls,
 * register via registerPopclawTools with a getWorldDeps lazy getter, then
 * verify:
 *   - registration is conditional on getWorldDeps
 *   - guide tool renders frontmatter summary + body; honest copy on failure
 *   - summary tool reuses summary-format rendering (stats/hot/notable),
 *     forwards window_hours, degrades honestly
 *   - author_latest resolves names (unique/ambiguous/zero), outputs full
 *     text + post link + platform badge, clamps count
 *   - popclaw_show_feed resolves filter_by_author names through resolveAuthor
 *   - TypeBox schema validation (Value.Check on the schema itself)
 */

import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import { Value } from 'typebox/value';
import { popclaw } from '@popclaw/contracts';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { ownerLang } from '../../../src/lexicon/owner-language.js';
import type { ResolveCandidate } from '../../../src/identity/follow-resolution.js';
import {
  WorldGuideSchema,
  WorldSummaryToolSchema,
  AuthorLatestSchema,
  PopclawFollowSchema,
} from '../../../src/tools/tool-schemas.js';
import type { WorldSummaryResponse } from '../../../src/world/world-summary-client.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { withOutcomes } from '../../helpers/with-outcomes.js';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { BondsStore } from '../../../src/bonds/bonds-store.js';
import { displayNamed, makeNameChain } from '../../../src/identity/person-name.js';
import { deriveSigil } from '../../../src/invite/sigil.js';

import { setOwnerTz } from '../../../src/time/time-context.js';
import { _observedPostIdsForTest, resolvePostRef } from '../../../src/world/post-ref.js';

// S3 pilot: popclaw_world_summary / popclaw_show_feed now render in
// `ownerLang()` (S1 process-wide singleton). Pin zh-CN so this whole file's
// pre-lexicon assertions stay byte-for-byte unchanged (same fix as
// status.test.ts / mcp-notice.test.ts). The dedicated en-lane tests below
// call `setOwnerLang('en', 'config')` first and restore zh-CN afterward.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GUIDE_MD = [
  '---',
  'world: popclaw.me',
  'kind: lore-house',
  'voice: 一座灯火江湖',
  'streams:',
  '  - name: world-feed',
  '    endpoint: /world-feed',
  '  - name: guide',
  '    endpoint: /v1/guide.md',
  '---',
  '# 欢迎来到江湖',
  '这里的声音跨平台跟着人走。',
].join('\n');

function makeSummary(overrides?: Partial<WorldSummaryResponse>): WorldSummaryResponse {
  return {
    window_hours: 24,
    generated_at_ms: 0,
    total_posts: 42,
    distinct_authors: 7,
    authors: {
      id_elon: { nickname: 'Elon Musk' },
      id_beast: { nickname: 'MrBeast' },
    },
    hot_posts: [
      {
        event_id: 'e'.repeat(64),
        author: 'id_elon',
        platform: 'x',
        body_preview: '火星基地年底动工',
        reply_count: 3,
        quote_count: 0,
        created_at_ms: 1,
      },
      {
        event_id: 'f'.repeat(64),
        author: 'id_beast',
        platform: 'youtube',
        body_preview: '埋了一百辆车',
        reply_count: 2,
        quote_count: 0,
        created_at_ms: 2,
      },
    ],
    ...overrides,
  };
}

interface FakeSnapshotItem {
  authorPopclawId?: string | null;
  actorNickname?: string | null;
  platform?: string | null;
  textPreview?: string | null;
  platformPostId?: string | null;
  originalUrl?: string | null;
  platformPostCreatedAt?: number;
  envelope?: Uint8Array;
}

const SNAPSHOT_ITEMS: FakeSnapshotItem[] = [
  // MrBeast on a second platform → multi-platform stitch in notable authors
  { authorPopclawId: 'id_beast', actorNickname: 'MrBeast', platform: 'tiktok' },
  { authorPopclawId: 'id_elon', actorNickname: 'Elon Musk', platform: 'x' },
];

interface WorldDepsOverrides {
  guideText?: string | null;
  summary?: WorldSummaryResponse | null;
  summaryFailure?: import('../../../src/runtime/house-lifecycle/read-failure.js').HouseReadFailure;
  sourcesItems?: FakeSnapshotItem[];
  authorItems?: FakeSnapshotItem[];
  snapshotThrows?: boolean;
  webBaseUrl?: string;
  /** 认人 (ADR-0028): controls what lore-house /v1/resolve returns. */
  resolve?: (q: { sigil?: string; name?: string }) => Promise<ResolveCandidate[] | null>;
  /** ADR-0041: 已挂的第三方坊的说明书缓存。 */
  mountedGuides?: Array<{ slug: string; houseName: string; guide: string }>;
}

/** Build fake world deps; snapshot fake serves sources (no author) and author queries. */
function makeWorldDeps(o?: WorldDepsOverrides) {
  const fetchGuideText = vi.fn(async () => (o?.guideText !== undefined ? o.guideText : GUIDE_MD));
  const fetchSummary = vi.fn(async () =>
    o?.summary !== undefined ? o.summary : makeSummary(),
  );
  const fetchSnapshot = vi.fn(async (q: { limit?: number; author?: string }) => {
    if (o?.snapshotThrows) throw new Error('lore-house down');
    if (q.author) return o?.authorItems ?? [];
    return o?.sourcesItems ?? SNAPSHOT_ITEMS;
  });
  const resolve = vi.fn(
    o?.resolve ?? (async () => [] as ResolveCandidate[]),
  );
  return {
    deps: {
      guideClient: { fetchGuideText },
      summaryClient: { fetchSummary, ...(o?.summaryFailure ? {fetchSummaryResult:async()=>({ok:false as const,failure:o.summaryFailure!})} : {}) },
      snapshotClient: { fetchSnapshot },
      resolveClient: { resolve },
      webBaseUrl: o?.webBaseUrl ?? 'http://localhost:3000',
      ...(o?.mountedGuides ? { mountedGuides: () => o.mountedGuides! } : {}),
    },
    fetchGuideText,
    fetchSummary,
    fetchSnapshot,
    resolve,
  };
}

/** Build a fake api and capture registered tools. */
function buildFakeApi() {
  const tools: Array<{
    name: string;
    description: string;
    execute: (callId: string, params: unknown) => Promise<{ type: string; text: string }>;
  }> = [];
  const api = {
    registerTool: (tool: { name?: string; execute?: unknown }) => {
      if (tool?.name && typeof tool.execute === 'function') {
        tools.push(tool as (typeof tools)[number]);
      }
    },
    logger: { info: vi.fn() },
  } as Parameters<typeof registerPopclawTools>[0]['api'];
  return { api, tools };
}

function findTool(tools: ReturnType<typeof buildFakeApi>['tools'], name: string) {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

function setup(o?: WorldDepsOverrides, runtime?: () => Promise<unknown>) {
  const { api, tools } = buildFakeApi();
  const world = makeWorldDeps(o);
  registerPopclawTools({
    api,
    runtime: (runtime ?? vi.fn()) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    getWorldDeps: async () => world.deps,
  });
  return { tools, ...world };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('world tools registration', () => {
  it('registers all four world tools when getWorldDeps is provided', () => {
    const { tools } = setup();
    const names = tools.map((t) => t.name);
    expect(names).toContain('popclaw_world_guide');
    expect(names).toContain('popclaw_world_summary');
    expect(names).toContain('popclaw_author_latest');
    expect(names).toContain('popclaw_follow');
  });

  it('does NOT register world tools when getWorldDeps is absent', () => {
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: vi.fn() as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('popclaw_world_guide');
    expect(names).not.toContain('popclaw_world_summary');
    expect(names).not.toContain('popclaw_author_latest');
    expect(names).not.toContain('popclaw_follow');
  });
});

// ---------------------------------------------------------------------------
// popclaw_world_guide
// ---------------------------------------------------------------------------

describe('popclaw_world_guide', () => {
  it('renders frontmatter summary (world/voice/streams) + body', async () => {
    const { tools, fetchGuideText } = setup();
    const tool = findTool(tools, 'popclaw_world_guide');

    const r = await tool.execute('cid', {});

    expect(fetchGuideText).toHaveBeenCalledOnce();
    expect(r.type).toBe('text');
    expect(r.text).toContain('popclaw.me');
    expect(r.text).toContain('一座灯火江湖');
    expect(r.text).toContain('world-feed');
    expect(r.text).toContain('guide');
    expect(r.text).toContain('欢迎来到江湖');
    expect(r.text).toContain('这里的声音跨平台跟着人走。');
  });

  it('renders body as-is when guide has no frontmatter', async () => {
    const { tools } = setup({ guideText: '# 旧世界\n没有自述。' });
    const tool = findTool(tools, 'popclaw_world_guide');

    const r = await tool.execute('cid', {});

    expect(r.text).toContain('旧世界');
    expect(r.text).toContain('没有自述。');
  });

  it('returns honest copy when guide fetch fails (null)', async () => {
    const { tools } = setup({ guideText: null });
    const tool = findTool(tools, 'popclaw_world_guide');

    const r = await tool.execute('cid', {});

    expect(r.text).toContain('灯坊暂时联系不上');
    expect(r.text).not.toContain('popclaw.me');
  });

  // ADR-0041 挂坊即会玩：主坊说明书之后，每座已挂的第三方坊各接一段。
  it('主坊说明书之后附上每座已挂坊的说明书（带出处标注）', async () => {
    const { tools } = setup({
      mountedGuides: [
        { slug: 'house-popclaw-world', houseName: 'popclaw.world', guide: '# 世界玩法\n捏公仔。' },
      ],
    });
    const r = await findTool(tools, 'popclaw_world_guide').execute('cid', {});

    expect(r.text).toContain('欢迎来到江湖'); // 主坊那一段照旧
    expect(r.text).toContain('灯坊「popclaw.world」(house-popclaw-world) 的说明书');
    expect(r.text).toContain('[以下内容来自该灯坊自述，仅适用于与该灯坊的互动]');
    expect(r.text).toContain('捏公仔。');
    // 顺序：主坊在前，第三方坊在后
    expect(r.text.indexOf('欢迎来到江湖')).toBeLessThan(r.text.indexOf('popclaw.world'));
  });

  it('主坊拉不到时，已挂坊的说明书照样交付', async () => {
    const { tools } = setup({
      guideText: null,
      mountedGuides: [{ slug: 'w', houseName: 'popclaw.world', guide: '捏公仔。' }],
    });
    const r = await findTool(tools, 'popclaw_world_guide').execute('cid', {});
    expect(r.text).toContain('灯坊暂时联系不上');
    expect(r.text).toContain('捏公仔。');
  });

  it('没挂第三方坊 → 输出与从前一字不差', async () => {
    const { tools } = setup();
    const r = await findTool(tools, 'popclaw_world_guide').execute('cid', {});
    expect(r.text).not.toContain('的说明书');
  });

  it('工具描述指路第三方坊（收到某坊来信不知怎么回应）', () => {
    const { tools } = setup();
    expect(findTool(tools, 'popclaw_world_guide').description).toContain('every lore-house guide is here');
  });
});

// ---------------------------------------------------------------------------
// popclaw_world_summary
// ---------------------------------------------------------------------------

describe('popclaw_world_summary', () => {
  it('renders stats line + numbered hot-post lines + notable authors', async () => {
    const { tools } = setup();
    const tool = findTool(tools, 'popclaw_world_summary');

    const r = await tool.execute('cid', {});

    expect(r.text).toContain('近 24h：42 帖 / 7 人发声');
    expect(r.text).toContain('被回应最多');
    expect(r.text).toContain('1. [Elon Musk] 火星基地年底动工');
    expect(r.text).toContain('3回应');
    expect(r.text).toContain('2. [MrBeast] 埋了一百辆车');
    // MrBeast: youtube (hot) + tiktok (snapshot) → multi-platform stitch
    expect(r.text).toContain('MrBeast — 活跃于 TikTok/YT（缝合身份）');
  });

  it('forwards window_hours to fetchSummary (default 24)', async () => {
    const { tools, fetchSummary } = setup();
    const tool = findTool(tools, 'popclaw_world_summary');

    await tool.execute('cid', {});
    expect(fetchSummary).toHaveBeenLastCalledWith(24);

    await tool.execute('cid', { window_hours: 6 });
    expect(fetchSummary).toHaveBeenLastCalledWith(6);
  });

  it('caps hot posts at 8 lines', async () => {
    const hot = Array.from({ length: 10 }, (_, i) => ({
      event_id: String(i).repeat(64).slice(0, 64),
      author: 'id_elon',
      platform: 'x',
      body_preview: `热帖 ${i + 1}`,
      reply_count: 10 - i,
      quote_count: 0,
      created_at_ms: i,
    }));
    const { tools } = setup({ summary: makeSummary({ hot_posts: hot }) });
    const tool = findTool(tools, 'popclaw_world_summary');

    const r = await tool.execute('cid', {});

    expect(r.text).toContain('8. [Elon Musk] 热帖 8');
    expect(r.text).not.toContain('热帖 9');
  });

  it('uses honest zero-entry copy when no hot posts', async () => {
    const { tools } = setup({ summary: makeSummary({ hot_posts: [] }), sourcesItems: [] });
    const tool = findTool(tools, 'popclaw_world_summary');

    const r = await tool.execute('cid', {});

    expect(r.text).toContain('还没有被回应的根帖');
  });

  it('returns honest copy when summary fetch fails (null)', async () => {
    const { tools } = setup({ summary: null });
    const tool = findTool(tools, 'popclaw_world_summary');

    const r = await tool.execute('cid', {});

    expect(r.text).toContain('HOUSE_REMOTE_UNKNOWN');
  });

  it('degrades notable authors to hot-post sources when snapshot throws', async () => {
    const { tools } = setup({ snapshotThrows: true });
    const tool = findTool(tools, 'popclaw_world_summary');

    const r = await tool.execute('cid', {});

    // summary itself still renders; notable from hot posts only (single platform each)
    expect(r.text).toContain('近 24h：42 帖 / 7 人发声');
    expect(r.text).toContain('Elon Musk — 活跃于 X');
    expect(r.text).not.toContain('缝合身份');
  });

  it('mirror-author section is labeled 活跃的镜像号 (renamed from 重要的人)', async () => {
    const { tools } = setup();
    const tool = findTool(tools, 'popclaw_world_summary');

    const r = await tool.execute('cid', {});

    expect(r.text).toContain('活跃的镜像号');
    expect(r.text).not.toContain('重要的人');
  });

  it('caps mirror authors at 3 (S4.2 收窄 5 → 3)', async () => {
    const { tools } = setup({
      summary: makeSummary({ hot_posts: [], authors: {} }),
      sourcesItems: ['a_one', 'b_two', 'c_three', 'd_four'].map((n, i) => ({
        authorPopclawId: `id_${i}`,
        actorNickname: n,
        platform: 'x',
      })),
    });
    const tool = findTool(tools, 'popclaw_world_summary');

    const r = await tool.execute('cid', {});

    // 同分（单平台、各 1 帖）按昵称字母序：a/b/c 入榜，d 截掉
    expect(r.text).toContain('a_one');
    expect(r.text).toContain('b_two');
    expect(r.text).toContain('c_three');
    expect(r.text).not.toContain('d_four');
  });
});

// ---------------------------------------------------------------------------
// popclaw_world_summary v2 段（S4.2-T3：状态行 + 大名鼎鼎 + summary_note）
// ---------------------------------------------------------------------------

describe('popclaw_world_summary v2 fields', () => {
  const SUMMARY_NOTE = '精华——回应、引用与新近度的混合排序，附江湖状态与认证名人';

  function makeV2Summary(): WorldSummaryResponse {
    return makeSummary({
      world_state: {
        identities_total: 56,
        namecards_total: 2,
        verified_accounts_total: 8,
        native_posts_total: 7,
      },
      notable_people: [
        {
          popclaw_id: 'id_elon',
          nickname: 'Elon Musk',
          accounts: [
            { platform: 'x', handle: 'elonmusk', follower_count: 220_000_000 },
            { platform: 'instagram', handle: 'elonmusk', follower_count: 18_000_000 },
          ],
          followers_total: 238_000_000,
        },
      ],
      summary_note: SUMMARY_NOTE,
    });
  }

  it('renders 状态行 + 大名鼎鼎 + summary_note heading in section order', async () => {
    const { tools } = setup({ summary: makeV2Summary() });
    const tool = findTool(tools, 'popclaw_world_summary');

    const r = await tool.execute('cid', {});

    expect(r.text).toContain('江湖：56 身份 · 8 认证账号 · 2 名片 · 原生帖 7');
    expect(r.text).toContain('大名鼎鼎');
    expect(r.text).toContain('Elon Musk ✓认证 — X @elonmusk 2.2亿粉 · IG @elonmusk 1800万');
    expect(r.text).toContain(SUMMARY_NOTE);
    // 行序：状态行 → 大名鼎鼎 → 精华帖 → 活跃的镜像号
    const state = r.text.indexOf('江湖：56 身份');
    const people = r.text.indexOf('大名鼎鼎');
    const hot = r.text.indexOf('1. [Elon Musk]');
    const mirror = r.text.indexOf('活跃的镜像号');
    expect(state).toBeGreaterThan(-1);
    expect(people).toBeGreaterThan(state);
    expect(hot).toBeGreaterThan(people);
    expect(mirror).toBeGreaterThan(hot);
  });

  it('镜像号段不标 ✓认证（绝不混淆）', async () => {
    const { tools } = setup({ summary: makeV2Summary() });
    const tool = findTool(tools, 'popclaw_world_summary');

    const r = await tool.execute('cid', {});

    const mirrorSection = r.text.slice(r.text.indexOf('活跃的镜像号'));
    expect(mirrorSection).not.toContain('✓认证');
  });

  it('旧服务端响应（无 v2 字段）→ 新段整段省略', async () => {
    const { tools } = setup(); // makeSummary() has no v2 fields
    const tool = findTool(tools, 'popclaw_world_summary');

    const r = await tool.execute('cid', {});

    expect(r.text).not.toContain('江湖：');
    expect(r.text).not.toContain('大名鼎鼎');
    expect(r.text).not.toContain('✓认证');
    expect(r.text).toContain('被回应最多');
  });
});

// ---------------------------------------------------------------------------
// popclaw_follow（S4.2-T3：guide 教的"关注一下 paulg"的真实承接）
// ---------------------------------------------------------------------------

describe('popclaw_follow', () => {
  function makeFollowRuntime(declareThrows = false) {
    const declareFollow = vi.fn(async (id: string) => {
      if (declareThrows) throw new Error('lore-house push refused');
      void id;
    });
    const runtime = vi.fn(async () => ({ socialGraph: withOutcomes({ declareFollow }) }));
    return { declareFollow, runtime };
  }

  const ELON: ResolveCandidate = {
    popclawId: 'id_elon',
    nickname: 'Elon Musk',
    sigil: '4f68bd',
    profiles: [{ platform: 'x', handle: 'elonmusk', followerCount: 220_000_000 }],
  };

  it('empty/whitespace name → asks who, no resolve, no follow', async () => {
    const { declareFollow, runtime } = makeFollowRuntime();
    const { tools, resolve } = setup({}, runtime as unknown as () => Promise<unknown>);
    const tool = findTool(tools, 'popclaw_follow');

    const r = await tool.execute('cid', { name: '   ' });

    expect(r.text).toContain('关注谁');
    expect(resolve).not.toHaveBeenCalled();
    expect(declareFollow).not.toHaveBeenCalled();
  });

  // Anything but an accepted follow is passed through exactly as the command
  // wrote it — no name#sigil re-render, no house.
  it.each([
    ['queued', { transport: 'queued' }, /^… /],
    ['refused by the house', { mode: 'none', transport: 'intent_recorded', reason: 'HOUSE_UNREACHABLE' }, /^⚠️ /],
  ] as const)('%s → the command\'s own receipt, unchanged', async (_label, overrides, head) => {
    const base: Record<string, unknown> = {
      mode: 'ordered', transport: 'accepted', domain: 'unknown', action: 'declare',
      followee: 'id_elon', houseKey: 'k', eventId: 'e', seq: 1n, anotherEndHasSigned: false,
      houseSlug: 'north-house',
    };
    const declareFollowWithOutcome = vi.fn(async () => ({ ...base, ...overrides }));
    const runtime = vi.fn(async () => ({ socialGraph: { declareFollowWithOutcome } }));
    const { tools } = setup({ resolve: async () => [ELON] }, runtime as unknown as () => Promise<unknown>);
    const r = await findTool(tools, 'popclaw_follow').execute('cid', { name: '#4f68bd' });
    expect(declareFollowWithOutcome).toHaveBeenCalledTimes(1);
    expect(r.text).toMatch(head);
    expect(r.text).not.toContain('Elon Musk#4f68bd');
    expect(r.text).not.toContain('north-house');
  });

  it('precise key (sigil) unique hit → declares follow + 名号#印信 receipt', async () => {
    const { declareFollow, runtime } = makeFollowRuntime();
    const { tools } = setup({ resolve: async () => [ELON] }, runtime as unknown as () => Promise<unknown>);
    const tool = findTool(tools, 'popclaw_follow');

    const r = await tool.execute('cid', { name: '#4f68bd' });

    expect(declareFollow).toHaveBeenCalledTimes(1);
    expect(declareFollow).toHaveBeenCalledWith('id_elon');
    expect(r.text).toBe('已关注 Elon Musk#4f68bd。之后对方公开发的帖在你的推荐和日报里会优先。对方会知道这次关注。');
  });

  // G1-copy caller carry-over: this tool re-renders relation.followReceived
  // itself (with the resolved name#sigil instead of the bare id
  // runFollowCommand used), reading reply.house from the command's own
  // receipt. If a caller ever dropped reply.house, only mcp-follow-doorbell
  // would have noticed (it names a real house) — this pins it directly.
  it('precise key (sigil) unique hit, house known → receipt names it (equal to the command\'s own text apart from who)', async () => {
    const declareFollow = vi.fn(async () => 'north-house');
    // No cached handshake name for this slug → the receipt's house resolves
    // through the origin-host fallback; `north-house` doubles as both the
    // slug and (via this URL) the origin host, so the pinned wording below
    // is unchanged.
    const runtime = vi.fn(async () => ({
      socialGraph: withOutcomes({ declareFollow }),
      paths: { houseHandshakeFile: () => '/nonexistent/handshake.json' },
      boot: { loreHouseUrls: ['https://north-house'] },
    }));
    const { tools } = setup({ resolve: async () => [ELON] }, runtime as unknown as () => Promise<unknown>);
    const tool = findTool(tools, 'popclaw_follow');

    const r = await tool.execute('cid', { name: '#4f68bd' });

    expect(declareFollow).toHaveBeenCalledWith('id_elon');
    expect(r.text).toBe(
      renderCopy('zh-CN', 'relation.followReceived', { who: 'Elon Musk#4f68bd', house: 'north-house' }),
    );
    // Same key, same house, only `who` differs: the id runFollowCommand used
    // vs. the resolved name#sigil this tool substitutes.
    expect(r.text.replace('Elon Musk#4f68bd', 'id_elon')).toBe(
      renderCopy('zh-CN', 'relation.followReceived', { who: 'id_elon', house: 'north-house' }),
    );
  });

  it('fuzzy name → always lists candidates (even single), no follow', async () => {
    const elonia: ResolveCandidate = { popclawId: 'id_elonia', nickname: 'Elonia', sigil: 'ab12cd', profiles: [] };
    const { declareFollow, runtime } = makeFollowRuntime();
    const { tools } = setup({ resolve: async () => [ELON, elonia] }, runtime as unknown as () => Promise<unknown>);
    const tool = findTool(tools, 'popclaw_follow');

    const r = await tool.execute('cid', { name: 'elon' });

    expect(r.text).toContain('Elon Musk#4f68bd');
    expect(r.text).toContain('Elonia#ab12cd');
    expect(r.text).toContain('挑一个');
    expect(declareFollow).not.toHaveBeenCalled();
  });

  it('sigil collision → lists both, never silently follows one', async () => {
    const a: ResolveCandidate = { popclawId: 'A', nickname: '甲', sigil: '4f68bd', profiles: [] };
    const b: ResolveCandidate = { popclawId: 'B', nickname: '乙', sigil: '4f68bd', profiles: [] };
    const { declareFollow, runtime } = makeFollowRuntime();
    const { tools } = setup({ resolve: async () => [a, b] }, runtime as unknown as () => Promise<unknown>);
    const tool = findTool(tools, 'popclaw_follow');

    const r = await tool.execute('cid', { name: '#4f68bd' });

    expect(r.text).toContain('甲#4f68bd');
    expect(r.text).toContain('乙#4f68bd');
    expect(declareFollow).not.toHaveBeenCalled();
  });

  it('查无此人 → honest copy, no fake follow', async () => {
    const { declareFollow, runtime } = makeFollowRuntime();
    const { tools } = setup({ resolve: async () => [] }, runtime as unknown as () => Promise<unknown>);
    const tool = findTool(tools, 'popclaw_follow');

    const r = await tool.execute('cid', { name: '苍梧居士#abcdef' });

    expect(r.text).toContain('还没登记过');
    expect(r.text).not.toContain('已关注');
    expect(declareFollow).not.toHaveBeenCalled();
  });

  it('灯坊 unreachable (resolve null) → lantern-down copy, no follow', async () => {
    const { declareFollow, runtime } = makeFollowRuntime();
    const { tools } = setup({ resolve: async () => null }, runtime as unknown as () => Promise<unknown>);
    const tool = findTool(tools, 'popclaw_follow');

    const r = await tool.execute('cid', { name: '#4f68bd' });

    expect(r.text).toContain('灯坊暂时联系不上');
    expect(declareFollow).not.toHaveBeenCalled();
  });

  it('follow command failure → honest error, never a fake 已关注 receipt', async () => {
    const { runtime } = makeFollowRuntime(true);
    const { tools } = setup({ resolve: async () => [ELON] }, runtime as unknown as () => Promise<unknown>);
    const tool = findTool(tools, 'popclaw_follow');

    const r = await tool.execute('cid', { name: '#4f68bd' });

    expect(r.text).toContain('follow 没跑成');
    expect(r.text).not.toContain('已关注');
  });

  // Follow doorbell (spec §6.5): the description keeps the exact-match fast
  // path AND carries the pending-list carve-out — batch confirmations from
  // the injected list are the one place a follow must echo before executing.
  it('description keeps the exact-match fast path and adds the pending-list batch carve-out', () => {
    const { tools } = setup();
    const d = findTool(tools, 'popclaw_follow').description;
    expect(d).toContain('on an exact match, execute directly without confirmation');
    expect(d).toContain(
      'When confirming names from the injected pending-follow list, batches of 6+ or ambiguous picks require echoing the full list back for a Y/N first.',
    );
  });

  it('wires the runtime bag pendingFollows through: confirmed only when declareFollow succeeded', async () => {
    const markConfirmed = vi.fn();
    const declareFollow = vi.fn(async () => {});
    const runtime = vi.fn(async () => ({
      socialGraph: withOutcomes({ declareFollow }),
      pendingFollows: { markConfirmed },
    }));
    const { tools } = setup({ resolve: async () => [ELON] }, runtime as unknown as () => Promise<unknown>);
    const tool = findTool(tools, 'popclaw_follow');

    await tool.execute('cid', { name: '#4f68bd' });
    expect(markConfirmed).toHaveBeenCalledTimes(1);
    expect(markConfirmed).toHaveBeenCalledWith('id_elon');

    declareFollow.mockRejectedValueOnce(new Error('push refused'));
    await tool.execute('cid', { name: '#4f68bd' });
    expect(markConfirmed).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// popclaw_author_latest
// ---------------------------------------------------------------------------

const LONG_TEXT =
  '这是一条远超一百二十字截断长度的全文：'.repeat(8) + '——结尾完整无截断。';

describe('popclaw_author_latest', () => {
  // The world feed stamps each row with the name the author had when it was
  // indexed; for the owner that is often the registration-time auto name. The
  // owner's own snapshot is named by what they declared, as status does.
  it("names the owner's own snapshot by their declared name, not the feed's stale handle", async () => {
    const { tools } = setup(
      {
        sourcesItems: [{ authorPopclawId: 'id_me', actorNickname: 'ranger-3gkVcd', platform: 'popclaw' }],
        authorItems: [],
      },
      async () => ({ boot: { popclawId: 'id_me', nickname: 'CanaryMe-26e2' } }),
    );
    const r = await findTool(tools, 'popclaw_author_latest').execute('cid', { name: 'ranger-3gkVcd' });
    expect(r.text).toBe(renderCopy(ownerLang(), 'world.author.noRecentSnapshot', { nickname: 'CanaryMe-26e2' }));
  });

  it("keeps someone else's feed name (the owner's name only overrides the owner's own id)", async () => {
    const { tools } = setup(
      {
        sourcesItems: [{ authorPopclawId: 'id_peer', actorNickname: 'CanaryPeer-26e2', platform: 'popclaw' }],
        authorItems: [],
      },
      async () => ({ boot: { popclawId: 'id_me', nickname: 'CanaryMe-26e2' } }),
    );
    const r = await findTool(tools, 'popclaw_author_latest').execute('cid', { name: 'CanaryPeer-26e2' });
    expect(r.text).toBe(renderCopy(ownerLang(), 'world.author.noRecentSnapshot', { nickname: 'CanaryPeer-26e2' }));
  });

  it('unique hit → fetches author posts and outputs full text + link + badge', async () => {
    const { tools, fetchSnapshot } = setup({
      authorItems: [
        {
          authorPopclawId: 'id_elon',
          actorNickname: 'Elon Musk',
          platform: 'popclaw',
          textPreview: LONG_TEXT,
          platformPostId: 'abcdef1234' + '9'.repeat(54),
        },
      ],
    });
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'elon musk' });

    // second snapshot call is the author-filtered fetch
    expect(fetchSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ author: 'id_elon', limit: 1 }),
    );
    expect(r.text).toContain('Elon Musk');
    expect(r.text).toContain(LONG_TEXT); // full text, not truncated
    expect(r.text).toContain('http://localhost:3000/post/abcdef1234'); // event_id 前 10
    expect(r.text).toContain('📜'); // popclaw platform badge
  });

  it('matches name case/whitespace-insensitively (ELON via prefix)', async () => {
    const { tools, fetchSnapshot } = setup({
      authorItems: [
        {
          authorPopclawId: 'id_elon',
          actorNickname: 'Elon Musk',
          platform: 'x',
          textPreview: 'hi',
          platformPostId: '1234567890',
        },
      ],
    });
    const tool = findTool(tools, 'popclaw_author_latest');

    await tool.execute('cid', { name: 'ELON MUSK' });

    expect(fetchSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ author: 'id_elon' }),
    );
  });

  it('shows source-platform original link for mirror posts (originalUrl)', async () => {
    const { tools } = setup({
      authorItems: [
        {
          authorPopclawId: 'id_elon',
          actorNickname: 'Elon Musk',
          platform: 'x',
          textPreview: 'mars update',
          platformPostId: '1900000000000000001',
          originalUrl: 'https://x.com/elonmusk/status/1900000000000000001',
        },
      ],
    });
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'Elon Musk' });

    expect(r.text).toContain('https://x.com/elonmusk/status/1900000000000000001');
    // mirror post must NOT generate a /post/ link (external platformPostId ≠ event_id)
    expect(r.text).not.toContain('/post/');
  });

  it('mirror post with no originalUrl → shows fallback text, no /post/ link', async () => {
    const { tools } = setup({
      authorItems: [
        {
          authorPopclawId: 'id_elon',
          actorNickname: 'Elon Musk',
          platform: 'x',
          textPreview: 'no source url post',
          platformPostId: '1900000000000000002',
          originalUrl: null,
        },
      ],
    });
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'Elon Musk' });

    expect(r.text).toContain('（源链接缺失）');
    expect(r.text).not.toContain('/post/');
  });

  it('clamps count to 1..100 (default 1)', async () => {
    const { tools, fetchSnapshot } = setup({
      authorItems: [
        {
          authorPopclawId: 'id_elon',
          actorNickname: 'Elon Musk',
          platform: 'x',
          textPreview: 'a',
          platformPostId: '1',
        },
      ],
    });
    const tool = findTool(tools, 'popclaw_author_latest');

    await tool.execute('cid', { name: 'Elon Musk', count: 999 });
    expect(fetchSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100 }));

    await tool.execute('cid', { name: 'Elon Musk', count: 0 });
    expect(fetchSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1 }));

    await tool.execute('cid', { name: 'Elon Musk', count: 50 });
    expect(fetchSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it('multiple hits → disambiguation list with nickname + platforms, no author fetch', async () => {
    const { tools, fetchSnapshot } = setup({
      sourcesItems: [
        { authorPopclawId: 'id_elon', actorNickname: 'Elon Musk', platform: 'x' },
        { authorPopclawId: 'id_elonia', actorNickname: 'Elonia', platform: 'tiktok' },
      ],
      summary: makeSummary({ hot_posts: [], authors: {} }),
    });
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'elon' });

    expect(r.text).toContain('Elon Musk');
    expect(r.text).toContain('Elonia');
    expect(r.text).toContain('TikTok');
    expect(r.text).toContain('主人');
    // only the sources fetch happened — never an author-filtered fetch
    const authorCalls = fetchSnapshot.mock.calls.filter(
      (c) => (c[0] as { author?: string }).author !== undefined,
    );
    expect(authorCalls).toHaveLength(0);
  });

  it('zero hits → honest copy + suggests popclaw_world_summary', async () => {
    const { tools } = setup();
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: '不存在的人' });

    expect(r.text).toContain('还没收录');
    expect(r.text).toContain('popclaw_world_summary');
  });

  it('unique hit but no posts → honest empty copy', async () => {
    const { tools } = setup({ authorItems: [] });
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'Elon Musk' });

    expect(r.text).toContain('没有');
  });

  it('all sources unreachable → honest copy, not a fake zero-hit', async () => {
    const { tools } = setup({ summary: null, snapshotThrows: true });
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'Elon Musk' });

    expect(r.text).toContain('灯坊暂时联系不上');
    expect(r.text).not.toContain('还没收录');
  });
});

// ---------------------------------------------------------------------------
// popclaw_author_latest — 认识档 (count > 5, spec 2026-07-25)
// ---------------------------------------------------------------------------

/** 造一个带单条 TEXT block 的已编码 EventEnvelope（ADR-0029 item.envelope）。 */
function encodePostEnvelope(text: string): Uint8Array {
  return popclaw.event.EventEnvelope.encode({
    post: { blocks: [{ blockType: 0, content: text }] },
  }).finish();
}

const FULL_BODY = '观点段落。'.repeat(200); // 1000 字符，远超 500 截断线

describe('popclaw_author_latest 认识档 (count > 5)', () => {
  const historyItem = (over?: Partial<FakeSnapshotItem>): FakeSnapshotItem => ({
    authorPopclawId: 'id_elon',
    actorNickname: 'Elon Musk',
    platform: 'x',
    textPreview: FULL_BODY.slice(0, 280),
    platformPostId: '1900000000000000001',
    originalUrl: 'https://x.com/elonmusk/status/1900000000000000001',
    platformPostCreatedAt: 1750000000, // 2025-06-15 UTC
    envelope: encodePostEnvelope(FULL_BODY),
    ...over,
  });

  it('renders date + envelope full text truncated at 500 + source link', async () => {
    const { tools } = setup({ authorItems: [historyItem()] });
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'Elon Musk', count: 50 });

    expect(r.text).toContain('[2025-06-15]');
    expect(r.text).toContain(`${FULL_BODY.slice(0, 500)}…`); // envelope 全文截 500 + 省略号
    expect(r.text).not.toContain(FULL_BODY.slice(0, 501)); // 不超截断线
    expect(r.text).toContain('https://x.com/elonmusk/status/1900000000000000001');
    expect(r.text).not.toContain('/post/'); // 镜像帖禁止拼 /post/
  });

  it('falls back to textPreview when envelope is missing', async () => {
    const { tools } = setup({
      authorItems: [historyItem({ envelope: undefined, textPreview: 'preview only' })],
    });
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'Elon Musk', count: 50 });

    expect(r.text).toContain('preview only');
  });

  it('popclaw-native item gets /post/<short-id> link', async () => {
    const { tools } = setup({
      authorItems: [
        historyItem({
          platform: 'popclaw',
          platformPostId: 'abcdef1234' + '9'.repeat(54),
          originalUrl: null,
        }),
      ],
    });
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'Elon Musk', count: 50 });

    expect(r.text).toContain('http://localhost:3000/post/abcdef1234');
  });

  it('header reports shortfall honestly and footer asks for a summary', async () => {
    const { tools } = setup({ authorItems: [historyItem(), historyItem()] });
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'Elon Musk', count: 50 });

    expect(r.text).toContain('最近 2 条发声');
    expect(r.text).toContain('共请求 50 条'); // 收录 < 请求 → 如实报
    expect(r.text).toContain('总结'); // 尾部素材提示（agent turn 渲染）
    expect(r.text).toContain('灯坊收录的 2 条');
  });

  it('count ≤ 5 keeps the existing render (no date bracket, no footer)', async () => {
    const { tools } = setup({ authorItems: [historyItem()] });
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'Elon Musk', count: 3 });

    expect(r.text).not.toContain('[2025-06-15]');
    expect(r.text).not.toContain('素材完毕');
    expect(r.text).toContain('最新'); // 现有 header 风格
  });
});

// ---------------------------------------------------------------------------
// popclaw_show_feed filter_by_author upgrade
// ---------------------------------------------------------------------------

describe('popclaw_show_feed filter_by_author name resolution', () => {
  function makeFeedRuntime() {
    // vi.fn records call args regardless of the declared signature; the
    // toHaveBeenCalledWith assertions below read them from mock.calls.
    const feedFetch = vi.fn(async () => []);
    const runtime = vi.fn(async () => ({ worldFeedClient: { fetchSnapshot: feedFetch } }));
    return { feedFetch, runtime };
  }

  it('resolves a name to popclaw_id before filtering the feed', async () => {
    const { feedFetch, runtime } = makeFeedRuntime();
    const { tools } = setup(undefined, runtime as unknown as () => Promise<unknown>);
    const tool = findTool(tools, 'popclaw_show_feed');

    await tool.execute('cid', { filter_by_author: 'Elon Musk' });

    expect(feedFetch).toHaveBeenCalledWith(expect.objectContaining({ author: 'id_elon' }));
  });

  it('passes a raw popclaw_id through unchanged when no name matches', async () => {
    const { feedFetch, runtime } = makeFeedRuntime();
    const { tools } = setup(undefined, runtime as unknown as () => Promise<unknown>);
    const tool = findTool(tools, 'popclaw_show_feed');

    await tool.execute('cid', { filter_by_author: 'zz_raw_popclaw_id' });

    expect(feedFetch).toHaveBeenCalledWith(
      expect.objectContaining({ author: 'zz_raw_popclaw_id' }),
    );
  });

  it('ambiguous name → disambiguation text, feed not fetched', async () => {
    const { feedFetch, runtime } = makeFeedRuntime();
    const { tools } = setup(
      {
        sourcesItems: [
          { authorPopclawId: 'id_elon', actorNickname: 'Elon Musk', platform: 'x' },
          { authorPopclawId: 'id_elonia', actorNickname: 'Elonia', platform: 'tiktok' },
        ],
        summary: makeSummary({ hot_posts: [], authors: {} }),
      },
      runtime as unknown as () => Promise<unknown>,
    );
    const tool = findTool(tools, 'popclaw_show_feed');

    const r = await tool.execute('cid', { filter_by_author: 'elon' });

    expect(r.text).toContain('Elon Musk');
    expect(r.text).toContain('Elonia');
    expect(feedFetch).not.toHaveBeenCalled();
  });

  it('without getWorldDeps the author flag passes through (legacy behavior)', async () => {
    const { feedFetch, runtime } = makeFeedRuntime();
    const { api, tools } = buildFakeApi();
    registerPopclawTools({
      api,
      runtime: runtime as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    });
    const tool = findTool(tools, 'popclaw_show_feed');

    await tool.execute('cid', { filter_by_author: 'Elon Musk' });

    expect(feedFetch).toHaveBeenCalledWith(expect.objectContaining({ author: 'Elon Musk' }));
  });
});

// ---------------------------------------------------------------------------
// S3 pilot — en lane. Same fixtures as the zh-CN describes above, with
// `setOwnerLang('en', 'config')` for the duration of each test (restored
// afterward so later tests in this file keep the zh-CN default).
// ---------------------------------------------------------------------------

describe('popclaw_world_summary · en lane (S3 lexicon parity)', () => {
  afterEach(() => setOwnerLang('zh-CN', 'config'));

  it('renders stats line + notable + hot posts + mirror authors in English', async () => {
    setOwnerLang('en', 'config');
    const { tools } = setup();
    const tool = findTool(tools, 'popclaw_world_summary');

    const r = await tool.execute('cid', {});

    expect(r.text).toContain('World digest (last 24h: 42 posts / 7 people posting)');
    expect(r.text).toContain('most-replied-to');
    expect(r.text).toContain('1. [Elon Musk] 火星基地年底动工');
    expect(r.text).toContain('3replies');
    expect(r.text).toContain('MrBeast — active on TikTok/YT (cross-platform)');
  });

  it('honest zero-entry copy in English when no hot posts', async () => {
    setOwnerLang('en', 'config');
    const { tools } = setup({ summary: makeSummary({ hot_posts: [] }), sourcesItems: [] });
    const tool = findTool(tools, 'popclaw_world_summary');

    const r = await tool.execute('cid', {});

    expect(r.text).toContain("Nobody's replied to anything in this window yet");
  });

  it('honest copy in English when summary fetch fails', async () => {
    setOwnerLang('en', 'config');
    const { tools } = setup({ summary: null });
    const tool = findTool(tools, 'popclaw_world_summary');

    const r = await tool.execute('cid', {});

    expect(r.text).toContain('HOUSE_REMOTE_UNKNOWN');
    expect(r.text).not.toContain('unreachable');
  });
});

describe('popclaw_show_feed · en lane (S3 lexicon parity)', () => {
  afterEach(() => setOwnerLang('zh-CN', 'config'));

  it('ambiguous name → English disambiguation text, feed not fetched', async () => {
    setOwnerLang('en', 'config');
    const feedFetch = vi.fn(async () => []);
    const runtime = vi.fn(async () => ({ worldFeedClient: { fetchSnapshot: feedFetch } }));
    const { tools } = setup(
      {
        sourcesItems: [
          { authorPopclawId: 'id_elon', actorNickname: 'Elon Musk', platform: 'x' },
          { authorPopclawId: 'id_elonia', actorNickname: 'Elonia', platform: 'tiktok' },
        ],
        summary: makeSummary({ hot_posts: [], authors: {} }),
      },
      runtime as unknown as () => Promise<unknown>,
    );
    const tool = findTool(tools, 'popclaw_show_feed');

    const r = await tool.execute('cid', { filter_by_author: 'elon' });

    expect(r.text).toContain('Found several matches for "elon" — ask the owner to pick one:');
    expect(r.text).toContain('Elon Musk');
    expect(r.text).toContain('Elonia');
    expect(feedFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rollout slice 1 — en lane. popclaw_world_guide / popclaw_author_latest /
// popclaw_follow / popclaw_unfollow. Same fixtures as the zh-CN describes
// above, with `setOwnerLang('en', 'config')` for the duration of each test
// (restored afterward so later tests in this file keep the zh-CN default).
// ---------------------------------------------------------------------------

describe('popclaw_world_guide · en lane (rollout slice 1)', () => {
  afterEach(() => setOwnerLang('zh-CN', 'config'));

  it('renders frontmatter summary + body with an English scaffold (guide content is data, unchanged)', async () => {
    setOwnerLang('en', 'config');
    const { tools } = setup();
    const tool = findTool(tools, 'popclaw_world_guide');

    const r = await tool.execute('cid', {});

    expect(r.text).toContain('popclaw.me');
    expect(r.text).toContain('一座灯火江湖'); // guide.md fixture content — data, not code literal
    expect(r.text).toContain('Streams: world-feed / guide (2)');
    expect(r.text).toContain('欢迎来到江湖');
  });

  it('returns honest English copy when guide fetch fails (null)', async () => {
    setOwnerLang('en', 'config');
    const { tools } = setup({ guideText: null });
    const tool = findTool(tools, 'popclaw_world_guide');

    const r = await tool.execute('cid', {});

    expect(r.text).toContain('The world guide is unreachable right now');
    expect(r.text).toContain('Lore-house unreachable — try again shortly.');
  });

  it('renders a mounted third-party house guide with an English scaffold', async () => {
    setOwnerLang('en', 'config');
    const { tools } = setup({
      mountedGuides: [
        { slug: 'house-popclaw-world', houseName: 'popclaw.world', guide: '# 世界玩法\n捏公仔。' },
      ],
    });
    const r = await findTool(tools, 'popclaw_world_guide').execute('cid', {});

    expect(r.text).toContain('popclaw.world (house-popclaw-world) lore-house guide');
    expect(r.text).toContain("[The following is from that lore-house's own guide");
    expect(r.text).toContain('捏公仔。');
  });
});

describe('popclaw_author_latest · en lane (rollout slice 1)', () => {
  afterEach(() => setOwnerLang('zh-CN', 'config'));

  it('zero hits → English honest copy + suggests popclaw_world_summary', async () => {
    setOwnerLang('en', 'config');
    const { tools } = setup();
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'nobody-like-this' });

    expect(r.text).toContain('No posts from "nobody-like-this" in the world stream yet');
    expect(r.text).toContain('popclaw_world_summary');
  });

  it('unique hit but no posts → English honest empty copy', async () => {
    setOwnerLang('en', 'config');
    const { tools } = setup({ authorItems: [] });
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'Elon Musk' });

    expect(r.text).toContain("No posts in Elon Musk's recent snapshot.");
  });

  it('all sources unreachable → English lantern-down copy', async () => {
    setOwnerLang('en', 'config');
    const { tools } = setup({ summary: null, snapshotThrows: true });
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'Elon Musk' });

    expect(r.text).toContain('Lore-house unreachable — try again shortly.');
  });

  it('count ≤ 5 short render uses English header + source-link labels', async () => {
    setOwnerLang('en', 'config');
    const { tools } = setup({
      authorItems: [
        {
          authorPopclawId: 'id_elon',
          actorNickname: 'Elon Musk',
          platform: 'x',
          textPreview: 'no source url post',
          platformPostId: '1900000000000000002',
          originalUrl: null,
        },
      ],
    });
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'Elon Musk' });

    expect(r.text).toContain('latest 1 posts:');
    expect(r.text).toContain('(source link missing)');
  });

  it('count > 5 long render uses English header/shortfall/footer + source link', async () => {
    setOwnerLang('en', 'config');
    const item: FakeSnapshotItem = {
      authorPopclawId: 'id_elon',
      actorNickname: 'Elon Musk',
      platform: 'x',
      textPreview: 'hi',
      platformPostId: '1900000000000000001',
      originalUrl: 'https://x.com/elonmusk/status/1900000000000000001',
      platformPostCreatedAt: 1750000000,
    };
    const { tools } = setup({ authorItems: [item, item] });
    const tool = findTool(tools, 'popclaw_author_latest');

    const r = await tool.execute('cid', { name: 'Elon Musk', count: 50 });

    expect(r.text).toContain('the lore-house has the latest 2 posts');
    expect(r.text).toContain('(you asked for 50; this is all the lore-house has)');
    expect(r.text).toContain('End of material.');
    expect(r.text).toContain('Source: https://x.com/elonmusk/status/1900000000000000001');
  });
});

describe('popclaw_follow · en lane (rollout slice 1)', () => {
  afterEach(() => setOwnerLang('zh-CN', 'config'));

  const ELON_EN: ResolveCandidate = {
    popclawId: 'id_elon',
    nickname: 'Elon Musk',
    sigil: '4f68bd',
    profiles: [{ platform: 'x', handle: 'elonmusk', followerCount: 220_000_000 }],
  };

  it('empty name → English ask-who, no resolve', async () => {
    setOwnerLang('en', 'config');
    const resolve = vi.fn(async () => []);
    const runtime = vi.fn(async () => ({ socialGraph: withOutcomes({ declareFollow: vi.fn() }) }));
    const { tools } = setup({ resolve }, runtime as unknown as () => Promise<unknown>);

    const r = await findTool(tools, 'popclaw_follow').execute('cid', { name: '   ' });

    expect(r.text).toContain('Who do you want to follow?');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('precise key unique hit → English follow receipt', async () => {
    setOwnerLang('en', 'config');
    const declareFollow = vi.fn(async () => {});
    const runtime = vi.fn(async () => ({ socialGraph: withOutcomes({ declareFollow }) }));
    const { tools } = setup({ resolve: async () => [ELON_EN] }, runtime as unknown as () => Promise<unknown>);

    const r = await findTool(tools, 'popclaw_follow').execute('cid', { name: '#4f68bd' });

    expect(r.text).toBe(
      'Following Elon Musk#4f68bd. Their public posts now get priority in your recommendations and daily paper. They can see that you followed them.',
    );
  });

  it('fuzzy name → English candidate list', async () => {
    setOwnerLang('en', 'config');
    const elonia: ResolveCandidate = { popclawId: 'id_elonia', nickname: 'Elonia', sigil: 'ab12cd', profiles: [] };
    const runtime = vi.fn(async () => ({ socialGraph: withOutcomes({ declareFollow: vi.fn() }) }));
    const { tools } = setup({ resolve: async () => [ELON_EN, elonia] }, runtime as unknown as () => Promise<unknown>);

    const r = await findTool(tools, 'popclaw_follow').execute('cid', { name: 'elon' });

    expect(r.text).toContain('Found 2 close matches');
    expect(r.text).toContain('Elon Musk#4f68bd');
    expect(r.text).toContain('Elonia#ab12cd');
  });

  it('查无此人 → English honest copy, no fake follow', async () => {
    setOwnerLang('en', 'config');
    const runtime = vi.fn(async () => ({ socialGraph: withOutcomes({ declareFollow: vi.fn() }) }));
    const { tools } = setup({ resolve: async () => [] }, runtime as unknown as () => Promise<unknown>);

    const r = await findTool(tools, 'popclaw_follow').execute('cid', { name: '苍梧居士#abcdef' });

    expect(r.text).toContain('has no record of');
  });

  it('灯坊 unreachable → English lantern-down copy', async () => {
    setOwnerLang('en', 'config');
    const runtime = vi.fn(async () => ({ socialGraph: withOutcomes({ declareFollow: vi.fn() }) }));
    const { tools } = setup({ resolve: async () => null }, runtime as unknown as () => Promise<unknown>);

    const r = await findTool(tools, 'popclaw_follow').execute('cid', { name: '#4f68bd' });

    expect(r.text).toContain('Lore-house unreachable — try again shortly.');
  });
});

// A first-contact follow resolved through the house: the name is in the
// resolve candidate, and the bond row does not exist until the follow creates
// it. The passive write-back ran before the row existed and wrote nothing, and
// the follow-time lookup only runs for a nameless candidate — so the name the
// echo printed never reached the bond book, and every later surface (status,
// DM labels, the next follow's echo) rendered `#sigil` with no name.
describe('popclaw_follow · a first follow keeps the name', () => {
  afterEach(() => setOwnerLang('zh-CN', 'config'));

  const MIGRATIONS_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
  const A_ID = '13gLyDGH237UoVJKDxihmfKxDCUTjxrdrEKzzfRuhLei';
  const A: ResolveCandidate = { popclawId: A_ID, nickname: 'Reh8120A-062c', sigil: deriveSigil(A_ID), profiles: [] };

  function harness(opts: { followers?: string[] } = {}) {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    const bondsStore = new BondsStore(db, () => 1000);
    let following: Array<{ popclawId: string; since: number }> = [];
    const socialGraph = withOutcomes({
      declareFollow: vi.fn(async (id: string) => {
        following.push({ popclawId: id, since: 1 });
      }),
      revokeFollow: vi.fn(async (id: string) => {
        following = following.filter((f) => f.popclawId !== id);
      }),
      following: () => following,
    });
    const nameOf = makeNameChain({ bond: (id) => bondsStore.get(id) });
    const runtime = vi.fn(async () => ({
      socialGraph,
      bondsStore,
      nameOf,
      boot: { popclawId: 'OWNER_B' },
      knownFollowers: { allFollowerIds: () => opts.followers ?? [] },
    }));
    const resolve = vi.fn(async () => [A]);
    const { tools } = setup({ resolve }, runtime as unknown as () => Promise<unknown>);
    return { tools, bondsStore, nameOf, resolve };
  }

  it('writes the name the house resolved into the bond book', async () => {
    setOwnerLang('en', 'config');
    const h = harness();

    const r = await findTool(h.tools, 'popclaw_follow').execute('cid', { name: '#' + A.sigil });

    expect(r.text).toContain('Following Reh8120A-062c#' + A.sigil);
    expect(h.bondsStore.get(A_ID)?.nickname).toBe('Reh8120A-062c');
    expect(displayNamed(A_ID, h.nameOf)).toBe('Reh8120A-062c#' + A.sigil);
  });

  it('a refollow after unfollow still echoes the name', async () => {
    setOwnerLang('en', 'config');
    const h = harness();
    const follow = findTool(h.tools, 'popclaw_follow');

    await follow.execute('cid', { name: '#' + A.sigil });
    const off = await findTool(h.tools, 'popclaw_unfollow').execute('cid', { name: '#' + A.sigil });
    expect(off.text).toContain('Unfollow of Reh8120A-062c#' + A.sigil + ' sent.');
    const r = await follow.execute('cid', { name: '#' + A.sigil });

    expect(r.text).toContain('Following Reh8120A-062c#' + A.sigil);
  });

  // Following back someone whose follow arrived first (`followed_you`): they
  // are a local, nameless hit in known_followers, so the #468 lookup fetches
  // their house name — and the receipt says it too, not a bare `#sigil`.
  it('following back a new follower names them in the receipt and the bond book', async () => {
    setOwnerLang('en', 'config');
    const h = harness({ followers: [A_ID] });

    const r = await findTool(h.tools, 'popclaw_follow').execute('cid', { name: 'Reh8120A-062c#' + A.sigil });

    expect(r.text).toContain('Following Reh8120A-062c#' + A.sigil);
    expect(h.bondsStore.get(A_ID)?.nickname).toBe('Reh8120A-062c');
    expect(displayNamed(A_ID, h.nameOf)).toBe('Reh8120A-062c#' + A.sigil);
  });

  // Resolution also matches the owner's private alias (remark_name), and a
  // local hit reports that alias as the candidate's nickname. It is not the
  // name they go by, so it must never land in the house-name column — the
  // house's own name is fetched instead (#468).
  it("following by the owner's alias writes the house name, never the alias", async () => {
    setOwnerLang('en', 'config');
    const h = harness();
    h.bondsStore.recordInteraction(A_ID);
    h.bondsStore.setKnowledge(A_ID, { remarkName: 'Bob' });

    const r = await findTool(h.tools, 'popclaw_follow').execute('cid', { name: 'Bob#' + A.sigil });

    expect(r.text).toMatch(/^Following /);
    expect(h.bondsStore.get(A_ID)?.nickname).toBe('Reh8120A-062c');
    expect(h.bondsStore.get(A_ID)?.remarkName).toBe('Bob');
  });
});

// N2 regression: the popclaw_unfollow tool's ambiguous-name candidate list
// must read with the unfollow verb, never follow's — mirrors popclaw_follow's
// "fuzzy name → candidate list" tests above (zh at ~line 534, en at ~line 1228).
describe('popclaw_unfollow · candidate-list copy (N2 regression)', () => {
  afterEach(() => setOwnerLang('zh-CN', 'config'));

  const ELON: ResolveCandidate = { popclawId: 'id_elon', nickname: 'Elon Musk', sigil: '4f68bd', profiles: [] };
  const ELONIA: ResolveCandidate = { popclawId: 'id_elonia', nickname: 'Elonia', sigil: 'ab12cd', profiles: [] };

  it('zh: fuzzy name → candidate list reads 取消关注, never 关注', async () => {
    const revokeFollow = vi.fn();
    const runtime = vi.fn(async () => ({ socialGraph: withOutcomes({ revokeFollow, following: () => [] }) }));
    const { tools } = setup({ resolve: async () => [ELON, ELONIA] }, runtime as unknown as () => Promise<unknown>);

    const r = await findTool(tools, 'popclaw_unfollow').execute('cid', { name: 'elon' });

    expect(r.text).toContain('挑一个，用「名号#印信」取消关注');
    expect(r.text).toContain('如 取消关注 Elon Musk#4f68bd');
    expect(r.text).not.toContain('用「名号#印信」关注');
    expect(r.text).not.toContain('如 关注 Elon Musk#4f68bd');
    expect(revokeFollow).not.toHaveBeenCalled();
  });

  it('en: fuzzy name → candidate list reads unfollow, never follow', async () => {
    setOwnerLang('en', 'config');
    const revokeFollow = vi.fn();
    const runtime = vi.fn(async () => ({ socialGraph: withOutcomes({ revokeFollow, following: () => [] }) }));
    const { tools } = setup({ resolve: async () => [ELON, ELONIA] }, runtime as unknown as () => Promise<unknown>);

    const r = await findTool(tools, 'popclaw_unfollow').execute('cid', { name: 'elon' });

    expect(r.text).toContain('Found 2 close matches — pick one, unfollow with "name#sigil"');
    expect(r.text).toContain('(e.g. unfollow Elon Musk#4f68bd)');
    expect(r.text).not.toContain('pick one, follow with "name#sigil"');
    expect(r.text).not.toContain('(e.g. follow Elon Musk#4f68bd)');
    expect(revokeFollow).not.toHaveBeenCalled();
  });
});

describe('popclaw_unfollow · en lane (rollout slice 1)', () => {
  afterEach(() => setOwnerLang('zh-CN', 'config'));

  it('empty name → English ask-who', async () => {
    setOwnerLang('en', 'config');
    const runtime = vi.fn(async () => ({ socialGraph: withOutcomes({ revokeFollow: vi.fn(), following: () => [] }) }));
    const { tools } = setup({}, runtime as unknown as () => Promise<unknown>);

    const r = await findTool(tools, 'popclaw_unfollow').execute('cid', { name: '' });

    expect(r.text).toContain('Who do you want to unfollow?');
  });

  it('precise key unique hit → English unfollow receipt', async () => {
    setOwnerLang('en', 'config');
    const elon: ResolveCandidate = {
      popclawId: 'id_elon',
      nickname: 'Elon Musk',
      sigil: '4f68bd',
      profiles: [],
    };
    const revokeFollow = vi.fn(async () => {});
    const runtime = vi.fn(async () => ({
      socialGraph: withOutcomes({ revokeFollow, following: () => [{ popclawId: 'id_elon' }] }),
    }));
    const { tools } = setup({ resolve: async () => [elon] }, runtime as unknown as () => Promise<unknown>);

    const r = await findTool(tools, 'popclaw_unfollow').execute('cid', { name: '#4f68bd' });

    expect(r.text).toBe('Unfollow of Elon Musk#4f68bd sent. Nobody has to approve it.');
  });

  // G1-copy caller carry-over: this tool re-renders relation.unfollowReceived
  // itself (with the resolved name#sigil), reading reply.house from the
  // command's own receipt. If a caller ever dropped reply.house, only
  // mcp-follow-doorbell would have noticed (it names a real house) — this
  // pins it directly.
  it('precise key unique hit, house known → receipt names it (equal to the command\'s own text apart from who)', async () => {
    setOwnerLang('en', 'config');
    const elon: ResolveCandidate = {
      popclawId: 'id_elon',
      nickname: 'Elon Musk',
      sigil: '4f68bd',
      profiles: [],
    };
    const revokeFollow = vi.fn(async () => 'north-house');
    // No cached handshake name for this slug → the receipt's house resolves
    // through the origin-host fallback; `north-house` doubles as both the
    // slug and (via this URL) the origin host, so the pinned wording below
    // is unchanged.
    const runtime = vi.fn(async () => ({
      socialGraph: withOutcomes({ revokeFollow, following: () => [{ popclawId: 'id_elon' }] }),
      paths: { houseHandshakeFile: () => '/nonexistent/handshake.json' },
      boot: { loreHouseUrls: ['https://north-house'] },
    }));
    const { tools } = setup({ resolve: async () => [elon] }, runtime as unknown as () => Promise<unknown>);

    const r = await findTool(tools, 'popclaw_unfollow').execute('cid', { name: '#4f68bd' });

    expect(r.text).toBe(
      renderCopy('en', 'relation.unfollowReceived', { who: 'Elon Musk#4f68bd', house: 'north-house' }),
    );
    // Same key, same house, only `who` differs: the id runPopclawUnfollowCommand
    // used vs. the resolved name#sigil this tool substitutes.
    expect(r.text.replace('Elon Musk#4f68bd', 'id_elon')).toBe(
      renderCopy('en', 'relation.unfollowReceived', { who: 'id_elon', house: 'north-house' }),
    );
  });

  it('查无此人 → English not-found copy', async () => {
    setOwnerLang('en', 'config');
    const runtime = vi.fn(async () => ({ socialGraph: withOutcomes({ revokeFollow: vi.fn(), following: () => [] }) }));
    const { tools } = setup({ resolve: async () => [] }, runtime as unknown as () => Promise<unknown>);

    const r = await findTool(tools, 'popclaw_unfollow').execute('cid', { name: '苍梧居士#abcdef' });

    expect(r.text).toContain("Can't find");
  });
});

// ---------------------------------------------------------------------------
// TypeBox schema validation
// ---------------------------------------------------------------------------

describe('world tool schemas', () => {
  it('WorldGuideSchema accepts {}', () => {
    expect(Value.Check(WorldGuideSchema, {})).toBe(true);
  });

  it('WorldSummaryToolSchema accepts {} and {window_hours: 6}, rejects string', () => {
    expect(Value.Check(WorldSummaryToolSchema, {})).toBe(true);
    expect(Value.Check(WorldSummaryToolSchema, { window_hours: 6 })).toBe(true);
    expect(Value.Check(WorldSummaryToolSchema, { window_hours: 'six' })).toBe(false);
  });

  it('AuthorLatestSchema requires name, count must be a number', () => {
    expect(Value.Check(AuthorLatestSchema, { name: 'Elon Musk' })).toBe(true);
    expect(Value.Check(AuthorLatestSchema, { name: 'Elon Musk', count: 3 })).toBe(true);
    expect(Value.Check(AuthorLatestSchema, {})).toBe(false);
    expect(Value.Check(AuthorLatestSchema, { name: 'x', count: '3' })).toBe(false);
  });

  it('PopclawFollowSchema requires name (string)', () => {
    expect(Value.Check(PopclawFollowSchema, { name: 'paulg' })).toBe(true);
    expect(Value.Check(PopclawFollowSchema, {})).toBe(false);
    expect(Value.Check(PopclawFollowSchema, { name: 42 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #588 — an empty world is a house outage until proven otherwise
// ---------------------------------------------------------------------------

describe('popclaw_world_summary — an empty world says when each house last spoke', () => {
  const catalogRuntime = (houses: Array<{ slug: string; lastFrameAt: number | null }>) =>
    async () => ({ worldFeedCache: { houseSilence: () => houses } });

  it('appends one line per mounted house when the window is empty', async () => {
    const { tools } = setup(
      { summary: makeSummary({ total_posts: 0, distinct_authors: 0, hot_posts: [] }), sourcesItems: [] },
      catalogRuntime([
        { slug: 'popclaw-me', lastFrameAt: 1_700_000_000 },
        { slug: 'house-popclaw-world', lastFrameAt: null },
      ]),
    );
    const r = await findTool(tools, 'popclaw_world_summary').execute('cid', {});
    expect(r.text).toContain('popclaw-me');
    expect(r.text).toContain('house-popclaw-world');
  });

  it('says nothing about houses when the world actually has posts', async () => {
    const { tools } = setup({}, catalogRuntime([{ slug: 'popclaw-me', lastFrameAt: null }]));
    const r = await findTool(tools, 'popclaw_world_summary').execute('cid', {});
    expect(r.text).not.toContain('popclaw-me');
  });

  it('a runtime with no catalog degrades to saying nothing, never to failing', async () => {
    const { tools } = setup(
      { summary: makeSummary({ total_posts: 0, distinct_authors: 0, hot_posts: [] }), sourcesItems: [] },
      async () => ({}),
    );
    const r = await findTool(tools, 'popclaw_world_summary').execute('cid', {});
    expect(r.text).toContain('近 24h：0 帖');
  });
});

describe('popclaw_show_feed — an empty feed says when each house last spoke', () => {
  it('appends the outage line, naming the house and its last frame', async () => {
    const runtime = vi.fn(async () => ({
      worldFeedClient: { fetchSnapshot: async () => [] },
      worldFeedCache: {
        houseSilence: () => [
          { slug: 'popclaw-me', lastFrameAt: 1_700_000_000 },
          { slug: 'house-popclaw-world', lastFrameAt: null },
        ],
      },
    }));
    const { tools } = setup(undefined, runtime as unknown as () => Promise<unknown>);
    const r = await findTool(tools, 'popclaw_show_feed').execute('cid', {});
    expect(r.text).toContain('popclaw-me');
    expect(r.text).toContain('house-popclaw-world');
  });

  it('stays quiet when the feed has something to show', async () => {
    const runtime = vi.fn(async () => ({
      worldFeedClient: {
        fetchSnapshot: async () => [
          {
            platform: 'x',
            platformPostId: 'p1',
            platformPostCreatedAt: 1_700_000_000,
            authorPopclawId: 'id_elon',
            handle: 'elonmusk',
            originalUrl: 'https://x.com/elonmusk/status/p1',
            textPreview: 'hello',
          } as popclaw.event.IWorldFeedItem,
        ],
      },
      worldFeedCache: { houseSilence: () => [{ slug: 'popclaw-me', lastFrameAt: null }] },
    }));
    const { tools } = setup(undefined, runtime as unknown as () => Promise<unknown>);
    const r = await findTool(tools, 'popclaw_show_feed').execute('cid', {});
    expect(r.text).not.toContain('popclaw-me');
  });
});

// Complete responses through the registered tool, including its side effects.

const HISTORY_NATIVE_ID = 'abcd123456' + 'a'.repeat(54);
const HISTORY_MIRROR_ID = 'fedc654321' + 'b'.repeat(54);
const HISTORY_INSTANT = Date.parse('2025-01-01T23:30:00Z') / 1000;
const HISTORY_MIXED: FakeSnapshotItem[] = [
  { platform: 'popclaw', platformPostId: HISTORY_NATIVE_ID, textPreview: ' native preview ', envelope: encodePostEnvelope(' full native body '), platformPostCreatedAt: HISTORY_INSTANT },
  { platform: 'x', platformPostId: HISTORY_MIRROR_ID, originalUrl: 'https://x.com/test/status/1', textPreview: ' mirror preview ', envelope: encodePostEnvelope(' full mirror body '), platformPostCreatedAt: HISTORY_INSTANT },
  { platform: 'youtube', platformPostId: 'missing-source', originalUrl: null, textPreview: ' missing link preview ', platformPostCreatedAt: 0 },
];
const HISTORY_SOURCES: FakeSnapshotItem[] = [
  { authorPopclawId: 'id_peer', actorNickname: 'Peer', platform: 'popclaw' },
  { authorPopclawId: 'id_peer', actorNickname: 'Peer', platform: 'x' },
];

// EXPECTED_HISTORY is literal output captured before extracting the renderer.
const EXPECTED_HISTORY = {
  "short-zh-CN": "[Alias]（popclaw/X）最新 3 条发声：\n\n1. 📜 popclaw\nnative preview\n链接：https://history.example/post/abcd123456\n\n2. 🐦 X\nmirror preview\n源平台原文：https://x.com/test/status/1\n\n3. ▶️ YT\nmissing link preview\n（源链接缺失）",
  "long-zh-CN": "[Alias]（popclaw/X）灯坊收录的最近 3 条发声（共请求 6 条，灯坊只收录了这些）：\n\n[2025-01-02] 📜 popclaw\nfull native body\n链接：https://history.example/post/abcd123456\n\n[2025-01-02] 🐦 X\nfull mirror body\n源平台原文：https://x.com/test/status/1\n\n[日期未知] ▶️ YT\nmissing link preview\n（源链接缺失）\n\n（素材完毕。请据此在本轮给主人一份对这个人的总结：主要话题、立场与口吻、时间线上的变化；并如实注明总结基于灯坊收录的 3 条帖子，不代表其全部历史。主人若决定关注，调 popclaw_follow。）",
  "short-en": "[Alias]（popclaw/X） latest 3 posts:\n\n1. 📜 popclaw\nnative preview\nLink: https://history.example/post/abcd123456\n\n2. 🐦 X\nmirror preview\nSource: https://x.com/test/status/1\n\n3. ▶️ YT\nmissing link preview\n(source link missing)",
  "long-en": "[Alias]（popclaw/X） the lore-house has the latest 3 posts (you asked for 6; this is all the lore-house has):\n\n[2025-01-02] 📜 popclaw\nfull native body\nLink: https://history.example/post/abcd123456\n\n[2025-01-02] 🐦 X\nfull mirror body\nSource: https://x.com/test/status/1\n\n[date unknown] ▶️ YT\nmissing link preview\n(source link missing)\n\n(End of material. This turn, sum this person up for the owner: what they write about, where they stand, how they sound, what changed over time. Say plainly that it rests on the 3 posts the lore-house has, not their whole history. If the owner wants to follow them, call popclaw_follow.)"
} as const;

describe('popclaw_author_latest complete response contract', () => {
  afterEach(() => {
    setOwnerLang('zh-CN', 'config');
    setOwnerTz(undefined);
    _observedPostIdsForTest.clear();
  });

  for (const lang of ['zh-CN', 'en'] as const) {
    for (const [mode, count] of [['short', 5], ['long', 6]] as const) {
      it(`${mode} ${lang}: native, mirror and missing source keep complete copy`, async () => {
        setOwnerLang(lang, 'config');
        setOwnerTz('Asia/Shanghai');
        _observedPostIdsForTest.clear();
        const record = vi.fn();
        const { tools, fetchSnapshot } = setup({
          summary: makeSummary({ hot_posts: [], authors: {} }),
          sourcesItems: HISTORY_SOURCES,
          authorItems: HISTORY_MIXED,
          webBaseUrl: 'https://history.example',
        }, async () => ({ nameOf: () => 'Alias', socialLog: { record } }));

        const response = await findTool(tools, 'popclaw_author_latest').execute('cid', { name: 'Peer', count });

        expect(response).toEqual({ type: 'text', text: EXPECTED_HISTORY[`${mode}-${lang}`] });
        expect(fetchSnapshot).toHaveBeenLastCalledWith({ author: 'id_peer', limit: count });
        expect(record).toHaveBeenCalledOnce();
        expect(record).toHaveBeenCalledWith({ kind: 'person_asked', actor: { id: 'id_peer', name: 'Alias' } });
        expect(record.mock.invocationCallOrder[0]).toBeLessThan(fetchSnapshot.mock.invocationCallOrder[1]!);
        expect(resolvePostRef('abcd123456', {}, 'en')).toEqual({ ok: true, eventId: HISTORY_NATIVE_ID });
        expect(resolvePostRef('fedc654321', {}, 'en').ok).toBe(false);
      });
    }
  }

  it('captures language before fetch but reads owner timezone when rendering', async () => {
    setOwnerLang('en', 'config');
    setOwnerTz('Asia/Shanghai');
    const { tools, fetchSnapshot } = setup({
      summary: makeSummary({ hot_posts: [], authors: {} }), sourcesItems: HISTORY_SOURCES,
      webBaseUrl: 'https://history.example',
    }, async () => ({ nameOf: () => 'Alias' }));
    fetchSnapshot.mockImplementation(async (q) => {
      if (!q.author) return HISTORY_SOURCES;
      setOwnerLang('zh-CN', 'config');
      setOwnerTz('America/Los_Angeles');
      return HISTORY_MIXED;
    });

    const response = await findTool(tools, 'popclaw_author_latest').execute('cid', { name: 'Peer', count: 6 });

    expect(response).toEqual({ type: 'text', text: EXPECTED_HISTORY['long-en'].replaceAll('2025-01-02', '2025-01-01') });
  });

  it('records the declared owner name after alias resolution and before a failed fetch', async () => {
    setOwnerLang('en', 'config');
    _observedPostIdsForTest.clear();
    const trace: unknown[] = [];
    const { tools, fetchSnapshot } = setup({
      summary: makeSummary({ hot_posts: [], authors: {} }), sourcesItems: HISTORY_SOURCES,
    }, async () => ({
      nameOf: () => 'Alias', boot: { popclawId: 'id_peer', nickname: 'Declared owner' },
      socialLog: { record: (entry: unknown) => { trace.push(entry); } },
    }));
    fetchSnapshot.mockImplementation(async (q) => {
      if (!q.author) return HISTORY_SOURCES;
      trace.push(q);
      throw new Error('author offline');
    });

    const response = await findTool(tools, 'popclaw_author_latest').execute('cid', { name: 'Peer', count: 6 });

    expect(response).toEqual({ type: 'text', text: 'Lore-house unreachable — try again shortly.' });
    expect(trace).toEqual([
      { kind: 'person_asked', actor: { id: 'id_peer', name: 'Declared owner' } },
      { author: 'id_peer', limit: 6 },
    ]);
    expect(resolvePostRef('abcd123456', {}, 'en').ok).toBe(false);
  });

  it('remembers native ids before a long-render decode error; short mode uses the preview', async () => {
    setOwnerLang('en', 'config');
    _observedPostIdsForTest.clear();
    const record = vi.fn();
    const { tools } = setup({
      summary: makeSummary({ hot_posts: [], authors: {} }), sourcesItems: HISTORY_SOURCES,
      authorItems: HISTORY_MIXED.map((it, i) => i === 0 ? { ...it, envelope: new Uint8Array([128]) } : it),
      webBaseUrl: 'https://history.example',
    }, async () => ({ nameOf: () => 'Alias', socialLog: { record } }));
    const tool = findTool(tools, 'popclaw_author_latest');

    await expect(tool.execute('cid', { name: 'Peer', count: 6 })).rejects.toThrow('WIRE_VARINT');
    expect(record).toHaveBeenCalledOnce();
    expect(resolvePostRef('abcd123456', {}, 'en')).toEqual({ ok: true, eventId: HISTORY_NATIVE_ID });
    expect(await tool.execute('cid', { name: 'Peer', count: 5 })).toEqual({ type: 'text', text: EXPECTED_HISTORY['short-en'] });
  });
});

describe('PC008 summary classification',()=>{
  it.each(['HOUSE_DISABLED','HOUSE_CONNECTING','HOUSE_LIFECYCLE_UNSUPPORTED','HOUSE_OWNER_INACTIVE','HOUSE_STORAGE_UNAVAILABLE','HOUSE_TRUST_REVOKED','HOUSE_REMOTE_NETWORK','HOUSE_REMOTE_HTTP','HOUSE_REMOTE_PARSE'] as const)('renders %s without converting local rejection to network outage',async code=>{
    for(const lang of ['en','zh-CN'] as const) {
      setOwnerLang(lang,'config');
      const {tools}=setup({summaryFailure:{code,origin:'https://house.fixture.invalid',status:503}});
      expect((await findTool(tools,'popclaw_world_summary').execute('fixture',{})).text).toContain(code);
    }
    setOwnerLang('zh-CN','config');
  });
});

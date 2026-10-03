/**
 * 唯一名字链的**表面**回归：备注名一旦有，主人看到的每一处称呼都得跟着改。
 * 每个 it = 一个表面（世界速览 / 报纸 / 认人回执 / 通知 / 标记 / 信箱）。
 */
import { describe, expect, it } from 'vitest';
import { makeNameChain } from '../../../src/identity/person-name.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { aggregateNotableAuthors } from '../../../src/world/notable-authors.js';
import { WorldSummaryClient } from '../../../src/world/world-summary-client.js';
import { gatherNewspaperMaterials } from '../../../src/newspaper/gather-materials.js';
import { resolvePerson, formatPerson, unresolvedText } from '../../../src/identity/person-resolver.js';
import { renderNotifications } from '../../../src/notifier/mcp-notice.js';
import { runPopclawInboxCommand } from '../../../src/commands/popclaw-inbox.js';
import type { WorldSummaryResponse } from '../../../src/world/world-summary-client.js';
import type { NotificationItem } from '../../../src/notifier/types.js';
import type { InboxStore } from '../../../src/messaging/inbox-store.js';

const ID = 'BFhFRcpqjFT8cQKmyLprxrgTAG14ttEkxCqCYcbBZWzB';
const SIGIL = deriveSigil(ID);
/** 主人给他起了备注名「老王」，他自报的名号是「Blackfeather」。 */
const nameOf = makeNameChain({ bond: () => ({ nickname: 'Blackfeather', remarkName: '老王' }) });

function summaryWith(nickname: string): WorldSummaryResponse {
  return {
    window_hours: 24,
    total_posts: 1,
    distinct_authors: 1,
    authors: { [ID]: { nickname } },
    hot_posts: [
      { event_id: 'e1', author: ID, platform: 'x', body_preview: 'hello', reply_count: 1 },
    ],
  } as unknown as WorldSummaryResponse;
}

describe('name chain surfaces — 备注名盖过一切自报名', () => {
  it('世界速览的作者名（WorldSummaryClient.nicknameFor）', () => {
    const s = summaryWith('Blackfeather');
    expect(WorldSummaryClient.nicknameFor(s, ID)).toBe('Blackfeather');
    expect(WorldSummaryClient.nicknameFor(s, ID, nameOf)).toBe('老王');
  });

  it('世界速览「活跃的镜像号」聚合（aggregateNotableAuthors）', () => {
    const inputs = [{ popclawId: ID, platform: 'x', nickname: 'Blackfeather' }];
    expect(aggregateNotableAuthors(inputs)[0]!.nickname).toBe('Blackfeather');
    expect(aggregateNotableAuthors(inputs, undefined, nameOf)[0]!.nickname).toBe('老王');
  });

  it('速览没有任何名字时仍只报印信（不给裸 id 前缀）', () => {
    const empty = makeNameChain({});
    expect(aggregateNotableAuthors([{ popclawId: ID, platform: 'x' }], undefined, empty)[0]!
      .nickname).toBe(`#${SIGIL}`);
  });

  it('报纸的作者名 + 私信行（gatherNewspaperMaterials）', () => {
    const item = {
      eventId: 'e1',
      platform: 'x',
      platformPostId: 'p1',
      authorPopclawId: ID,
      handle: 'blackfeather_ai',
      actorNickname: 'Blackfeather',
      body: 'hello world',
      platformPostCreatedAt: 500,
      media: [],
      markCount: 0,
      replyCount: 0,
      originalUrl: 'https://x.com/blackfeather_ai/1',
      houseSlug: 'me',
    };
    const deps = {
      cache: { recentForReading: () => [item] as never },
      inbox: {
        recent: () => [{ ts: 600, fromPopclawId: ID, toPopclawId: 'me', body: 'yo' }] as never,
      },
      readContentRules: () => '',
      readLayoutRules: () => '',
      ownerNickname: 'me',
      webBaseUrl: 'https://popclaw.me',
      now: () => 1000,
      mintToken: () => 'tok',
      isFollowing: () => false,
    };
    const before = gatherNewspaperMaterials(deps, { hours: 24 });
    const after = gatherNewspaperMaterials({ ...deps, nameOf }, { hours: 24 });
    // 名字链在候选页上就要生效——挑人正是靠它认人（两步协议：候选页 → 挑 → 素材页）。
    expect(before.kind).toBe('candidates');
    expect(after.kind).toBe('candidates');
    if (before.kind !== 'candidates' || after.kind !== 'candidates') return;
    expect(after.payload).toContain('老王');
    expect(after.payload).toContain(`老王#${SIGIL}`); // 私信行 fromShort
    expect(before.payload).not.toContain('老王');
  });

  it('认人回执（resolvePerson → formatPerson）', async () => {
    const sources = {
      known: () => [{ popclawId: ID, nickname: 'Blackfeather' }],
      seen: () => [],
      house: async () => null,
      nameOf,
    };
    const r = await resolvePerson('Blackfeather', sources);
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') return;
    expect(r.nickname).toBe('老王');
    expect(formatPerson(r)).toBe(`老王#${SIGIL} (${ID})`);
  });

  it('认人的候选单也走链（unresolvedText 复述给主人）', async () => {
    const other = 'BFhFRcpqjFT8cQKmyLprxrgTAG14ttEkxCqCYcbBZWzC';
    const sources = {
      known: () => [
        { popclawId: ID, nickname: '白鹭' },
        { popclawId: other, nickname: '白鹭' },
      ],
      seen: () => [],
      house: async () => null,
      nameOf,
    };
    const r = await resolvePerson('白鹭', sources);
    expect(r.kind).toBe('ambiguous');
    expect(unresolvedText('白鹭', r)).toContain('老王');
  });

  it('MCP 通知：payload 里烘的自报名号被现在的备注名盖过', () => {
    const items: NotificationItem[] = [
      {
        id: 1,
        level: 'L1',
        kind: 'dm',
        payload: { fromPopclawId: ID, fromName: 'Blackfeather', body: 'hi' },
      } as unknown as NotificationItem,
    ];
    expect(renderNotifications(items)).toContain('Blackfeather');
    expect(renderNotifications(items, nameOf)).toContain(`老王#${SIGIL}`);
  });

  it('MCP 通知：新粉那条 payload 根本没名字，靠链才认得出人', () => {
    const items: NotificationItem[] = [
      { id: 2, level: 'L2', kind: 'followed_you', payload: { followerPopclawId: ID } },
    ] as unknown as NotificationItem[];
    expect(renderNotifications(items)).toContain(`#${SIGIL}`);
    expect(renderNotifications(items, nameOf)).toContain(`老王#${SIGIL}`);
  });

  it('信箱列表（/popclaw inbox）', async () => {
    const store = {
      recent: () => [{ ts: 100, fromPopclawId: ID, toPopclawId: 'me', body: 'hi' }],
    } as unknown as InboxStore;
    const out = await runPopclawInboxCommand({ positional: [], flags: {} }, { store, nameOf });
    expect(out.text).toContain(`老王#${SIGIL}`);
  });
});

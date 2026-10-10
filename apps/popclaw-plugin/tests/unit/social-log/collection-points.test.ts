/**
 * Social-log collection points: attach every kind after an action actually succeeds, never to intent.
 * Collect inside command functions, not both index.ts slash routing and register-tools execute: both
 * entries converge on one command. Recording at the convergence guarantees one action = one record;
 * entry-layer recording duplicates it.
 */
import { withOutcomes } from '../../helpers/with-outcomes.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import type { MasterKey } from '../../../src/identity/keystore.js';
import type { SocialLogEntry, SocialLogRecorder } from '../../../src/social-log/social-log.js';
import { runPopclawPostCommand } from '../../../src/commands/popclaw-post.js';
import { runPopclawReplyCommand } from '../../../src/commands/popclaw-reply.js';
import { runPopclawMessageCommand } from '../../../src/commands/popclaw-message.js';
import { runPopclawMarkCommand } from '../../../src/commands/popclaw-mark.js';
import { runFollowCommand } from '../../../src/commands/follow.js';
import { runPopclawUnfollowCommand } from '../../../src/commands/popclaw-unfollow.js';
import { ReplyPingsStore, routeReplyPing } from '../../../src/pings/reply-pings.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';

class FakeLog implements SocialLogRecorder {
  entries: SocialLogEntry[] = [];
  record(e: SocialLogEntry): void {
    this.entries.push(e);
  }
}

/**
 * A recorder that throws, proving log failures never affect the main flow.
 */
const exploding: SocialLogRecorder = {
  record() {
    throw new Error('disk on fire');
  },
};

let log: FakeLog;
beforeEach(() => {
  log = new FakeLog();
});

// ---------------------------------------------------------------------------
// post_sent / reply_sent — /popclaw post
// ---------------------------------------------------------------------------

function makeSigner(): MasterKeySigner {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i;
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const key: MasterKey = {
    seed,
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    popclawId: bs58.encode(kp.publicKey),
  };
  return new MasterKeySigner(key);
}

const okEgress = { push: async () => ({ status: 200 }) };
const postDeps = (socialLog?: SocialLogRecorder, egress: unknown = okEgress) =>
  ({
    signer: makeSigner(),
    egress,
    nickname: '我',
    cache: {
      findFullEventId: () => ({ full: null, ambiguous: [] }),
      findByEventIdPrefix: () => ({ item: null, ambiguous: [] }),
    },
    webBaseUrl: 'https://popclaw.me',
    socialLog,
  }) as unknown as Parameters<typeof runPopclawPostCommand>[1];

describe('post_sent / reply_sent — runPopclawPostCommand', () => {
  it('推送成功才记；根帖记 post_sent 并带 event_id + 完整原文', async () => {
    const r = await runPopclawPostCommand({ positional: ['你好', '江湖'], flags: {} }, postDeps(log));
    expect(r.text).toContain('📜 posted');
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]!.kind).toBe('post_sent');
    expect(log.entries[0]!.text).toBe('你好 江湖');
    expect(log.entries[0]!.event_id).toBeTruthy();
    expect(log.entries[0]!.url).toContain('https://popclaw.me/post/');
  });

  it('--reply 记 reply_sent，并带上被回那条的 event_id', async () => {
    const target = 'a'.repeat(64);
    const r = await runPopclawPostCommand(
      { positional: ['接话'], flags: { reply: target } },
      postDeps(log),
    );
    expect(r.text).toContain('↩ replied');
    expect(log.entries[0]!.kind).toBe('reply_sent');
    expect(log.entries[0]!.in_reply_to?.event_id).toBe(target);
  });

  it('推送失败（5xx / 非 2xx）一条都不记 —— 没发出去就不是动作', async () => {
    const deps = postDeps(log, { push: async () => ({ status: 500 }) });
    await runPopclawPostCommand({ positional: ['失败'], flags: {} }, deps);
    expect(log.entries).toEqual([]);
  });

  it('签名/推送抛错不记', async () => {
    const deps = postDeps(log, {
      push: async () => {
        throw new Error('网断了');
      },
    });
    await runPopclawPostCommand({ positional: ['失败'], flags: {} }, deps);
    expect(log.entries).toEqual([]);
  });

  it('空 body 走 usage，不记（草稿/误触不是动作）', async () => {
    await runPopclawPostCommand({ positional: [], flags: {} }, postDeps(log));
    expect(log.entries).toEqual([]);
  });

  it('日志抛错不影响发帖回执（韧性硬要求）', async () => {
    const r = await runPopclawPostCommand({ positional: ['照发'], flags: {} }, postDeps(exploding));
    expect(r.text).toContain('📜 posted');
  });
});

// ---------------------------------------------------------------------------
// reply_sent: /popclaw reply (cross-platform).
// ---------------------------------------------------------------------------

const replyCache = {
  lookup: () => ({
        handle: 'elonmusk',
        textPreview: '被回的那条原文',
        authorPopclawId: 'THEM',
        eventId: 'evt-target',
        originalUrl: 'https://x.com/elonmusk/status/1',
    actorVerified: [{ platform: 'x', handle: 'elonmusk', profileUrl: '', followerCount: 12000 }],
  }),
};

const replyDeps = (
  socialLog?: SocialLogRecorder,
  push = async () => ({}) as unknown,
  cache: unknown = replyCache,
) =>
  ({
    signer: makeSigner(),
    egress: { push },
    nickname: '我',
    cache,
    socialLog,
  }) as unknown as Parameters<typeof runPopclawReplyCommand>[1];

describe('reply_sent — runPopclawReplyCommand', () => {
  it('推送成功后记 reply_sent，带对方身份 + 双向原文 + verified_then', async () => {
    await runPopclawReplyCommand({ positional: ['x:123', 'good', 'point'] }, replyDeps(log));
    expect(log.entries).toHaveLength(1);
    const e = log.entries[0]!;
    expect(e.kind).toBe('reply_sent');
    expect(e.actor?.id).toBe('THEM');
    expect(e.actor?.name).toBe('elonmusk');
    expect(e.actor?.verified_then).toEqual([{ platform: 'x', followers: 12000 }]);
    expect(e.text).toBe('good point');
    expect(e.in_reply_to?.text).toBe('被回的那条原文');
    expect(e.in_reply_to?.url).toBe('https://x.com/elonmusk/status/1');
  });

  it('缓存里查不到目标 → 没发出去，不记', async () => {
    const deps = replyDeps(log, undefined, { lookup: () => null });
    await runPopclawReplyCommand({ positional: ['x:123', 'hi'] }, deps);
    expect(log.entries).toEqual([]);
  });

  it('push 抛错 → 不记（异常照常冒泡给主流程）', async () => {
    const deps = replyDeps(log, async () => {
      throw new Error('网断了');
    });
    await expect(
      runPopclawReplyCommand({ positional: ['x:123', 'hi'] }, deps),
    ).rejects.toThrow();
    expect(log.entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dm_sent — /popclaw message
// ---------------------------------------------------------------------------

const msgDeps = (socialLog?: SocialLogRecorder) =>
  ({
    signer: makeSigner(),
    egress: { push: async () => ({}) },
    nickname: '我',
    socialLog,
  }) as unknown as Parameters<typeof runPopclawMessageCommand>[1];

// #227: recipient ID must be a real public key because the body is encrypted to it; an arbitrary base58 string need not be a curve point.
const RECIPIENT = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey);

describe('dm_sent — runPopclawMessageCommand', () => {
  it('发出后记 dm_sent，带收件人与完整原文', async () => {
    await runPopclawMessageCommand({ positional: [RECIPIENT, 'hey', 'there'] }, msgDeps(log));
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]!.kind).toBe('dm_sent');
    expect(log.entries[0]!.actor?.id).toBe(RECIPIENT);
    expect(log.entries[0]!.text).toBe('hey there');
  });

  it('给自己发 / 缺 body → 不记', async () => {
    await runPopclawMessageCommand({ positional: [RECIPIENT] }, msgDeps(log));
    expect(log.entries).toEqual([]);
  });

  it('日志抛错不影响 DM 回执', async () => {
    const r = await runPopclawMessageCommand(
      { positional: [RECIPIENT, 'hi'] },
      msgDeps(exploding),
    );
    expect(r.text).toBe('✉️ Letter sent\nTo: #dxpzk557\n\nThe relay accepted the letter; recipient delivery is not confirmed.');
  });
});

// ---------------------------------------------------------------------------
// mark_added — /popclaw mark
// ---------------------------------------------------------------------------

const CACHED = {
  platform: 'x',
  platformPostId: '999',
  eventId: 'evt-marked',
  authorPopclawId: 'THEM',
  handle: 'someone',
  textPreview: '被 mark 的那条原文',
  originalUrl: 'https://x.com/someone/status/999',
  platformPostCreatedAt: 1_700_000_000,
  actorVerified: [{ platform: 'x', handle: 'someone', profileUrl: '', followerCount: 500 }],
};

const markCache = {
  lookup: () => CACHED,
  findByEventIdPrefix: () => ({ item: CACHED, ambiguous: [] }),
};

const markDeps = (socialLog?: SocialLogRecorder, pushed = true, cache: unknown = markCache) =>
  ({
    cache,
    markService: { mark: async () => ({ pushed }) },
    socialLog,
  }) as unknown as Parameters<typeof runPopclawMarkCommand>[1];

describe('mark_added — runPopclawMarkCommand', () => {
  it('mark 成功后记，带被 mark 内容的原文与来源链接', async () => {
    await runPopclawMarkCommand({ positional: ['x:999'] }, markDeps(log));
    expect(log.entries).toHaveLength(1);
    const e = log.entries[0]!;
    expect(e.kind).toBe('mark_added');
    expect(e.actor?.id).toBe('THEM');
    expect(e.text).toBe('被 mark 的那条原文');
    expect(e.event_id).toBe('evt-marked');
    expect(e.url).toBe('https://x.com/someone/status/999');
    expect(e.actor?.verified_then).toEqual([{ platform: 'x', followers: 500 }]);
  });

  it('灯坊推送失败但本地已 mark —— 仍然是主人做过的动作，照记', async () => {
    await runPopclawMarkCommand({ positional: ['x:999'] }, markDeps(log, false));
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]!.kind).toBe('mark_added');
  });

  it('目标解析失败 → 不记', async () => {
    const deps = markDeps(log, true, {
      lookup: () => null,
      findByEventIdPrefix: () => ({ item: null, ambiguous: [] }),
    });
    await runPopclawMarkCommand({ positional: ['x:404'] }, deps);
    expect(log.entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// follow_added / follow_removed
// ---------------------------------------------------------------------------

describe('follow_added / follow_removed', () => {
  it('declareFollow 成功后记 follow_added', async () => {
    await runFollowCommand('THEM', {
      socialGraph: withOutcomes({ declareFollow: async () => {} }),
      socialLog: log,
    } as never);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]!.kind).toBe('follow_added');
    expect(log.entries[0]!.actor?.id).toBe('THEM');
  });

  it('declareFollow 抛错 → 不记（意图不是动作）', async () => {
    await runFollowCommand('THEM', {
      socialGraph: withOutcomes({
        declareFollow: async () => {
          throw new Error('灯坊挂了');
        },
      }),
      socialLog: log,
    } as never);
    expect(log.entries).toEqual([]);
  });

  it('日志抛错不影响 follow 回执', async () => {
    const r = await runFollowCommand('THEM', {
      socialGraph: withOutcomes({ declareFollow: async () => {} }),
      socialLog: exploding,
    } as never);
    expect(r.text).toContain('✓ Following');
  });

  it('revokeFollow 成功后记 follow_removed', async () => {
    await runPopclawUnfollowCommand('THEM', {
      socialGraph: withOutcomes({
        following: () => [{ popclawId: 'THEM' }],
        revokeFollow: async () => {},
      }),
      socialLog: log,
    } as never);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]!.kind).toBe('follow_removed');
    expect(log.entries[0]!.actor?.id).toBe('THEM');
  });

  it('本来就没关注 → 什么都没发生，不记', async () => {
    await runPopclawUnfollowCommand('THEM', {
      socialGraph: { revokeFollowWithOutcome: async () => ({ mode: 'none', reason: 'RELATION_NOT_FOLLOWING' }) },
      socialLog: log,
    } as never);
    expect(log.entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// reply_received: routeReplyPing reuses an existing collection point, without adding another.
// ---------------------------------------------------------------------------

const OWNER = 'OWNER';
const TARGET_POST = 'my-post-1';
const pingDatabases: InMemoryHostDb[] = [];
afterEach(() => { for (const db of pingDatabases.splice(0)) db.close(); });

function pingDeps(socialLog?: SocialLogRecorder) {
  const db = new InMemoryHostDb();
  pingDatabases.push(db);
  runMigrations(db, fileURLToPath(new URL('../../../migrations', import.meta.url)));
  return {
    ownerPopclawId: OWNER,
    cache: {
      lookup: () => ({
        authorPopclawId: OWNER,
        textPreview: '我原来那条的原文',
        eventId: 'evt-mine',
        platform: 'popclaw',
        platformPostId: TARGET_POST,
      }),
    },
    pings: new ReplyPingsStore(db),
    notifier: new SqliteNotifier(db),
    now: () => 1_700_000_100,
    socialLog,
  } as never;
}

const incomingReply = {
  platform: 'popclaw',
  platformPostId: 'their-reply-1',
  eventId: 'evt-their-reply',
  authorPopclawId: 'THEM',
  handle: 'someone',
  actorNickname: '苍梧阁大学士',
  textPreview: '回复的完整原文',
  platformPostCreatedAt: 1_700_000_050,
  replyToPlatform: 'popclaw',
  replyToPostId: TARGET_POST,
  actorVerified: [{ platform: 'x', handle: 'someone', profileUrl: '', followerCount: 12000 }],
};

describe('reply_received — routeReplyPing', () => {
  it('过闸后记一条，带双向原文 + verified_then', () => {
    routeReplyPing(pingDeps(log), incomingReply);
    expect(log.entries).toHaveLength(1);
    const e = log.entries[0]!;
    expect(e.kind).toBe('reply_received');
    expect(e.actor?.id).toBe('THEM');
    expect(e.actor?.name).toBe('苍梧阁大学士');
    expect(e.actor?.verified_then).toEqual([{ platform: 'x', followers: 12000 }]);
    expect(e.text).toBe('回复的完整原文');
    expect(e.in_reply_to?.text).toBe('我原来那条的原文');
  });

  it('同一条回复重复到货（SSE 重连回补）只记一次', () => {
    const deps = pingDeps(log);
    expect(routeReplyPing(deps, incomingReply)).toBe('first');
    expect(routeReplyPing(deps, incomingReply)).toBe('duplicate');
    expect(routeReplyPing(deps, incomingReply)).toBe('duplicate');
    expect(log.entries).toHaveLength(1);
  });

  it('不是回我的 / 我回我自己 → 不记', () => {
    routeReplyPing(pingDeps(log), { ...incomingReply, replyToPostId: '' });
    routeReplyPing(pingDeps(log), { ...incomingReply, authorPopclawId: OWNER });
    expect(log.entries).toEqual([]);
  });

  it('旧回复（首回但已过新鲜窗）仍是真实发生的动作，照记', () => {
    routeReplyPing(pingDeps(log), { ...incomingReply, platformPostCreatedAt: 1 });
    expect(log.entries).toHaveLength(1);
  });

  it('日志抛错不影响路由判定', () => {
    expect(routeReplyPing(pingDeps(exploding), incomingReply)).toBe('first');
  });
});

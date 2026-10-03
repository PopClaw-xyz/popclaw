/**
 * ADR-0037 总法则「坊是事实的维度」落到社交日志：凡记录**发生了什么**的都必须带坊。
 * 这些采集点本地本来就算出了坊（路由用的就是它），只是没写进日志 —— 出处丢了不可回填。
 *
 * 判据两条：算得出就带；算不出就**省略**（不填 'popclaw' 之类的假默认 ——
 * social-log 的诚实空缺纪律，见 social-log.ts 头注三条硬要求）。
 *
 * 另含 `mark_removed`：unmark 此前全流程零 safeRecord —— P-004 立法动机
 *（「UI 选择信号没家」）的原样复现。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import type { MasterKey } from '../../../src/identity/keystore.js';
import type { SocialLogEntry, SocialLogRecorder } from '../../../src/social-log/social-log.js';
import { runPopclawPostCommand } from '../../../src/commands/popclaw-post.js';
import { runPopclawMessageCommand } from '../../../src/commands/popclaw-message.js';
import { runPopclawMarkCommand, runPopclawUnmarkCommand } from '../../../src/commands/popclaw-mark.js';
import { runFollowCommand } from '../../../src/commands/follow.js';
import { runPopclawUnfollowCommand } from '../../../src/commands/popclaw-unfollow.js';
import { withOutcomes } from '../../helpers/with-outcomes.js';

class FakeLog implements SocialLogRecorder {
  entries: SocialLogEntry[] = [];
  record(e: SocialLogEntry): void {
    this.entries.push(e);
  }
}

let log: FakeLog;
beforeEach(() => {
  log = new FakeLog();
});

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

// ---------------------------------------------------------------------------
// follow_added / follow_removed —— 坊由 SocialGraph 解出（declare 时查缓存，
// revoke 时回本地账本），命令层拿它的返回值。
// ---------------------------------------------------------------------------

describe('follow_added / follow_removed 带坊', () => {
  it('declareFollow 回哪座坊，日志就记哪座', async () => {
    await runFollowCommand('THEM', {
      socialGraph: withOutcomes({ declareFollow: async () => 'popclaw-world' }),
      socialLog: log,
    } as never);
    expect(log.entries[0]!.house_slug).toBe('popclaw-world');
  });

  it('主坊（SocialGraph 返回 undefined）→ 省略字段，不填假默认', async () => {
    await runFollowCommand('THEM', {
      socialGraph: withOutcomes({ declareFollow: async () => undefined }),
      socialLog: log,
    } as never);
    expect(log.entries[0]!.kind).toBe('follow_added');
    expect('house_slug' in log.entries[0]!).toBe(false);
  });

  it('revokeFollow 回当初 declare 的那座坊', async () => {
    await runPopclawUnfollowCommand('THEM', {
      socialGraph: withOutcomes({
        following: () => [{ popclawId: 'THEM' }],
        revokeFollow: async () => 'popclaw-world',
      }),
      socialLog: log,
    } as never);
    expect(log.entries[0]!.kind).toBe('follow_removed');
    expect(log.entries[0]!.house_slug).toBe('popclaw-world');
  });
});

// ---------------------------------------------------------------------------
// dm_sent —— 回信沿原路返回，那条路就是坊。
// ---------------------------------------------------------------------------

// #227: 收件人 id 必须是**真公钥**（正文加密到它）；随手编的 base58 串不是曲线上的点。
const RECIPIENT = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey);

const msgDeps = (houseOfRecipient?: () => string | undefined) =>
  ({
    signer: makeSigner(),
    egress: { push: async () => ({}) },
    nickname: '我',
    socialLog: log,
    houseOfRecipient,
  }) as unknown as Parameters<typeof runPopclawMessageCommand>[1];

describe('dm_sent 带坊', () => {
  it('私信发去哪座坊就记哪座', async () => {
    await runPopclawMessageCommand({ positional: [RECIPIENT, 'hey'] }, msgDeps(() => 'popclaw-world'));
    expect(log.entries[0]!.kind).toBe('dm_sent');
    expect(log.entries[0]!.house_slug).toBe('popclaw-world');
  });

  it('没接 houseOfRecipient（单坊 / dev CLI）→ 省略', async () => {
    await runPopclawMessageCommand({ positional: [RECIPIENT, 'hey'] }, msgDeps());
    expect('house_slug' in log.entries[0]!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// post_sent / reply_sent —— 原创发主坊；--reply/--quote 落被回那条的来源坊。
// ---------------------------------------------------------------------------

const postDeps = (targetHouse?: string) =>
  ({
    signer: makeSigner(),
    egress: { push: async () => ({ status: 200 }) },
    nickname: '我',
    cache: {
      findFullEventId: () => ({ full: null, ambiguous: [] }),
      findByEventIdPrefix: () => ({
        item: { eventId: 'evt-target', textPreview: '被回的原文', houseSlug: targetHouse },
        ambiguous: [],
      }),
    },
    webBaseUrl: 'https://popclaw.me',
    socialLog: log,
  }) as unknown as Parameters<typeof runPopclawPostCommand>[1];

describe('post_sent / reply_sent 带坊', () => {
  it('--reply 记被回那条的来源坊', async () => {
    await runPopclawPostCommand(
      { positional: ['接话'], flags: { reply: 'a'.repeat(64) } },
      postDeps('popclaw-world'),
    );
    expect(log.entries[0]!.kind).toBe('reply_sent');
    expect(log.entries[0]!.house_slug).toBe('popclaw-world');
  });

  it('原创帖走主坊 → 省略（没算出坊就不编一个）', async () => {
    await runPopclawPostCommand({ positional: ['你好'], flags: {} }, postDeps('popclaw-world'));
    expect(log.entries[0]!.kind).toBe('post_sent');
    expect('house_slug' in log.entries[0]!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mark_added / mark_removed
// ---------------------------------------------------------------------------

const CACHED = {
  platform: 'x',
  platformPostId: '999',
  eventId: 'evt-marked',
  authorPopclawId: 'THEM',
  handle: 'someone',
  textPreview: '被 mark 的那条原文',
  originalUrl: 'https://x.com/someone/status/999',
  houseSlug: 'popclaw-world',
};

const markCache = (item: unknown = CACHED) => ({
  lookup: () => item,
  findByEventIdPrefix: () => ({ item, ambiguous: [] }),
});

const unmarkDeps = (opts: { wasMarked?: boolean; item?: unknown; localRows?: unknown[] } = {}) => {
  const calls: Array<{ eventId: string; houseSlug?: string }> = [];
  const deps = {
    cache: markCache(opts.item === undefined ? CACHED : opts.item),
    markService: {
      unmark: async (eventId: string, houseSlug?: string) => {
        calls.push({ eventId, houseSlug });
        return { pushed: true, wasMarked: opts.wasMarked ?? true };
      },
    },
    store: { listActive: () => opts.localRows ?? [] },
    socialLog: log,
  } as unknown as Parameters<typeof runPopclawUnmarkCommand>[1];
  return { deps, calls };
};

describe('mark_added 带坊', () => {
  it('被 mark 那条在哪座坊露的面就记哪座', async () => {
    await runPopclawMarkCommand({ positional: ['x:999'] }, {
      cache: markCache(),
      markService: { mark: async () => ({ pushed: true }) },
      socialLog: log,
    } as unknown as Parameters<typeof runPopclawMarkCommand>[1]);
    expect(log.entries[0]!.kind).toBe('mark_added');
    expect(log.entries[0]!.house_slug).toBe('popclaw-world');
  });
});

describe('mark_removed —— unmark 此前零记录（P-004 补课）', () => {
  it('撤销成功后记一条，带坊 + 被撤那条的原文与来源链接', async () => {
    const { deps } = unmarkDeps();
    await runPopclawUnmarkCommand({ positional: ['x:999'] }, deps);
    expect(log.entries).toHaveLength(1);
    const e = log.entries[0]!;
    expect(e.kind).toBe('mark_removed');
    expect(e.house_slug).toBe('popclaw-world');
    expect(e.actor?.id).toBe('THEM');
    expect(e.actor?.name).toBe('someone');
    expect(e.text).toBe('被 mark 的那条原文');
    expect(e.event_id).toBe('evt-marked');
    expect(e.url).toBe('https://x.com/someone/status/999');
  });

  it('本来就没 mark 过 → revoke 照样推给灯坊，所以照样记（不同于 unfollow：它提前 return 什么都不推）', async () => {
    const { deps } = unmarkDeps({ wasMarked: false });
    await runPopclawUnmarkCommand({ positional: ['x:999'] }, deps);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]!.kind).toBe('mark_removed');
  });

  it('缓存已 prune、只剩本地 marks 行 → 用本地行的原文补自足性', async () => {
    const localRow = {
      eventId: 'abcdef123456',
      authorPopclawId: 'THEM',
      handle: 'someone',
      bodySnapshot: '本地快照原文',
      summaryLine: '摘要',
      sourceUrl: 'https://x.com/someone/status/999',
    };
    const { deps } = unmarkDeps({ item: null, localRows: [localRow] });
    await runPopclawUnmarkCommand({ positional: ['abcdef'] }, deps);
    expect(log.entries).toHaveLength(1);
    const e = log.entries[0]!;
    expect(e.kind).toBe('mark_removed');
    expect(e.event_id).toBe('abcdef123456');
    expect(e.text).toBe('本地快照原文');
    expect(e.actor?.id).toBe('THEM');
    expect('house_slug' in e).toBe(false); // 缓存没了 → 坊不可考，省略
  });

  it('目标解析失败 → 不记', async () => {
    const { deps } = unmarkDeps({ item: null });
    await runPopclawUnmarkCommand({ positional: ['x:404'] }, deps);
    expect(log.entries).toEqual([]);
  });

  it('日志抛错不影响 unmark 回执', async () => {
    const { deps } = unmarkDeps();
    (deps as { socialLog?: SocialLogRecorder }).socialLog = {
      record() {
        throw new Error('disk on fire');
      },
    };
    const r = await runPopclawUnmarkCommand({ positional: ['x:999'] }, deps);
    expect(r.text).toContain('✓ unmarked');
  });
});

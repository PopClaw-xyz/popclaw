/**
 * Slice ① lookup foundation + slice ② awareness (enqueue / first reply / unread).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { popclaw } from '@popclaw/contracts';
import { deriveSigil } from '../../../src/invite/sigil';
import { makeCache, bytesOf, item } from '../../helpers/world-feed-cache';
import type { WorldFeedCache } from '../../../src/ingress/world-feed-cache';
import { LocalHostDb } from '../../../src/host/local-host-db';
import { runMigrations } from '../../../src/host/migrations';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier';
import { notifierForOrigin } from '../../../src/runtime/house-lifecycle/notification-scope';
import { readSocialLog, SocialLogWriter } from '../../../src/social-log/social-log';
import { setOwnerLang } from '../../../src/lexicon/owner-language';
import {
  ReplyPingsStore,
  routeReplyPing,
  collectPings,
  renderPings,
  type PingMaterial,
} from '../../../src/pings/reply-pings';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

// S3 rollout slice 2: renderPings now renders in `ownerLang()` (S1
// process-wide singleton). Pin zh-CN so this file's pre-lexicon assertions
// stay byte-for-byte unchanged (same fix as status.test.ts / popclaw-feed.test.ts).
// The dedicated en-lane tests below pass `lang: 'en'` explicitly.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

const OWNER = 'ownerPid';

function makeStores() {
  const db = new LocalHostDb(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return { db, pings: new ReplyPingsStore(db, () => 1000), notifier: new SqliteNotifier(db, () => 1000) };
}

/** A popclaw-native post/reply as it arrives on the world-feed stream. */
function wfi(over: Partial<popclaw.event.IWorldFeedItem>): popclaw.event.IWorldFeedItem {
  return item({ platform: 'popclaw', ...over });
}

function rec(cache: WorldFeedCache, over: Partial<popclaw.event.IWorldFeedItem>) {
  const i = wfi(over);
  cache.record(i, bytesOf(i), 1);
  return i;
}

// ---------------------------------------------------------------------------
// Slice ①: WorldFeedCache.repliesToOwner.
// ---------------------------------------------------------------------------

describe('WorldFeedCache.repliesToOwner', () => {
  it('counts replies to my post', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'mine', authorPopclawId: OWNER, textPreview: '我的帖' });
    rec(cache, {
      platformPostId: 'r1',
      authorPopclawId: 'other',
      textPreview: '接一句',
      replyToPostId: 'mine',
    });
    const got = cache.repliesToOwner(OWNER, 50);
    expect(got).toHaveLength(1);
    expect(got[0]!.reply.platformPostId).toBe('r1');
    expect(got[0]!.targetPreview).toBe('我的帖');
  });

  it('counts replies to MY REPLY (my 发言 = post + my replies)', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'theirs', authorPopclawId: 'other', textPreview: '别人的帖' });
    rec(cache, {
      platformPostId: 'myreply',
      authorPopclawId: OWNER,
      textPreview: '我的回复',
      replyToPostId: 'theirs',
    });
    rec(cache, {
      platformPostId: 'r1',
      authorPopclawId: 'other',
      textPreview: '回我的回复',
      replyToPostId: 'myreply',
    });
    const got = cache.repliesToOwner(OWNER, 50);
    expect(got.map((g) => g.reply.platformPostId)).toEqual(['r1']);
  });

  it('does NOT count replies to someone else’s post', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'theirs', authorPopclawId: 'other', textPreview: '别人的帖' });
    rec(cache, {
      platformPostId: 'r1',
      authorPopclawId: 'third',
      textPreview: '回别人',
      replyToPostId: 'theirs',
    });
    expect(cache.repliesToOwner(OWNER, 50)).toEqual([]);
  });

  it('does NOT count me replying to myself', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'mine', authorPopclawId: OWNER, textPreview: '我的帖' });
    rec(cache, {
      platformPostId: 'r1',
      authorPopclawId: OWNER,
      textPreview: '自己补一句',
      replyToPostId: 'mine',
    });
    expect(cache.repliesToOwner(OWNER, 50)).toEqual([]);
  });

  it('never filters on reply_to_author_popclaw_id (empty on live tail — spec §12)', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'mine', authorPopclawId: OWNER, textPreview: '我的帖' });
    // Live tail: reply_to_author_popclaw_id is always an empty string.
    rec(cache, {
      platformPostId: 'r1',
      authorPopclawId: 'other',
      textPreview: '接一句',
      replyToPostId: 'mine',
      replyToAuthorPopclawId: '',
    });
    expect(cache.repliesToOwner(OWNER, 50)).toHaveLength(1);
  });

  it('newest first, so a cap never drops the freshest reply', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'mine', authorPopclawId: OWNER, textPreview: '我的帖' });
    for (const [id, ts] of [['old', 100], ['mid', 200], ['new', 300]] as const) {
      rec(cache, {
        platformPostId: id,
        authorPopclawId: 'other',
        replyToPostId: 'mine',
        platformPostCreatedAt: ts,
      });
    }
    expect(cache.repliesToOwner(OWNER, 2).map((g) => g.reply.platformPostId)).toEqual([
      'new',
      'mid',
    ]);
  });

  it('joins on the FULL primary key — a forged platform cannot hit my mirror row', async () => {
    const { cache } = await makeCache();
    // Owner's mirrored X post, ID "111".
    rec(cache, {
      platform: 'x',
      platformPostId: '111',
      authorPopclawId: OWNER,
      textPreview: '我的 X 镜像帖',
    });
    // Someone else's TikTok post with the same ID and a reply to it; the replier can supply any platform.
    rec(cache, { platform: 'tiktok', platformPostId: '111', authorPopclawId: 'other' });
    rec(cache, {
      platform: 'popclaw',
      platformPostId: 'forged',
      authorPopclawId: 'attacker',
      replyToPlatform: 'tiktok',
      replyToPostId: '111',
    });
    expect(cache.repliesToOwner(OWNER, 50)).toEqual([]);
    // A reply correctly targeting the owner's X mirror still matches.
    rec(cache, {
      platform: 'popclaw',
      platformPostId: 'real',
      authorPopclawId: 'friend',
      replyToPlatform: 'x',
      replyToPostId: '111',
    });
    expect(cache.repliesToOwner(OWNER, 50).map((g) => g.reply.platformPostId)).toEqual(['real']);
  });
});

// ---------------------------------------------------------------------------
// Slice ②: enqueue routing / first reply / idempotency.
// ---------------------------------------------------------------------------

/** Default post time from helpers/world-feed-cache; pin now to the same instant so replies are fresh. */
const NOW = 1_700_000_000;

describe('routeReplyPing', () => {
  async function setup(now: () => number = () => NOW) {
    const { cache } = await makeCache();
    const s = makeStores();
    rec(cache, { platformPostId: 'mine', authorPopclawId: OWNER, textPreview: '我的帖' });
    const deps = { ownerPopclawId: OWNER, cache, pings: s.pings, notifier: s.notifier, now };
    return { cache, deps, ...s };
  }

  it('first reply → L1, later replies → L2', async () => {
    const { cache, deps, notifier } = await setup();
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'a', replyToPostId: 'mine' });
    const b = rec(cache, { platformPostId: 'r2', authorPopclawId: 'b', replyToPostId: 'mine' });
    expect(routeReplyPing(deps, a)).toBe('first');
    expect(routeReplyPing(deps, b)).toBe('more');
    expect(notifier.count('L1')).toBe(1);
    expect(notifier.count('L2')).toBe(1);
  });

  it('same reply delivered twice does not enqueue twice (idempotent)', async () => {
    const { cache, deps, notifier } = await setup();
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'a', replyToPostId: 'mine' });
    expect(routeReplyPing(deps, a)).toBe('first');
    expect(routeReplyPing(deps, a)).toBe('duplicate');
    expect(notifier.count()).toBe(1);
  });

  it.each([
    ['first', false, false],
    ['first', false, true],
    ['first-stale', true, false],
    ['first-stale', true, true],
    ['more', false, false],
    ['more', false, true],
  ] as const)('rolls back failed %s routing (stale=%s, queue written=%s) and restores it once on replay', async (outcome, stale, writeQueue) => {
    const { cache, deps, db, pings, notifier } = await setup(() => NOW + (stale ? 3600 : 60));
    const origin = 'https://reply-house.invalid';
    const logDir = mkdtempSync(resolve(tmpdir(), 'popclaw-reply-pings-'));
    const socialLog = new SocialLogWriter({ dir: logDir, now: () => NOW * 1000 });
    const readLog = () => readSocialLog(logDir, NOW, NOW + 1);
    try {
      if (outcome === 'more') {
        routeReplyPing(deps, rec(cache, { eventId: 'earlier', platformPostId: 'earlier', authorPopclawId: 'a', replyToPostId: 'mine' }));
      }
      const beforeUnread = pings.listUnread(10);
      const beforeQueue = notifier.count();
      const beforeFirst = db.queryAll('SELECT * FROM reply_first_ping');
      const reply = rec(cache, { eventId: 'failed-reply', platformPostId: 'failed-reply', authorPopclawId: 'b', replyToPostId: 'mine', textPreview: 'Reply body' });
      const failed = {
        ...deps,
        socialLog,
        notifier: notifierForOrigin({ enqueue: (args) => {
          if (writeQueue) notifier.enqueue(args);
          throw new Error('QUEUE-FAILURE');
        } }, origin),
      };
      expect(() => routeReplyPing(failed, reply)).toThrow('QUEUE-FAILURE');
      expect(pings.listUnread(10)).toEqual(beforeUnread);
      expect(db.queryAll('SELECT * FROM reply_first_ping')).toEqual(beforeFirst);
      expect(notifier.count()).toBe(beforeQueue);
      expect(readLog()).toEqual([]);

      const recovered = { ...deps, socialLog, notifier: notifierForOrigin(notifier, origin) };
      expect(routeReplyPing(recovered, reply)).toBe(outcome);
      expect(routeReplyPing(recovered, reply)).toBe('duplicate');
      expect(pings.unreadCount()).toBe(beforeUnread.length + 1);
      expect(notifier.count()).toBe(beforeQueue + 1);
      expect(db.queryAll('SELECT * FROM reply_first_ping')).toHaveLength(1);
      const queued = notifier.drain().filter((notice) => notice.payload.replyEventId === 'failed-reply');
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ level: outcome === 'first' ? 'L1' : 'L2', kind: 'reply', payload: { houseOrigin: origin } });
      expect(readLog()).toHaveLength(1);
      expect(readLog()[0]).toMatchObject({ kind: 'reply_received', event_id: 'failed-reply', text: 'Reply body' });
    } finally {
      db.close();
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('rolls back both reply gates after a real SQLite queue insert failure, then replays normally', async () => {
    const { cache, deps, db, pings, notifier } = await setup();
    const reply = rec(cache, { eventId: 'sql-failure', platformPostId: 'sql-failure', authorPopclawId: 'a', replyToPostId: 'mine' });
    db.execute("CREATE TEMP TRIGGER reject_reply_queue BEFORE INSERT ON notification_queue BEGIN SELECT RAISE(ABORT, 'QUEUE-SQL-FAILURE'); END");
    expect(() => routeReplyPing(deps, reply)).toThrow('QUEUE-SQL-FAILURE');
    expect(pings.unreadCount()).toBe(0);
    expect(db.queryAll('SELECT * FROM reply_first_ping')).toEqual([]);
    expect(notifier.count()).toBe(0);
    db.execute('DROP TRIGGER reject_reply_queue');
    expect(routeReplyPing(deps, reply)).toBe('first');
    expect(routeReplyPing(deps, reply)).toBe('duplicate');
    expect(notifier.count('L1')).toBe(1);
    expect(pings.unreadCount()).toBe(1);
    db.close();
  });

  it('does not append JSONL when SQLite rejects the transaction at commit', async () => {
    const { cache, deps, db, pings, notifier } = await setup();
    const logDir = mkdtempSync(resolve(tmpdir(), 'popclaw-reply-pings-commit-'));
    const socialLog = new SocialLogWriter({ dir: logDir, now: () => NOW * 1000 });
    const readLog = () => readSocialLog(logDir, NOW, NOW + 1);
    try {
      // The queue insert succeeds; its deferred foreign key fails only at COMMIT.
      db.execute('CREATE TABLE commit_parent (id INTEGER PRIMARY KEY)');
      db.execute('CREATE TABLE commit_child (parent_id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED)');
      db.execute('CREATE TEMP TRIGGER reject_reply_commit AFTER INSERT ON notification_queue BEGIN INSERT INTO commit_child (parent_id) VALUES (404); END');
      const reply = rec(cache, { eventId: 'commit-failure', platformPostId: 'commit-failure', authorPopclawId: 'a', replyToPostId: 'mine' });
      const routed = { ...deps, socialLog };
      expect(() => routeReplyPing(routed, reply)).toThrow(/FOREIGN KEY constraint failed/);
      expect(readLog()).toEqual([]);
      expect(pings.unreadCount()).toBe(0);
      expect(db.queryAll('SELECT * FROM reply_first_ping')).toEqual([]);
      expect(notifier.count()).toBe(0);
      db.execute('DROP TRIGGER reject_reply_commit');
      expect(routeReplyPing(routed, reply)).toBe('first');
      expect(routeReplyPing(routed, reply)).toBe('duplicate');
      expect(notifier.count('L1')).toBe(1);
      expect(readLog()).toHaveLength(1);
    } finally {
      db.close();
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('首回 is judged once per 发言 — a redelivered first reply never re-fires L1', async () => {
    const { cache, deps, notifier } = await setup();
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'a', replyToPostId: 'mine' });
    const b = rec(cache, { platformPostId: 'r2', authorPopclawId: 'b', replyToPostId: 'mine' });
    routeReplyPing(deps, a);
    routeReplyPing(deps, b);
    routeReplyPing(deps, a); // SSE reconnect backfill.
    routeReplyPing(deps, b);
    expect(notifier.count('L1')).toBe(1);
    expect(notifier.count('L2')).toBe(1);
  });

  it('ignores replies to other people and self-replies', async () => {
    const { cache, deps, notifier } = await setup();
    rec(cache, { platformPostId: 'theirs', authorPopclawId: 'other' });
    const toOther = rec(cache, {
      platformPostId: 'r9',
      authorPopclawId: 'a',
      replyToPostId: 'theirs',
    });
    const mine = rec(cache, {
      platformPostId: 'r8',
      authorPopclawId: OWNER,
      replyToPostId: 'mine',
    });
    const plainPost = rec(cache, { platformPostId: 'p1', authorPopclawId: 'a' });
    expect(routeReplyPing(deps, toOther)).toBe('not-mine');
    expect(routeReplyPing(deps, mine)).toBe('self');
    expect(routeReplyPing(deps, plainPost)).toBe('not-mine');
    expect(notifier.count()).toBe(0);
  });

  // Bond-context trailing line (2026-07-29): like fromName, bake it into the payload when enqueuing.
  it('bondContext 有话说 → 烘进 payload.bondLine；没话说不带这个 key', async () => {
    const { cache, deps, notifier } = await setup();
    const withCtx = {
      ...deps,
      bondContext: (id: string) => (id === 'laozhang' ? '　 ↳ 好友 · 昨天他给你来过信' : ''),
    };
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'laozhang', replyToPostId: 'mine' });
    const b = rec(cache, { platformPostId: 'r2', authorPopclawId: 'stranger', replyToPostId: 'mine' });
    routeReplyPing(withCtx, a);
    routeReplyPing(withCtx, b);
    expect(notifier.drain('L1')[0]!.payload['bondLine']).toBe('　 ↳ 好友 · 昨天他给你来过信');
    expect(notifier.drain('L2')[0]!.payload).not.toHaveProperty('bondLine');
  });

  it('a stale reply (SSE backfill) still queues, but never at L1', async () => {
    // First install/reinstall: backfill a 5000-item window, where every historical reply looks like a first reply.
    const { cache, deps, notifier } = await setup(() => NOW + 3600);
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'a', replyToPostId: 'mine' });
    expect(routeReplyPing(deps, a)).toBe('first-stale');
    expect(notifier.count('L1')).toBe(0);
    expect(notifier.count('L2')).toBe(1);
  });

  it('a reply inside the freshness window still wakes at L1', async () => {
    const { cache, deps, notifier } = await setup(() => NOW + 60);
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'a', replyToPostId: 'mine' });
    expect(routeReplyPing(deps, a)).toBe('first');
    expect(notifier.count('L1')).toBe(1);
  });

  it('my own self-reply does not burn 首回 — the next person still counts as first', async () => {
    const { cache, deps, notifier, pings } = await setup();
    const selfie = rec(cache, {
      platformPostId: 'r0',
      authorPopclawId: OWNER,
      replyToPostId: 'mine',
    });
    expect(routeReplyPing(deps, selfie)).toBe('self');
    const laoZhang = rec(cache, {
      platformPostId: 'r1',
      authorPopclawId: 'laozhang',
      replyToPostId: 'mine',
    });
    expect(routeReplyPing(deps, laoZhang)).toBe('first');
    expect(notifier.count('L1')).toBe(1);
    expect(pings.unreadCount()).toBe(1); // The self-reply does not enter pending replies.
  });

  it('unread survives until popclaw_show_pings takes the batch (agent 不取则未读不清)', async () => {
    const { cache, deps, pings } = await setup();
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'a', replyToPostId: 'mine' });
    routeReplyPing(deps, a);
    expect(pings.unreadCount()).toBe(1);
    // Agent saw the trailing notice but did not fetch: keep unread.
    expect(pings.unreadCount()).toBe(1);
    expect(pings.markRead(pings.listUnread(10))).toBe(1);
    expect(pings.unreadCount()).toBe(0);
  });

  it('the L1 drain (DM path) does not clear ping unread state', async () => {
    const { cache, deps, pings, notifier } = await setup();
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'a', replyToPostId: 'mine' });
    routeReplyPing(deps, a);
    notifier.drain('L1');
    expect(pings.unreadCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Materials + tiered rendering (same two-level response shape as popclaw_author_latest).
// ---------------------------------------------------------------------------

describe('collectPings / renderPings', () => {
  /** Cache + ledger + N routed replies, all unread. */
  async function seeded(n: number, over: (i: number) => Partial<popclaw.event.IWorldFeedItem> = () => ({})) {
    const { cache } = await makeCache();
    const s = makeStores();
    rec(cache, { platformPostId: 'mine', authorPopclawId: OWNER, textPreview: '我的帖' });
    const deps = { ownerPopclawId: OWNER, cache, pings: s.pings, notifier: s.notifier, now: () => NOW };
    for (let i = 0; i < n; i++) {
      const r = rec(cache, {
        platformPostId: `r${i}`,
        authorPopclawId: `p${i}`,
        handle: `人${i}`,
        textPreview: `正文${i}`,
        platformPostCreatedAt: NOW + i,
        replyToPostId: 'mine',
        ...over(i),
      });
      routeReplyPing(deps, r);
    }
    return { cache, ...s };
  }

  it('tags every ping with the replier bond tier, unknown → stranger', async () => {
    const { cache, pings } = await seeded(2, (i) => ({
      authorPopclawId: i === 0 ? 'friendPid' : 'nobody',
    }));
    const got = collectPings({
      cache,
      pings,
      ownerPopclawId: OWNER,
      bondOf: (id) => (id === 'friendPid' ? { tier: 'close' as const, remarkName: '' } : null),
    });
    // Bond tier descending, then time descending (newest first).
    expect(got.map((p) => p.replierPopclawId)).toEqual(['friendPid', 'nobody']);
    expect(got[0]!.tier).toBe('close');
    expect(got[1]!.tier).toBe('stranger');
  });

  // renderPings renders replierName directly, so
  // repliers without aliases or handles previously had raw ID prefixes baked into names. Same display rule:
  // always name#sigil, or just #sigil when no name can be resolved.
  it('no alias and no handle → the name falls back to #sigil, never a bare id prefix', async () => {
    const { cache, pings } = await seeded(1, () => ({ authorPopclawId: 'ghostPid', handle: '' }));
    const got = collectPings({ cache, pings, ownerPopclawId: OWNER, bondOf: () => null });
    expect(got).toHaveLength(1);
    expect(got[0]!.replierName).toBe(`#${deriveSigil('ghostPid')}`);
    const rendered = renderPings(got);
    expect(rendered.text).not.toContain('ghostPid'.slice(0, 10));
  });

  it('only unread replies become material; read ones drop out', async () => {
    const { cache, pings } = await seeded(3);
    const all = collectPings({ cache, pings, ownerPopclawId: OWNER, bondOf: () => null });
    expect(all).toHaveLength(3);
    pings.markRead(renderPings(all).shown.map((p) => p.eventId));
    expect(collectPings({ cache, pings, ownerPopclawId: OWNER, bondOf: () => null })).toEqual([]);
  });

  it('a truncated batch keeps the un-shown tail unread (the newest is never lost)', async () => {
    const { cache, pings } = await seeded(130);
    const items = collectPings({ cache, pings, ownerPopclawId: OWNER, bondOf: () => null });
    expect(items).toHaveLength(130);
    const { shown } = renderPings(items);
    expect(shown).toHaveLength(20);
    // The newest reply must be among the 20 shown (time descending within a tier).
    expect(shown[0]!.eventId).toBe(items[0]!.eventId);
    expect(pings.markRead(shown.map((p) => p.eventId))).toBe(20);
    expect(pings.unreadCount()).toBe(110); // Prompt for the rest next time; do not lose them forever.
  });

  it('≤5 renders full text; >5 switches to the compact timeline', () => {
    const mk = (n: number): PingMaterial[] =>
      Array.from({ length: n }, (_, i) => ({
        eventId: `e${i}`,
        replierPopclawId: `p${i}`,
        replierName: `人${i}`,
        tier: 'stranger' as const,
        body: `第 ${i} 条回复正文`,
        createdAt: 1_700_000_000 + i,
        targetPostId: 'mine',
        targetPreview: '我的帖',
        webUrl: '',
      }));
    const full = renderPings(mk(5));
    const compact = renderPings(mk(6));
    expect(full.text).toContain('回你的：');
    expect(full.shown).toHaveLength(5);
    expect(compact.text).not.toContain('回你的：');
    expect(compact.text).toContain('6 条');
    expect(compact.shown).toHaveLength(6);
  });

  // S3 rollout slice 2 — en lane, same fixtures as the zh-CN case above.
  it('≤5 renders full text; >5 switches to the compact timeline (en lane)', () => {
    const mk = (n: number): PingMaterial[] =>
      Array.from({ length: n }, (_, i) => ({
        eventId: `e${i}`,
        replierPopclawId: `p${i}`,
        replierName: `person${i}`,
        tier: 'stranger' as const,
        body: `reply body ${i}`,
        createdAt: 1_700_000_000 + i,
        targetPostId: 'mine',
        targetPreview: 'my post',
        webUrl: '',
      }));
    const full = renderPings(mk(5), 'en');
    const compact = renderPings(mk(6), 'en');
    expect(full.text).toContain('Replying to yours:');
    expect(full.shown).toHaveLength(5);
    expect(compact.text).not.toContain('Replying to yours:');
    expect(compact.text).toContain('Pending replies (6');
    expect(compact.shown).toHaveLength(6);
  });

  it('>100 shows the first 20 plus an aggregate count', () => {
    const many: PingMaterial[] = Array.from({ length: 130 }, (_, i) => ({
      eventId: `e${i}`,
      replierPopclawId: `p${i}`,
      replierName: `人${i}`,
      tier: 'stranger' as const,
      body: `正文${i}`,
      createdAt: 1_700_000_000 + i,
      targetPostId: 'mine',
      targetPreview: '我的帖',
      webUrl: '',
    }));
    const { text, shown } = renderPings(many);
    expect(text).toContain('人0');
    expect(text).toContain('人19');
    expect(text).not.toContain('人20');
    expect(text).toContain('另有 110 人回复');
    expect(shown).toHaveLength(20);
  });

  // S3 rollout slice 2 — en lane, same fixture as the zh-CN case above.
  it('>100 shows the first 20 plus an aggregate count (en lane)', () => {
    const many: PingMaterial[] = Array.from({ length: 130 }, (_, i) => ({
      eventId: `e${i}`,
      replierPopclawId: `p${i}`,
      replierName: `person${i}`,
      tier: 'stranger' as const,
      body: `body ${i}`,
      createdAt: 1_700_000_000 + i,
      targetPostId: 'mine',
      targetPreview: 'my post',
      webUrl: '',
    }));
    const { text, shown } = renderPings(many, 'en');
    expect(text).toContain('person0');
    expect(text).toContain('person19');
    expect(text).not.toContain('person20');
    expect(text).toContain('110 more people are still waiting');
    expect(shown).toHaveLength(20);
  });

  it('empty → an honest no-pings line', () => {
    expect(renderPings([]).text).toContain('没有');
    expect(renderPings([]).shown).toEqual([]);
  });

  // S3 rollout slice 2 — en lane.
  it('empty → an honest no-pings line (en lane)', () => {
    expect(renderPings([], 'en').text).toContain("Nobody's waiting");
    expect(renderPings([], 'en').shown).toEqual([]);
  });
});

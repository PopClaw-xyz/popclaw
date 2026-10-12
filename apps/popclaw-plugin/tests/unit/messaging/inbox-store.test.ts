import { describe, it, expect, beforeEach } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { InboxStore, type InboxItem } from '../../../src/messaging/inbox-store.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  ts: 100, fromPopclawId: 'alice', toPopclawId: 'me', body: 'hello',
  receivedAtMs: 1000, ...over,
});

describe('InboxStore (DB-backed)', () => {
  let db: InMemoryHostDb;
  beforeEach(() => { db = new InMemoryHostDb(); runMigrations(db, MIGRATIONS); });

  // Real host (abc3177): after popclaw_acknowledge_notifications took
  // notification 2 (message 1), show_inbox still listed message 1 as `queued`.
  // `queued` is the policy decision; the hand-off lives on the notice.
  it('a queued message whose notice was acknowledged reads as acknowledged', () => {
    const s = new InboxStore(db);
    const notifier = new SqliteNotifier(db);
    s.record(item());
    const msg = s.recent(1)[0]!;
    s.settleNotification(msg.id, 'queued', () => notifier.enqueue({ level: 'L1', kind: 'dm', payload: { messageId: msg.id } }));
    const listed = () => s.notificationStatesOf([s.get(msg.id)!]).get(msg.id);
    expect(listed()).toBe('queued');
    const [notice] = notifier.peekFor('claude-code');
    expect(notice!.payload.messageId).toBe(msg.id);
    expect(listed()).toBe('queued'); // offered is not acknowledged
    notifier.acknowledgeFor('claude-code', [notice!.id]);
    expect(listed()).toBe('acknowledged');
  });

  it('records new items and reports duplicates', () => {
    const s = new InboxStore(db);
    expect(s.record(item())).toBe(true);
    expect(s.record(item())).toBe(false);
    expect(s.recent(10)).toHaveLength(1);
  });

  it('dedups across separate store instances on the SAME db (cross-process)', () => {
    expect(new InboxStore(db).record(item())).toBe(true);
    expect(new InboxStore(db).record(item())).toBe(false);
    expect(new InboxStore(db).recent(10)).toHaveLength(1);
  });

  // Spec B, slice 4: house dimension. The deduplication key is deliberately house-independent: a DM relayed by two houses
  // is processed once (exactly-once behavior verified bidirectionally on real machines).
  it('同一封 DM 从两座坊各到一次 → 只落一行，记先到的那座坊', () => {
    const s = new InboxStore(db);
    expect(s.record(item({ houseSlug: 'popclaw-me' }))).toBe(true);
    expect(s.record(item({ houseSlug: 'popclaw-world' }))).toBe(false);
    expect(s.recent(10)).toHaveLength(1);
    expect(s.recent(10)[0]!.houseSlug).toBe('popclaw-me');
    expect(s.houseOf('alice')).toBe('popclaw-me');
  });

  it('两座坊各来一条不同的 DM → 两行，各带自己的坊标签', () => {
    const s = new InboxStore(db);
    s.record(item({ ts: 1, fromPopclawId: 'alice', body: 'from home', houseSlug: 'popclaw-me' }));
    s.record(item({ ts: 2, fromPopclawId: 'bob', body: 'from world', houseSlug: 'popclaw-world' }));
    expect(s.recent(10).map((x) => [x.body, x.houseSlug])).toEqual([
      ['from world', 'popclaw-world'],
      ['from home', 'popclaw-me'],
    ]);
    expect(s.houseOf('alice')).toBe('popclaw-me');
    expect(s.houseOf('bob')).toBe('popclaw-world');
  });

  // P0-A: the full signed envelope must survive the round-trip into the precious
  // DB so a future (v0.2) verifier can rebuild canonical bytes and check it.
  it('persists and reads back the envelope bytes', () => {
    const s = new InboxStore(db);
    const env = new Uint8Array(80).fill(0x5a);
    s.record(item({ envelopeBytes: env }));
    expect(s.recent(1)[0]!.envelopeBytes).toEqual(env);
  });

  it('legacy DM with no envelope reads back undefined (graceful)', () => {
    const s = new InboxStore(db);
    s.record(item()); // no envelopeBytes
    expect(s.recent(1)[0]!.envelopeBytes).toBeUndefined();
  });

  it('empty envelope is stored as absent, not an empty blob', () => {
    const s = new InboxStore(db);
    s.record(item({ envelopeBytes: new Uint8Array(0) }));
    expect(s.recent(1)[0]!.envelopeBytes).toBeUndefined();
  });

  it('houseOf() 取该收件人的最近一条来信的坊', () => {
    const s = new InboxStore(db);
    s.record(item({ ts: 1, body: 'old', houseSlug: 'popclaw-me' }));
    s.record(item({ ts: 2, body: 'new', houseSlug: 'popclaw-world' }));
    expect(s.houseOf('alice')).toBe('popclaw-world');
  });

  it('旧行（空串 house_slug）与查无此人都回落主坊（undefined）', () => {
    const s = new InboxStore(db);
    s.record(item()); // No houseSlug means an existing single-house row.
    expect(s.recent(1)[0]!.houseSlug).toBeUndefined();
    expect(s.houseOf('alice')).toBeUndefined();
    expect(s.houseOf('nobody')).toBeUndefined();
  });

  // Real host 2026-09-25: the agent paged with before_id:11 looking for a NEWER
  // letter; the store has to be able to say how many rows sit above a cursor.
  it('newerThan() counts rows above a cursor and names the latest', () => {
    const s = new InboxStore(db);
    for (let i = 1; i <= 17; i++) s.record(item({ ts: i, body: `m${i}` }));
    expect(s.newerThan(11)).toEqual({ count: 6, latestId: 17 });
    expect(s.newerThan(17)).toEqual({ count: 0, latestId: null });
  });

  it('recent() returns newest-first by ts, capped at N, round-tripping fields', () => {
    const s = new InboxStore(db);
    s.record(item({ ts: 1, body: 'a' }));
    s.record(item({ ts: 3, body: 'c', inReplyToPlatform: 'x', inReplyToPostId: 'p9' }));
    s.record(item({ ts: 2, body: 'b' }));
    const r = s.recent(2);
    expect(r.map((x) => x.body)).toEqual(['c', 'b']);
    const newest = r[0]!;
    expect(newest.inReplyToPlatform).toBe('x');
    expect(newest.inReplyToPostId).toBe('p9');
  });

  // #231: path of the image saved with a message; old NULL values become undefined.
  it('media_path round-trips; 无图的行是 undefined（不是空串）', () => {
    const s = new InboxStore(db);
    s.record(item({ ts: 1, body: 'with pic', mediaPath: '/data/dm-media/1-abcdefgh.png' }));
    s.record(item({ ts: 2, body: 'no pic' }));
    const [newest, older] = s.recent(2);
    expect(newest!.mediaPath).toBeUndefined();
    expect(older!.mediaPath).toBe('/data/dm-media/1-abcdefgh.png');
  });

  // Hard rule: deduplicate on decrypted TEXT, never the image; replaying the same message through SSE twice
  // with the same image path still produces only one row.
  it('图不进去重键：同一封信重放仍只落一行', () => {
    const s = new InboxStore(db);
    expect(s.record(item({ ts: 1, body: 'hi', mediaPath: '/a.png' }))).toBe(true);
    expect(s.record(item({ ts: 1, body: 'hi', mediaPath: '/a.png' }))).toBe(false);
    expect(s.recent(10)).toHaveLength(1);
  });

  // Onboarding R1 started predicate: a DM from the house's official account proves activity there.
  describe('hasIncomingFrom', () => {
    it('坊官方来过信 → true；换个坊的官方 → false', () => {
      const s = new InboxStore(db);
      s.record(item({ fromPopclawId: 'world-official', houseSlug: 'popclaw-world' }));
      expect(s.hasIncomingFrom('popclaw-world', ['world-official'])).toBe(true);
      expect(s.hasIncomingFrom('popclaw-world', ['me-official'])).toBe(false);
    });

    it('存量旧行（空 house_slug）也算 —— 发件人已经把坊锁死了', () => {
      const s = new InboxStore(db);
      s.record(item({ fromPopclawId: 'me-official' })); // Row from the single-house era.
      expect(s.hasIncomingFrom('popclaw-me', ['me-official'])).toBe(true);
    });

    it('别的坊中继的同一个官方 → 不算这座坊已开始', () => {
      const s = new InboxStore(db);
      s.record(item({ fromPopclawId: 'world-official', houseSlug: 'popclaw-world' }));
      expect(s.hasIncomingFrom('third-house', ['world-official'])).toBe(false);
    });

    it('空 official_ids / 没来过信 → false（查不到就是查不到，不猜）', () => {
      const s = new InboxStore(db);
      expect(s.hasIncomingFrom('popclaw-world', [])).toBe(false);
      expect(s.hasIncomingFrom('popclaw-world', ['nobody'])).toBe(false);
    });
  });

  // Material for the bond-context footer saying this person wrote before. beforeTs is required: the receive loop persists
  // before enqueueing; without excluding this message it would always report that the person wrote today.
  describe('lastIncomingTs', () => {
    it('取严格早于 beforeTs 的最近一封', () => {
      const s = new InboxStore(db);
      s.record(item({ ts: 100, body: 'a' }));
      s.record(item({ ts: 300, body: 'b' }));
      s.record(item({ ts: 500, body: 'c' }));
      expect(s.lastIncomingTs('alice', 500)).toBe(300);
      expect(s.lastIncomingTs('alice', 1000)).toBe(500);
    });

    it('只有当前这一封 → null（不会把主人正在读的信当"上次互动"）', () => {
      const s = new InboxStore(db);
      s.record(item({ ts: 500, body: 'only' }));
      expect(s.lastIncomingTs('alice', 500)).toBeNull();
    });

    it('查无此人 → null', () => {
      expect(new InboxStore(db).lastIncomingTs('nobody', 999)).toBeNull();
    });

    it('只看这个人自己的来信', () => {
      const s = new InboxStore(db);
      s.record(item({ ts: 100, fromPopclawId: 'bob', body: 'x' }));
      expect(s.lastIncomingTs('alice', 999)).toBeNull();
      expect(s.lastIncomingTs('bob', 999)).toBe(100);
    });
  });
});

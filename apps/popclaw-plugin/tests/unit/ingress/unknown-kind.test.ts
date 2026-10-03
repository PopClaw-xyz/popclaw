/** Public semantic extensions use HouseEvent.kind; unknown wire members are rejected. */
import { describe, it, expect, vi } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { LocalHostDb } from '../../../src/host/local-host-db';
import { WorldFeedCache, envelopeKind } from '../../../src/ingress/world-feed-cache';
import { WorldFeedCatalog, type HouseFeed } from '../../../src/ingress/world-feed-catalog';
import { bytesOf, item } from '../../helpers/world-feed-cache';

/** protobuf varint。 */
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}

/** 一个只有 event_id（字段 1）+ 未知 body 成员（字段 `field`）的 EventEnvelope。 */
function unknownEnvelope(field: number, eventId = 'evt-from-world'): Uint8Array {
  const idBytes = [...Buffer.from(eventId, 'utf8')];
  const bodyBytes = [...Buffer.from('{"postcard":"从 world 坊寄来"}', 'utf8')];
  return new Uint8Array([
    ...varint((1 << 3) | 2), ...varint(idBytes.length), ...idBytes,
    ...varint((field << 3) | 2), ...varint(bodyBytes.length), ...bodyBytes,
  ]);
}

/** 真 HouseEvent（字段 34）——popclaw.world 的词汇，本地 proto 认得格子、不认得词。 */
const houseEventEnvelope = (kind: string) =>
  popclaw.event.EventEnvelope.encode({
    eventId: 'evt-house',
    houseEvent: { kind, schemaVersion: 1, body: Buffer.from('{"from":"京都"}', 'utf8') },
  }).finish() as Uint8Array;

const postEnvelope = () =>
  popclaw.event.EventEnvelope.encode({
    eventId: 'evt-post',
    post: { blocks: [{ blockType: 0, content: '认得的帖' }] },
  }).finish() as Uint8Array;

async function makeCacheWith(debug?: (m: string) => void) {
  const db = new LocalHostDb(':memory:');
  const cache = new WorldFeedCache(debug ? { db, debug } : { db });
  await cache.start();
  return { cache, db };
}

describe('envelopeKind — 认得的成员报名字，认不得的报字段号', () => {
  it('认得的 oneof 成员 → 名字', () => {
    expect(envelopeKind(postEnvelope())).toBe('post');
    expect(envelopeKind(popclaw.event.EventEnvelope.encode({
      eventId: 'e', reply: { body: 'hi' },
    }).finish() as Uint8Array)).toBe('reply');
  });

  it('HouseEvent（#188 扩展位）→ 取 body 里的坊词汇，不是笼统的 house_event', () => {
    expect(envelopeKind(houseEventEnvelope('world.postcard'))).toBe('house:world.postcard');
    expect(envelopeKind(houseEventEnvelope('world.encounter'))).toBe('house:world.encounter');
    // kind 空（不合规的坊）→ 退回格子名，仍然不崩。
    expect(envelopeKind(houseEventEnvelope(''))).toBe('house_event');
  });

  it('本版 proto 不认识的成员 → unknown:<字段号>（字段号就是它的身份）', () => {
    expect(envelopeKind(unknownEnvelope(40))).toBe('unknown:40');
    expect(envelopeKind(unknownEnvelope(120))).toBe('unknown:120'); // 两字节 key
  });

  it('没有 envelope / 只有信封头 → ""', () => {
    expect(envelopeKind(undefined)).toBe('');
    expect(envelopeKind(new Uint8Array())).toBe('');
    expect(envelopeKind(popclaw.event.EventEnvelope.encode({ eventId: 'e' }).finish() as Uint8Array)).toBe('');
  });

  it('畸形字节绝不抛', () => {
    for (const bad of [[0xff], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], [0x0a, 0x7f], [0x07]]) {
      expect(() => envelopeKind(new Uint8Array(bad))).not.toThrow();
    }
  });
});

describe('未知 kind 的事件进缓存', () => {
  it('拒绝未知结构成员，不存原文也不输出预览', async () => {
    const { cache, db } = await makeCacheWith();
    const candidate = item({ envelope: unknownEnvelope(40) });
    expect(() => cache.record(candidate, bytesOf(candidate), 1)).toThrow();
    expect(db.queryAll('SELECT * FROM world_feed')).toEqual([]);
    expect(cache.recentForReading(10)).toEqual([]);
  });

  it('真 HouseEvent 进缓存：kind 是坊词汇，原始字节留着', async () => {
    const { cache, db } = await makeCacheWith();
    const envelope = houseEventEnvelope('world.postcard');
    const it = item({ platform: 'popclaw', platformPostId: 'pc-1', eventId: 'evt-house', envelope, platformPostCreatedAt: 100 });
    cache.record(it, bytesOf(it), 1);
    expect(cache.recentForReading(10)[0]!.kind).toBe('house:world.postcard');
    const row = db.queryOne<{ raw: Uint8Array }>(`SELECT raw FROM world_feed WHERE platform_post_id = ?`, ['pc-1']);
    expect(Buffer.from(popclaw.event.WorldFeedItem.decode(row!.raw).envelope as Uint8Array))
      .toEqual(Buffer.from(envelope));
  });

  it('不丢相邻事件：未知 kind 夹在两条认得的帖中间，三条都在', async () => {
    const { cache } = await makeCacheWith();
    for (const [id, ts, env] of [
      ['known-1', 100, postEnvelope()],
      ['weird', 200, houseEventEnvelope('legacy-.opaque_kind')],
      ['known-2', 300, postEnvelope()],
    ] as const) {
      const it = item({ platform: 'popclaw', platformPostId: id, eventId: `e-${id}`, envelope: env, platformPostCreatedAt: ts });
      cache.record(it, bytesOf(it), 1);
    }
    const read = cache.recentForReading(10);
    expect(read.map((i) => i.platformPostId)).toEqual(['known-2', 'weird', 'known-1']);
    expect(read.map((i) => i.kind)).toEqual(['post', 'house:legacy-.opaque_kind', 'post']);
    expect(read[0]!.body).toBe('认得的帖'); // 认得的那条照常解出正文
  });

  it('拒绝未知结构不产生成功 debug，也不影响相邻正常事件', async () => {
    const debug = vi.fn();
    const { cache } = await makeCacheWith(debug);
    for (const id of ['before', 'after']) {
      const known = item({ platformPostId: id, envelope: postEnvelope() });
      cache.record(known, bytesOf(known), 1);
      if (id === 'before') {
        const weird = item({ platformPostId: 'rejected', envelope: unknownEnvelope(40) });
        expect(() => cache.record(weird, bytesOf(weird), 1)).toThrow();
      }
    }
    expect(cache.recent(10).map(row => row.platformPostId).sort()).toEqual(['after', 'before']);
    expect(debug).not.toHaveBeenCalled();
  });

  it('跨坊合并视图里，world 坊的未知事件照样带来源坊 slug', async () => {
    const mk = async (slug: string): Promise<HouseFeed> => ({
      slug, baseUrl: `https://${slug}`, dbPath: ':memory:',
      cache: (await makeCacheWith()).cache,
      snapshot: { fetchSnapshot: async () => [] },
    });
    const home = await mk('popclaw-me');
    const world = await mk('popclaw-world');
    const post = item({ platform: 'popclaw', platformPostId: 'h1', eventId: 'eh', envelope: postEnvelope(), platformPostCreatedAt: 100 });
    home.cache.record(post, bytesOf(post), 1);
    const weird = item({ platform: 'popclaw', platformPostId: 'w1', eventId: 'ew', envelope: houseEventEnvelope('world.postcard'), platformPostCreatedAt: 200 });
    world.cache.record(weird, bytesOf(weird), 1);

    const merged = new WorldFeedCatalog([home, world]).recentForReading(10);
    expect(merged.map((i) => [i.houseSlug, i.kind])).toEqual([
      ['popclaw-world', 'house:world.postcard'],
      ['popclaw-me', 'post'],
    ]);
  });
});

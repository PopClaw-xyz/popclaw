/**
 * Slice F, F1: unpack house-event envelopes.
 *
 * HouseEvent.body contains bytes encoded by each house according to its manifest JSON Schema. The
 * newspaper previously saw only `house:world.trip` (the house always returned an empty
 * text_preview), leaving places, scenes, companions and home links unopened in the envelope.
 *
 * Fixture field names come verbatim from the manifest fetched on 2026-07-31 at
 * `https://house.popclaw.world/v1/manifest`: world.trip uses figure/phase/trip_ref/place_name/tier;
 * world.encounter uses place_name/occurred_at/present[]/scene; world.embodiment uses
 * figure/home_url/...
 */
import { describe, it, expect, afterEach } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { LocalHostDb } from '../../../src/host/local-host-db';
import { WorldFeedCache, houseBodyFields, decodeEnvelopeBody } from '../../../src/ingress/world-feed-cache';
import { setOwnerLang } from '../../../src/lexicon/owner-language';
import { bytesOf, item } from '../../helpers/world-feed-cache';

const bodyOf = (json: unknown): Uint8Array =>
  new Uint8Array(Buffer.from(JSON.stringify(json), 'utf8'));

const houseEnvelope = (kind: string, json: unknown): Uint8Array =>
  popclaw.event.EventEnvelope.encode({
    eventId: 'evt-house',
    houseEvent: { kind, schemaVersion: 1, body: Buffer.from(bodyOf(json)) },
  }).finish() as Uint8Array;

afterEach(() => setOwnerLang(undefined));

describe('houseBodyFields — 只搬运，不解释', () => {
  it('world.trip 的真实 body → 平表（键名逐字照抄告示牌 schema）', () => {
    expect(
      houseBodyFields(
        bodyOf({
          figure: { figure_ref: 'fig_1', figure_name: '小蓝' },
          phase: 'returned',
          trip_ref: 'trip_9',
          place_name: '苏州',
          tier: 'city',
        }),
        'zh-CN',
      ),
    ).toEqual({
      'figure.figure_ref': 'fig_1',
      'figure.figure_name': '小蓝',
      phase: 'returned',
      trip_ref: 'trip_9',
      place_name: '苏州',
      tier: 'city',
    });
  });

  it('world.encounter：同框者数组按序号摊开，scene 的 langtext 取主人语言那条', () => {
    setOwnerLang('zh-CN');
    const f = houseBodyFields(
      bodyOf({
        place_name: '山塘街',
        occurred_at: 1785400000,
        present: [
          { figure_ref: 'f1', figure_name: '小蓝', owner_popclaw_id: 'OWNER_A' },
          { figure_ref: 'f2', figure_name: '阿橙', owner_popclaw_id: 'OWNER_B' },
        ],
        scene: { 'zh-CN': '两只在桥头蹲了一会儿', en: 'they sat by the bridge' },
      }),
      'zh-CN',
    );
    expect(f!['place_name']).toBe('山塘街');
    expect(f!['present.1.figure_name']).toBe('小蓝');
    expect(f!['present.2.owner_popclaw_id']).toBe('OWNER_B');
    expect(f!['scene']).toBe('两只在桥头蹲了一会儿');
  });

  it('langtext 没有主人语言那条 → 取第一条并标出语言码，绝不冒充主人的话', () => {
    expect(houseBodyFields(bodyOf({ scene: { ja: '橋の上で' } }), 'zh-CN')!['scene'])
      .toBe('橋の上で（ja）');
  });

  it('坏 body / 非 JSON / 空 → null（静默降级成今天的行为）', () => {
    expect(houseBodyFields(bodyOf('just a string'), 'zh-CN')).toBeNull();
    expect(houseBodyFields(new Uint8Array(Buffer.from('not json', 'utf8')), 'zh-CN')).toBeNull();
    expect(houseBodyFields(new Uint8Array(), 'zh-CN')).toBeNull();
    expect(houseBodyFields(undefined, 'zh-CN')).toBeNull();
    expect(houseBodyFields(bodyOf({}), 'zh-CN')).toBeNull();
  });

  it('上限：≤12 个键、值 ≤120 字（坊的 body 是外部输入）', () => {
    const many = Object.fromEntries([...Array(30)].map((_, i) => [`k${i}`, `v${i}`]));
    expect(Object.keys(houseBodyFields(bodyOf(many), 'zh-CN')!)).toHaveLength(12);
    const long = houseBodyFields(bodyOf({ scene: 'x'.repeat(300) }), 'zh-CN')!['scene']!;
    expect(long).toHaveLength(121); // 120 characters plus an ellipsis.
  });
});

describe('decodeEnvelopeBody / recentForReading — 坊事件带着字段进缓存', () => {
  it('HouseEvent → fields；帖/回复不受影响', () => {
    const decoded = decodeEnvelopeBody(houseEnvelope('world.trip', { place_name: '苏州' }));
    expect(decoded).toEqual({ text: '', media: [], fields: { place_name: '苏州' } });
    expect(
      decodeEnvelopeBody(
        popclaw.event.EventEnvelope.encode({ post: { blocks: [{ blockType: 0, content: 'hi' }] } }).finish() as Uint8Array,
      ),
    ).toEqual({ text: 'hi', media: [] });
  });

  it('recentForReading 把字段带出来，kind 与 body 的老行为一字不差', async () => {
    const cache = new WorldFeedCache({ db: new LocalHostDb(':memory:') });
    await cache.start();
    const envelope = houseEnvelope('world.embodiment', {
      figure: { figure_ref: 'f1', figure_name: '小蓝' },
      home_url: 'https://popclaw.world/h/3m8v5x1p',
    });
    const it_ = item({ platform: 'popclaw', platformPostId: 'e1', eventId: 'e1', envelope, textPreview: '' });
    cache.record(it_, bytesOf(it_), 1);
    const read = cache.recentForReading(10)[0]!;
    expect(read.kind).toBe('house:world.embodiment');
    expect(read.houseFields).toEqual({
      'figure.figure_ref': 'f1',
      'figure.figure_name': '小蓝',
      home_url: 'https://popclaw.world/h/3m8v5x1p',
    });
  });

  it('body 认不出来的坊事件 → 一格 houseFields 都不出（不猜）', async () => {
    const cache = new WorldFeedCache({ db: new LocalHostDb(':memory:') });
    await cache.start();
    const envelope = popclaw.event.EventEnvelope.encode({
      eventId: 'e2',
      houseEvent: { kind: 'world.stamp_collected', schemaVersion: 1, body: Buffer.from('not json', 'utf8') },
    }).finish() as Uint8Array;
    const it_ = item({ platform: 'popclaw', platformPostId: 'e2', eventId: 'e2', envelope, textPreview: 'fallback' });
    cache.record(it_, bytesOf(it_), 1);
    const read = cache.recentForReading(10)[0]!;
    expect(read.kind).toBe('house:world.stamp_collected');
    expect(read.houseFields).toBeUndefined();
    expect(read.body).toBe('fallback');
  });
});
